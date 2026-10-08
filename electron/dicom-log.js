const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const FIELDS = {
  echo: ['host', 'port', 'calledAet', 'callingAet', 'ok', 'error', 'ms'],
  'send.start': ['host', 'port', 'calledAet', 'count', 'studyUID12', 'seriesUID12', 'startInstanceNumber'],
  'send.end': ['host', 'port', 'calledAet', 'count', 'studyUID12', 'seriesUID12', 'startInstanceNumber', 'ok', 'sent', 'failed', 'indeterminate', 'error', 'ms', 'bytesSent', 'activitySource', 'release', 'peerMaxPdu'],
  'send.timeout': ['sent', 'total'],
  'send.abort': ['sent', 'total'],
  'queue.add': ['id', 'dstPath', 'files', 'attempts', 'lastError'],
  'queue.update': ['id', 'dstPath', 'files', 'attempts', 'lastError'],
  'queue.remove': ['id', 'dstPath', 'files', 'attempts', 'lastError'],
  ui: ['level', 'text'],
};

function getPath() {
  return path.join(app.getPath('userData'), 'dicom-send.log');
}

function rotateIfNeeded() {
  const file = getPath();
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    // 1世代だけ残す。追記前に切り替えれば既存の行の途中を切らずに済む。
    fs.renameSync(file, file + '.1');
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('DICOM log rotation failed:', e);
  }
}

// 保存先フォルダ名は設定次第で患者 ID・氏名を含む（例: 2026-10-08_P0001_モモ_去勢術）。
// 日付（YYYY-MM-DD または YYYYMMDD）で始まるものは日付だけを残し、後ろは … にする。
// 日付で始まらない名前は中身を一切出さず、同じフォルダを突き合わせられる sha1 先頭 8 桁にする。
function redactDstPath(dstPath) {
  const leaf = path.basename(String(dstPath).replace(/[\\/]+$/, ''));
  const date = leaf.match(/^(?:\d{4}-\d{2}-\d{2}|\d{8})(?!\d)/);
  if (date) return date[0] + (leaf.length > date[0].length ? '…' : '');
  return crypto.createHash('sha1').update(leaf).digest('hex').slice(0, 8);
}

// エラー文のパスを [path] に伏せる。ただし「3/5」のような件数表記は消さない:
// `/` の直後が英字・_・.・非 ASCII のもの、`/` を 2 個以上含む連続文字列、ドライブ文字つきだけをパスとみなす。
function redactPaths(text) {
  return text.replace(/((?:[A-Za-z]:)?)([\\/][^\s,，;；)）]+)/g, (m, drive, rest) => {
    if (drive) return '[path]';
    if (/^[\\/][A-Za-z_.\u0080-\uFFFF]/.test(rest)) return '[path]';
    if ((rest.match(/[\\/]/g) || []).length >= 2) return '[path]';
    return m;
  });
}

function log(event, fields = {}) {
  try {
    if (!FIELDS[event]) return;
    const row = { at: new Date().toISOString(), event };
    for (const key of FIELDS[event]) {
      if (fields[key] === undefined) continue;
      if (key === 'dstPath') {
        row[key] = redactDstPath(fields[key]);
      } else if (key === 'studyUID12' || key === 'seriesUID12') {
        row[key] = String(fields[key]).slice(-12);
      } else if (key === 'error' || key === 'lastError') {
        // 例外文にファイルパスが混入する場合があるため、既知の患者情報とパスを除く。
        let value = String(fields[key]);
        for (const secret of [fields.patientName, fields.patientId, fields.dstPath].filter(Boolean)) {
          value = value.split(String(secret)).join('[patient]');
        }
        row[key] = redactPaths(value).slice(0, 500);
      } else {
        row[key] = fields[key];
      }
    }
    const file = getPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch (e) {
    // 診断ログの障害で送信結果や失敗キューの保存を変えてはいけない。
    console.warn('DICOM log write failed:', e);
  }
}

module.exports = { log, getPath, rotateIfNeeded };
