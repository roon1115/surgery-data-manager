const { ipcMain } = require('electron');
const crypto = require('crypto');
const settings = require('./settings-handler');
const db = require('./db');

let dimse = null;
try {
  dimse = require('dcmjs-dimse');
} catch (_) {
  dimse = null;
}

function generateUID() {
  const buf = crypto.randomBytes(16);
  const big = BigInt('0x' + buf.toString('hex'));
  return '2.25.' + big.toString();
}

function dicomDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? m[1] + m[2] + m[3] : '';
}

function dicomTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function pickTransferSyntax(uid) {
  if (!dimse) return null;
  const TS = dimse.constants.TransferSyntax;
  switch (uid) {
    case '1.2.840.10008.1.2': return TS.ImplicitVRLittleEndian;
    case '1.2.840.10008.1.2.1': return TS.ExplicitVRLittleEndian;
    default: return TS.ImplicitVRLittleEndian;
  }
}

function asciiOnly(s) {
  return String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
}

function buildDataset(opts) {
  if (!dimse) throw new Error('dcmjs-dimse not installed');
  const { Dataset } = dimse;
  const {
    patient, exam, studyUID, seriesUID, sopUID, modality, charset,
    instanceNumber, width, height, rgb, transferSyntax,
  } = opts;

  const studyDate = dicomDate(exam?.datetime);
  const studyTime = dicomTime(exam?.datetime);
  const pixelBytes = Buffer.from(rgb);

  const elements = {
    SpecificCharacterSet: charset || 'ISO_IR 100',
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.7',
    SOPInstanceUID: sopUID,
    ImageType: ['DERIVED', 'SECONDARY'],
    StudyInstanceUID: studyUID,
    StudyDate: studyDate,
    StudyTime: studyTime,
    AccessionNumber: '',
    ReferringPhysicianName: '',
    StudyID: '1',
    StudyDescription: asciiOnly(exam?.desc),
    SeriesInstanceUID: seriesUID,
    SeriesNumber: '1',
    Modality: modality || 'OT',
    Manufacturer: 'Stella',
    ManufacturerModelName: 'SurgeryDataManager',
    DateOfSecondaryCapture: studyDate,
    TimeOfSecondaryCapture: studyTime,
    PatientName: asciiOnly(patient?.name),
    PatientID: asciiOnly(patient?.id),
    PatientBirthDate: dicomDate(patient?.dob),
    PatientSex: asciiOnly(patient?.sex),
    InstanceNumber: String(instanceNumber),
    PatientOrientation: '',
    SamplesPerPixel: 3,
    PhotometricInterpretation: 'RGB',
    PlanarConfiguration: 0,
    Rows: height,
    Columns: width,
    BitsAllocated: 8,
    BitsStored: 8,
    HighBit: 7,
    PixelRepresentation: 0,
    PixelData: [pixelBytes.buffer.slice(pixelBytes.byteOffset, pixelBytes.byteOffset + pixelBytes.byteLength)],
  };

  return new Dataset(elements, pickTransferSyntax(transferSyntax));
}

// runClient: dcmjs-dimse の Client を「無応答タイムアウト」付きで実行する。
//
// タイムアウトは総時間ではなく **無応答（進捗なし）が timeoutMs 続いたとき** に発火する。
// v0.3.18 では総時間 60 秒の固定だったため、遅い経路（Wi-Fi・Tailscale 等）で 20 枚バッチ
// （約 240MB）の転送が 60 秒を超えると、まだ順調に送れている最中に abort で打ち切り、
// 残りの画像が PACS に届かなかった（v0.3.16 以前は abort しなかったので裏で届いていた）。
// setup 側は C-STORE 応答のたびに ctl.touch() を呼び、ctl.progress.sent を更新する。
function runClient(setup, timeoutMs = 30000) {
  if (!dimse) return Promise.resolve({ ok: false, error: 'dcmjs-dimse not installed' });
  const { Client } = dimse;
  return new Promise((resolve) => {
    let settled = false;
    let closed = false;
    let pendingAfterClose = null; // タイムアウト時: closed を待ってから返す値
    let closeGrace = null;
    let t = null;
    const progress = { sent: 0, total: 0, results: [] };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (t) clearTimeout(t);
      if (closeGrace) clearTimeout(closeGrace);
      resolve(value);
    };
    // タイムアウト: Promise を失敗で確定するだけでは association と未完了 C-STORE が生き残り、
    // 呼出側が「失敗」として次バッチや再送を始めた後に旧クライアントが PACS へ遅延到達して
    // 重複登録になる。association を明示 abort し、closed を待ってから確定する
    // （closed が来ない場合も 5 秒で打ち切る）。結果は「送信状況不明」として返すが、
    // 応答済み（=PACS が受理済み）の枚数は sent として正しく返す。
    const onTimeout = () => {
      if (settled) return;
      try { client.abort(); } catch (_) { /* 未接続など */ }
      const value = {
        ok: false,
        indeterminate: true,
        sent: progress.sent,
        failed: Math.max(0, progress.total - progress.sent),
        results: progress.results,
        error: `timeout（${Math.round(timeoutMs / 1000)}秒間応答なし。受理済み ${progress.sent}/${progress.total} 枚。未受理分は再送時に重複しない）`,
      };
      if (closed) return settleAndStop(value);
      pendingAfterClose = value;
      closeGrace = setTimeout(() => settleAndStop(value), 5000);
    };
    const armTimer = () => {
      if (t) clearTimeout(t);
      t = setTimeout(onTimeout, timeoutMs);
    };
    const touch = () => { if (!settled) armTimer(); };
    armTimer();

    const client = new Client();

    // 応答イベントだけでは「1 枚の転送が timeoutMs を超える」低速経路（例: 12MB/枚を 1.5Mbps
    // 以下で送る）を救えないため、ソケットの送受信バイト数（Client.getStatistics）を定期的に
    // 見て、バイトが動いている限り進捗とみなす。これで「本当に止まった」ときだけ abort する。
    let lastBytes = 0;
    const activityPoll = setInterval(() => {
      if (settled) { clearInterval(activityPoll); return; }
      try {
        const st = client.getStatistics && client.getStatistics();
        const bytes = st ? (st.getBytesSent() + st.getBytesReceived()) : 0;
        if (bytes !== lastBytes) { lastBytes = bytes; touch(); }
      } catch (_) { /* 統計未対応でも応答ベースの再武装は残る */ }
    }, 2000);
    const origSettle = settle;
    // settle 時にポーリングも止める（settle は const なので内側で差し替え）
    const settleAndStop = (value) => { clearInterval(activityPoll); origSettle(value); };
    client.on('networkError', (err) => settleAndStop({ ok: false, sent: progress.sent, results: progress.results, error: `network: ${err?.message || err}` }));
    client.on('associationRejected', () => settleAndStop({ ok: false, sent: 0, results: progress.results, error: 'association rejected' }));
    client.on('associationAccepted', () => touch()); // 接続確立も進捗
    client.on('associationReleased', () => { /* normal close */ });
    client.on('closed', () => {
      closed = true;
      if (pendingAfterClose) settleAndStop(pendingAfterClose);
    });

    try {
      setup(client, settleAndStop, { touch, progress });
    } catch (e) {
      settleAndStop({ ok: false, sent: progress.sent, error: String(e?.message || e) });
    }
  });
}

ipcMain.handle('dicom:echo', async (_e, args = {}) => {
  if (!dimse) return { ok: false, error: 'dcmjs-dimse not installed' };
  const cfg = settings.getAll().dicom;
  const callingAet = (args.callingAet || cfg.callingAet || 'SURGERY').trim();
  const calledAet = (args.calledAet || cfg.calledAet || 'STELLADICOM').trim();
  const host = (args.host || cfg.host || '').trim();
  const port = parseInt(args.port ?? cfg.port, 10) || 104;
  if (!host) return { ok: false, error: 'host is empty' };

  return await runClient((client, settle) => {
    const { requests, constants } = dimse;
    const req = new requests.CEchoRequest();
    req.on('response', (response) => {
      const status = response.getStatus();
      if (status === constants.Status.Success) settle({ ok: true });
      else settle({ ok: false, error: `C-ECHO failed (status=0x${status.toString(16)})` });
    });
    client.addRequest(req);
    client.send(host, port, callingAet, calledAet);
  });
});

// main 側の排他: 同時に走る C-STORE 送信は1系列だけ。
// レンダラのロックをすり抜けた多重呼び出し（再描画・二重クリック）で同じ画像が
// 別 Study として PACS に重複登録されるのを止める。バッチは直列 await なので影響しない。
let sendStudyBusy = false;

ipcMain.handle('dicom:sendStudy', async (_e, args = {}) => {
  if (!dimse) return { ok: false, error: 'dcmjs-dimse not installed' };
  if (sendStudyBusy) return { ok: false, sent: 0, error: '別のDICOM送信が実行中です' };
  sendStudyBusy = true;
  try {
    return await sendStudyImpl(args);
  } finally {
    sendStudyBusy = false;
  }
});

async function sendStudyImpl(args) {
  const cfg = settings.getAll().dicom;
  const host = (args.host || cfg.host || '').trim();
  const port = parseInt(args.port ?? cfg.port, 10);
  const calledAet = (args.calledAet || cfg.calledAet || '').trim();
  const callingAet = (args.callingAet || cfg.callingAet || 'SURGERY').trim();
  if (!host || !port || !calledAet) return { ok: false, error: 'DICOM接続先設定が不完全です' };

  const modality = args.modality || cfg.modality || 'OT';
  const charset = args.charset || cfg.charset || 'ISO_IR 100';
  const transferSyntax = args.transferSyntax || cfg.transferSyntax || '1.2.840.10008.1.2';

  const decodedImages = Array.isArray(args.decodedImages) ? args.decodedImages : [];
  if (decodedImages.length === 0) return { ok: false, error: '送信対象の画像がありません' };

  const patient = args.patient || {};
  const exam = args.exam || {};
  // バッチ送信に対応: 呼出側から studyUID/seriesUID/startInstanceNumber を渡すことで
  // 同じ Study に追加できる。指定なしなら新規生成（後方互換）。
  const studyUID = args.studyUID || generateUID();
  const seriesUID = args.seriesUID || generateUID();
  const startInstance = Number.isInteger(args.startInstanceNumber) && args.startInstanceNumber > 0
    ? args.startInstanceNumber : 1;
  const requestedSopUIDs = Array.isArray(args.sopUIDs) ? args.sopUIDs : [];
  const sopUIDs = decodedImages.map((_, i) => requestedSopUIDs[i] || generateUID());
  // InstanceNumber は呼出側がファイル単位で固定して渡す（再送でも同じ番号で送るため）。
  // 指定が無い要素だけ従来どおり startInstanceNumber からの連番にする（後方互換）。
  const requestedInstanceNumbers = Array.isArray(args.instanceNumbers) ? args.instanceNumbers : [];
  const instanceNumbers = decodedImages.map((_, i) => {
    const n = requestedInstanceNumbers[i];
    return Number.isInteger(n) && n > 0 ? n : startInstance + i;
  });

  let datasets;
  try {
    datasets = decodedImages.map((img, i) => buildDataset({
      patient, exam, studyUID, seriesUID,
      sopUID: sopUIDs[i],
      modality, charset,
      instanceNumber: instanceNumbers[i],
      width: img.width,
      height: img.height,
      rgb: new Uint8Array(img.rgb),
      transferSyntax,
    }));
  } catch (e) {
    return { ok: false, error: `dataset構築失敗: ${e?.message || e}`, studyUID, seriesUID };
  }

  // バッチごとに新規 association を張る。Study/Series UID は呼出側で固定される。
  const result = await runClient((client, settle, ctl) => {
    const { requests, constants } = dimse;
    let sent = 0;
    let lastError = null;
    let pending = datasets.length;
    const results = new Array(datasets.length);
    ctl.progress.results = results;
    ctl.progress.total = datasets.length;

    datasets.forEach((ds, index) => {
      const req = new requests.CStoreRequest(ds);
      req.on('response', (response) => {
        const status = response.getStatus();
        const ok = status === constants.Status.Success;
        results[index] = { index, ok, status, sopUID: sopUIDs[index], instanceNumber: instanceNumbers[index] };
        if (ok) sent++;
        else lastError = `C-STORE status=0x${status.toString(16)}`;
        ctl.progress.sent = sent;
        ctl.touch(); // 応答が来ている限りタイムアウトしない（遅い経路でも打ち切らない）
        if (--pending === 0) {
          // 部分成功は失敗として返す（ok は全件成功のときだけ）。
          // 呼出側が ok だけを見て「バッチ成功」と扱うと未送信分が失敗キューに残らず欠落するため。
          if (sent === datasets.length) settle({ ok: true, sent, failed: 0, results });
          else settle({ ok: false, sent, failed: datasets.length - sent, results, error: lastError || `C-STORE 部分失敗 (${sent}/${datasets.length})` });
        }
      });
      client.addRequest(req);
    });

    client.send(host, port, callingAet, calledAet);
  }, 60000); // 無応答 60 秒でタイムアウト（総時間ではない。応答が続く限り継続）

  // networkError/timeout/abort では応答イベントが来ない画像がある。応答済みの結果を保ち、
  // 未応答だけを失敗にすることで、保存済み画像を再送対象へ混ぜない。
  const responseResults = Array.isArray(result.results) ? result.results : [];
  const byIndex = new Map(responseResults.filter(Boolean).map((it) => [it.index, it]));
  const results = datasets.map((_, index) => byIndex.get(index) || ({
    index, ok: false, status: null, sopUID: sopUIDs[index], instanceNumber: instanceNumbers[index],
    reason: result.error || 'no-response',
  }));
  const sent = results.filter((it) => it.ok).length;
  return { ...result, ok: sent === datasets.length, sent, failed: datasets.length - sent, results, studyUID, seriesUID };
}

const hasFileLevelInfo = (rec) => Array.isArray(rec && rec.files) && rec.files.length > 0;

ipcMain.handle('dicom:queueFailure', async (_e, args = {}) => {
  if (!args.target || !args.patient) return { ok: false, error: 'invalid args' };
  // 同じフォルダの失敗記録への相乗り（dedup）は、記録の意味が完全に一致するときだけ行う。
  // フォルダが同じでも Study が違えば別の送信であり、混ぜると未送信の範囲が壊れる：
  //   - 旧レコード（files 無し）は「このフォルダ全体が未送信かもしれない」という意味。
  //     そこへファイル単位の失敗を merge すると、フォルダ全体という範囲が消えて
  //     未送信が黙って落ちる。
  //   - 別 Study の失敗を混ぜると、再送時に他 Study の SOP UID を持つ画像まで
  //     同じ Study へ送られ、PACS に重複登録され得る。
  // 一致しないものは既存レコードに触らず、新しいレコードを別に作る（キューに複数行
  // 並ぶが、レンダラ側の一覧・再送・削除はいずれも id 単位なので同じ dstPath でも扱える）。
  const sameFolder = db.listPendingDicom().filter(
    (it) => it && it.id != null && (it.dstPath || it.dst_path) === args.target
  );
  const incomingFiles = (Array.isArray(args.files) ? args.files : []).filter((f) => f && f.path);

  // 既存レコードの更新条件: 既存も今回もファイル単位、かつ同じ Study。
  // studyUID が取れなかった（IPC 例外等で main の応答が無い）ときは同一性を判断できないので
  // 相乗りしない。判断できないまま混ぜる方が、キューが1行増えるより危険。
  // Series も一致を要求する。同じ Study 内で別 Series の失敗を混ぜると、旧 Series の files が
  // 新しい seriesUID で再送され、受理済み SOP UID と属性が食い違う（PACS 上で重複・競合）。
  const mergeable = incomingFiles.length > 0 && args.studyUID && args.seriesUID
    ? sameFolder.find((it) => hasFileLevelInfo(it) && it.studyUID === args.studyUID && it.seriesUID === args.seriesUID)
    : null;
  if (mergeable) {
    const merged = new Map();
    for (const file of mergeable.files) if (file?.path) merged.set(file.path, file);
    for (const file of incomingFiles) merged.set(file.path, file);
    db.updatePendingDicom(mergeable.id, {
      attempts: (mergeable.attempts || 0) + 1,
      lastError: args.error || mergeable.lastError || mergeable.last_error || null,
      files: Array.from(merged.values()),
      // studyUID / seriesUID は一致が相乗りの条件なので上書きしない（同一性の基準を書き換えない）
      nextInstanceNumber: args.nextInstanceNumber,
      sentCount: args.sentCount,
      totalCount: args.totalCount,
    });
    return { ok: true, deduped: true, id: mergeable.id };
  }

  // 旧レコード（フォルダ単位）どうしは従来どおり attempts を増やすだけ。
  // ファイル単位の情報を持たないので studyUID 等は触らない（触ると意味が壊れる）。
  if (incomingFiles.length === 0) {
    const folderRec = sameFolder.find((it) => !hasFileLevelInfo(it));
    if (folderRec) {
      db.updatePendingDicom(folderRec.id, {
        attempts: (folderRec.attempts || 0) + 1,
        lastError: args.error || folderRec.lastError || folderRec.last_error || null,
      });
      return { ok: true, deduped: true, id: folderRec.id };
    }
  }

  const id = db.queueDicom({
    dstPath: args.target,
    patientId: args.patient.id || '',
    patientName: args.patient.nameRomaji || args.patient.name || '',
    procedure: args.patient.procedure || '',
    studyDate: args.patient.date || '',
    // path を持たない要素は再送に使えないので落とす。全部落ちたら files 無し
    // （＝フォルダ全体が未送信かもしれない）の記録として残す方が安全側。
    files: incomingFiles.length > 0 ? incomingFiles : undefined,
    studyUID: args.studyUID,
    seriesUID: args.seriesUID,
    nextInstanceNumber: args.nextInstanceNumber,
    sentCount: args.sentCount,
    totalCount: args.totalCount,
    lastError: args.error || null,
  });
  return { ok: true, id };
});

ipcMain.handle('dicom:updatePending', async (_e, args = {}) => {
  if (!Number.isInteger(args.id)) return { ok: false, error: 'invalid id' };
  const allowed = {};
  for (const key of ['files', 'studyUID', 'seriesUID', 'nextInstanceNumber', 'sentCount', 'totalCount', 'attempts', 'lastError']) {
    if (args[key] !== undefined) allowed[key] = args[key];
  }
  db.updatePendingDicom(args.id, allowed);
  return { ok: true, id: args.id };
});

ipcMain.handle('dicom:listPending', async () => {
  return { ok: true, items: db.listPendingDicom() };
});

// 再送成功時・ユーザー操作でキューから削除する
ipcMain.handle('dicom:removePending', async (_e, args = {}) => {
  const id = args.id;
  if (!Number.isInteger(id)) return { ok: false, error: 'invalid id' };
  db.updatePendingDicom(id, { remove: true });
  return { ok: true };
});

module.exports = { generateUID, sendStudyImpl, runClient };
