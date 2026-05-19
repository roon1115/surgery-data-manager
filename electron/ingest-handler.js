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

function classifyByExt(ext) {
  const e = ext.toLowerCase();
  if (PHOTO_EXT.has(e)) return 'photo';
  if (VIDEO_EXT.has(e)) return 'video';
  if (CSV_EXT.has(e)) return 'csv';
  return 'other';
}

function emitProgress(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('ingest:progress', payload);
  }
}

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
  const date = dateIso || new Date().toISOString().slice(0, 10);
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

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function copyStream(src, dst) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dst);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('close', resolve);
    rs.pipe(ws);
  });
}

ipcMain.handle('ingest:start', async (_e, args = {}) => {
  // targets: { surgicalPhoto: "/abs/path/...", anesthesia: "/abs/path/...", ... }
  //   (prepareTarget で計算済の、種別→患者フォルダのフルパス対応表)
  // 後方互換: target (string) と files が来た場合は旧形式
  const { targets, files, patient, useHashDiff } = args;
  if (!targets || typeof targets !== 'object' || !Array.isArray(files)) {
    return { ok: false, error: 'invalid args (targets, files required)' };
  }

  const planned = files.filter(f => f.selected !== false);
  const totalBytes = planned.reduce((s, f) => s + (f.size || 0), 0);
  let doneBytes = 0;
  let copied = 0;
  let skippedDup = 0;
  let failed = 0;
  const failures = [];
  const dicomCandidates = [];

  emitProgress({ type: 'start', total: planned.length, totalBytes });

  for (let i = 0; i < planned.length; i++) {
    const f = planned[i];
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
      let sha = null;
      if (diffEnabled) {
        sha = await hashFile(f.path);
        if (db.hasHash(sha)) {
          skippedDup++;
          doneBytes += f.size || 0;
          emitProgress({ type: 'file-skip', index: i, reason: 'duplicate', name: path.basename(f.path) });
          continue;
        }
      }

      // f.type は 5種別(anesthesia/surgicalPhoto/laparoscope/bronchoscope/endoscope)
      const typeDir = targets[f.type];
      if (!typeDir) {
        failed++;
        failures.push({ file: f.path, error: `種別 ${f.type} の保存先が未指定` });
        emitProgress({ type: 'file-fail', index: i, name: path.basename(f.path), error: '保存先未指定' });
        continue;
      }
      const ext = path.extname(f.path);
      const base = path.basename(f.path, ext);
      let dstName = `${base}${ext}`;
      let dst = path.join(typeDir, dstName);
      if (fs.existsSync(dst)) {
        let n = 2;
        while (fs.existsSync(path.join(typeDir, `${base}_${n}${ext}`))) n++;
        dstName = `${base}_${n}${ext}`;
        dst = path.join(typeDir, dstName);
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });

      await copyStream(f.path, dst);

      if (diffEnabled && sha) {
        const dstSha = await hashFile(dst);
        if (dstSha !== sha) {
          fs.unlinkSync(dst);
          failed++;
          failures.push({ file: f.path, error: 'ハッシュ不一致（コピー失敗）' });
          emitProgress({ type: 'file-fail', index: i, name: path.basename(f.path), error: 'ハッシュ不一致' });
          continue;
        }
      }

      const stat = fs.statSync(f.path);
      if (diffEnabled && sha) {
        db.recordFile({
          sha256: sha,
          srcPath: f.path,
          dstPath: dst,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs),
          patientId: patient?.id,
          kind: f.type || f.kind,
        });
      }

      copied++;
      doneBytes += f.size || 0;

      // DICOM 送信対象: 種別が surgicalPhoto なら自動的に候補入り
      // ファイル拡張子が画像系であることも軽くチェック
      if (f.type === 'surgicalPhoto') {
        const e = ext.toLowerCase();
        if (['.jpg','.jpeg','.png','.heic','.heif','.bmp'].includes(e)) {
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
    } catch (e) {
      failed++;
      failures.push({ file: f.path, error: String(e?.message || e) });
      emitProgress({ type: 'file-fail', index: i, name: path.basename(f.path), error: String(e?.message || e) });
    }
  }

  emitProgress({ type: 'done', copied, skippedDup, failed });

  // 履歴に記録（1ファイル以上コピーまたはスキップで再取込が起きた場合）
  if ((copied > 0 || skippedDup > 0) && args.folderName) {
    history.recordSession({
      folderName: args.folderName,
      patient: patient || {},
      targets,
      filesAdded: copied,
    });
  }

  return {
    ok: failed === 0,
    copied,
    skippedDup,
    failed,
    failures,
    dicomCandidates,
    targets,
  };
});

module.exports = {};
