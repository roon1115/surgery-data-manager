const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sanitize = require('sanitize-filename');
const settings = require('./settings-handler');
const db = require('./db');
const history = require('./history');

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.tif', '.tiff', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mts', '.mxf', '.mkv']);
const CSV_EXT = new Set(['.csv', '.tsv', '.txt']);

// 外部（レンダラ）から渡された値が sha256 の体裁をしているか
const isSha256 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

// 重複チェック（runCheckDuplicates）が最後に確定させた結果の台帳。
//   キー: 絶対パス / 値: { sha, verified, size, mtimeMs, dev, ino }
// レンダラ経由で届く f.sha256 / f.sha256Verified は外部入力で、main 側では
// 「その sha が本当に中身を読んで得た値か」を保証できない。元ファイルの削除に効く
// verified フラグは main 自身が計算した事実だけを根拠にする必要があるため、
// 判定結果はこの台帳に持ち、stat が一致したときだけ再利用する。
//
// 残余リスク（承知のうえで受容している範囲）:
//   stat の dev+ino は FAT ではドライバが合成する値で、別カード間で衝突しうる。
//   台帳の verified を削除判断に使う経路は取り込み側のガード5（stat 照合）も通るが、
//   「チェック済み → 物理的にカードを差し替え → 取り込み」の順で同じマウントパスに
//   同名・同サイズ・同更新時刻・同 dev+ino のファイルが現れる状況は原理的に検出しきれない。
//   実運用の入口を塞ぐため、ejectVolume が呼ばれたら（成功・失敗・既に取り外し済みの
//   いずれでも）台帳を丸ごと破棄する（下記 ingest:ejectVolume）。
// パージは必ず「Map ごと差し替え」で行うこと（entries を clear しない）。
// チェック実行中に eject でパージされた場合、完走時の差し替えを
// 「開始時に掴んだ参照と同一か」で判定して弾いている（runCheckDuplicates 末尾）。
// 世代カウンタ方式だと新しいパージ箇所を足すときにインクリメントを忘れうるが、
// 参照比較なら差し替えた時点で自動的に不採用になる。
let checkLedger = new Map();

// スキャン時の stat（f.size / f.mtime）と現物の stat が一致するか。
// fail-closed: size / mtime が数値で来ていなければ「一致していない」とみなす。
// この判定は元ファイル削除の可否に効くので、情報が無い＝安全側（削除しない・再ハッシュする）に倒す。
function statMatches(st, f) {
  if (!st || !f) return false;
  if (typeof f.size !== 'number' || !Number.isFinite(f.size)) return false;
  if (typeof f.mtime !== 'number' || !Number.isFinite(f.mtime)) return false;
  return st.size === f.size && Math.abs(st.mtimeMs - f.mtime) < 1;
}

// 台帳エントリが現物と同一ファイルを指しているか。
// size/mtime に加えて dev+ino も見るのは、「同じラベルの別カードが同じマウントパスに来た」
// 場合（/Volumes/Untitled の挿し替え）に、前回チェックの sha を別カードのファイルへ
// 誤って流用しないため。パス・名前・サイズ・更新時刻は容易に一致しうる。
function ledgerMatches(st, led) {
  if (!st || !led) return false;
  if (!statMatches(st, { size: led.size, mtime: led.mtimeMs })) return false;
  return st.dev === led.dev && st.ino === led.ino;
}

function classifyByExt(ext) {
  const e = ext.toLowerCase();
  if (PHOTO_EXT.has(e)) return 'photo';
  if (VIDEO_EXT.has(e)) return 'video';
  if (CSV_EXT.has(e)) return 'csv';
  return 'other';
}

// 全ウィンドウへ進捗イベントを送る。破棄済み/破棄途中のウィンドウは飛ばし、
// send が投げても握りつぶす。
// 進捗の emit は onBytes（ストリームの 'data' リスナー）から同期で呼ばれるため、
// ここで例外が漏れると Promise では捕まらない uncaughtException になり
// メインプロセスごと落ちる（＝コピー途中の取り込みが道連れになる）。
// isDestroyed の有無は duck-typing で見る（提供しない実装でも送信自体は続行する）。
function sendToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) continue;
      const wc = win.webContents;
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) continue;
      wc.send(channel, payload);
    } catch (_) { /* 破棄途中のウィンドウ等。進捗表示のために取り込みを落とさない */ }
  }
}

function emitProgress(payload) {
  sendToWindows('ingest:progress', payload);
}

// walk() が無視するメタデータ系ファイル（コピーもされない）。
// これらだけが残っているフォルダは実質「空」とみなして削除してよい。
function isIgnorableMeta(name) {
  return name === '.DS_Store' || name === 'Thumbs.db' || name.startsWith('._');
}

// 削除してはいけないディレクトリ（ルート / ボリュームのマウント元）。
//   /                → 保護
//   /Volumes         → 保護
//   /Volumes/<mount> → 保護（SDカード等のマウント元そのもの）
function isProtectedDir(dir) {
  const norm = path.resolve(dir);
  if (norm === '/') return true;
  const parts = norm.split('/').filter(Boolean);
  if (parts.length < 2) return true;
  if (parts[0] === 'Volumes' && parts.length <= 2) return true;
  return false;
}

// child が parent の中（parent 自身を含む）にあるか。パスは正規化して比較。
function isWithin(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// dir のシンボリックリンクを解決した実パスを返す（解決できなければ null）。
async function realOrNull(dir) {
  try { return await fsp.realpath(dir); } catch (_) { return null; }
}

// dir が「.DS_Store 等のメタファイルのみ（または完全に空）」なら、メタファイルを消して
// フォルダごと削除し true を返す。実ファイル・サブフォルダ・symlink が残っていれば触らない。
//   - boundary: 実パス。この境界の外は絶対に削除しない（シンボリックリンク経由の脱出も遮断）
//   - /Volumes 直下のマウント元等は isProtectedDir で保護
async function removeDirIfEmptyMeta(dir, boundary) {
  const realDir = await realOrNull(dir);
  if (!realDir || !isWithin(boundary, realDir)) return false;
  if (isProtectedDir(dir)) return false;

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return false;
  }
  // メタデータ以外（実ファイル・サブフォルダ・シンボリックリンク等）が残っていれば削除しない
  if (entries.some((e) => !(e.isFile() && isIgnorableMeta(e.name)))) return false;

  for (const e of entries) {
    try { await fsp.unlink(path.join(dir, e.name)); } catch (_) {}
  }
  try {
    await fsp.rmdir(dir);
    return true;
  } catch (_) {
    return false;
  }
}

// 中断フラグ + 進行中ストリーム参照（取り込み中に cancel が呼ばれたら destroy する）
// 並列コピー対応のため Set で全ストリームを追跡する（コピー/ハッシュ両方）
let cancelRequested = false;
const activeStreams = new Set();

function requestCancel() {
  cancelRequested = true;
  for (const s of activeStreams) {
    try { s.destroy(); } catch (_) {}
  }
}

ipcMain.handle('ingest:cancel', async () => {
  requestCancel();
  return { ok: true };
});

// ストリームバッファ: 既定の 64KB では NAS(SMB) や SDカードで往復回数が多く遅い。
// 8MB のチャンクで読むことでシーケンシャル速度に近づける。
const STREAM_HWM = 8 * 1024 * 1024;

ipcMain.handle('ingest:listVolumes', async () => {
  try {
    const entries = await fsp.readdir('/Volumes', { withFileTypes: true });
    const volumes = [];
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const full = path.join('/Volumes', ent.name);
      try {
        const stat = await fsp.stat(full);
        if (!stat.isDirectory()) continue;
        volumes.push({ name: ent.name, path: full });
      } catch (_) {}
    }
    return { ok: true, volumes };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), volumes: [] };
  }
});

ipcMain.handle('ingest:chooseSource', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: '取り込み元フォルダを選択',
    properties: ['openDirectory'],
    defaultPath: '/Volumes',
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});

async function walk(dir, out, root) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, out, root);
    } else if (ent.isFile()) {
      try {
        const stat = await fsp.stat(full);
        out.push({
          path: full,
          relPath: path.relative(root, full),
          size: stat.size,
          mtime: stat.mtimeMs,
          ext: path.extname(full),
          kind: classifyByExt(path.extname(full)),
        });
      } catch (_) {}
    }
  }
}

ipcMain.handle('ingest:scanSource', async (_e, args = {}) => {
  const { sourcePath } = args;
  if (!sourcePath || typeof sourcePath !== 'string') return { ok: false, error: 'invalid sourcePath' };
  const stat = await fsp.stat(sourcePath).catch(() => null);
  if (!stat || !stat.isDirectory()) return { ok: false, error: 'sourcePath is not a directory' };

  const files = [];
  await walk(sourcePath, files, sourcePath);
  const summary = { photo: 0, video: 0, csv: 0, other: 0, totalBytes: 0 };
  for (const f of files) {
    summary[f.kind] = (summary[f.kind] || 0) + 1;
    summary.totalBytes += f.size;
  }
  return { ok: true, files, summary };
});

function buildFolderName(pattern, patient, dateIso) {
  const safe = (v) => sanitize(String(v || '').trim()).replace(/\s+/g, '');
  // フォールバックはローカル日付を使う（toISOString は UTC のため JST の朝9時前は前日になる）
  const now = new Date();
  const localDate = now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0');
  const date = dateIso || localDate;
  return (pattern || '{date}_{id}_{name}_{procedure}')
    .replace('{date}', safe(date))
    .replace('{id}', safe(patient.id))
    .replace('{name}', safe(patient.name))
    .replace('{procedure}', safe(patient.procedure));
}

// 種別フォルダの解決:
//   - 絶対パス (/...) ならそのまま使う
//   - 相対パスなら outputRoot 配下として解決（後方互換）
//   - 空なら outputRoot/{type-default-name} にフォールバック
function resolveTypeFolderRoot(type, cfg) {
  const tf = (cfg.typeFolders || {})[type] || '';
  const defaults = {
    anesthesia: '麻酔記録', surgicalPhoto: '手術写真',
    laparoscope: '腹腔鏡', bronchoscope: '気管支鏡', endoscope: '内視鏡',
  };
  if (tf && tf.startsWith('/')) return tf;
  const root = cfg.outputRoot || '';
  if (tf) return path.join(root, tf);
  return path.join(root, defaults[type] || type);
}

ipcMain.handle('ingest:prepareTarget', async (_e, args = {}) => {
  const cfg = settings.getAll();
  const usedTypes = Array.isArray(args.types) && args.types.length > 0
    ? args.types
    : Object.keys(cfg.typeFolders || {});

  // 使用予定の各種別フォルダの存在チェック
  const missing = [];
  for (const t of usedTypes) {
    const root = resolveTypeFolderRoot(t, cfg);
    if (!root) { missing.push({ type: t, reason: '未設定' }); continue; }
    if (!fs.existsSync(root)) missing.push({ type: t, reason: `見つかりません: ${root}` });
  }
  if (missing.length > 0) {
    return { ok: false, error: '保存先フォルダの確認が必要です: ' + missing.map(m => `${m.type}(${m.reason})`).join(', ') };
  }

  const folderName = buildFolderName(cfg.folderPattern, args.patient || {}, args.date);

  // 各種別フォルダ配下に患者フォルダがすでにあるか確認 → 衝突検出
  const collisions = {};
  for (const t of usedTypes) {
    const root = resolveTypeFolderRoot(t, cfg);
    let target = path.join(root, folderName);
    if (fs.existsSync(target)) {
      if (args.onCollision === 'rename') {
        let n = 2;
        while (fs.existsSync(`${target}_${n}`)) n++;
        target = `${target}_${n}`;
        collisions[t] = { renamed: true, target };
      } else if (args.onCollision === 'abort') {
        return { ok: false, error: '同名フォルダが既に存在します', collision: true, type: t, target };
      } else {
        collisions[t] = { existing: true, target };
      }
    }
  }

  // 患者フォルダを各種別フォルダ配下に作成
  const targets = {};
  for (const t of usedTypes) {
    const root = resolveTypeFolderRoot(t, cfg);
    const target = collisions[t]?.target || path.join(root, folderName);
    try {
      fs.mkdirSync(target, { recursive: true });
      targets[t] = target;
    } catch (e) {
      return { ok: false, error: `${t} の患者フォルダ作成失敗: ${e?.message || e}` };
    }
  }

  return {
    ok: true,
    folderName,
    targets,                // { surgicalPhoto: "/Volumes/NAS/手術写真/2026..." , ... }
    typeFolders: cfg.typeFolders,
    collisions: Object.keys(collisions).length > 0 ? collisions : null,
  };
});

// track=true のとき activeStreams に登録し、ingest:cancel で destroy できるようにする。
// extra.streams で別のストリームセットを指定可（checkDuplicates は専用セットで中断管理する）。
// extra.onBytes(チャンク長) で読み取り進捗を通知できる。
function hashFile(filePath, track = false, extra = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: STREAM_HWM });
    const streamSet = extra.streams || (track ? activeStreams : null);
    if (streamSet) streamSet.add(stream);
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (streamSet) streamSet.delete(stream);
      if (err) reject(err); else resolve(val);
    };
    stream.on('error', (e) => done(e));
    stream.on('data', (chunk) => {
      hash.update(chunk);
      if (extra.onBytes) extra.onBytes(chunk.length);
    });
    stream.on('end', () => done(null, hash.digest('hex')));
    // destroy() では 'end' も 'error' も来ないため、'close' で未完なら中断として reject
    stream.on('close', () => done(new Error('ハッシュ計算が中断されました')));
  });
}

// コピーしながら同時に SHA-256 を計算する（高速化の要）。
// 従来は「①事前ハッシュで src 読み → ②コピーで src 読み → ③削除前リチェックで src 読み」と
// 同じファイルを最大3回読んでいたが、コピー中のインラインハッシュで src 読みを1回にできる。
// resolve 値 = 転送バイト列の SHA-256（＝コピー時点の src の内容のハッシュ）
function copyStreamHashed(src, dst, onBytes = null) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, { highWaterMark: STREAM_HWM });
    const ws = fs.createWriteStream(dst, { highWaterMark: STREAM_HWM });
    const hash = crypto.createHash('sha256');
    activeStreams.add(rs);
    activeStreams.add(ws);
    let finished = false;
    let settled = false;
    const done = (err, sha) => {
      if (settled) return;
      settled = true;
      activeStreams.delete(rs);
      activeStreams.delete(ws);
      if (err) reject(err); else resolve(sha);
    };
    rs.on('data', (chunk) => {
      hash.update(chunk);
      if (onBytes) onBytes(chunk.length);
    });
    // 片側エラー時はもう片側も閉じる（fd リーク防止）
    rs.on('error', (e) => { try { ws.destroy(); } catch (_) {} done(e); });
    ws.on('error', (e) => { try { rs.destroy(); } catch (_) {} done(e); });
    ws.on('finish', () => { finished = true; });
    // 'close' は正常完了でも destroy（中断）でも発火する。
    // finish を経ていない close は「書き切っていない」＝中断/異常として reject する。
    ws.on('close', () => finished ? done(null, hash.digest('hex')) : done(new Error('コピーが完了する前に中断されました')));
    rs.pipe(ws);
  });
}

// 再入ガード: レンダラのリロード等で取り込みが二重起動すると、
// モジュールグローバルの cancelRequested/activeStreams が競合し
// 「中断済みランの復活」「同名 dst の truncate 競合」が起こりうるため、常に単一実行にする
let ingestBusy = false;

ipcMain.handle('ingest:start', async (_e, args = {}) => {
  if (ingestBusy) {
    return { ok: false, error: '別の取り込みが実行中です。完了または中断を待ってください。' };
  }
  // 重複チェックと同時に走らせない。両者は db（サイズ集合キャッシュ・stat 索引）と
  // ハッシュ用ストリーム集合を共有しており、並走すると
  // 「チェック中に記録が増えて結果が食い違う」「キャンセルが相手のストリームまで巻き込む」
  // といった混線が起きる。
  if (checkBusy) {
    return { ok: false, error: '重複チェック実行中です。完了または中断を待ってください。' };
  }
  ingestBusy = true;
  try {
    return await runIngest(args);
  } finally {
    ingestBusy = false;
  }
});

async function runIngest(args) {
  // 中断フラグの初期化は「最初の await より前」に置くこと。
  // 後ろに置くと、await 中（例: db.getKnownSizes の初回走査は NAS への stat を伴い数秒かかる）に
  // 届いたキャンセルをここで消してしまい、UI が「中断中...」のまま
  // 削除を含む取り込みが最後まで走り切る。
  cancelRequested = false;
  // 前回ランの取り残し（中断時に destroy 済みのストリーム等）を捨てる。
  // ingestBusy で単一実行が保証されているので、この時点で生きたストリームは存在しない。
  activeStreams.clear();

  // targets: { surgicalPhoto: "/abs/path/...", anesthesia: "/abs/path/...", ... }
  //   (prepareTarget で計算済の、種別→患者フォルダのフルパス対応表)
  // 後方互換: target (string) と files が来た場合は旧形式
  const { targets, files, patient, useHashDiff } = args;
  if (!targets || typeof targets !== 'object' || !Array.isArray(files)) {
    return { ok: false, error: 'invalid args (targets, files required)' };
  }

  // selected=false を除外しつつ、同一パスの二重指定も除外する。
  // （取り込み元に親フォルダとそのサブフォルダを両方追加すると同じファイルが2回来る。
  //   放置すると二重コピー(_2)や「削除済み src の再コピー失敗」を招く）
  const seenPaths = new Set();
  const planned = files.filter((f) => {
    if (f.selected === false) return false;
    if (typeof f.path !== 'string' || seenPaths.has(f.path)) return false;
    seenPaths.add(f.path);
    return true;
  });
  const totalBytes = planned.reduce((s, f) => s + (f.size || 0), 0);

  // start は最初の await より前に流す（checkDuplicates 側と同じ方針）。
  // 後ろに置くと、db.getKnownSizes の初回走査（旧レコードのコピー先 stat）と
  // 保存先の realpath 解決（NAS 往復）が終わるまで進捗画面が無反応に見える。
  // total / totalBytes は planned から計算済みなので DB を待つ必要がない。
  emitProgress({ type: 'start', total: planned.length, totalBytes });

  // サイズ事前フィルタ（checkDuplicates と同じ理屈のコピー前プレハッシュ版）:
  // 「DB に同サイズの記録なし」かつ「同一バッチ内にも同サイズのファイルなし」なら
  // そのファイルは重複になり得ず、バッチ内調停(inFlightBySha)も不要
  // → コピー前の事前ハッシュ（src 全読み1回分）を丸ごと省略できる。
  // バッチ内に同サイズがある場合は従来どおり事前ハッシュ＋調停に回す（同一内容の
  // ファイルを同時に2つコピーしてしまう事故を防ぐ。同一内容なら必ず同サイズ）。
  // 差分インポートが1件も有効でないバッチでは重複判定自体を行わないので、
  // サイズ集合（初回は全レコード走査＋旧レコードのコピー先 stat を伴う）は作らない。
  const diffNeeded = planned.some((f) => (f.useHashDiff !== undefined ? f.useHashDiff : useHashDiff));
  const knownSizes = diffNeeded ? await db.getKnownSizes() : null;
  const batchSizeCount = new Map();
  for (const f of planned) {
    if (typeof f.size === 'number') {
      batchSizeCount.set(f.size, (batchSizeCount.get(f.size) || 0) + 1);
    }
  }

  let doneBytes = 0;
  let copied = 0;
  let skippedDup = 0;
  let failed = 0;
  let deleted = 0;       // 種別 deleteAfterCopy=true で削除された元ファイル数
  const failures = [];   // 実失敗（failed カウント対象）
  const warnings = [];   // 警告（削除見送り等。コピー自体は成功しているもの）
  const dicomCandidates = [];

  // 削除設定を取得（種別ごと）
  const cfg = settings.getAll();
  const deleteAfterCopy = cfg.deleteAfterCopy || {};
  // コピー後の読み戻し照合を行うか（既定 true）。
  // OFF 設定でも「コピー後に元ファイルを削除する種別」では必ず照合する
  // （src が残らないため、読み戻し照合が破損検出の最終防衛線になる）。
  const verifySetting = cfg.verifyAfterCopy !== false;

  // コピー先の実パス一覧（削除ガードと空フォルダ後片付けの両方で使う）:
  // 今回の targets / outputRoot / 全種別の保存先ルート（絶対パス設定を含む）
  const typeRootPaths = Object.keys(cfg.typeFolders || {}).map((t) => resolveTypeFolderRoot(t, cfg));
  const destReals = [];
  for (const p of [...Object.values(targets || {}), cfg.outputRoot, ...typeRootPaths].filter(Boolean)) {
    const rp = await realOrNull(p);
    if (rp) destReals.push(rp);
  }
  // src がコピー先（NAS 等の保存領域）の中にある場合は true。
  // 「過去の取り込み先を取り込み元に選んだ」ケースで元データを削除しないための安全判定。
  const isUnderDestRoots = (realPath) => !!realPath && destReals.some((d) => isWithin(d, realPath));

  // 削除に成功した src の親フォルダ（空フォルダ後片付けの対象を「実際に削除が起きた場所」に限定する）
  const deletedParents = new Set();

  // ==== 並列コピー（高速化）====
  // - CONCURRENCY 本のワーカーがファイルキューを消化（大量の小ファイルで SMB/SD の往復待ちを隠蔽）
  // - dst のファイル名割当は reservedDst で同期的に予約し、同名衝突のレースを防ぐ
  // - 同一内容（同じ sha）のファイルがバッチ内に複数ある場合は inFlightBySha で調停し、
  //   最初の1つだけがコピー、残りはその完了を待って重複スキップ扱いにする
  const CONCURRENCY = 3;
  const reservedDst = new Set();
  const inFlightBySha = new Map(); // sha -> Promise<{ok:boolean}>

  // ファイル内バイト進捗: 大容量動画1本のコピー/照合に数分かかっても進捗バーが
  // 止まって見えないよう、250ms スロットルで file-progress を通知する。
  // inFlightBytes は「まだ doneBytes に繰り入れていない、進行中コピーの転送済みバイト」。
  const inFlightBytes = new Map(); // index -> bytes
  let lastByteEmit = 0;
  function emitByteProgress(i, f, phase, phaseBytes) {
    const now = Date.now();
    if (now - lastByteEmit < 250) return;
    lastByteEmit = now;
    let inFlight = 0;
    for (const v of inFlightBytes.values()) inFlight += v;
    emitProgress({
      type: 'file-progress',
      index: i,
      name: path.basename(f.path),
      phase,                       // 'copy' | 'verify'
      phaseBytes,                  // その処理フェーズで読み/書きしたバイト数
      fileSize: f.size || 0,
      bytes: Math.min(doneBytes + inFlight, totalBytes),
      totalBytes,
    });
  }

  // 削除を見送るときの警告（コピー/スキップ自体は成功しているので「失敗」にはしない）
  function warnSkipDelete(f, i, msg) {
    warnings.push({ file: f.path, error: msg });
    emitProgress({ type: 'file-warn', index: i, name: path.basename(f.path), error: msg });
  }

  // 元ファイル削除の共通シーケンス。
  // このアプリで最も危険な操作なので、重複スキップ経路（handleDupSkip）と
  // コピー完了経路（processFile ステップ5）で実装を分けず、必ずここを通す。
  // 呼び出し側は事前に各経路のガード（ハッシュ照合・stat 照合・保存領域チェック等）を
  // 通し終えていること。例外はそのまま投げ、経路ごとの文言で警告にするのは呼び出し側の責任。
  // 戻り値: 実際に削除したか（中断要求中は何もせず false）。
  function deleteSrc(f, i) {
    if (cancelRequested) return false;
    db.flush(); // 削除前に取り込み記録をディスクへ確定（クラッシュしても記録が残る）
    fs.unlinkSync(f.path);
    // 消したパスの台帳エントリは捨てる（同じパスに現れる別ファイルへ流用しないため）
    checkLedger.delete(f.path);
    deleted++;
    deletedParents.add(path.dirname(f.path));
    emitProgress({ type: 'file-deleted', index: i, name: path.basename(f.path), src: f.path });
    return true;
  }

  // 重複スキップ時の処理。deleteAfterCopy の種別では、以下の全条件を満たした場合のみ元ファイルを削除する:
  //   1. 既存コピーが「取り込み元自身」でない（realpath / dev+ino 照合。アーカイブ再取り込みでの自己削除防止）
  //   2. src がコピー先（NAS 等の保存領域）の中にない（保存領域内のデータは決して削除しない）
  //   3. 既存コピーが同じ患者・同じ種別として記録されている（別患者の保存分を根拠に削除しない）
  //   4. 既存コピーが実在し、読み戻したハッシュが一致する
  //   5. src が事前チェック以降変更されていない（stat 照合）
  // pinnedStat: ガード5の照合元 { size, mtimeMs }。呼び出し側（processFile）が
  //   「main 自身が取得した値」だけを詰めて渡す（台帳から sha を採ったならその台帳エントリの
  //   値、それ以外なら main が取り込み開始時に stat した値）。削除可否の照合元を
  //   main の観測に閉じるため（レンダラ申告の f.size / f.mtime で削除判断が変わらない、という
  //   台帳の信頼モデルをガード5でも一貫させる）。stat 自体が取れなかった場合だけ null で、
  //   その時は従来どおり f.size / f.mtime を使う（statMatches は欠損に fail-closed）。
  async function handleDupSkip(f, i, sha, pinnedStat = null) {
    skippedDup++;
    inFlightBytes.delete(i); // 進行中バイトを doneBytes へ繰り入れ（二重計上防止）
    doneBytes += f.size || 0;
    emitProgress({ type: 'file-skip', index: i, reason: 'duplicate', name: path.basename(f.path), bytes: doneBytes, totalBytes });

    if (!(f.type && deleteAfterCopy[f.type] === true)) return;
    if (cancelRequested) return;
    try {
      const rec = db.getByHash(sha);
      if (!rec || !rec.dstPath || !fs.existsSync(rec.dstPath)) {
        warnSkipDelete(f, i, '重複判定だが既存コピーが見つからず削除せず');
        return;
      }

      // --- ガード1: 自己参照（既存コピー＝取り込み元自身）なら絶対に削除しない ---
      const srcReal = await realOrNull(f.path);
      const recReal = await realOrNull(rec.dstPath);
      if (!srcReal || !recReal || srcReal === recReal) {
        warnSkipDelete(f, i, '既存コピーが取り込み元自身のため削除せず');
        return;
      }
      try {
        const s1 = fs.statSync(srcReal);
        const s2 = fs.statSync(recReal);
        if (s1.dev === s2.dev && s1.ino === s2.ino) {
          warnSkipDelete(f, i, '既存コピーと取り込み元が同一実体のため削除せず');
          return;
        }
      } catch (_) {
        warnSkipDelete(f, i, '同一性確認に失敗したため削除せず');
        return;
      }

      // --- ガード2: src がコピー先（保存領域）内なら削除しない ---
      if (isUnderDestRoots(srcReal)) {
        warnSkipDelete(f, i, '取り込み元が保存先フォルダ内のため削除せず');
        return;
      }

      // --- ガード3: 既存コピーの患者・種別が今回と一致する場合のみ削除 ---
      const samePatient = (rec.patientId ?? null) === (patient?.id ?? null);
      const sameKind = (rec.kind ?? null) === (f.type ?? null);
      if (!samePatient || !sameKind) {
        warnSkipDelete(f, i, `同一内容が別の患者/種別（${rec.patientId || '不明'}/${rec.kind || '不明'}）として取り込み済みのため削除せず`);
        return;
      }

      // --- ガード4: 既存コピーを読み戻したハッシュが一致すること（毎回・全量） ---
      // ここだけは stat（サイズ）照合に置き換えない。取り込み記録は何ヶ月も生き続けるので、
      // 「取り込み時に読み戻し照合した」事実は削除する今この瞬間の保証にならない。
      // サイズ照合では、同サイズ別内容への上書き・シンボリックリンクへの差し替え・
      // アプリ外からの編集を検出できない。元データを消す直前に限り、NAS 上の現物が
      // 本当にこの内容であることを毎回証明してから消す。
      const existingSha = await hashFile(rec.dstPath, true);
      if (existingSha !== sha) {
        warnSkipDelete(f, i, '重複判定だが既存コピーのハッシュ不一致のため削除せず');
        return;
      }

      // --- ガード5: sha はスキャン直後の事前チェックで計算した値のことがあるため、
      //             その後 src が変更されていないかを stat（サイズ+更新時刻）で確認 ---
      // 非同期版で stat する（SD/NAS の stat は1件あたり数十ms かかることがあり、同期版だと
      // 数千ファイルの取り込みでメインプロセスが刻まれる）。
      // この stat 取得から deleteSrc の unlink までの間に await を挟まないこと
      // （挟むと「照合後・削除前」の変更を取りこぼす）。
      const st = await fsp.stat(f.path);
      const ref = pinnedStat ? { size: pinnedStat.size, mtime: pinnedStat.mtimeMs } : f;
      if (!statMatches(st, ref)) {
        warnSkipDelete(f, i, '重複判定後にファイル変更の形跡があるため削除せず');
        return;
      }

      deleteSrc(f, i);
    } catch (e) {
      if (!cancelRequested) warnSkipDelete(f, i, '重複元の削除失敗: ' + (e?.message || e));
    }
  }

  // dst パスの割当（同期処理で予約するため並列でも衝突しない）
  function allocateDst(typeDir, srcPath) {
    const ext = path.extname(srcPath);
    const base = path.basename(srcPath, ext);
    let dstName = `${base}${ext}`;
    let dst = path.join(typeDir, dstName);
    let n = 2;
    while (reservedDst.has(dst) || fs.existsSync(dst)) {
      dstName = `${base}_${n}${ext}`;
      dst = path.join(typeDir, dstName);
      n++;
    }
    reservedDst.add(dst);
    return { dst, dstName };
  }

  async function processFile(f, i) {
    emitProgress({
      type: 'file-start',
      index: i,
      total: planned.length,
      name: path.basename(f.path),
      bytes: doneBytes,
      totalBytes,
    });

    // ファイル個別 useHashDiff があればそれを尊重、なければ呼び出し時の useHashDiff にフォールバック
    const diffEnabled = (f.useHashDiff !== undefined) ? f.useHashDiff : useHashDiff;

    try {
      // --- 1) 重複判定用ハッシュの解決 ---
      // プレビュー前の事前チェック(checkDuplicates)で計算済みの sha があれば再利用し、
      // src の読み直しを丸ごと省く（高速化）。
      // 参照するのは main 側の台帳 checkLedger のみ。レンダラ由来の f.sha256 は
      // 「main が中身を読んだ」ことを保証できないため、値のヒントとしてしか使わない
      // （＝必ず未 verified 扱い。削除が絡む場面では下の重複判定ループが全量ハッシュで裏を取る）。
      // いずれの経路も stat（サイズ+更新時刻、台帳経路はさらに dev+ino）で
      // src が変わっていないことを確認してから採用する。
      // knownShaVerified: knownSha が「src の中身を実際に読んで得た値」か。
      // 事前チェックの stat 逆引き経路は中身を読んでいない推定なので false で届く。
      // 元ファイルを削除する判断にはこのフラグが true の sha しか使わない（下の重複判定ループ）。
      let knownSha = null;
      let knownShaVerified = false;
      // 削除可否の照合元 stat（handleDupSkip のガード5へ引き渡す）。
      // sha をどの経路で採用したかに関わらず、main が自分で取得した値だけを使う
      // （レンダラ申告の f.size / f.mtime を削除判断の根拠から排除する）。
      let pinnedStat = null;
      if (diffEnabled) {
        let preSha = null;
        let preVerified = false;
        let sizeRuledOut = false; // サイズ事前フィルタで「重複になり得ない」と確定したか
        let st = null;
        // 数千ファイルの取り込みでメインプロセスを同期ブロックしないよう非同期版で stat する
        // （チェック側も移行済み）。
        try { st = await fsp.stat(f.path); } catch (_) { /* stat 不能 → 再ハッシュへ */ }
        // 台帳の参照は上の await より後に置くこと（await 中に ejectVolume が台帳を
        // 破棄しうる。破棄後の Map を読めば「台帳なし＝再ハッシュ」に倒れる＝安全側）。
        const led = st ? checkLedger.get(f.path) : null;
        // 既定の照合元は「main が今 stat した値」。台帳経路ではこの後さらに
        // 台帳の値（チェック時に main が記録した stat）へ差し替える。
        // st が取れなかったときだけ null のままにし、handleDupSkip 側の従来フォールバック
        // （f との照合。statMatches は欠損に対して fail-closed＝削除しない）に委ねる。
        if (st) pinnedStat = { size: st.size, mtimeMs: st.mtimeMs };
        if (led && ledgerMatches(st, led)) {
          preSha = led.sha;
          preVerified = led.verified === true; // main 自身が全量ハッシュで得た値のときだけ true
          // 削除可否の照合は main が記録した値だけで完結させる（レンダラ申告に依存しない）
          pinnedStat = { size: led.size, mtimeMs: led.mtimeMs };
        } else if (isSha256(f.sha256)) {
          if (st && statMatches(st, f)) {
            preSha = f.sha256.toLowerCase();
            preVerified = false; // レンダラ由来の値は素性を保証できないので常に未 verified
          }
        } else if (st && knownSizes) {
          // 実サイズ＝スキャン時サイズ（変更の形跡なし）で、DB にもバッチ内にも
          // 同サイズが存在しない場合のみ事前ハッシュを省略（バッチ内カウントは自分を含むため <=1）
          sizeRuledOut = st.size === f.size
            && !knownSizes.has(st.size)
            && (batchSizeCount.get(f.size) || 0) <= 1;
        }
        if (!sizeRuledOut) {
          if (preSha) {
            knownSha = preSha;
            knownShaVerified = preVerified;
          } else {
            knownSha = await hashFile(f.path, true);
            knownShaVerified = true; // 自分で全読みした値なので内容由来であることが確実
          }
        }
      }
      if (knownSha) {
        // --- 2) 重複判定 + 同一バッチ内の調停（担当が決まるまでループ） ---
        // 先行ファイル（同一 sha）の完了を待ったあとは、claim の結果値を信用せず
        // 必ず db.hasHash で再判定する。担当が実際に記録できたときだけ重複扱いになるので、
        // 「担当が別 sha を記録した／失敗した」ケースでも取りこぼしが起きない。
        for (;;) {
          if (cancelRequested) return;
          if (db.hasHash(knownSha)) {
            // スキップ（＝コピーしない）や元ファイル削除の根拠になる sha は
            // 「src の中身を実際に読んで得た値」でなければならない。
            // 事前チェックの stat 逆引き（名前+サイズ+更新時刻）は内容未読の推定で、
            // 未 verified のままここに来るのは、推定で「既取込」となったファイルを
            // ユーザーがプレビューで明示的に再選択したときだけ（既取込は既定で選択解除）。
            // 頻度が低く正確さが最優先の場面なので、必ず全量ハッシュで裏を取る。
            if (!knownShaVerified) {
              // 大容量動画1本だと数分かかるため、コピー後の読み戻し照合と同じ形式で
              // バイト進捗を流す（進捗バーが無音で止まって見えるのを防ぐ）
              let recheckBytes = 0;
              const realSha = await hashFile(f.path, true, {
                onBytes: (n) => {
                  recheckBytes += n;
                  emitByteProgress(i, f, 'verify', recheckBytes);
                },
              });
              knownShaVerified = true;
              if (realSha !== knownSha) {
                // 推定が外れていた（同名・同サイズ・同更新時刻で中身だけ違うファイル）。
                // 実測値に差し替えてループ先頭から判定し直す
                // → DB に無ければ通常コピーへ自己回復し、元ファイルは削除されない。
                knownSha = realSha;
                continue;
              }
            }
            // 台帳由来の sha なら、ガード5の照合元も台帳の stat に揃える（H4）
            await handleDupSkip(f, i, knownSha, pinnedStat);
            return;
          }
          const prior = inFlightBySha.get(knownSha);
          if (!prior) break; // 誰も担当していない → 自分がコピー担当になる
          await prior;       // 先行する同一内容ファイルの完了を待つ → ループ先頭で DB を再判定
          if (inFlightBySha.get(knownSha) === prior) inFlightBySha.delete(knownSha);
        }
      }

      // このファイルがこの sha のコピー担当であることを宣言（ここまで同期区間なのでレース無し）
      let resolveClaim = null;
      if (diffEnabled && knownSha) {
        inFlightBySha.set(knownSha, new Promise((r) => { resolveClaim = r; }));
      }

      try {
        if (cancelRequested) return;

        // f.type は 5種別(anesthesia/surgicalPhoto/laparoscope/bronchoscope/endoscope)
        const typeDir = targets[f.type];
        if (!typeDir) {
          failed++;
          doneBytes += f.size || 0; // 進捗バーを停滞させない
          failures.push({ file: f.path, error: `種別 ${f.type} の保存先が未指定` });
          emitProgress({ type: 'file-fail', index: i, name: path.basename(f.path), error: '保存先未指定', bytes: doneBytes, totalBytes });
          return;
        }
        const { dst, dstName } = allocateDst(typeDir, f.path);
        fs.mkdirSync(path.dirname(dst), { recursive: true });

        // 削除前検証用に、コピー開始時点の src の stat を記録（非同期版。同期 stat は
        // SD/NAS 相手だと1件あたり数十ms メインプロセスを止めるため）。
        // ここは「記録直前ガード〜recordFile」の同期区間の外なので await を挟んでよい。
        const preStat = await fsp.stat(f.path);

        // --- 3) コピー＋インラインハッシュ（src の読み取りはこの1回だけ） ---
        // copiedBytes: 実際に転送した（＝srcSha を計算した）バイト数。
        // db に記録する size はこの値を使う。dst を stat し直すと NAS への往復が
        // 1ファイルにつき1回増えるうえ、値の意味も「保存された実バイト数」ではなくなる。
        let copiedBytes = 0;
        let srcSha;
        try {
          srcSha = await copyStreamHashed(f.path, dst, (n) => {
            copiedBytes += n;
            inFlightBytes.set(i, (inFlightBytes.get(i) || 0) + n);
            emitByteProgress(i, f, 'copy', inFlightBytes.get(i));
          });
        } catch (copyErr) {
          // コピー途中の中断/失敗: 書きかけの dst をこの場で削除してから上位 catch へ。
          // （dst はここで確実に特定できる。e.path からの推測は読み込み側エラー時に
          //   src を指してしまい元ファイルを消す危険があるため使わない）
          try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (_) {}
          throw copyErr;
        }

        // 書き込みを物理ストレージへ確定（fsync）。これが無いと直後の読み戻しが
        // OS のローカルキャッシュから返ってしまい、照合の実効性が下がる
        // （SMB では fsync がサーバ側へのフラッシュを強制する）。
        try {
          const fh = await fsp.open(dst, 'r+');
          try { await fh.sync(); } finally { await fh.close(); }
        } catch (_) { /* fsync 非対応の FS では何もしない（従来と同等の保証水準） */ }

        // 事前チェック時のハッシュと不一致 → 事前 stat 検証をすり抜けた変更（極めて稀）。
        // コピーで実際に読んだ内容(srcSha)を真として重複判定をやり直す。
        // 待機側は claim 解決後に必ず db.hasHash(knownSha) を再判定するため、
        // ここで別 sha を記録しても「未コピーのままスキップ」される取りこぼしは起きない。
        if (knownSha && srcSha !== knownSha) {
          warnSkipDelete(f, i, '事前チェック時からファイルが変更されていたため再判定');
          if (db.hasHash(srcSha)) {
            try { fs.unlinkSync(dst); } catch (_) {}
            // 照合元はコピー直前に main が取った preStat（レンダラ申告の f には依存しない）
            await handleDupSkip(f, i, srcSha, { size: preStat.size, mtimeMs: preStat.mtimeMs });
            return;
          }
        }

        // サイズ事前フィルタでプレハッシュを省略したファイルの保険:
        // コピーで得た srcSha で重複を最終判定する（フィルタ条件が正しければ到達しないが、
        // チェックと取り込みの間にファイル内容が変わった等の万一でも二重登録を防ぐ）
        if (diffEnabled && !knownSha && db.hasHash(srcSha)) {
          try { fs.unlinkSync(dst); } catch (_) {}
          await handleDupSkip(f, i, srcSha, { size: preStat.size, mtimeMs: preStat.mtimeMs });
          return;
        }

        // --- 4) 書き込み後リチェック（dst を読み戻して照合） ---
        // 設定 verifyAfterCopy=false でも、元ファイルを削除する種別では必ず実施する。
        // 例外（中断・I/Oエラー）時も未検証の dst を残さない（DB 未記録の孤児ファイル防止）
        const mustVerify = verifySetting || (f.type && deleteAfterCopy[f.type] === true);
        if (mustVerify) {
          let verifiedBytes = 0;
          let dstSha;
          try {
            dstSha = await hashFile(dst, true, {
              onBytes: (n) => {
                verifiedBytes += n;
                emitByteProgress(i, f, 'verify', verifiedBytes);
              },
            });
          } catch (e) {
            try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (_) {}
            throw e;
          }
          if (dstSha !== srcSha) {
            try { fs.unlinkSync(dst); } catch (_) {}
            failed++;
            inFlightBytes.delete(i);
            doneBytes += f.size || 0;
            failures.push({ file: f.path, error: 'コピー後リチェック失敗（ハッシュ不一致）' });
            emitProgress({ type: 'file-fail', index: i, name: path.basename(f.path), error: 'コピー後リチェック失敗', bytes: doneBytes, totalBytes });
            return;
          }
        }

        if (diffEnabled) {
          // 記録する size は「実際に転送したバイト数」。コピー中に src が伸びた場合も
          // 縮んだ（stat と copy の間に truncate された）場合も、保存された実バイト数は
          // copiedBytes の方であり、preStat.size は dst の実体と食い違う。
          // 食い違ったまま記録すると、後続の重複チェックが実在しないサイズで逆引き・
          // フィルタすることになる。コピー成功時は copiedBytes を無条件で採用する
          // （0 も「0 バイト転送した」という真値。preStat.size へのフォールバックは
          //   copiedBytes が数値でない＝計上が壊れた場合の保険にとどめる）。
          // コピー側が数え終えている値をそのまま使うので、dst の stat（NAS 往復）は不要。
          const recordedSize = Number.isFinite(copiedBytes) ? copiedBytes : preStat.size;

          // 記録直前の最終重複ガード（この判定と recordFile の間に await を挟まないこと）。
          // 自分がコピー・検証している間に、サイズ事前フィルタで調停(inFlightBySha)を
          // 通らなかった別ファイルが同一内容を先に記録した場合ここで検出し、二重登録を防ぐ。
          if (db.hasHash(srcSha)) {
            try { fs.unlinkSync(dst); } catch (_) {}
            await handleDupSkip(f, i, srcSha, { size: preStat.size, mtimeMs: preStat.mtimeMs });
            return;
          }
          db.recordFile({
            sha256: srcSha,
            srcPath: f.path,
            dstPath: dst,
            size: recordedSize,
            mtime: Math.floor(preStat.mtimeMs),
            patientId: patient?.id,
            kind: f.type || f.kind,
          });
        }

        copied++;
        inFlightBytes.delete(i); // 進行中バイトを doneBytes へ繰り入れ
        doneBytes += f.size || 0;

        // DICOM 送信対象: 種別が surgicalPhoto なら自動的に候補入り
        // ファイル拡張子が画像系であることも軽くチェック
        if (f.type === 'surgicalPhoto') {
          const ext = path.extname(f.path).toLowerCase();
          if (['.jpg','.jpeg','.png','.heic','.heif','.bmp'].includes(ext)) {
            dicomCandidates.push({ path: dst, name: dstName });
          }
        }

        emitProgress({
          type: 'file-done',
          index: i,
          name: path.basename(f.path),
          dst,
          bytes: doneBytes,
          totalBytes,
        });

        // --- 5) 種別が deleteAfterCopy なら削除前検証をして src を削除 ---
        // 検証チェーン:
        //   コピー中インラインハッシュ === 書き込み後 dst ハッシュ（上で照合済み）
        //   + コピー開始時と現在の src stat（サイズ・更新時刻）が不変
        //   + src がコピー先（保存領域）内でない（保存済みデータは決して削除しない）
        // 従来の「src をもう一度フル読みして再ハッシュ」を stat 照合に置き換えて高速化。
        // コピー後に src が書き換えられた場合は stat が変わるため検出できる。
        if (f.type && deleteAfterCopy[f.type] === true && !cancelRequested) {
          try {
            const srcReal = await realOrNull(f.path);
            if (isUnderDestRoots(srcReal)) {
              warnSkipDelete(f, i, '取り込み元が保存先フォルダ内のため削除せず');
            } else {
              // preStat は必ず fsp.stat 由来（コピー開始直前に取得）なので
              // statMatches の fail-closed 判定で誤って削除見送りになることはない。
              // 現在値も非同期版で取る（同期 stat でメインプロセスを止めないため）。
              // この stat から deleteSrc の unlink までは await を挟まない
              // （挟むと「照合後・削除前」の変更を取りこぼす）。
              const nowStat = await fsp.stat(f.path);
              if (statMatches(nowStat, { size: preStat.size, mtime: preStat.mtimeMs })) {
                deleteSrc(f, i);
              } else {
                warnSkipDelete(f, i, '削除前検証失敗（コピー後に src が変更された形跡があるため削除せず）');
              }
            }
          } catch (e) {
            if (!cancelRequested) {
              warnSkipDelete(f, i, '削除失敗: ' + (e?.message || e));
            }
          }
        }
      } finally {
        // 同一 sha を待っている後続ファイルを解放（早期 return・例外でも必ず解決）。
        // 結果値は渡さない — 待機側は db.hasHash で真実を再判定する。
        if (resolveClaim) resolveClaim();
      }
    } catch (e) {
      // 中断要求由来のエラー（ストリーム destroy 等）は失敗にカウントしない。
      // 書きかけ/未検証の dst は各箇所で削除済みなので、ここでは何も消さない。
      // （この catch に来るのは copied++ より前のエラーのみなので bytes 加算は二重にならない）
      if (!cancelRequested) {
        failed++;
        inFlightBytes.delete(i);
        doneBytes += f.size || 0;
        failures.push({ file: f.path, error: String(e?.message || e) });
        emitProgress({ type: 'file-fail', index: i, name: path.basename(f.path), error: String(e?.message || e), bytes: doneBytes, totalBytes });
      }
    } finally {
      inFlightBytes.delete(i); // 全経路の取りこぼし防止（中断時など）
    }
  }

  // ワーカープール実行
  let nextIdx = 0;
  async function worker() {
    while (!cancelRequested) {
      const i = nextIdx++;
      if (i >= planned.length) return;
      await processFile(planned[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(planned.length, 1)) }, () => worker()));

  // デバウンスされた履歴DBの書き込みを確定
  db.flush();

  const cancelled = cancelRequested;

  // === 空になったソースフォルダの後片付け ===
  // 「今回の取り込みで実際に元ファイルを削除した場所（deletedParents）」から上方向にのみ、
  // 空になったフォルダ（.DS_Store 等のメタファイルのみ含む）を症例フォルダごと削除する。
  // 取り込みと無関係な既存の空フォルダには触れない。
  // 安全原則:
  //   - 中断時は一切実行しない
  //   - /Volumes 直下のマウント元は保護
  //   - コピー先（targets / outputRoot / 全種別ルート）と重なるソースは対象外
  //   - 各ルートは実パス(realpath)を境界にして、その外はシンボリックリンク経由でも削除しない
  let removedDirs = 0;
  if (!cancelled && deletedParents.size > 0) {
    const cleanupRoots = new Set();
    for (const f of planned) {
      if (f.type && deleteAfterCopy[f.type] === true && f.sourcePath) {
        cleanupRoots.add(f.sourcePath);
      }
    }
    for (const root of cleanupRoots) {
      const realRoot = await realOrNull(root);
      if (!realRoot) continue;                          // 存在しない/解決不可なら触らない
      if (isProtectedDir(realRoot)) continue;           // マウント元・浅すぎるパスは保護
      // ソースがコピー先を含む/含まれる場合は、取り違え防止で丸ごと対象外
      if (destReals.some((d) => isWithin(realRoot, d) || isWithin(d, realRoot))) continue;
      // このルート配下で削除が起きた親フォルダを深い順に処理し、空なら root まで登りながら削除。
      // （共有の祖先は複数チェーンから再試行されうるが、readdir 1回のコストなので許容）
      const parents = [...deletedParents]
        .filter((p) => isWithin(root, p))
        .sort((a, b) => b.length - a.length);
      for (const parent of parents) {
        let cur = parent;
        while (isWithin(root, cur)) {
          let removed = false;
          try { removed = await removeDirIfEmptyMeta(cur, realRoot); } catch (_) {}
          if (!removed) break;
          removedDirs++;
          if (path.resolve(cur) === path.resolve(root)) break; // ルート自身も空なら削除して終了
          cur = path.dirname(cur);
        }
      }
    }
  }
  if (removedDirs > 0) {
    emitProgress({ type: 'dirs-cleaned', removedDirs });
  }

  emitProgress({ type: 'done', copied, skippedDup, failed, deleted, removedDirs, cancelled });

  // 履歴に記録（1ファイル以上コピーまたはスキップで再取込が起きた場合、中断時も記録）
  if ((copied > 0 || skippedDup > 0) && args.folderName) {
    history.recordSession({
      folderName: args.folderName,
      patient: patient || {},
      targets,
      filesAdded: copied,
    });
  }

  return {
    ok: failed === 0 && !cancelled,
    cancelled,
    copied,
    skippedDup,
    failed,
    deleted,
    removedDirs,
    failures,   // 実失敗（failed カウント対象）
    warnings,   // 警告（削除見送り等。コピー自体は成功）
    dicomCandidates,
    targets,
  };
}

// プレビュー前の重複チェック: 履歴DBと照合し、必要なファイルだけ並行ハッシュ計算する
// 結果: [{ path, sha256, alreadyImported, hashed }] を返す
//   hashed = その sha256 を「ファイルの中身を実際に読んで」得たか（stat 由来の推定なら false）。
//   結果は main 側の checkLedger にも記録され、取り込み時の削除判断はそちらだけを根拠にする。
//   レンダラが持ち回る f.sha256Verified は表示・後方互換のための参考情報にすぎない。
// 進捗は ingest:checkProgress イベントで通知
// 再入ガード: レンダラのリロード・画面往復で二重起動すると進捗イベントが混線し
// SD への読み込みも倍になるため、常に単一実行にする
let checkBusy = false;
let checkCancelRequested = false;
const checkStreams = new Set();

// 重複チェックの中断（UI のキャンセルボタンから）。進行中のハッシュ計算を止める
ipcMain.handle('ingest:cancelCheck', async () => {
  checkCancelRequested = true;
  for (const s of checkStreams) {
    try { s.destroy(); } catch (_) {}
  }
  return { ok: true };
});

ipcMain.handle('ingest:checkDuplicates', async (_e, args = {}) => {
  const rawFiles = Array.isArray(args.files) ? args.files : [];
  if (rawFiles.length === 0) return { ok: true, results: [] };
  if (checkBusy) return { ok: false, busy: true, error: '重複チェックが既に実行中です' };
  // 取り込み中はチェックしない（ingest:start 側と対の相互ガード）。
  // 取り込み中は記録が増え続けるので、チェック結果がその場で陳腐化する。
  if (ingestBusy) return { ok: false, busy: true, error: '取り込み実行中です。完了または中断を待ってください。' };

  // ハンドラ境界で要素を検証する。レンダラ由来の配列に null や path 欠落が混ざると
  // ワーカー内の f 参照で TypeError になり、チェック全体が不明なエラーで落ちる
  // （1件の不正で数千件のチェック結果が失われる）。
  // 不正な要素はワーカーに渡さず、その位置にエラー行を置く。
  // レンダラは結果を添字でファイルに突き合わせるため、要素数と順序は必ず保つこと。
  const valid = [];
  const validIdx = [];
  const results = new Array(rawFiles.length);
  for (let i = 0; i < rawFiles.length; i++) {
    const f = rawFiles[i];
    if (f && typeof f.path === 'string') {
      validIdx.push(i);
      valid.push(f);
    } else {
      results[i] = { path: null, sha256: null, alreadyImported: false, hashed: false, error: 'invalid entry' };
    }
  }
  if (valid.length === 0) return { ok: true, results, duplicateCount: 0 };

  checkBusy = true;
  checkCancelRequested = false;
  let r;
  try {
    r = await runCheckDuplicates(valid);
  } finally {
    checkBusy = false;
  }
  // 中断時は results を返さない契約なのでそのまま素通し
  if (!r || r.cancelled || !Array.isArray(r.results)) return r;
  for (let k = 0; k < validIdx.length; k++) results[validIdx[k]] = r.results[k];
  return { ...r, results };
});

const SPOT_BYTES = 64 * 1024; // 端点スポットチェックで読むバイト数（先頭・末尾それぞれ）

// fh から offset..offset+len を必ず len バイト読む。短い読み取り(EOF)なら null。
async function readExactAt(fh, offset, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, offset + got);
    if (bytesRead === 0) return null; // 期待より短い＝別物
    got += bytesRead;
  }
  return buf;
}

// 経路1（stat 逆引き）の裏取り: src と既存コピー(dst)の先頭64KB+末尾64KB+内部7点(各64KB)を直接バイト比較する。
// 名前+サイズ+更新時刻だけの推定で「取り込まない」を決めない、という原則のため。
// 固定サイズ分割された動画（4GiB ちょうどのファイルが並ぶ）× カメラの連番リセットによる
// 同名再出現 × 内蔵時計の狂いで同一 mtime、という複合は現実に起こり得る組み合わせで、
// そのとき推定ヒットは「別内容のファイルを既取込として画面から消す」ことになる。
// ハッシュ全読みは高速化の目的を潰すので、現物同士の端点だけを突き合わせて裏を取る。
// 一致しない・読めない（NAS 未マウント等）場合は false を返し、呼び出し側は
// 経路3の全量ハッシュへ落として自己回復する。
async function spotCheckMatches(srcPath, dstPath, size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return false;
  let srcFh = null;
  let dstFh = null;
  try {
    srcFh = await fsp.open(srcPath, 'r');
    dstFh = await fsp.open(dstPath, 'r');
    const dstStat = await dstFh.stat();
    if (dstStat.size !== size) return false; // 記録の相手が別物になっている
    if (size === 0) return true;
    // 128KB 以下なら分割せず全体を1回で読んで比較する（端点が重なるだけなので）。
    // それより大きい場合は先頭・末尾に加えて内部を等間隔（1/8〜7/8）で7点サンプルする。
    // コンテナのヘッダ/末尾（moov/mdat 境界など）が同一で映像本体だけ異なるファイルを
    // 端点だけで「一致」としないため。読み取り量は最大 9×64KB≒576KB で高速化の目的は損なわない。
    const ranges = [];
    if (size <= SPOT_BYTES * 2) {
      ranges.push([0, size]);
    } else {
      ranges.push([0, SPOT_BYTES]);
      const seen = new Set([0, size - SPOT_BYTES]);
      for (let k = 1; k <= 7; k++) {
        const off = Math.floor((size * k) / 8) - Math.floor(SPOT_BYTES / 2);
        if (off < SPOT_BYTES || off + SPOT_BYTES > size - SPOT_BYTES) continue; // 端点と重なる分は不要
        if (seen.has(off)) continue;
        seen.add(off);
        ranges.push([off, SPOT_BYTES]);
      }
      ranges.push([size - SPOT_BYTES, SPOT_BYTES]);
    }
    for (const [offset, len] of ranges) {
      if (checkCancelRequested) return false; // 中断要求中は採用しない（安全側）
      const a = await readExactAt(srcFh, offset, len);
      const b = await readExactAt(dstFh, offset, len);
      if (!a || !b || !a.equals(b)) return false;
    }
    return true;
  } catch (_) {
    return false; // open/read 失敗（未マウント・権限なし等）は不採用
  } finally {
    if (srcFh) { try { await srcFh.close(); } catch (_) {} }
    if (dstFh) { try { await dstFh.close(); } catch (_) {} }
  }
}

async function runCheckDuplicates(files) {
  const total = files.length;
  let done = 0;
  const results = new Array(total);
  const CONCURRENCY = 4; // I/Oバウンドなので4並列くらいが妥当
  let nextIdx = 0;

  // 破棄済みウィンドウへの send で落ちないよう共通ヘルパ経由（emitProgress と同じ理由）
  const emit = (payload) => sendToWindows('ingest:checkProgress', payload);

  // バイト単位進捗（runIngest 側 emitByteProgress と同型）:
  // - totalBytes はレンダラが walk() 取得済みの size を送ってくる前提（数値でなければ0扱い）
  // - doneBytes は「経路0/1/2でスキップ、または経路3のハッシュが完了したファイル」の確定バイト数
  // - inFlightBytes は経路3で現在ハッシュ中のファイルの読み取り済みバイト数（index単位）
  const totalBytes = files.reduce((a, f) => a + (typeof f.size === 'number' ? f.size : 0), 0);
  let doneBytes = 0;
  const inFlightBytes = new Map(); // index -> bytes
  let lastByteEmit = 0;

  function currentBytes() {
    let inFlight = 0;
    for (const v of inFlightBytes.values()) inFlight += v;
    return Math.min(doneBytes + inFlight, totalBytes);
  }

  // 表示中のファイル名は inFlightBytes（＝いま読んでいるファイル）から引く。
  // 直近名を別変数で覚えると、そのファイルが終わったあとも名前だけ残り
  // 「終わった処理をまだやっているように見える」ため。進行中が無ければ空。
  function currentName() {
    for (const idx of inFlightBytes.keys()) {
      const f = files[idx];
      if (f && typeof f.path === 'string') return path.basename(f.path);
    }
    return '';
  }

  // 250ms スロットルで progress を emit（force=true なら終端等で強制発火）
  function emitCheckProgress(force) {
    const now = Date.now();
    if (!force && now - lastByteEmit < 250) return;
    lastByteEmit = now;
    emit({ type: 'progress', done, total, bytes: currentBytes(), totalBytes, name: currentName() });
  }

  // start は最初の await より前に流す。getKnownSizes の初回走査は旧レコードの
  // コピー先 stat を伴って数秒かかることがあり、その間モーダルが 0/0 のままになるため
  // （totalBytes はレンダラ申告の size 合計なので DB を待つ必要がない）。
  emit({ type: 'start', total, totalBytes });

  // サイズ事前フィルタ: DB に同じサイズの記録が1件も無いファイルは重複になり得ないため、
  // ハッシュ計算（ファイル全読み）を省略する。大容量動画が大半のこのアプリでは、
  // 新規データの取り込み時にチェックが stat のみ（ほぼ一瞬）で済む。
  // getKnownSizes() が null（サイズ不明の記録あり）ならフィルタ無効＝従来どおり全ハッシュ。
  const knownSizes = await db.getKnownSizes();

  // 今回のチェックで確定した結果の新しい台帳。キャンセルされなかった場合だけ採用する
  // （中断したランの部分的な結果を取り込み時の判断根拠にしない）。
  // 参照の取得は上の await より後に置くこと（await 中に ejectVolume が台帳を破棄したら、
  // 破棄後の空の台帳を使う＝前のカードの判定を引きずらないため）。
  const prevLedger = checkLedger;
  const nextLedger = new Map();

  async function worker() {
    while (true) {
      if (checkCancelRequested) return;
      const i = nextIdx++;
      if (i >= total) return;
      // f は ipcMain ハンドラ境界で { path: string } を検証済み（不正要素はここへ来ない）
      const f = files[i];
      let sizeForProgress = 0; // catch節でも参照するため try の外で宣言
      // 結果オブジェクトの生成を1か所に集約（形が経路ごとにズレるのを防ぐ）
      const mkResult = (sha, already, hashed, error) => (error === undefined
        ? { path: f.path, sha256: sha, alreadyImported: already, hashed }
        : { path: f.path, sha256: sha, alreadyImported: already, hashed, error });
      try {
        const fallbackSize = typeof f.size === 'number' && Number.isFinite(f.size) ? f.size : 0;
        sizeForProgress = fallbackSize;
        // 現物の stat。fs.statSync だと数千ファイルでメインプロセスを同期ブロックするため非同期版。
        let st = null;
        try { st = await fsp.stat(f.path); } catch (_) { /* stat 不能 → ハッシュ経路でエラー判定 */ }
        sizeForProgress = st ? st.size : fallbackSize;

        let res = null;

        // --- 経路0: 画面往復（プレビュー→戻る→次へ）で計算済みの sha を再利用 ---
        // 根拠は main 側の台帳のみ。レンダラの f.sha256 / f.sha256Verified は信用しない
        // （外部入力で、その sha を本当に中身から計算したかを main は保証できない）。
        // 前回チェック時から stat（サイズ+更新時刻+dev+ino）が変わっていないことを確認してから使う。
        // 再利用するのは verified（＝main が全量ハッシュで得た）エントリだけ。
        // 経路1由来の未 verified エントリを使い回すと、名前+サイズ+更新時刻の推定判定が
        // 台帳経由でセッション中ずっと固定されてしまう。未 verified は毎回
        // 経路2→経路1（スポットチェック）からやり直し、dst が消えた/変わった場合も再評価する。
        if (st) {
          const led = prevLedger.get(f.path);
          if (led && led.verified === true && ledgerMatches(st, led)) {
            res = mkResult(led.sha, db.hasHash(led.sha), true);
          }
        }

        // --- 経路2: サイズ事前フィルタ（同サイズの記録が無い＝重複になり得ない） ---
        // 経路1より先に置く: 同サイズの記録が1件も無ければ stat 逆引きもヒットし得ないので、
        // Set 1回引きで済むこちらを先に試す（逆順だと索引引き＋スポットチェックが無駄に走る）。
        if (!res && st && knownSizes && !knownSizes.has(st.size)) {
          // sha256 は未計算のまま返す
          // （取り込み本体はコピー中のインラインハッシュで sha を得るため問題ない）
          res = mkResult(null, false, false);
        }

        // --- 経路1: stat 逆引き（名前+サイズ+更新時刻）＋ 現物同士の端点バイト照合 ---
        // 既取込ファイルが大量に残ったカードを刺し直したときの全量再ハッシュを消すための本命。
        // ただし名前+サイズ+更新時刻だけの推定で「取り込まない」を決めない。
        // src と既存コピーの先頭・末尾を突き合わせ、内容の端点まで一致することを確かめてから採用する。
        // それでも全量一致の証明ではないため hashed:false のまま（削除が絡む場面では
        // 取り込み側が全量ハッシュで裏を取る）。照合できなければ経路3の全量ハッシュへ落ちる。
        if (!res && st) {
          const hit = db.findByStat({ name: path.basename(f.path), size: st.size, mtimeMs: st.mtimeMs });
          if (hit) {
            const rec = db.getByHash(hit);
            if (rec && typeof rec.dstPath === 'string' && rec.dstPath
                && await spotCheckMatches(f.path, rec.dstPath, st.size)) {
              res = mkResult(hit, true, false);
            }
          }
        }

        // --- 経路3: 全量ハッシュ（従来どおり。checkStreams 経由で中断可能） ---
        if (!res) {
          if (checkCancelRequested) return;
          inFlightBytes.set(i, 0); // 進行中として登録（進捗の表示名をここから引くため）
          const sha = await hashFile(f.path, false, {
            streams: checkStreams,
            onBytes: (n) => {
              inFlightBytes.set(i, (inFlightBytes.get(i) || 0) + n);
              emitCheckProgress(false);
            },
          });
          inFlightBytes.delete(i); // 進行中バイトを doneBytes へ繰り入れ（二重計上防止）
          doneBytes += sizeForProgress;
          res = mkResult(sha, db.hasHash(sha), true);
        } else {
          // 経路0/1/2（スキップ経路）でもバー上は「そのファイル分だけ一気に進む」ように加算
          doneBytes += sizeForProgress;
        }

        results[i] = res;
        // 台帳へ記録（sha が確定していて、照合に使える stat が取れたものだけ）
        if (st && typeof res.sha256 === 'string' && res.sha256) {
          nextLedger.set(f.path, {
            sha: res.sha256,
            verified: res.hashed === true,
            size: st.size,
            mtimeMs: st.mtimeMs,
            dev: st.dev,
            ino: st.ino,
          });
        }
      } catch (e) {
        inFlightBytes.delete(i);
        doneBytes += sizeForProgress;
        if (checkCancelRequested) return; // 中断由来のエラーは結果に残さない
        results[i] = mkResult(null, false, false, String(e?.message || e));
      }
      done++;
      emitCheckProgress(done === total);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  // 中断時は done を出さない（進捗バーが100%で終わったように見えるのを防ぐ）。
  // レンダラ側のモーダル片付けは checkDuplicates の戻り値で行われる。
  if (checkCancelRequested) {
    return { ok: false, cancelled: true, results: [] };
  }

  // doneBytes は stat 時点の実サイズ（sizeForProgress）を積むため、レンダラ申告の
  // totalBytes（スキャン時サイズの合計）を超えることがある。バーが100%を超えないようクランプ。
  emit({ type: 'done', total, bytes: Math.min(doneBytes, totalBytes), totalBytes });

  // 完走し、かつ実行中に eject 由来のパージが入っていないときだけ台帳を差し替える。
  // パージは必ず Map ごとの差し替えなので、開始時に掴んだ参照のままなら
  // 「この間パージは起きていない」と言い切れる（H10: 世代カウンタの更新漏れを構造的に排除）。
  if (checkLedger === prevLedger) checkLedger = nextLedger;

  const dupCount = results.filter(r => r && r.alreadyImported).length;
  return { ok: true, results, duplicateCount: dupCount };
}

// eject 前に「中断したチェックが実際に止まる」のを待つ上限とポーリング間隔。
// 上限は体感（ボタンを押してから固まったように見えない範囲）と、中断が届いてから
// ストリームが閉じるまでの実測（通常は数十ms）の兼ね合いで 3 秒。
const EJECT_QUIESCE_MS = 3000;
const EJECT_QUIESCE_POLL_MS = 50;

// /Volumes/ 配下のボリュームを eject する（macOS: diskutil eject）
ipcMain.handle('ingest:ejectVolume', async (_e, args = {}) => {
  const { volumePath } = args;
  if (typeof volumePath !== 'string' || !volumePath.startsWith('/Volumes/')) {
    return { ok: false, error: '/Volumes/ 配下のパスのみ取り外せます' };
  }
  // 方針: 「eject を試みた時点で、このカードに対するチェック結果は信用しない」。
  // ユーザーは既にカードを抜く意思で操作しており、次に同じマウントパス
  // （/Volumes/Untitled 等）へ別のカードが来る可能性がある。成功分岐だけでパージすると、
  // 「先に物理的に抜いてから『取り外す』を押した」（＝ alreadyEjected）や
  // diskutil 失敗（ビジー等・その後ユーザーが強制的に抜く）の経路で
  // 前カードの判定（sha・verified）が台帳に残ってしまう。
  // パージは必ず Map ごとの差し替えで行う（実行中のチェックの完走差し替えを弾くため）。
  //
  // 実行中の重複チェックがあれば先に中断する。そのチェックは今から取り外すボリュームを
  // 読み続けており、台帳をパージした後も走り切れば「開始時に掴んだ旧台帳」を根拠にした
  // 判定を出し続けるだけ（完走しても差し替えは弾かれる）。カードを抜く操作の最中に
  // SD を読み続ける意味はないので、ここで止める。
  cancelCheckIfRunning();
  // 中断要求を出しただけでは、進行中の読み取り（ハッシュ用ストリーム）がまだ fd を掴んでいる。
  // そのまま diskutil eject を呼ぶと「ボリュームが使用中」で失敗しうるので、チェックが
  // 静まるのを短時間だけ待つ。待ちきれなかった場合は従来どおりそのまま実行する
  // （diskutil のエラーはユーザーに表示され、リトライできる）。
  const quietDeadline = Date.now() + EJECT_QUIESCE_MS;
  while (checkBusy && Date.now() < quietDeadline) {
    await new Promise((r) => setTimeout(r, EJECT_QUIESCE_POLL_MS));
  }
  if (!fs.existsSync(volumePath)) {
    checkLedger = new Map();
    return { ok: false, error: '既に取り外されています', alreadyEjected: true };
  }
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('/usr/sbin/diskutil', ['eject', volumePath], { timeout: 30000 }, (err, stdout, stderr) => {
      checkLedger = new Map();
      if (err) {
        resolve({ ok: false, error: (stderr || err.message || '').trim() });
      } else {
        resolve({ ok: true, message: stdout.trim() });
      }
    });
  });
});

// 取り込み実行中かどうか（main.js の終了ガード / updater.js のダイアログ遅延から参照）
function isIngestBusy() {
  return ingestBusy;
}

// 取り込みを中断し、完了処理（書きかけ dst の削除・DB flush）が終わるまで待つ。
// アプリ終了時に呼ばれる。タイムアウトしたら false を返す（呼び出し側は終了を続行する）。
async function cancelAndWaitIdle(timeoutMs = 30000) {
  if (!ingestBusy) return true;
  requestCancel();
  const deadline = Date.now() + timeoutMs;
  while (ingestBusy && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return !ingestBusy;
}

// 実行中の重複チェックがあれば中断する（レンダラのリロード・画面遷移から呼ばれる）。
// リロードすると進捗イベントの受け手が消えるため、放置すると SD を読み続けたまま
// 進捗が見えない孤児チェックになり、次のチェックも checkBusy で弾かれる。
// 戻り値: 実際に中断要求を出したか。
function cancelCheckIfRunning() {
  if (!checkBusy) return false;
  checkCancelRequested = true;
  for (const s of checkStreams) {
    try { s.destroy(); } catch (_) {}
  }
  return true;
}

module.exports = { isIngestBusy, cancelAndWaitIdle, cancelCheckIfRunning };
