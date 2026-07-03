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
  ingestBusy = true;
  try {
    return await runIngest(args);
  } finally {
    ingestBusy = false;
  }
});

async function runIngest(args) {
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

  // サイズ事前フィルタ（checkDuplicates と同じ理屈のコピー前プレハッシュ版）:
  // 「DB に同サイズの記録なし」かつ「同一バッチ内にも同サイズのファイルなし」なら
  // そのファイルは重複になり得ず、バッチ内調停(inFlightBySha)も不要
  // → コピー前の事前ハッシュ（src 全読み1回分）を丸ごと省略できる。
  // バッチ内に同サイズがある場合は従来どおり事前ハッシュ＋調停に回す（同一内容の
  // ファイルを同時に2つコピーしてしまう事故を防ぐ。同一内容なら必ず同サイズ）。
  const knownSizes = db.getKnownSizes();
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

  // 中断フラグを初期化（前回の取り込みでセットされた値をクリア）
  cancelRequested = false;

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

  emitProgress({ type: 'start', total: planned.length, totalBytes });

  // ==== 並列コピー（高速化）====
  // - CONCURRENCY 本のワーカーがファイルキューを消化（大量の小ファイルで SMB/SD の往復待ちを隠蔽）
  // - dst のファイル名割当は reservedDst で同期的に予約し、同名衝突のレースを防ぐ
  // - 同一内容（同じ sha）のファイルがバッチ内に複数ある場合は inFlightBySha で調停し、
  //   最初の1つだけがコピー、残りはその完了を待って重複スキップ扱いにする
  const CONCURRENCY = 3;
  const reservedDst = new Set();
  const inFlightBySha = new Map(); // sha -> Promise<{ok:boolean}>
  const isSha256 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

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

  // 重複スキップ時の処理。deleteAfterCopy の種別では、以下の全条件を満たした場合のみ元ファイルを削除する:
  //   1. 既存コピーが「取り込み元自身」でない（realpath / dev+ino 照合。アーカイブ再取り込みでの自己削除防止）
  //   2. src がコピー先（NAS 等の保存領域）の中にない（保存領域内のデータは決して削除しない）
  //   3. 既存コピーが同じ患者・同じ種別として記録されている（別患者の保存分を根拠に削除しない）
  //   4. 既存コピーが実在し、読み戻したハッシュが一致する
  //   5. src が事前チェック以降変更されていない（stat 照合）
  async function handleDupSkip(f, i, sha) {
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

      // --- ガード4: 既存コピーの内容一致 ---
      const existingSha = await hashFile(rec.dstPath, true);
      if (existingSha !== sha) {
        warnSkipDelete(f, i, '重複判定だが既存コピーのハッシュ不一致のため削除せず');
        return;
      }

      // --- ガード5: sha はスキャン直後の事前チェックで計算した値のことがあるため、
      //             その後 src が変更されていないかを stat（サイズ+更新時刻）で確認 ---
      const st = fs.statSync(f.path);
      const statOk = (f.size === undefined || st.size === f.size)
        && (f.mtime === undefined || Math.abs(st.mtimeMs - f.mtime) < 1);
      if (!statOk) {
        warnSkipDelete(f, i, '重複判定後にファイル変更の形跡があるため削除せず');
        return;
      }

      if (cancelRequested) return;
      db.flush(); // 削除前に取り込み記録をディスクへ確定（クラッシュしても記録が残る）
      fs.unlinkSync(f.path);
      deleted++;
      deletedParents.add(path.dirname(f.path));
      emitProgress({ type: 'file-deleted', index: i, name: path.basename(f.path), src: f.path });
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
      // プレビュー前の事前チェック(checkDuplicates)で計算済みの f.sha256 があれば再利用し、
      // src の読み直しを丸ごと省く（高速化）。
      // ただし事前チェック以降に src が変更されていないか stat（サイズ+更新時刻）で確認し、
      // 変更の形跡があれば再ハッシュにフォールバックする（stale な sha で誤スキップしないため）。
      let knownSha = null;
      if (diffEnabled) {
        let preSha = null;
        let sizeRuledOut = false; // サイズ事前フィルタで「重複になり得ない」と確定したか
        if (isSha256(f.sha256)) {
          try {
            const st = fs.statSync(f.path);
            const statOk = (f.size === undefined || st.size === f.size)
              && (f.mtime === undefined || Math.abs(st.mtimeMs - f.mtime) < 1);
            if (statOk) preSha = f.sha256.toLowerCase();
          } catch (_) { /* stat 不能 → 再ハッシュへ */ }
        } else if (knownSizes) {
          try {
            const st = fs.statSync(f.path);
            // 実サイズ＝スキャン時サイズ（変更の形跡なし）で、DB にもバッチ内にも
            // 同サイズが存在しない場合のみ事前ハッシュを省略（バッチ内カウントは自分を含むため <=1）
            sizeRuledOut = st.size === f.size
              && !knownSizes.has(st.size)
              && (batchSizeCount.get(f.size) || 0) <= 1;
          } catch (_) { /* stat 不能 → 従来どおり事前ハッシュへ */ }
        }
        if (!sizeRuledOut) {
          knownSha = preSha || await hashFile(f.path, true);
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
            await handleDupSkip(f, i, knownSha);
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

        // 削除前検証用に、コピー開始時点の src の stat を記録
        const preStat = fs.statSync(f.path);

        // --- 3) コピー＋インラインハッシュ（src の読み取りはこの1回だけ） ---
        let srcSha;
        try {
          srcSha = await copyStreamHashed(f.path, dst, (n) => {
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
            await handleDupSkip(f, i, srcSha);
            return;
          }
        }

        // サイズ事前フィルタでプレハッシュを省略したファイルの保険:
        // コピーで得た srcSha で重複を最終判定する（フィルタ条件が正しければ到達しないが、
        // チェックと取り込みの間にファイル内容が変わった等の万一でも二重登録を防ぐ）
        if (diffEnabled && !knownSha && db.hasHash(srcSha)) {
          try { fs.unlinkSync(dst); } catch (_) {}
          await handleDupSkip(f, i, srcSha);
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
          // 記録直前の最終重複ガード（この判定と recordFile の間に await を挟まないこと）。
          // 自分がコピー・検証している間に、サイズ事前フィルタで調停(inFlightBySha)を
          // 通らなかった別ファイルが同一内容を先に記録した場合ここで検出し、二重登録を防ぐ。
          if (db.hasHash(srcSha)) {
            try { fs.unlinkSync(dst); } catch (_) {}
            await handleDupSkip(f, i, srcSha);
            return;
          }
          db.recordFile({
            sha256: srcSha,
            srcPath: f.path,
            dstPath: dst,
            size: preStat.size,
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
              const nowStat = fs.statSync(f.path);
              if (nowStat.size === preStat.size && Math.abs(nowStat.mtimeMs - preStat.mtimeMs) < 1) {
                if (cancelRequested) return;
                db.flush(); // 削除前に取り込み記録をディスクへ確定（クラッシュしても記録が残る）
                fs.unlinkSync(f.path);
                deleted++;
                deletedParents.add(path.dirname(f.path));
                emitProgress({
                  type: 'file-deleted',
                  index: i,
                  name: path.basename(f.path),
                  src: f.path,
                });
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

// プレビュー前の重複チェック: 全ファイルを並行ハッシュ計算し、履歴DBと照合
// 結果: [{ path, sha256, alreadyImported }] を返す
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
  const files = Array.isArray(args.files) ? args.files : [];
  if (files.length === 0) return { ok: true, results: [] };
  if (checkBusy) return { ok: false, busy: true, error: '重複チェックが既に実行中です' };
  checkBusy = true;
  checkCancelRequested = false;
  try {
    return await runCheckDuplicates(files);
  } finally {
    checkBusy = false;
  }
});

async function runCheckDuplicates(files) {
  const total = files.length;
  let done = 0;
  const results = new Array(total);
  const CONCURRENCY = 4; // I/Oバウンドなので4並列くらいが妥当
  let nextIdx = 0;

  // サイズ事前フィルタ: DB に同じサイズの記録が1件も無いファイルは重複になり得ないため、
  // ハッシュ計算（ファイル全読み）を省略する。大容量動画が大半のこのアプリでは、
  // 新規データの取り込み時にチェックが stat のみ（ほぼ一瞬）で済む。
  // getKnownSizes() が null（サイズ不明の記録あり）ならフィルタ無効＝従来どおり全ハッシュ。
  const knownSizes = db.getKnownSizes();

  const emit = (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ingest:checkProgress', payload);
    }
  };

  emit({ type: 'start', total });

  async function worker() {
    while (true) {
      if (checkCancelRequested) return;
      const i = nextIdx++;
      if (i >= total) return;
      const f = files[i];
      try {
        let skipHash = false;
        if (knownSizes) {
          try {
            skipHash = !knownSizes.has(fs.statSync(f.path).size);
          } catch (_) { /* stat 不能 → 従来どおりハッシュ側でエラー判定 */ }
        }
        if (skipHash) {
          // 同サイズの取り込み記録なし＝重複ではない。sha256 は未計算のまま返す
          // （取り込み本体はコピー中のインラインハッシュで sha を得るため問題ない）
          results[i] = { path: f.path, sha256: null, alreadyImported: false };
        } else {
          const sha = await hashFile(f.path, false, { streams: checkStreams });
          const dup = db.hasHash(sha);
          results[i] = { path: f.path, sha256: sha, alreadyImported: dup };
        }
      } catch (e) {
        if (checkCancelRequested) return; // 中断由来のエラーは結果に残さない
        results[i] = { path: f.path, sha256: null, alreadyImported: false, error: String(e?.message || e) };
      }
      done++;
      // 進捗は10ファイルごとか終端で通知（イベント抑制）
      if (done % 10 === 0 || done === total) {
        emit({ type: 'progress', done, total });
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);

  emit({ type: 'done', total });

  if (checkCancelRequested) {
    return { ok: false, cancelled: true, results: [] };
  }
  const dupCount = results.filter(r => r && r.alreadyImported).length;
  return { ok: true, results, duplicateCount: dupCount };
}

// /Volumes/ 配下のボリュームを eject する（macOS: diskutil eject）
ipcMain.handle('ingest:ejectVolume', async (_e, args = {}) => {
  const { volumePath } = args;
  if (typeof volumePath !== 'string' || !volumePath.startsWith('/Volumes/')) {
    return { ok: false, error: '/Volumes/ 配下のパスのみ取り外せます' };
  }
  if (!fs.existsSync(volumePath)) {
    return { ok: false, error: '既に取り外されています', alreadyEjected: true };
  }
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('/usr/sbin/diskutil', ['eject', volumePath], { timeout: 30000 }, (err, stdout, stderr) => {
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

module.exports = { isIngestBusy, cancelAndWaitIdle };
