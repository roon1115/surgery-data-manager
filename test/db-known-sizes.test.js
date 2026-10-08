'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('旧記録の NAS stat 補完は初回のみで、サイズ集合は増分更新される', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'known-sizes-'));
  const dst = path.join(dir, 'legacy.jpg');
  fs.writeFileSync(dst, 'legacy');
  fs.writeFileSync(path.join(dir, 'ingest.json'), JSON.stringify({
    files: { legacy: { srcPath: '/sd/legacy.jpg', dstPath: dst } }, pending_dicom: [],
  }));
  const originalLoad = Module._load;
  const originalStat = fsp.stat;
  let statCount = 0;
  let db;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'electron' && parent?.filename?.endsWith('/electron/db.js')) {
        return { app: { getPath: () => dir } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    db = require('../electron/db.js');
    fsp.stat = async function(p, ...args) {
      if (p === dst) statCount++;
      return originalStat.call(this, p, ...args);
    };
    const first = await db.getKnownSizes();
    assert.ok(first.has(6));
    assert.equal(statCount, 1);
    const second = await db.getKnownSizes();
    assert.equal(second, first);
    assert.equal(statCount, 1);
    db.recordFile({ sha256: 'new', srcPath: '/sd/new.jpg', dstPath: '/nas/new.jpg', size: 9, mtime: 1 });
    assert.ok((await db.getKnownSizes()).has(9));
    assert.equal(statCount, 1);
  } finally {
    Module._load = originalLoad;
    fsp.stat = originalStat;
    if (db) db.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
