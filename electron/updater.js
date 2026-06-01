/**
 * 自動アップデート（electron-updater）
 *
 * VetCalc と同方式:
 *   - electron-builder の publish 設定 (package.json build.publish: github) を見て
 *     ビルド時に latest-mac.yml / *.zip / *.dmg を GitHub Releases にアップロード
 *   - アプリは起動時に latest-mac.yml をチェック → 新版があれば zip を自動ダウンロード
 *   - ダウンロード完了で「今すぐ再起動して適用」ダイアログ → quitAndInstall()
 *   - 完全自動なので、ユーザーが毎回ブラウザで DMG をダウンロードする必要はない
 *
 * 開発時 (app.isPackaged === false) は electron-updater を動かさない。
 */
const { app, dialog, ipcMain, BrowserWindow } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null;
}

function mainWin() {
  return BrowserWindow.getAllWindows()[0] || null;
}

let updateDownloaded = false;
let latestKnownVersion = null;

function setupAutoUpdater() {
  if (!autoUpdater) return;
  if (!app.isPackaged) return; // 開発時はスキップ

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    latestKnownVersion = info?.version || null;
    console.log('[updater] update available:', info?.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up to date');
  });

  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading ${Math.round(p.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    const choice = dialog.showMessageBoxSync(mainWin(), {
      type: 'info',
      buttons: ['今すぐ再起動して適用', '次回起動時に適用'],
      defaultId: 0,
      cancelId: 1,
      title: 'アップデート',
      message: `新しいバージョン v${info?.version} をダウンロードしました`,
      detail: '今すぐ再起動して新バージョンを適用しますか？\n（「次回起動時に適用」を選ぶと、アプリを次に終了したとき自動的に適用されます）',
    });
    if (choice === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  autoUpdater.on('error', (err) => {
    console.warn('[updater] error:', err?.message || err);
  });

  // 起動 3 秒後に静かにチェック（新版があれば自動DL→update-downloaded で再起動確認）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.warn('[updater] checkForUpdates failed:', err?.message || err);
    });
  }, 3000);
}

// 手動チェック（メニュー / 設定画面の「今すぐアップデートを確認」ボタンから）
async function manualCheck() {
  if (!autoUpdater || !app.isPackaged) {
    return { ok: false, dev: true, error: '開発モードではアップデートチェックは無効です（パッケージ版で動作します）。' };
  }
  if (updateDownloaded) {
    return { ok: true, hasUpdate: true, downloaded: true, latestVersion: latestKnownVersion, currentVersion: app.getVersion() };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const current = app.getVersion();
    const hasUpdate = !!latest && latest !== current;
    return { ok: true, hasUpdate, latestVersion: latest || current, currentVersion: current };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// メニューから呼ばれる: ダイアログ付きの手動チェック
async function manualCheckWithDialog() {
  const win = mainWin();
  if (!autoUpdater || !app.isPackaged) {
    dialog.showMessageBox(win, {
      type: 'info',
      message: '開発モードではアップデートチェックは無効です。',
      detail: 'パッケージ版（.app）から実行してください。',
    });
    return;
  }
  if (updateDownloaded) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      buttons: ['今すぐ再起動して適用', '後で'],
      defaultId: 0, cancelId: 1,
      title: 'アップデート',
      message: `v${latestKnownVersion} はダウンロード済みです`,
      detail: '再起動して適用しますか？',
    });
    if (choice === 0) setImmediate(() => autoUpdater.quitAndInstall());
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const current = app.getVersion();
    if (!latest || latest === current) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Surgery Data Manager',
        message: '最新版です。',
        detail: `現在のバージョン: ${current}`,
      });
    } else {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'アップデート',
        message: `新しいバージョン v${latest} が見つかりました`,
        detail: 'バックグラウンドでダウンロードしています。完了したら再起動の確認が表示されます。',
      });
    }
  } catch (e) {
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'アップデート確認エラー',
      message: 'アップデート情報を取得できませんでした。',
      detail: String(e?.message || e),
    });
  }
}

// 設定画面の「今すぐアップデートを確認」ボタン用 IPC（ダイアログなしで結果を返す）
ipcMain.handle('updater:check', async () => manualCheck());

app.whenReady().then(() => {
  setupAutoUpdater();
});

module.exports = { manualCheckWithDialog };
