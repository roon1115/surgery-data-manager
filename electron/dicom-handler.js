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

function runClient(setup, timeoutMs = 30000) {
  if (!dimse) return Promise.resolve({ ok: false, error: 'dcmjs-dimse not installed' });
  const { Client } = dimse;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(value);
    };
    const t = setTimeout(() => settle({ ok: false, error: 'timeout' }), timeoutMs);

    const client = new Client();
    client.on('networkError', (err) => settle({ ok: false, error: `network: ${err?.message || err}` }));
    client.on('associationRejected', () => settle({ ok: false, error: 'association rejected' }));
    client.on('associationReleased', () => { /* normal close */ });

    try {
      setup(client, settle);
    } catch (e) {
      settle({ ok: false, error: String(e?.message || e) });
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

ipcMain.handle('dicom:sendStudy', async (_e, args = {}) => {
  if (!dimse) return { ok: false, error: 'dcmjs-dimse not installed' };
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
  const studyUID = generateUID();
  const seriesUID = generateUID();

  let datasets;
  try {
    datasets = decodedImages.map((img, i) => buildDataset({
      patient, exam, studyUID, seriesUID,
      sopUID: generateUID(),
      modality, charset,
      instanceNumber: i + 1,
      width: img.width,
      height: img.height,
      rgb: new Uint8Array(img.rgb),
      transferSyntax,
    }));
  } catch (e) {
    return { ok: false, error: `dataset構築失敗: ${e?.message || e}` };
  }

  return await runClient((client, settle) => {
    const { requests, constants } = dimse;
    let sent = 0;
    let lastError = null;
    let pending = datasets.length;

    datasets.forEach((ds) => {
      const req = new requests.CStoreRequest(ds);
      req.on('response', (response) => {
        const status = response.getStatus();
        if (status === constants.Status.Success) sent++;
        else lastError = `C-STORE status=0x${status.toString(16)}`;
        if (--pending === 0) {
          if (sent === datasets.length) settle({ ok: true, sent });
          else settle({ ok: sent > 0, sent, error: lastError });
        }
      });
      client.addRequest(req);
    });

    client.send(host, port, callingAet, calledAet);
  });
});

ipcMain.handle('dicom:queueFailure', async (_e, args = {}) => {
  if (!args.target || !args.patient) return { ok: false, error: 'invalid args' };
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

module.exports = { generateUID };
