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
    } catch (_) {
      jsonFallback = { files: {}, pending_dicom: [] };
    }
  }
}

function persistJson() {
  if (!jsonFallback || !jsonPath) return;
  fs.writeFileSync(jsonPath, JSON.stringify(jsonFallback));
}

function hasHash(sha256) {
  init();
  if (db) {
    const row = db.prepare('SELECT 1 FROM files WHERE sha256 = ?').get(sha256);
    return !!row;
  }
  return !!jsonFallback.files[sha256];
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
    persistJson();
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
  recordFile,
  queueDicom,
  listPendingDicom,
  updatePendingDicom,
};
