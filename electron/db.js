const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// SQLite ネイティブモジュールは Electron 最新版との互換性問題を避けるため未使用。
// JSON ファイル保存で十分な性能（数万件レベルまで）。
let Database = null;

let db = null;
let jsonFallback = null;
let jsonPath = null;

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
  } else {
    jsonPath = path.join(dir, 'ingest.json');
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
  }
}

let dirty = false; // メモリ上の変更がディスク未反映なら true

function persistJson() {
  if (!jsonFallback || !jsonPath) return;
  // アトミック書き込み（tmp → rename）。書き込み途中のクラッシュ・電源断でも
  // 既存の ingest.json が途中切れで破損することがない。
  const tmp = jsonPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jsonFallback));
  fs.renameSync(tmp, jsonPath);
  dirty = false;
}

// 高速化: 取り込み中は recordFile が大量に呼ばれるため、毎回のフル書き込みを
// デバウンスする（300ms 以内の連続記録は1回の書き込みにまとめる）。
// 取り込み完了時・削除直前に flush() で必ず確定させる。
let persistTimer = null;
function schedulePersist() {
  if (!jsonFallback || !jsonPath) return;
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { persistJson(); } catch (e) { console.error('[db] persist failed:', e?.message || e); }
  }, 300);
}

function flush() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (dirty) persistJson(); // 未反映の変更があるときだけ書く（削除のたびの無駄書き込み防止）
}

// プロセス終了時にも未書き込み分を確定
process.on('exit', () => { try { flush(); } catch (_) {} });

function hasHash(sha256) {
  init();
  if (db) {
    const row = db.prepare('SELECT 1 FROM files WHERE sha256 = ?').get(sha256);
    return !!row;
  }
  return !!jsonFallback.files[sha256];
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
    jsonFallback.files[sha256] = {
      srcPath, dstPath, size, mtime, importedAt, patientId, kind,
    };
    schedulePersist(); // メモリ上は即時反映（hasHash/getByHash は正しく動く）、ディスク書き込みはまとめる
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
    jsonFallback.pending_dicom.push({
      dstPath, patientId, patientName, procedure, studyDate, queuedAt: Date.now(), attempts: 0,
    });
    persistJson();
  }
}

function listPendingDicom() {
  init();
  if (db) {
    return db.prepare('SELECT * FROM pending_dicom ORDER BY queued_at ASC').all();
  }
  return [...jsonFallback.pending_dicom];
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
  }
}

module.exports = {
  init,
  hasHash,
  getByHash,
  recordFile,
  flush,
  queueDicom,
  listPendingDicom,
  updatePendingDicom,
};
