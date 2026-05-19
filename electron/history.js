/**
 * 患者セッション履歴
 *
 * 同じ症例で SD カード等を差し替えながら複数回取り込む際に、
 * 過去の患者情報（ID、名前、処置名、日付）を呼び出せるようにする。
 *
 * 保存場所: ~/Library/Application Support/surgery-data-manager/history.json
 */
const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

const MAX_HISTORY = 100;
let histFile = null;
let loaded = null;

function init() {
  if (loaded) return loaded;
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  histFile = path.join(dir, 'history.json');
  try {
    loaded = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    if (!Array.isArray(loaded.patients)) loaded.patients = [];
  } catch (_) {
    loaded = { patients: [] };
  }
  return loaded;
}

function persist() {
  if (!histFile || !loaded) return;
  try {
    fs.writeFileSync(histFile, JSON.stringify(loaded, null, 2));
  } catch (e) {
    console.error('[history] persist failed:', e?.message || e);
  }
}

// folderName をキーに既存エントリを更新、無ければ追加
function recordSession(entry) {
  init();
  if (!entry || !entry.folderName) return;
  const now = Date.now();
  const existing = loaded.patients.find(p => p.folderName === entry.folderName);
  if (existing) {
    existing.lastIngestAt = now;
    existing.ingestCount = (existing.ingestCount || 0) + 1;
    existing.totalFiles = (existing.totalFiles || 0) + (entry.filesAdded || 0);
    // 患者情報は最新で上書き（ローマ字修正等を反映）
    if (entry.patient) {
      existing.patient = { ...existing.patient, ...entry.patient };
    }
    if (entry.targets) existing.targets = entry.targets;
  } else {
    loaded.patients.unshift({
      folderName: entry.folderName,
      patient: entry.patient || {},
      targets: entry.targets || {},
      firstIngestAt: now,
      lastIngestAt: now,
      ingestCount: 1,
      totalFiles: entry.filesAdded || 0,
    });
    // 上限を超えたら古いものから削除
    if (loaded.patients.length > MAX_HISTORY) {
      loaded.patients.length = MAX_HISTORY;
    }
  }
  persist();
}

function listRecent({ limit = 20 } = {}) {
  init();
  // lastIngestAt 降順
  const sorted = [...loaded.patients].sort((a, b) => (b.lastIngestAt || 0) - (a.lastIngestAt || 0));
  return sorted.slice(0, limit);
}

function removeByFolderName(folderName) {
  init();
  loaded.patients = loaded.patients.filter(p => p.folderName !== folderName);
  persist();
}

ipcMain.handle('history:listRecent', async (_e, args = {}) => {
  return { ok: true, items: listRecent({ limit: args.limit || 20 }) };
});

ipcMain.handle('history:remove', async (_e, args = {}) => {
  if (!args.folderName) return { ok: false, error: 'folderName required' };
  removeByFolderName(args.folderName);
  return { ok: true };
});

module.exports = { recordSession, listRecent };
