'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// dicom-handler.js は electron / 設定 / DB を読み込むので、読み込み時だけ空の代役に差し替える。
const originalLoad = Module._load;
let handler;
try {
  Module._load = function(request, parent, isMain) {
    if (parent?.filename?.endsWith('/electron/dicom-handler.js')) {
      if (request === 'electron') return { ipcMain: { handle() {} } };
      if (request === './settings-handler' || request === './db' || request === './dicom-log') return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  handler = require('../electron/dicom-handler.js');
} finally {
  Module._load = originalLoad;
}
const { readVerifiedSourceImpl } = handler;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-src-'));
const write = (name, data) => { const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };

test('SHA-256 が一致したときだけ bytes を返す', async () => {
  const data = Buffer.from('case-A-photo-bytes');
  const p = write('a.jpg', data);
  const r = await readVerifiedSourceImpl({ path: p, sha256: sha(data) });
  assert.equal(r.ok, true);
  assert.ok(r.bytes instanceof Uint8Array);
  assert.deepEqual(Buffer.from(r.bytes), data);
  // 大文字 hex でも照合できる
  assert.equal((await readVerifiedSourceImpl({ path: p, sha256: sha(data).toUpperCase() })).ok, true);
});

test('同じパスに別の写真が来たら（SD 差し替え）ok:false で bytes を返さない', async () => {
  const p = write('b.jpg', 'case-A');
  const shaA = sha(Buffer.from('case-A'));
  fs.writeFileSync(p, 'case-B-different');
  const r = await readVerifiedSourceImpl({ path: p, sha256: shaA });
  assert.deepEqual(r, { ok: false, reason: 'sha-mismatch' });
});

test('読めない・引数不正・ディレクトリ・大きさ上限超えは ok:false', async () => {
  const good = 'b'.repeat(64);
  assert.deepEqual(await readVerifiedSourceImpl({ path: path.join(dir, 'none.jpg'), sha256: good }), { ok: false, reason: 'read-failed' });
  assert.equal((await readVerifiedSourceImpl({ path: 'relative.jpg', sha256: good })).reason, 'invalid-args');
  assert.equal((await readVerifiedSourceImpl({ path: path.join(dir, 'x'), sha256: 'zz' })).reason, 'invalid-args');
  assert.equal((await readVerifiedSourceImpl({})).reason, 'invalid-args');
  assert.equal((await readVerifiedSourceImpl({ path: dir, sha256: good })).ok, false);
  const big = write('big.jpg', Buffer.alloc(2048, 1));
  const r = await readVerifiedSourceImpl({ path: big, sha256: sha(Buffer.alloc(2048, 1)) }, { maxBytes: 1024 });
  assert.deepEqual(r, { ok: false, reason: 'too-large' });
});

test('読み込みが終わらないときは時間切れで ok:false', async () => {
  const fsp = require('node:fs/promises');
  const p = write('slow.jpg', 'slow');
  const originalOpen = fsp.open;
  fsp.open = () => new Promise(() => {}); // SD/共有ドライブが応答しない状態
  try {
    const started = Date.now();
    const r = await readVerifiedSourceImpl({ path: p, sha256: sha(Buffer.from('slow')) }, { timeoutMs: 50 });
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
    assert.ok(Date.now() - started < 2000);
  } finally {
    fsp.open = originalOpen;
  }
});
