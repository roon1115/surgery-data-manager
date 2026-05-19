/**
 * スクリーンショット撮影モード
 * SDM_SCREENSHOT=1 を渡すと、各画面を順番に表示してPNGを保存して終了する
 * 出力先: /tmp/sdm-screenshots/
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.env.SDM_SCREENSHOT !== '1') return;

const OUT_DIR = '/tmp/sdm-screenshots';
fs.mkdirSync(OUT_DIR, { recursive: true });

const SCREENS = [
  { name: '01-settings', step: 'settings' },
  { name: '02-patient', step: 'patient' },
  { name: '03-source', step: 'source' },
  { name: '04-preview', step: 'preview' },
  { name: '05-ingest', step: 'ingest' },
  { name: '06-dicom', step: 'dicom' },
  { name: '07-done', step: 'done' },
];

async function capture(win, name) {
  await new Promise(r => setTimeout(r, 800)); // レンダリング待ち
  const img = await win.webContents.capturePage();
  const buf = img.toPNG();
  const outPath = path.join(OUT_DIR, name + '.png');
  fs.writeFileSync(outPath, buf);
  console.log('[screenshot] saved:', outPath, buf.length, 'bytes');
}

async function run(win) {
  // mockState を仕込んで各画面に遷移
  const mockSetup = `
    (async () => {
      // 設定をセット
      await window.App.settings.save({
        outputRoot: '/Volumes/Stella_8TB',
        dicom: { callingAet: 'SURGERY', calledAet: 'STELLADICOM', host: 'stelladicom.local', port: 104, modality: 'OT', transferSyntax: '1.2.840.10008.1.2' },
        typeFolders: {
          anesthesia: '/Volumes/Stella_8TB/麻酔記録',
          surgicalPhoto: '/Volumes/Stella_8TB/手術写真',
          laparoscope: '/Volumes/Stella_8TB/腹腔鏡',
          bronchoscope: '/Volumes/Stella_8TB/気管支鏡',
          endoscope: '/Volumes/Stella_8TB/内視鏡',
        },
      });
      // ダミーstate を window.__sdmState に置く
      window.__sdmState = {
        step: 'patient',
        settings: await window.App.settings.get(),
        patient: { id: 'P0001', name: 'モモ', nameRomaji: 'MOMO', procedure: '去勢術', date: '2026-05-19' },
        sources: [{
          path: '/Volumes/Camera_SD',
          name: 'Camera_SD',
          type: 'surgicalPhoto',
          useHashDiff: true,
          files: [
            { path: '/Volumes/Camera_SD/IMG_0001.jpg', relPath: 'IMG_0001.jpg', size: 2_500_000, ext: '.jpg', kind: 'photo', selected: true },
            { path: '/Volumes/Camera_SD/IMG_0002.jpg', relPath: 'IMG_0002.jpg', size: 2_300_000, ext: '.jpg', kind: 'photo', selected: true },
            { path: '/Volumes/Camera_SD/IMG_0003.jpg', relPath: 'IMG_0003.jpg', size: 2_800_000, ext: '.jpg', kind: 'photo', selected: true },
            { path: '/Volumes/Camera_SD/IMG_0004.jpg', relPath: 'IMG_0004.jpg', size: 1_900_000, ext: '.jpg', kind: 'photo', selected: true },
          ],
          summary: { photo: 4, video: 0, csv: 0, other: 0, totalBytes: 9_500_000 },
        }, {
          path: '/Volumes/Anesthesia_USB',
          name: 'Anesthesia_USB',
          type: 'anesthesia',
          useHashDiff: true,
          files: [
            { path: '/Volumes/Anesthesia_USB/log.csv', relPath: 'log.csv', size: 24_000, ext: '.csv', kind: 'csv', selected: true },
          ],
          summary: { photo: 0, video: 0, csv: 1, other: 0, totalBytes: 24_000 },
        }],
        targets: {
          surgicalPhoto: '/Volumes/Stella_8TB/手術写真/2026-05-19_P0001_モモ_去勢術',
          anesthesia: '/Volumes/Stella_8TB/麻酔記録/2026-05-19_P0001_モモ_去勢術',
        },
        folderName: '2026-05-19_P0001_モモ_去勢術',
        ingestResult: {
          copied: 4,
          skippedDup: 1,
          failed: 0,
          dicomCandidates: [
            { path: '/Volumes/Stella_8TB/手術写真/2026-05-19_P0001_モモ_去勢術/IMG_0001.jpg', name: 'IMG_0001.jpg' },
            { path: '/Volumes/Stella_8TB/手術写真/2026-05-19_P0001_モモ_去勢術/IMG_0002.jpg', name: 'IMG_0002.jpg' },
            { path: '/Volumes/Stella_8TB/手術写真/2026-05-19_P0001_モモ_去勢術/IMG_0003.jpg', name: 'IMG_0003.jpg' },
          ],
        },
        dicomResult: { ok: true, sent: 3 },
        goto: function(step) { this.step = step; window.__sdmRender(); },
        reset: function() {},
      };
    })();
  `;
  await win.webContents.executeJavaScript(mockSetup);

  for (const sc of SCREENS) {
    const script = `
      (async () => {
        window.__sdmState.step = '${sc.step}';
        // 既存の app.js の render を再利用するため、グローバル参照を作る
        const mount = document.getElementById('app');
        const view = window.Views['${sc.step}'];
        if (view) {
          try { await view.render(window.__sdmState, mount); } catch(e) { console.error('render error', e); }
        }
        // ステップインジケーター更新
        const order = ['settings','patient','source','preview','ingest','dicom','done'];
        const idx = order.indexOf('${sc.step}');
        document.querySelectorAll('.step').forEach(el => {
          const k = el.dataset.step;
          el.classList.toggle('active', k === '${sc.step === 'settings' ? 'patient' : sc.step}');
          el.classList.toggle('done', order.indexOf(k) < idx);
        });
      })();
    `;
    await win.webContents.executeJavaScript(script);
    await capture(win, sc.name);
  }

  console.log('[screenshot] DONE');
  setTimeout(() => app.quit(), 500);
}

app.whenReady().then(async () => {
  // BrowserWindow が出来るのを待つ
  for (let i = 0; i < 40; i++) {
    const w = BrowserWindow.getAllWindows()[0];
    if (w && !w.webContents.isLoading()) {
      await new Promise(r => setTimeout(r, 1500));
      await run(w);
      return;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.error('[screenshot] timeout');
  app.quit();
});
