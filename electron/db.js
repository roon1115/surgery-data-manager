const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { app } = require('electron');

// SQLite ネイティブモジュールは Electron 最新版との互換性問題を避けるため未使用。
// JSON スナップショット + 追記ジャーナル(NDJSON)で永続化する。
//
// 旧方式(毎回 ingest.json 全体を書き直す)は記録件数 n に対して O(n) の同期書き込みで、
// 「削除前に必ず flush」の安全要件と組み合わさると取り込み1回で O(files×n) になり
// メインプロセスを長時間ブロックしていた。
// 新方式: 変更は ingest.journal.ndjson に1行追記(O(1))、flush は fsync のみ。
// 起動時にスナップショット+ジャーナルをマージして新スナップショットに固め(コンパクション)、
// ジャーナルを空にする。クラッシュしてもジャーナルの追記済み行から復元できる。
let Database = null;

let db = null;
let jsonFallback = null;
let jsonPath = null;
let journalPath = null;
let journalFd = null;
let journalDirty = false; // fsync 未実施の追記があるか
let nextDicomId = 1;

// ジャーナル1行 = 1操作。
//   { t:'file', sha256, rec }                          … recordFile
//   { t:'dcm+', item }                                 … queueDicom (item.id 採番済み)
//   { t:'dcm~', id, attempts, lastError, remove }      … updatePendingDicom
function applyOp(op) {
  if (!op || typeof op !== 'object') return;
  if (op.t === 'file' && typeof op.sha256 === 'string' && op.rec) {
    jsonFallback.files[op.sha256] = op.rec;
  } else if (op.t === 'dcm+' && op.item) {
    jsonFallback.pending_dicom.push(op.item);
    if (Number.isInteger(op.item.id) && op.item.id >= nextDicomId) nextDicomId = op.item.id + 1;
  } else if (op.t === 'dcm~') {
    const idx = jsonFallback.pending_dicom.findIndex((it) => it.id === op.id);
    if (idx < 0) return;
    if (op.remove) {
      jsonFallback.pending_dicom.splice(idx, 1);
    } else {
      if (op.attempts !== undefined) jsonFallback.pending_dicom[idx].attempts = op.attempts;
      if (op.lastError !== undefined) jsonFallback.pending_dicom[idx].lastError = op.lastError;
    }
  }
}

function appendOp(op) {
  // 記録の耐久性はデータ削除の安全性に直結するため、書けない場合は例外にする
  // (呼び出し元の取り込み処理が該当ファイルを失敗扱いにし、元ファイルは削除されない)
  fs.writeSync(journalFd, JSON.stringify(op) + '\n');
  journalDirty = true;
}

// スナップショットをアトミック+耐久に書く(tmp へ書いて fsync してから rename)。
// fsync が無いと rename 直後の電源断でデータ未達のまま「書けた」ことになり、
// 「削除前に記録をディスクへ確定」の保証が破れる。
function writeSnapshotSync() {
  const tmp = jsonPath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(jsonFallback));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, jsonPath);
  // rename 自体の耐久化(親ディレクトリの fsync)。失敗しても致命ではないので best-effort
  try {
    const dirFd = fs.openSync(path.dirname(jsonPath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (_) {}
}

function init() {
  if (db || jsonFallback) return;

  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });

  if (Database) {
    const dbPath = path.join(dir, 'ingest.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        sha256       TEXT PRIMARY KEY,
        src_path     TEXT NOT NULL,
        dst_path     TEXT NOT NULL,
        size         INTEGER NOT NULL,
        mtime        INTEGER NOT NULL,
        imported_at  INTEGER NOT NULL,
        patient_id   TEXT,
        kind         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_files_patient ON files(patient_id);
      CREATE TABLE IF NOT EXISTS pending_dicom (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        dst_path    TEXT NOT NULL,
        patient_id  TEXT NOT NULL,
        patient_name TEXT NOT NULL,
        procedure   TEXT,
        study_date  TEXT,
        queued_at   INTEGER NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT
      );
    `);
    return;
  }

  jsonPath = path.join(dir, 'ingest.json');
  journalPath = path.join(dir, 'ingest.journal.ndjson');

  // 1) スナップショット読み込み
  try {
    jsonFallback = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    // ファイルが存在するのに parse に失敗 → 破損。無言で空 DB 上書きせず退避してから初期化
    if (fs.existsSync(jsonPath)) {
      try {
        const bak = jsonPath + '.corrupt-' + Date.now() + '.bak';
        fs.copyFileSync(jsonPath, bak);
        console.error('[db] ingest.json の読み込みに失敗したため退避しました:', bak, e?.message || e);
      } catch (_) {}
    }
    jsonFallback = { files: {}, pending_dicom: [] };
  }
  if (!jsonFallback.files || typeof jsonFallback.files !== 'object') jsonFallback.files = {};
  if (!Array.isArray(jsonFallback.pending_dicom)) jsonFallback.pending_dicom = [];

  // 旧形式(id なし)の pending_dicom に id を採番
  for (const it of jsonFallback.pending_dicom) {
    if (Number.isInteger(it.id) && it.id >= nextDicomId) nextDicomId = it.id + 1;
  }
  for (const it of jsonFallback.pending_dicom) {
    if (!Number.isInteger(it.id)) it.id = nextDicomId++;
  }

  // 2) ジャーナル再生(前回セッションの確定済み変更)。
  //    途中で切れた行(クラッシュ時の書きかけ)はそこで再生を打ち切る。
  let replayed = 0;
  try {
    const raw = fs.readFileSync(journalPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let op = null;
      try { op = JSON.parse(line); } catch (_) { break; }
      applyOp(op);
      replayed++;
    }
  } catch (_) { /* ジャーナルなし = 初回 or 正常終了後 */ }

  // 3) コンパクション: マージ結果をスナップショットに固めてからジャーナルを空にする。
  //    (スナップショットの耐久化が先。逆順だとクラッシュで再生分が消える)
  journalFd = fs.openSync(journalPath, 'a');
  if (replayed > 0 || !fs.existsSync(jsonPath)) {
    try {
      writeSnapshotSync();
      fs.ftruncateSync(journalFd, 0);
      fs.fsyncSync(journalFd);
    } catch (e) {
      // スナップショット書き込み失敗時はジャーナルを残す(次回起動で再度マージされる)
      console.error('[db] コンパクション失敗(ジャーナルは保持):', e?.message || e);
    }
  }
}

// 未 fsync の追記をディスクへ確定させる。元ファイル削除の直前に必ず呼ぶこと。
function flush() {
  if (!journalFd || !journalDirty) return;
  fs.fsyncSync(journalFd);
  journalDirty = false;
}

// プロセス終了時にも未確定分をディスクへ
process.on('exit', () => { try { flush(); } catch (_) {} });

function hasHash(sha256) {
  init();
  if (db) {
    const row = db.prepare('SELECT 1 FROM files WHERE sha256 = ?').get(sha256);
    return !!row;
  }
  return !!jsonFallback.files[sha256];
}

// ---- stat 逆引きインデックス（重複チェック高速化） ----
// 同じSDカードを挿し直すたびに、既に取り込み済みのファイルまでゼロから全量ハッシュしていた。
// 記録には size / mtime / srcPath が入っているので、そこから sha256 を逆引きできるようにする。
//   キー: basename(srcPath) + size + floor(mtimeMs)
//   - フルパスをキーにしない理由: SD の再マウントで /Volumes/Untitled → /Volumes/Untitled 1 の
//     ように変わり、狙っているシナリオ（同一カードの再挿入）でことごとく外れるため。
//   - size+mtime だけにしない理由: FAT32 の 4GiB 分割動画は同一サイズになりやすく、
//     FAT の2秒 mtime 粒度と重なって別ファイル同士が衝突しうるため。
//   値 null = 同じキーに別々の sha が複数ある（曖昧）→ そのキーは使わない。
// 重要: このヒットは「内容を読んで確かめた値」ではない（名前・サイズ・更新時刻からの推定）。
// 呼び出し側（ingest-handler の経路1）は採用前に src と既存コピーの端点バイト比較で裏を取るが、
// それでも全量一致の証明ではない。元ファイルの削除が絡む判断には決して使わず、
// 呼び出し側で必ず実ハッシュに落とすこと。
let statIndex = null;

function statKey(name, size, mtimeMs) {
  // 大文字小文字を無視するのは、同じカードが大小文字非依存の FS 経由で見えることがあるため。
  // NFC 正規化は macOS(NFD) と SMB(NFC) で同じファイルが別キーにならないようにするため。
  return String(name).normalize('NFC').toLowerCase() + ' ' + size + ' ' + Math.floor(mtimeMs);
}

// 1レコードをインデックスへ反映（初回構築と recordFile 後の増分更新で共用）。
// size/mtime/srcPath が欠けた旧レコードは「その1件だけ」無視する
// （1件の欠損でインデックス全体を捨てると、狙った高速化が丸ごと効かなくなるため）。
function indexRecord(sha256, rec) {
  if (!statIndex || !rec) return;
  // sizeFromDst のレコードは size が「取り込み時の実測」ではなくコピー先を後から stat した
  // 補完値。既にコピー先が壊れて（サイズが変わって）いた場合、その誤ったサイズが逆引きキーの
  // 一部になり「壊れた dst のサイズと一致する src」を既取込と誤判定しうる。索引には載せない。
  if (rec.sizeFromDst === true) return;
  if (typeof rec.srcPath !== 'string' || !rec.srcPath) return;
  if (typeof rec.size !== 'number' || !Number.isFinite(rec.size)) return;
  if (typeof rec.mtime !== 'number' || !Number.isFinite(rec.mtime)) return;
  const key = statKey(path.basename(rec.srcPath), rec.size, rec.mtime);
  const cur = statIndex.get(key);
  if (cur === undefined) statIndex.set(key, sha256);
  else if (cur !== sha256) statIndex.set(key, null); // 同一キーに別の内容 → 曖昧なので不使用
}

// 名前+サイズ+更新時刻から取り込み済み sha256 を引く。ヒット無し・曖昧なら null。
// 呼び出し側は生の basename をそのまま渡してよい（正規化はこの中で行う）。
function findByStat({ name, size, mtimeMs } = {}) {
  init();
  if (db) {
    // SQLite 経路（現状 Database=null で未使用）には逆引き用のインデックスが無い。
    // ヒット無し扱い＝従来どおり全量ハッシュへフォールバックする。
    return null;
  }
  if (typeof name !== 'string' || !name) return null;
  if (typeof size !== 'number' || !Number.isFinite(size)) return null;
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return null;
  if (!statIndex) {
    statIndex = new Map();
    for (const [sha, rec] of Object.entries(jsonFallback.files)) indexRecord(sha, rec);
  }
  const hit = statIndex.get(statKey(name, size, mtimeMs));
  return typeof hit === 'string' ? hit : null;
}

// 残り予算 budgetMs 以内に stat する。取れなければ（エラー・予算切れとも）null。
// 予算切れを待たずに諦めるのは、応答しない NAS/SMB マウントでは fsp.stat が
// 分単位でハングすることがあり、そのままだと呼び出し側の時間予算（FILL_BUDGET_MS）が
// 「次のファイルを取りに行くタイミング」でしか効かず、実質無制限に待たされるため。
// タイマーは race 確定後に必ず clearTimeout する（イベントループに残さない）。
function statWithin(p, budgetMs) {
  if (!(budgetMs > 0)) return Promise.resolve(null);
  let timer = null;
  // stat 側の reject もここで null に畳む（race の敗者になっても未処理 rejection にしない）
  const statP = fsp.stat(p).then((st) => st, () => null);
  const timeoutP = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); });
  return Promise.race([statP, timeoutP]).then(
    (v) => { if (timer) clearTimeout(timer); return v; },
    (e) => { if (timer) clearTimeout(timer); throw e; });
}

// size 未記録の旧レコードを、コピー先の実ファイルから補完する。補完できたサイズ or null。
// 補完値は通常の {t:'file'} ジャーナル op として追記するので、旧バージョンでも再生できる。
// NAS 上の stat は1件あたり数十msかかることがあり、記録件数ぶん同期実行するとメインプロセスが
// 止まって UI が固まるため非同期版を使う（呼び出しは getKnownSizes の初回走査のみ）。
// deadline: 呼び出し側（getKnownSizes）の時間予算の締切（epoch ms）。stat 1回がこれを
// 超えて返らない場合は補完失敗として扱う。
async function fillMissingSize(sha256, rec, deadline) {
  if (!rec || typeof rec.dstPath !== 'string' || !rec.dstPath) return null;
  const st = await statWithin(rec.dstPath, Number.isFinite(deadline) ? deadline - Date.now() : FILL_BUDGET_MS);
  if (!st) return null;
  if (!st.isFile() || typeof st.size !== 'number' || !Number.isFinite(st.size)) return null;
  // sizeFromDst: この size は取り込み時の実測ではなく、後からコピー先を stat した補完値。
  // 補完した時点でコピー先が既に壊れていた可能性を否定できないため、元ファイル削除前の
  // ガード（ingest-handler のガード4）はこのフラグ付きレコードを stat 照合で信用せず、
  // 従来どおり全量ハッシュで確認する。
  const updated = { ...rec, size: st.size, sizeFromDst: true };
  jsonFallback.files[sha256] = updated;
  try {
    appendOp({ t: 'file', sha256, rec: updated });
  } catch (e) {
    // 追記に失敗してもメモリ上の補完値は使える（次回起動時にまた補完を試みるだけ）。
    // ここで例外を投げると重複チェック全体が失敗するので、サイズ補完は best-effort に留める。
    console.error('[db] size 補完の記録に失敗:', e?.message || e);
  }
  // 索引には意図的に載せない（sizeFromDst のレコードは indexRecord 冒頭のガードで弾かれる）
  return st.size;
}

// 記録済みファイルの全サイズ集合を返す（重複チェックのサイズ事前フィルタ用）。
// 同じサイズの記録が1件も無いファイルは内容が一致しようがない＝重複になり得ないので、
// ハッシュ計算（ファイル全読み）を省略できる。
// サイズ不明の記録が混ざっている場合はフィルタとして使えないため null を返す（安全側）。
//
// メモ化: 全走査＋（旧レコードがあれば）NAS への stat を伴うため、取り込み/重複チェックの
// たびに繰り返すと数千件規模で無視できないコストになる。初回だけ計算してキャッシュし、
// 以後は recordFile 側の増分更新（knownSizesCache.add）で追随させる。
let knownSizesCache = null;    // Set = 計算済み / null = 未計算 or 現在は使用不能
// サイズ事前フィルタを諦めた場合の「次に再試行してよい時刻」（epoch ms。0 = 諦めていない）。
// 以前はセッション固定の boolean だったが、それだと「NAS がマウントされる前にアプリを開いた」
// だけでアプリを再起動するまで全量ハッシュに落ち続けた。失敗から SIZE_FILTER_RETRY_MS の間は
// 即 null を返し、期限が切れたら1回だけ再試行する（NAS が後から来た環境は1分で自己回復する）。
// 再試行1回のコストは補完の時間予算 FILL_BUDGET_MS が上限なので、恒久的に失敗する環境でも
// 「1分あたり最大5秒」に有界（＝毎回の重複チェックが遅くなり続けることはない）。
let sizeFilterRetryAfter = 0;
const SIZE_FILTER_RETRY_MS = 60 * 1000;

// レガシー（size 未記録）レコードの補完に使う並列数と時間予算。
// 補完1件が NAS への stat 1回で、未記録レコードが数千件あると直列では分単位で待たされる。
// 並列化しても終わらないほど古い/遅い環境では、待たせ続けるより「しばらくは
// サイズ事前フィルタ無効（＝従来どおり全量ハッシュ）」に倒す方が体感が読める。
// 成功した分の補完はジャーナルに追記済みなので、再試行時は残りから前進できる。
const FILL_CONCURRENCY = 8;
const FILL_BUDGET_MS = 5000;

async function getKnownSizes() {
  init();
  if (knownSizesCache) return knownSizesCache;
  // 直近で補完に失敗/時間切れしたら、しばらくは走査せず即 null（＝従来どおり全量ハッシュ）。
  // 期限が切れたら再試行する: 失敗の主因（NAS 未マウント・電源断）は時間で解消しうるため。
  if (Date.now() < sizeFilterRetryAfter) return null;

  const sizes = new Set();
  if (db) {
    for (const row of db.prepare('SELECT size FROM files').all()) {
      if (typeof row.size !== 'number' || !Number.isFinite(row.size)) return null;
      sizes.add(row.size);
    }
    knownSizesCache = sizes;
    return sizes;
  }
  // size 未記録の旧レコードが1件でも混ざるとフィルタ全体が無効になり、
  // 全ファイルの再ハッシュに逆戻りしてしまう。コピー先の実ファイルから補完して救う。
  const missing = [];
  for (const [sha, r] of Object.entries(jsonFallback.files)) {
    const s = r ? r.size : undefined;
    if (typeof s === 'number' && Number.isFinite(s)) sizes.add(s);
    else missing.push([sha, r]);
  }
  if (missing.length > 0) {
    const deadline = Date.now() + FILL_BUDGET_MS;
    let next = 0;
    let filled = 0;      // 補完に成功した件数（ログ用）
    let failed = null;   // 補完不能だった最初のレコード [sha, rec]
    let timedOut = false;
    async function fillWorker() {
      while (true) {
        if (failed || timedOut) return;              // 1件でも諦めが確定したら以降は無駄
        // キュー枯渇の判定を締切より先に行う。逆にすると「全件の補完に成功したのに、
        // その stat が予算を超えて返った」だけで timedOut になり、完成した Set を捨てて
        // フィルタ無効（＝全量ハッシュ）に落ちてしまう。
        const k = next++;
        if (k >= missing.length) return;
        if (Date.now() >= deadline) { timedOut = true; return; }
        const [sha, r] = missing[k];
        const s = await fillMissingSize(sha, r, deadline);
        if (s === null) {
          // 予算を使い切っての失敗（ハングしたマウント等）は「時間切れ」、
          // それ以外（dst 消失・権限なし）は「補完不能」として区別する。ログの文言が変わるだけで
          // 以後の扱い（フィルタ無効化＋再試行ラッチ）は同じ。
          if (Date.now() >= deadline) timedOut = true;
          else if (!failed) failed = [sha, r];
          return;
        }
        filled++;
        sizes.add(s);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(FILL_CONCURRENCY, missing.length) }, () => fillWorker()));

    // 以後しばらく重複チェック・取り込みが全量ハッシュに戻り、大容量カードで数分遅くなる。
    // 無言で遅くなる原因が分からなくなるのでログを残す（ラッチにより最短でも
    // SIZE_FILTER_RETRY_MS に1回しか出ない＝ログが溢れることはない）。
    if (failed) {
      // 補完不能（dst 消失等）→ 従来どおりフィルタ無効（安全側）
      sizeFilterRetryAfter = Date.now() + SIZE_FILTER_RETRY_MS;
      console.error('[db] サイズ事前フィルタ無効化: size 未記録レコードのコピー先を確認できませんでした'
        + `（sha=${String(failed[0]).slice(0, 12)}…, dst=${(failed[1] && failed[1].dstPath) || '(未記録)'}）。`
        + `以後の重複チェックは全量ハッシュになります（${Math.round(SIZE_FILTER_RETRY_MS / 1000)}秒後に再試行）。`);
      return null;
    }
    if (timedOut) {
      sizeFilterRetryAfter = Date.now() + SIZE_FILTER_RETRY_MS;
      console.error('[db] サイズ事前フィルタ無効化: レガシーレコードの補完が時間内に終わらず打ち切りました'
        + `（未記録 ${missing.length} 件中 ${filled} 件を補完、予算 ${FILL_BUDGET_MS}ms）。`
        + `補完できた分は記録済みで次回以降は続きから前進します（${Math.round(SIZE_FILTER_RETRY_MS / 1000)}秒後に再試行）。`);
      return null;
    }
  }
  // 走査中（await を挟む）に recordFile が走ると、その size は
  // knownSizesCache がまだ null なので増分更新されず、この Set から漏れうる。
  // 呼び出し元（取り込み / 重複チェック）は busy フラグで相互排他されており、
  // 各処理の先頭で1回だけ呼ぶため実際には重ならない。万一漏れても
  // 「重複になり得ないと誤判定 → 事前ハッシュを省略」までで、コピー後の
  // db.hasHash(srcSha) 判定が二重登録を防ぐ。
  knownSizesCache = sizes;
  return sizes;
}

// ハッシュから既存の取り込み記録を引く（重複ファイルの既存コピー先を確認するため）。
// 返り値は { sha256, srcPath, dstPath, size, mtime, patientId, kind } または null。
function getByHash(sha256) {
  init();
  if (db) {
    const row = db.prepare('SELECT * FROM files WHERE sha256 = ?').get(sha256);
    if (!row) return null;
    return {
      sha256: row.sha256,
      srcPath: row.src_path,
      dstPath: row.dst_path,
      size: row.size,
      mtime: row.mtime,
      patientId: row.patient_id,
      kind: row.kind,
    };
  }
  const r = jsonFallback.files[sha256];
  return r ? { sha256, ...r } : null;
}

function recordFile({ sha256, srcPath, dstPath, size, mtime, patientId, kind }) {
  init();
  const importedAt = Date.now();
  // サイズ集合の増分更新（getKnownSizes のキャッシュを作り直さずに済ませる）。
  // 未計算(null)なら何もしない＝次の初回走査で拾われる。
  if (knownSizesCache && typeof size === 'number' && Number.isFinite(size)) knownSizesCache.add(size);
  if (db) {
    db.prepare(`
      INSERT OR IGNORE INTO files (sha256, src_path, dst_path, size, mtime, imported_at, patient_id, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sha256, srcPath, dstPath, size, mtime, importedAt, patientId || null, kind || null);
  } else {
    const rec = { srcPath, dstPath, size, mtime, importedAt, patientId, kind };
    jsonFallback.files[sha256] = rec; // メモリ上は即時反映（hasHash/getByHash は正しく動く）
    // stat 逆引きも同一セッション中に追随させる（未構築なら何もしない）。
    // appendOp（例外を投げうる）より先に呼ぶ: 追記に失敗しても jsonFallback.files には
    // 既に載っているので、索引だけ取り残されて hasHash と食い違う状態を作らない。
    indexRecord(sha256, rec);
    appendOp({ t: 'file', sha256, rec }); // ディスクへの確定は flush() の fsync で
  }
}

function queueDicom({ dstPath, patientId, patientName, procedure, studyDate }) {
  init();
  if (db) {
    db.prepare(`
      INSERT INTO pending_dicom (dst_path, patient_id, patient_name, procedure, study_date, queued_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(dstPath, patientId, patientName, procedure || '', studyDate || '', Date.now());
  } else {
    const item = {
      id: nextDicomId++,
      dstPath, patientId, patientName, procedure, studyDate, queuedAt: Date.now(), attempts: 0,
    };
    jsonFallback.pending_dicom.push(item);
    appendOp({ t: 'dcm+', item });
    flush(); // キュー投入は低頻度なので即確定
  }
}

function listPendingDicom() {
  init();
  if (db) {
    return db.prepare('SELECT * FROM pending_dicom ORDER BY queued_at ASC').all();
  }
  return jsonFallback.pending_dicom.map((it) => ({ ...it }));
}

function updatePendingDicom(id, { attempts, lastError, remove }) {
  init();
  if (db) {
    if (remove) {
      db.prepare('DELETE FROM pending_dicom WHERE id = ?').run(id);
    } else {
      db.prepare('UPDATE pending_dicom SET attempts = ?, last_error = ? WHERE id = ?')
        .run(attempts, lastError || null, id);
    }
    return;
  }
  const op = { t: 'dcm~', id, attempts, lastError, remove: !!remove };
  applyOp(op);
  appendOp(op);
  flush(); // 再送成功でキューから消す操作は低頻度なので即確定
}

module.exports = {
  init,
  hasHash,
  getKnownSizes,
  findByStat,
  getByHash,
  recordFile,
  flush,
  queueDicom,
  listPendingDicom,
  updatePendingDicom,
};
