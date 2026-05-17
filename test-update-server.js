// アップデーターの単体テスト用ローカルHTTPサーバー
const http = require('http');
const url = require('url');

const PORT = parseInt(process.env.PORT || '8766', 10);

const manifests = {
  '/latest.json': {
    version: '0.2.0',
    pubDate: '2026-05-18',
    notes: 'テスト用の新版マニフェスト\n- 新機能A\n- バグ修正B',
    url: 'http://localhost:8766/手術データ管理-0.2.0-arm64.dmg',
    urlX64: 'http://localhost:8766/手術データ管理-0.2.0.dmg',
  },
  '/latest-old.json': {
    version: '0.0.5',
    pubDate: '2026-01-01',
    notes: '古いバージョン',
    url: 'http://localhost:8766/手術データ管理-0.0.5-arm64.dmg',
  },
  '/latest-same.json': {
    version: '0.1.0',
    pubDate: '2026-05-17',
    notes: '同一バージョン',
    url: 'http://localhost:8766/手術データ管理-0.1.0-arm64.dmg',
  },
  '/latest-bad.json': { /* no version */ },
};

const server = http.createServer((req, res) => {
  const p = url.parse(req.url).pathname;
  if (manifests[p] !== undefined) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifests[p]));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`Test update server on http://localhost:${PORT}`);
  console.log('endpoints:');
  for (const k of Object.keys(manifests)) console.log('  ' + k);
});
