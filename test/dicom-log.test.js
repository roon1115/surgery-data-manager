'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dicom-log-test-'));
const originalLoad = Module._load;
let dicomLog;
try {
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => tmpdir } };
    return originalLoad.call(this, request, parent, isMain);
  };
  dicomLog = require('../electron/dicom-log.js');
} finally {
  Module._load = originalLoad;
}

test.after(() => fs.rmSync(tmpdir, { recursive: true, force: true }));

test('JSON Lines で1行ずつ同期追記する', () => {
  dicomLog.log('echo', { host: 'pacs.example', port: 104, ok: true, ms: 12 });
  const lines = fs.readFileSync(dicomLog.getPath(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).event, 'echo');
  assert.equal(JSON.parse(lines[0]).host, 'pacs.example');
});

test('患者名を含む dstPath は日付で始まらなければ sha1 先頭8桁にする', () => {
  const patient = 'PatientFullName';
  dicomLog.log('queue.add', { id: 1, dstPath: `/private/${patient}/2026-${patient}-surgery`, files: 2, attempts: 1 });
  const line = fs.readFileSync(dicomLog.getPath(), 'utf8').trim().split('\n').at(-1);
  const row = JSON.parse(line);
  assert.match(row.dstPath, /^[0-9a-f]{8}$/);
  assert.ok(!line.includes(patient));
  assert.ok(!line.includes('/private/'));
});

function lastRow() {
  return JSON.parse(fs.readFileSync(dicomLog.getPath(), 'utf8').trim().split('\n').at(-1));
}

test('dstPath: 日付で始まるフォルダ名は日付だけ残し、患者 ID・氏名は残さない', () => {
  dicomLog.log('queue.add', { id: 1, dstPath: '/x/2026-10-08_P0001_モモ_去勢術/', files: 1, attempts: 1 });
  const line = fs.readFileSync(dicomLog.getPath(), 'utf8').trim().split('\n').at(-1);
  assert.equal(JSON.parse(line).dstPath, '2026-10-08…');
  assert.ok(!line.includes('P0001') && !line.includes('モモ'));
  dicomLog.log('queue.add', { id: 1, dstPath: '/x/20261008_P0001', files: 1, attempts: 1 });
  assert.equal(lastRow().dstPath, '20261008…');
  dicomLog.log('queue.add', { id: 1, dstPath: '/x/2026-10-08', files: 1, attempts: 1 });
  assert.equal(lastRow().dstPath, '2026-10-08');
  // 日付の直後が数字（患者 ID の可能性）は日付とみなさない
  dicomLog.log('queue.add', { id: 1, dstPath: '/x/2026-10-081234', files: 1, attempts: 1 });
  assert.match(lastRow().dstPath, /^[0-9a-f]{8}$/);
});

test('dstPath: 日付で始まらないフォルダ名は sha1 先頭8桁（同じ名前は同じ値）', () => {
  const crypto = require('crypto');
  const expected = crypto.createHash('sha1').update('P0001_モモ').digest('hex').slice(0, 8);
  dicomLog.log('queue.add', { id: 1, dstPath: '/x/P0001_モモ', files: 1, attempts: 1 });
  const line = fs.readFileSync(dicomLog.getPath(), 'utf8').trim().split('\n').at(-1);
  assert.equal(JSON.parse(line).dstPath, expected);
  assert.equal(expected.length, 8);
  assert.ok(!line.includes('P0001') && !line.includes('モモ'));
});

test('エラー文: 3/5 のような件数表記は残し、パスだけ [path] にする', () => {
  dicomLog.log('echo', { ok: false, error: 'C-STORE 部分失敗 (3/5)' });
  assert.equal(lastRow().error, 'C-STORE 部分失敗 (3/5)');
  dicomLog.log('echo', { ok: false, error: '受理済み 3/5 枚' });
  assert.equal(lastRow().error, '受理済み 3/5 枚');
  dicomLog.log('echo', { ok: false, error: 'ENOENT: open /Users/me/photos/a.jpg failed' });
  assert.equal(lastRow().error, 'ENOENT: open [path] failed');
  dicomLog.log('echo', { ok: false, error: 'read C:\\Users\\me\\a.jpg and /_tmp/x and /.hidden and /日本語/a' });
  assert.equal(lastRow().error, 'read [path] and [path] and [path] and [path]');
  // / を 2 個以上含む連続文字列は数字始まりでもパス扱い
  dicomLog.log('echo', { ok: false, error: 'open /2026-10-08/file.dcm failed' });
  assert.equal(lastRow().error, 'open [path] failed');
});

test('2MB を超えたログを1世代ローテートする', () => {
  const old = 'x'.repeat(2 * 1024 * 1024 + 1);
  fs.writeFileSync(dicomLog.getPath(), old);
  dicomLog.log('echo', { ok: false, error: 'timeout' });
  assert.equal(fs.readFileSync(dicomLog.getPath() + '.1', 'utf8'), old);
  const rows = fs.readFileSync(dicomLog.getPath(), 'utf8').trim().split('\n');
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]).error, 'timeout');
});

// 実通信を使わず、C-STORE の全応答後に association 解放を待つ契約を確認する。
function loadRunClient() {
  class Client extends EventEmitter {
    abort() { setImmediate(() => this.emit('closed')); }
    getStatistics() { return { getBytesSent: () => 42, getBytesReceived: () => 0 }; }
  }
  const oldLoad = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { ipcMain: { handle() {} }, app: { getPath: () => tmpdir } };
      if (request === 'dcmjs-dimse') return { Client };
      if (parent?.filename?.endsWith('dicom-handler.js') && (request === './settings-handler' || request === './db')) return {};
      return oldLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../electron/dicom-handler.js')];
    return require('../electron/dicom-handler.js').runClient;
  } finally {
    Module._load = oldLoad;
  }
}

test('全 C-STORE 応答後も associationReleased まで確定しない', async () => {
  const runClient = loadRunClient();
  let client;
  let done = false;
  const pending = runClient((c, _settle, ctl) => {
    client = c;
    ctl.progress.total = 1;
    ctl.progress.sent = 1;
    ctl.settleAfterRelease({ ok: true, sent: 1 });
  }, 100, 'send').then((result) => { done = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  client.emit('associationReleased');
  const result = await pending;
  assert.equal(result.release, 'released');
  assert.equal(result.bytesSent, 42);
});

test('無応答タイムアウトは従来どおり abort と closed を待つ', async () => {
  const runClient = loadRunClient();
  const result = await runClient((_client, _settle, ctl) => { ctl.progress.total = 2; }, 10, 'send');
  assert.equal(result.indeterminate, true);
  assert.equal(result.failed, 2);
  assert.equal(result.release, undefined);
});

// ---- 活動監視・ログ・キューログの契約 ----
function loadHandler({ Client, settingsStub = {}, dbStub = {}, dimseBase = {} } = {}) {
  const handlers = {};
  const oldLoad = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron') return { ipcMain: { handle(name, fn) { handlers[name] = fn; } }, app: { getPath: () => tmpdir } };
      if (request === 'dcmjs-dimse') return { ...dimseBase, Client: Client || class extends EventEmitter {} };
      if (parent?.filename?.endsWith('dicom-handler.js') && request === './settings-handler') return settingsStub;
      if (parent?.filename?.endsWith('dicom-handler.js') && request === './db') return dbStub;
      return oldLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../electron/dicom-handler.js')];
    return { mod: require('../electron/dicom-handler.js'), handlers };
  } finally {
    Module._load = oldLoad;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Date.now だけを進める偽の時計（setTimeout は実時間のまま）。「書き込み待ちは 10 分まで進捗扱い」の
// 10 分を実際に待たずに越えるために使う。必ず restore() すること。
const PDU_TIMEOUT_MS = 10 * 60 * 1000;
function fakeClock() {
  const real = Date.now;
  let offset = 0;
  Date.now = () => real.call(Date) + offset;
  return { advance(ms) { offset += ms; }, restore() { Date.now = real; } };
}

test('活動監視: 送信中に生きている socket の送出量が動く間は無応答タイムアウトしない', async () => {
  // Client.getStatistics() は close まで 0 のまま（実物と同じ）。network.socket だけが進む。
  class Client extends EventEmitter {
    constructor() {
      super();
      this.network = { socket: { bytesWritten: 0, writableLength: 0, bytesRead: 0 } };
      this.tick = setInterval(() => {
        if (this.network) { this.network.socket.bytesWritten += 1000; }
      }, 20);
    }
    abort() { clearInterval(this.tick); setImmediate(() => this.emit('closed')); }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  }
  const { mod } = loadHandler({ Client });
  let client;
  const started = Date.now();
  const pending = mod.runClient((c, _settle, ctl) => {
    client = c;
    ctl.progress.total = 1;
    // 400ms 後に送信完了（応答）。無応答 150ms のタイムアウトなら、それより前に abort されるはず。
    setTimeout(() => { clearInterval(client.tick); ctl.progress.sent = 1; ctl.settleAfterRelease({ ok: true, sent: 1 }); client.emit('associationReleased'); }, 400);
  }, 150, 'send', 30);
  const result = await pending;
  assert.ok(Date.now() - started >= 380);
  assert.equal(result.ok, true);
  assert.equal(result.indeterminate, undefined);
  assert.equal(result.activitySource, 'socket');
  assert.ok(result.bytesSent > 0, 'socket から bytesSent が取れる');
});

test('活動監視: 送出量が止まり、書き込み待ちのまま 10 分を超えれば timeoutMs 後に abort される（socket 経路）', async () => {
  class Client extends EventEmitter {
    constructor() { super(); this.network = { socket: { bytesWritten: 500, writableLength: 100, bytesRead: 0 } }; }
    abort() { setImmediate(() => this.emit('closed')); }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  }
  const { mod } = loadHandler({ Client });
  const clock = fakeClock();
  try {
    const started = Date.now();
    const result = await mod.runClient((_c, _s, ctl) => {
      ctl.progress.total = 2;
      setTimeout(() => clock.advance(PDU_TIMEOUT_MS + 1000), 80); // 最後の実進捗（最初の確認）から 10 分超
    }, 150, 'send', 30);
    assert.ok(Date.now() - started - (PDU_TIMEOUT_MS + 1000) < 1500, '偽の時計の進み分を除いて 1.5 秒未満');
    assert.equal(result.indeterminate, true);
    assert.equal(result.activitySource, 'socket');
    assert.equal(result.bytesSent, 400, 'bytesWritten - writableLength（実際に送り出せた分）');
  } finally { clock.restore(); }
});

test('活動監視: 書き込み待ちが無く送出量も止まれば（socket 経路）従来どおり timeoutMs 後に abort される', async () => {
  class Client extends EventEmitter {
    constructor() { super(); this.network = { socket: { bytesWritten: 500, writableLength: 0, bytesRead: 0 } }; }
    abort() { setImmediate(() => this.emit('closed')); }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  }
  const { mod } = loadHandler({ Client });
  const started = Date.now();
  const result = await mod.runClient((_c, _s, ctl) => { ctl.progress.total = 2; }, 150, 'send', 30);
  assert.ok(Date.now() - started < 1500);
  assert.equal(result.indeterminate, true);
  assert.equal(result.bytesSent, 500);
});

test('活動監視: bytesWritten がキューで全量に跳ねても、writableLength が減らず 10 分を超えれば進捗とみなさない', async () => {
  class Client extends EventEmitter {
    constructor() { super(); this.network = { socket: { bytesWritten: 9_999_999, writableLength: 9_999_999, bytesRead: 0 } }; }
    abort() { setImmediate(() => this.emit('closed')); }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  }
  const { mod } = loadHandler({ Client });
  const clock = fakeClock();
  try {
    const result = await mod.runClient((_c, _s, ctl) => {
      ctl.progress.total = 1;
      setTimeout(() => clock.advance(PDU_TIMEOUT_MS + 1000), 80);
    }, 150, 'send', 30);
    assert.equal(result.indeterminate, true);
    assert.equal(result.bytesSent, undefined, '送り出せた量が 0 ならフィールドを出さない');
  } finally { clock.restore(); }
});

test('活動監視: socket が無ければ network 統計、それも無ければ client 統計、全部無ければ none', async () => {
  const mk = (extra) => class extends EventEmitter {
    constructor() { super(); Object.assign(this, extra); }
    abort() { setImmediate(() => this.emit('closed')); }
  };
  const stats = (n) => ({ getBytesSent: () => n, getBytesReceived: () => 0 });
  const run = async (Client) => {
    const { mod } = loadHandler({ Client });
    return mod.runClient((_c, _s, ctl) => { ctl.progress.total = 1; }, 60, 'send', 20);
  };
  const net = await run(mk({ network: { getStatistics: () => stats(7) } }));
  assert.equal(net.activitySource, 'network');
  assert.equal(net.bytesSent, 7);
  const cli = await run(mk({ getStatistics: () => stats(9) }));
  assert.equal(cli.activitySource, 'client');
  assert.equal(cli.bytesSent, 9);
  const none = await run(mk({}));
  assert.equal(none.activitySource, 'none');
  assert.equal('bytesSent' in none, false);
});

test('send.end に activitySource が残る（FIELDS を通る）', () => {
  dicomLog.log('send.end', { ok: true, activitySource: 'socket', bytesSent: 10, count: 1 });
  assert.equal(lastRow().activitySource, 'socket');
  assert.equal(lastRow().bytesSent, 10);
});

test('sendStudyImpl の早期 return（設定不完全・画像 0 枚）も send.end に残る', async () => {
  const cfg = { dicom: { host: '', port: 104, calledAet: 'X', callingAet: 'Y' } };
  const { mod } = loadHandler({ settingsStub: { getAll: () => cfg } });
  const r1 = await mod.sendStudyImpl({});
  assert.equal(r1.ok, false);
  let row = lastRow();
  assert.equal(row.event, 'send.end');
  assert.equal(row.ok, false);
  assert.match(row.error, /設定が不完全/);
  assert.equal(row.count, 0);

  const cfg2 = { dicom: { host: 'pacs.example', port: 104, calledAet: 'X', callingAet: 'Y' } };
  const { mod: mod2 } = loadHandler({ settingsStub: { getAll: () => cfg2 } });
  const r2 = await mod2.sendStudyImpl({ decodedImages: [] });
  assert.equal(r2.ok, false);
  row = lastRow();
  assert.equal(row.event, 'send.end');
  assert.equal(row.ok, false);
  assert.match(row.error, /送信対象の画像がありません/);
  assert.equal(row.host, 'pacs.example');
});

test('失敗キューのログ用検索が例外を出しても、DB 更新と IPC の結果は変わらない', async () => {
  const calls = [];
  const dbStub = {
    listPendingDicom: () => { throw new Error('list failed'); },
    updatePendingDicom: (id, data) => { calls.push(['update', id, data]); },
    queueDicom: () => 42,
  };
  const { handlers } = loadHandler({ dbStub });
  const r1 = await handlers['dicom:updatePending']({}, { id: 5, attempts: 3 });
  assert.deepEqual(r1, { ok: true, id: 5 });
  assert.deepEqual(calls, [['update', 5, { attempts: 3 }]]);
  const r2 = await handlers['dicom:removePending']({}, { id: 5 });
  assert.deepEqual(r2, { ok: true });
  assert.deepEqual(calls.at(-1), ['update', 5, { remove: true }]);

  // 本体の検索は成功し、ログ用の検索（2 回目以降）だけ失敗する場合でも追加は成功する
  let n = 0;
  const dbStub2 = {
    listPendingDicom: () => { if (++n > 1) throw new Error('log lookup failed'); return []; },
    updatePendingDicom() {},
    queueDicom: () => 7,
  };
  const { handlers: h2 } = loadHandler({ dbStub: dbStub2 });
  const r3 = await h2['dicom:queueFailure']({}, { target: '/x/2026-10-08_A', patient: { id: 'A' }, files: [{ path: '/x/a.jpg' }] });
  assert.deepEqual(r3, { ok: true, id: 7 });
});

test('removePending: 削除前に控えた記録で queue.remove がログされる', async () => {
  const rec = { id: 9, dstPath: '/x/2026-10-08_A', files: [{ path: 'a' }], attempts: 2 };
  let removed = false;
  const dbStub = {
    listPendingDicom: () => (removed ? [] : [rec]),
    updatePendingDicom: () => { removed = true; },
  };
  const { handlers } = loadHandler({ dbStub });
  await handlers['dicom:removePending']({}, { id: 9 });
  const row = lastRow();
  assert.equal(row.event, 'queue.remove');
  assert.equal(row.id, 9);
  assert.equal(row.files, 1);
  assert.equal(row.dstPath, '2026-10-08…');
});


// ---- 指摘対応（2026-10-08 敵対的レビュー 2 巡目）の回帰試験 ----

test('書き込み待ち（writableLength>0 / writableNeedDrain）がある間は 10 分まで進捗扱い、10 分超で abort', async () => {
  const mkClient = (socket, hooks) => class extends EventEmitter {
    constructor() { super(); this.network = { socket: { bytesRead: 0, ...socket } }; }
    abort() { hooks.onAbort(); setImmediate(() => this.emit('closed')); }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  };
  // 書き込み待ちが残る socket（バイトは動かない）。timeoutMs=100 なので、進捗扱いが効かなければ 100ms 台で abort される。
  for (const socket of [
    { bytesWritten: 500, writableLength: 100 },
    { bytesWritten: 500, writableLength: 0, writableNeedDrain: true },
  ]) {
    const clock = fakeClock();
    try {
      let jumped = false;
      let abortedBeforeJump = null;
      const { mod } = loadHandler({ Client: mkClient(socket, { onAbort: () => { abortedBeforeJump = !jumped; } }) });
      const started = Date.now();
      const result = await mod.runClient((_c, _s, ctl) => {
        ctl.progress.total = 1;
        setTimeout(() => { jumped = true; clock.advance(PDU_TIMEOUT_MS + 1000); }, 300);
      }, 100, 'send', 20);
      assert.equal(abortedBeforeJump, false, `10 分を超えるまでは abort しない: ${JSON.stringify(socket)}`);
      assert.ok(Date.now() - started - (PDU_TIMEOUT_MS + 1000) >= 280, '偽の時計の進み分を除いても 300ms 近く待っている');
      assert.equal(result.indeterminate, true);
    } finally { clock.restore(); }
  }
  // 10 分以内に全応答が来れば通常終了（誤って打ち切らない）
  const { mod } = loadHandler({ Client: mkClient({ bytesWritten: 500, writableLength: 100 }, { onAbort() { assert.fail('abort されてはならない'); } }) });
  const ok = await mod.runClient((c, _s, ctl) => {
    ctl.progress.total = 1;
    setTimeout(() => { ctl.progress.sent = 1; ctl.settleAfterRelease({ ok: true, sent: 1 }); c.emit('associationReleased'); }, 350);
  }, 100, 'send', 20);
  assert.equal(ok.ok, true);
  assert.equal(ok.indeterminate, undefined);
});

test('応答が 1 件だけ返った後に closed が来たら、indeterminate・sent=1 で即確定する', async () => {
  class Client extends EventEmitter {
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  }
  const { mod } = loadHandler({ Client });
  const started = Date.now();
  const result = await mod.runClient((c, _s, ctl) => {
    const results = new Array(3);
    ctl.progress.total = 3;
    ctl.progress.results = results;
    results[0] = { index: 0, ok: true, status: 0 };
    ctl.progress.sent = 1;
    setImmediate(() => c.emit('closed'));
  }, 120000, 'send', 2000);
  assert.ok(Date.now() - started < 1000, '無進捗タイムアウト（120 秒）を待たずに確定する');
  assert.equal(result.ok, false);
  assert.equal(result.indeterminate, true);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1], undefined, '未応答は runClient 段階では空（sendStudyImpl が ok:false で補う）');
  assert.match(result.error, /接続が相手側で閉じられました（受理済み 1\/3 枚/);
});

// sendStudyImpl を実ライブラリの Dataset/CStoreRequest + 偽 Client で通す（Client.send 以降だけ偽物）。
function loadSendStudy(onSend) {
  const real = require('dcmjs-dimse');
  class Client extends EventEmitter {
    constructor() { super(); this.reqs = []; }
    addRequest(r) { this.reqs.push(r); }
    send(...args) { this.sendArgs = args; this.network = new EventEmitter(); onSend(this); }
    abort() { setImmediate(() => this.emit('closed')); }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  }
  const cfg = { dicom: { host: 'pacs.example', port: 104, calledAet: 'X', callingAet: 'Y' } };
  const h = loadHandler({ Client, dimseBase: real, settingsStub: { getAll: () => cfg } });
  return h.mod;
}
const tinyImages = (n) => Array.from({ length: n }, () => ({ width: 2, height: 2, rgb: new Uint8Array(12) }));

test('sendStudyImpl: 1 件だけ応答後に closed → 未応答は ok:false で即確定。pduTimeout は 600000、peerMaxPdu がログに残る', async () => {
  let sendArgs;
  const mod = loadSendStudy((client) => {
    sendArgs = client.sendArgs;
    setImmediate(() => {
      client.emit('associationAccepted', { getMaxPduLength: () => 16384 });
      client.reqs[0].emit('response', { getStatus: () => 0 }); // Success
      setImmediate(() => client.emit('closed'));
    });
  });
  const started = Date.now();
  const r = await mod.sendStudyImpl({ decodedImages: tinyImages(3), patient: { id: 'P1', name: 'N' }, exam: {} });
  assert.ok(Date.now() - started < 3000);
  assert.equal(sendArgs[4].pduTimeout, 600000, 'client.send の第 5 引数に pduTimeout: 600000');
  assert.equal(r.ok, false);
  assert.equal(r.indeterminate, true);
  assert.equal(r.sent, 1);
  assert.equal(r.failed, 2);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[1].ok, false);
  assert.equal(r.results[2].ok, false);
  assert.equal(r.peerMaxPdu, 16384);
  const row = lastRow();
  assert.equal(row.event, 'send.end');
  assert.equal(row.peerMaxPdu, 16384);
  assert.equal(row.sent, 1);
});

test('sendStudyImpl: 相手の最大 PDU 長が取れなければ peerMaxPdu を出さない', async () => {
  const mod = loadSendStudy((client) => {
    setImmediate(() => {
      client.emit('associationAccepted', {}); // getMaxPduLength なし
      client.reqs[0].emit('response', { getStatus: () => 0 });
      setImmediate(() => client.emit('closed'));
    });
  });
  const r = await mod.sendStudyImpl({ decodedImages: tinyImages(1), patient: {}, exam: {} });
  assert.equal('peerMaxPdu' in r, false);
  assert.equal('peerMaxPdu' in lastRow(), false);
});

test('正常終了の順序（全応答 → closed → released）では release は closed', async () => {
  const runClient = loadRunClient();
  const result = await runClient((c, _s, ctl) => {
    ctl.progress.total = 1;
    ctl.progress.sent = 1;
    ctl.settleAfterRelease({ ok: true, sent: 1 });
    setImmediate(() => { c.emit('closed'); c.emit('associationReleased'); });
  }, 120000, 'send');
  assert.equal(result.ok, true);
  assert.equal(result.release, 'closed');
});

test('相手が A-ABORT だけ送って接続を閉じなくても、即 indeterminate で確定しソケットを破棄する', async () => {
  let destroyed = 0;
  class Client extends EventEmitter {
    send() { this.network = new EventEmitter(); this.network.socket = { destroy() { destroyed++; } }; }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  }
  const { mod } = loadHandler({ Client });
  const started = Date.now();
  const result = await mod.runClient((c, _s, ctl) => {
    ctl.progress.total = 2;
    ctl.progress.sent = 1;
    ctl.progress.results = [{ index: 0, ok: true }, undefined];
    c.send(); // 実物と同様、send() が network を作る（setup 内）
    setImmediate(() => c.network.emit('abort', { source: 0, reason: 0 }));
  }, 120000, 'send', 2000);
  assert.ok(Date.now() - started < 1000, '無進捗タイムアウト（120 秒）を待たない');
  assert.equal(result.ok, false);
  assert.equal(result.indeterminate, true);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].ok, true);
  assert.match(result.error, /相手側から A-ABORT を受信しました（受理済み 1\/2 枚/);
  assert.equal(destroyed, 1, '相手が閉じないので自分でソケットを破棄する');
});

test('全応答後の解放待ち中に A-ABORT を受けたら release=abort で確定する（成功扱いは変えない）', async () => {
  class Client extends EventEmitter {
    send() { this.network = new EventEmitter(); this.network.socket = { destroy() {} }; }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  }
  const { mod } = loadHandler({ Client });
  const result = await mod.runClient((c, _s, ctl) => {
    ctl.progress.total = 1;
    ctl.progress.sent = 1;
    c.send();
    ctl.settleAfterRelease({ ok: true, sent: 1 });
    setImmediate(() => c.network.emit('abort', {}));
  }, 120000, 'send', 2000);
  assert.equal(result.ok, true);
  assert.equal(result.release, 'abort');
});

test('タイムアウト時に closed が来ないまま 5 秒（試験では短縮）で確定するときだけソケットを destroy する', async () => {
  let destroyed = 0;
  const mk = (emitClosed) => class extends EventEmitter {
    constructor() { super(); this.network = { socket: { destroy() { destroyed++; } } }; }
    abort() { if (emitClosed) setImmediate(() => this.emit('closed')); }
    getStatistics() { return { getBytesSent: () => 0, getBytesReceived: () => 0 }; }
  };
  // closed が来ない → closeGrace 経由で確定 → destroy
  const { mod } = loadHandler({ Client: mk(false) });
  const r1 = await mod.runClient((_c, _s, ctl) => { ctl.progress.total = 1; }, 20, 'send', 2000, 40);
  assert.equal(r1.indeterminate, true);
  assert.equal(destroyed, 1);
  // closed が来る → destroy しない
  const { mod: mod2 } = loadHandler({ Client: mk(true) });
  const r2 = await mod2.runClient((_c, _s, ctl) => { ctl.progress.total = 1; }, 20, 'send', 2000, 40);
  assert.equal(r2.indeterminate, true);
  assert.equal(destroyed, 1, 'closed 済みなら破棄しない');
});
