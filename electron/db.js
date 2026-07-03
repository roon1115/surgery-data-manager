const path = require('path');
const fs = require('fs');
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

// 記録済みファイルの全サイズ集合を返す（重複チェックのサイズ事前フィルタ用）。
// 同じサイズの記録が1件も無いファイルは内容が一致しようがない＝重複になり得ないので、
// ハッシュ計算（ファイル全読み）を省略できる。
// サイズ不明の記録が混ざっている場合はフィルタとして使えないため null を返す（安全側）。
function getKnownSizes() {
  init();
  const sizes = new Set();
  if (db) {
    for (const row of db.prepare('SELECT size FROM files').all()) {
      if (typeof row.size !== 'number' || !Number.isFinite(row.size)) return null;
      sizes.add(row.size);
    }
    return sizes;
  }
  for (const r of Object.values(jsonFallback.files)) {
    const s = r ? r.size : undefined;
    if (typeof s !== 'number' || !Number.isFinite(s)) return null;
    sizes.add(s);
  }
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
  if (db) {
    db.prepare(`
      INSERT OR IGNORE INTO files (sha256, src_path, dst_path, size, mtime, imported_at, patient_id, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sha256, srcPath, dstPath, size, mtime, importedAt, patientId || null, kind || null);
  } else {
    const rec = { srcPath, dstPath, size, mtime, importedAt, patientId, kind };
    jsonFallback.files[sha256] = rec; // メモリ上は即時反映（hasHash/getByHash は正しく動く）
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
  getByHash,
  recordFile,
  flush,
  queueDicom,
  listPendingDicom,
  updatePendingDicom,
};
