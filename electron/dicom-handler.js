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
    const progress = { sent: 0, total: 0 };
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
    client.on('networkError', (err) => settleAndStop({ ok: false, sent: progress.sent, error: `network: ${err?.message || err}` }));
    client.on('associationRejected', () => settleAndStop({ ok: false, sent: 0, error: 'association rejected' }));
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

  let datasets;
  try {
    datasets = decodedImages.map((img, i) => buildDataset({
      patient, exam, studyUID, seriesUID,
      sopUID: generateUID(),
      modality, charset,
      instanceNumber: startInstance + i,
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
    ctl.progress.total = datasets.length;

    datasets.forEach((ds) => {
      const req = new requests.CStoreRequest(ds);
      req.on('response', (response) => {
        const status = response.getStatus();
        if (status === constants.Status.Success) sent++;
        else lastError = `C-STORE status=0x${status.toString(16)}`;
        ctl.progress.sent = sent;
        ctl.touch(); // 応答が来ている限りタイムアウトしない（遅い経路でも打ち切らない）
        if (--pending === 0) {
          // 部分成功は失敗として返す（ok は全件成功のときだけ）。
          // 呼出側が ok だけを見て「バッチ成功」と扱うと未送信分が失敗キューに残らず欠落するため。
          if (sent === datasets.length) settle({ ok: true, sent });
          else settle({ ok: false, sent, failed: datasets.length - sent, error: lastError || `C-STORE 部分失敗 (${sent}/${datasets.length})` });
        }
      });
      client.addRequest(req);
    });

    client.send(host, port, callingAet, calledAet);
  }, 60000); // 無応答 60 秒でタイムアウト（総時間ではない。応答が続く限り継続）

  // 呼出側がバッチ送信を続けられるよう、生成済 UID を必ず返す
  return { ...result, studyUID, seriesUID };
}

ipcMain.handle('dicom:queueFailure', async (_e, args = {}) => {
  if (!args.target || !args.patient) return { ok: false, error: 'invalid args' };
  // 同じフォルダの失敗記録が既にあれば、新規追加せず attempts を増やす
  // （送信リトライのたびにキューが際限なく増えるのを防ぐ）
  const existing = db.listPendingDicom().find(
    (it) => (it.dstPath || it.dst_path) === args.target
  );
  if (existing && existing.id != null) {
    db.updatePendingDicom(existing.id, {
      attempts: (existing.attempts || 0) + 1,
      lastError: args.error || existing.lastError || existing.last_error || null,
    });
    return { ok: true, deduped: true };
  }
  db.queueDicom({
    dstPath: args.target,
    patientId: args.patient.id || '',
    patientName: args.patient.nameRomaji || args.patient.name || '',
    procedure: args.patient.procedure || '',
    studyDate: args.patient.date || '',
  });
  return { ok: true };
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

module.exports = { generateUID };
