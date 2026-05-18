/**
 * デバッグ用: Electron 起動時に環境変数 SDM_DEBUG_FLOW=1 を渡すと
 * 各 IPC ハンドラ・主要ビューを順番に検査して結果を stdout に出力する。
 *
 * 実行: SDM_DEBUG_FLOW=1 npx electron .
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.env.SDM_DEBUG_FLOW !== '1') return;

console.log('[debug-flow] activated');

async function runChecks(win) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdm-debug-'));
  const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'sdm-src-'));

  // ダミーファイルを作成
  fs.writeFileSync(path.join(tmpSrc, 'photo1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0,0,0,0]));
  fs.writeFileSync(path.join(tmpSrc, 'photo2.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0,0,0,0]));
  fs.writeFileSync(path.join(tmpSrc, 'video.mp4'), Buffer.alloc(1024, 0x41));
  fs.writeFileSync(path.join(tmpSrc, 'anesthesia.csv'), 'time,bp,hr\n0,120,80\n');
  fs.writeFileSync(path.join(tmpSrc, 'unknown.xyz'), 'unknown');

  console.log('[debug-flow] tmpRoot=', tmpRoot);
  console.log('[debug-flow] tmpSrc=', tmpSrc);

  // IPC handler は ipcMain.handle で登録されている。
  // 直接呼ぶには webContents から invoke するか、内部で関数経由でテストするしかない。
  // ここではレンダラに executeJavaScript で IPC を呼び出してもらう。
  const wc = win.webContents;
  await wc.executeJavaScript(`window.__debugFlow = ${JSON.stringify({ tmpRoot, tmpSrc })};`);

  const script = `
    (async () => {
      const log = (...args) => console.log('[debug-flow renderer]', ...args);
      const errLog = (label, e) => console.error('[debug-flow renderer ERR]', label, e && (e.stack || e.message || e));
      const { tmpRoot, tmpSrc } = window.__debugFlow;
      try {
        log('1. settings.save');
        await window.App.settings.save({ outputRoot: tmpRoot, dicom: { host: '127.0.0.1', port: 4242, calledAet: 'TEST', callingAet: 'SURGERY' } });
        const s = await window.App.settings.get();
        log('   settings:', JSON.stringify({outputRoot: s.outputRoot, host: s.dicom.host}));

        log('2. listVolumes');
        const vols = await window.App.ingest.listVolumes();
        log('   ok:', vols.ok, 'count:', vols.volumes && vols.volumes.length);

        log('3. scanSource on tmpSrc');
        const scan = await window.App.ingest.scanSource({ sourcePath: tmpSrc });
        log('   ok:', scan.ok, 'files:', scan.files && scan.files.length, 'summary:', JSON.stringify(scan.summary));

        log('4. prepareTarget');
        const patient = { id: 'P0001', name: 'モモ', nameRomaji: 'MOMO', procedure: '去勢術', date: '2026-05-17' };
        const prep = await window.App.ingest.prepareTarget({ patient, date: patient.date, onCollision: 'rename' });
        log('   ok:', prep.ok, 'target:', prep.target, 'folderName:', prep.folderName);

        log('5. ingest.start (no diff)');
        const filesToCopy = scan.files.map(f => ({ ...f, selected: true, isSurgicalPhoto: f.kind === 'photo' }));
        const r = await window.App.ingest.start({ target: prep.target, files: filesToCopy, patient, useHashDiff: false });
        log('   ok:', r.ok, 'copied:', r.copied, 'skipped:', r.skippedDup, 'failed:', r.failed, 'dicom:', r.dicomCandidates && r.dicomCandidates.length);

        log('6. ingest.start (with diff, 2nd run — should record hashes)');
        const r2 = await window.App.ingest.start({ target: prep.target, files: filesToCopy, patient, useHashDiff: true });
        log('   ok:', r2.ok, 'copied:', r2.copied, 'skipped:', r2.skippedDup, 'failed:', r2.failed);

        log('6b. ingest.start (with diff, 3rd run — now all should be skipped)');
        const r3 = await window.App.ingest.start({ target: prep.target, files: filesToCopy, patient, useHashDiff: true });
        log('   ok:', r3.ok, 'copied:', r3.copied, 'skipped:', r3.skippedDup, 'failed:', r3.failed);

        log('7. utils.toRomaji');
        const romaji = window.U.toRomaji('モモタロウ');
        log('   モモタロウ →', romaji);

        log('8. App.toRomaji (preload)');
        log('   ジョン →', window.App.toRomaji('ジョン'));

        log('9. dicom.echo (期待: 失敗 — サーバー無し)');
        const echo = await window.App.dicom.echo({});
        log('   ok:', echo.ok, 'error:', echo.error);

        log('9b. dicom.sendStudy with synthetic image (期待: dataset構築は成功するがnetwork失敗)');
        // 2x2 dummy RGB image
        const rgb = new Uint8Array([255,0,0, 0,255,0, 0,0,255, 128,128,128]);
        const study = await window.App.dicom.sendStudy({
          patient: { id: 'P0001', name: 'モモ', nameRomaji: 'MOMO' },
          exam: { datetime: '2026-05-17T10:00:00', desc: 'orchiectomy' },
          decodedImages: [{ width: 2, height: 2, rgb: Array.from(rgb) }],
        });
        log('   ok:', study.ok, 'error:', study.error, 'sent:', study.sent);
        // Patient.name は 'モモ' でも内部で nameRomaji を使うわけではない（呼び出し側責任）。
        // 呼び出し側は nameRomaji を渡す。送信時 ASCII フィルタで非ASCII文字は除去。

        log('9c. ASCII フィルタ確認 — patient.name=モモ で送信した場合に空になるか');
        const study2 = await window.App.dicom.sendStudy({
          patient: { id: 'P0002', name: 'モモ' },  // 非ASCII
          exam: { datetime: '2026-05-17T10:00:00', desc: '去勢術' },
          decodedImages: [{ width: 2, height: 2, rgb: Array.from(rgb) }],
        });
        log('   ok:', study2.ok, 'error:', study2.error);
        // network 失敗で ok=false だが、エラーが network 由来なら dataset 構築自体は成功している

        log('9d. updater check (URL未設定 — error 返す)');
        await window.App.settings.save({ updateUrl: '' });
        const updNo = await window.App.updater.check({ dryRun: true });
        log('   ok:', updNo.ok, 'error:', updNo.error);

        log('9e. updater check (新版あり — テストサーバー)');
        await window.App.settings.save({ updateUrl: 'http://localhost:8766/latest.json' });
        const upd = await window.App.updater.check({ dryRun: true });
        log('   ok:', upd.ok, 'hasUpdate:', upd.hasUpdate, 'latest:', upd.latestVersion, 'current:', upd.currentVersion);

        log('9f. updater check (同一バージョン — hasUpdate:false)');
        await window.App.settings.save({ updateUrl: 'http://localhost:8766/latest-same.json' });
        const upd2 = await window.App.updater.check({ dryRun: true });
        log('   ok:', upd2.ok, 'hasUpdate:', upd2.hasUpdate);

        log('9g. updater check (古いバージョン — hasUpdate:false)');
        await window.App.settings.save({ updateUrl: 'http://localhost:8766/latest-old.json' });
        const upd3 = await window.App.updater.check({ dryRun: true });
        log('   ok:', upd3.ok, 'hasUpdate:', upd3.hasUpdate);

        log('9h. updater check (不正manifest)');
        await window.App.settings.save({ updateUrl: 'http://localhost:8766/latest-bad.json' });
        const upd4 = await window.App.updater.check({ dryRun: true });
        log('   ok:', upd4.ok, 'error:', upd4.error);

        log('10. views check — レンダリング可能か');
        const views = ['settings','patient','source','preview','ingest','dicom','done'];
        for (const v of views) {
          log('   view exists:', v, typeof window.Views[v]?.render === 'function');
        }

        log('11. 各ビューを実際にrender — 例外が出ないか');
        // mock state for views that depend on prior state
        const mockState = {
          step: 'patient',
          settings: await window.App.settings.get(),
          patient: { id: 'P0001', name: 'モモ', nameRomaji: 'MOMO', procedure: '去勢術', date: '2026-05-17' },
          sources: [{ path: '/tmp', name: 'TestSource', files: [{ path: '/tmp/a.jpg', ext: '.jpg', size: 100, selected: true }], summary: {photo:1,video:0,csv:0,other:0,totalBytes:100}, type: 'surgicalPhoto', useHashDiff: true }],
          targetFolder: '/tmp/test',
          ingestResult: { copied: 3, skippedDup: 1, failed: 0, dicomCandidates: [{ path: '/tmp/a.jpg', name: 'a.jpg' }] },
          dicomResult: null,
          goto: () => {},
          reset: () => {},
        };
        const testMount = document.createElement('div');
        for (const v of views) {
          try {
            await window.Views[v].render(mockState, testMount);
            log('   ✓ render OK:', v);
          } catch (e) {
            log('   ✗ render FAIL:', v, e && (e.message || e));
          }
        }

        log('=== ALL CHECKS DONE ===');
      } catch (e) {
        errLog('FATAL', e);
      }
    })();
  `;
  await wc.executeJavaScript(script);
}

app.whenReady().then(async () => {
  // メインの BrowserWindow が出来るのを少し待つ
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) {
      await wait(500);
      await runChecks(w);
      return;
    }
    await wait(200);
  }
  console.error('[debug-flow] timeout waiting for window');
});
