'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../www/js/decode.js'), 'utf8');

test('画像イベントが返らなくても時間切れでデコード失敗になり、読み込みを取り消す', async () => {
  const images = [];
  class SilentImage {
    constructor() { images.push(this); }
    set src(value) { this.url = value; }
  }
  const context = { window: {}, Image: SilentImage, setTimeout, clearTimeout, encodeURI, Uint8Array, Error };
  vm.runInNewContext(source, context);
  await assert.rejects(context.window.Decode.readFileUrlAsRgb('/nas/photo.jpg', 5), (e) => {
    assert.match(e.message, /image load timeout/);
    assert.equal(e.decodeTimeout, true);
    return true;
  });
  assert.equal(images[0].onload, null);
  assert.equal(images[0].onerror, null);
  assert.equal(images[0].url, ''); // 打ち切り後に読み込みが続かない
});

test('decodeToRgb は画像 1 枚に 60 秒の期限を設定する', async () => {
  let scheduled;
  class SilentImage { set src(value) { this.url = value; } }
  const context = {
    window: {}, Image: SilentImage,
    setTimeout: (fn, ms) => { scheduled = { fn, ms }; return 1; },
    clearTimeout: () => {}, encodeURI, Uint8Array, Error,
  };
  vm.runInNewContext(source, context);
  const pending = context.window.Decode.decodeToRgb('/nas/photo.jpg');
  assert.equal(scheduled.ms, 60000);
  scheduled.fn();
  await assert.rejects(pending, /image load timeout/);
});

test('decodeBytesToRgb は Blob URL で読み、時間切れでも revoke する／未対応形式は読まない', async () => {
  const created = [];
  const revoked = [];
  const images = [];
  class SilentImage {
    constructor() { images.push(this); }
    set src(value) { this.url = value; }
  }
  class FakeBlob { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } }
  const context = {
    window: {}, Image: SilentImage, Blob: FakeBlob, setTimeout, clearTimeout, encodeURI, Uint8Array, Error,
    URL: {
      createObjectURL: (b) => { created.push(b); return 'blob:fake/1'; },
      revokeObjectURL: (u) => revoked.push(u),
    },
  };
  vm.runInNewContext(source, context);
  await assert.rejects(context.window.Decode.decodeBytesToRgb(new Uint8Array([1]), '/sd/IMG.JPG', 5), /image load timeout/);
  assert.equal(created[0].type, 'image/jpeg');
  assert.deepEqual(revoked, ['blob:fake/1']);
  await assert.rejects(context.window.Decode.decodeBytesToRgb(new Uint8Array([1]), '/sd/IMG.HEIC', 5), /Canvas未対応形式/);
  assert.equal(created.length, 1); // 未対応形式では Blob を作らない
});
