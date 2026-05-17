/**
 * 軽量カスタムアップデーター
 *
 * 動作:
 *   1. 設定された URL から latest.json を取得
 *      期待フォーマット:
 *        {
 *          "version": "0.2.0",
 *          "notes":   "変更点の説明...",
 *          "url":     "https://.../手術データ管理-0.2.0-arm64.dmg",
 *          "urlX64":  "https://.../手術データ管理-0.2.0.dmg",
 *          "pubDate": "2026-05-18"
 *        }
 *   2. アプリ現バージョンと比較
 *   3. 新版があればダイアログ → ユーザーが「ダウンロード」をクリックすると
 *      既定ブラウザで DMG URL を開く（手動インストール）
 *
 * Ad-hoc 署名のため electron-updater による完全自動インストールは行わない。
 */
const { app, dialog, shell, ipcMain, BrowserWindow } = require('electron');
const https = require('https');
const http = require('http');
const settings = require('./settings-handler');

const isMac = process.platform === 'darwin';
const arch = process.arch; // 'arm64' | 'x64'

function compareSemver(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function fetchJson(url, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!url || !/^https?:\/\//i.test(url)) {
      reject(new Error('invalid URL'));
      return;
    }
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'SurgeryDataManager-Updater' } }, (res) => {
      // リダイレクト追従
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchJson(res.headers.location, { timeoutMs }).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

function pickDmgUrl(manifest) {
  if (!manifest) return null;
  if (arch === 'arm64' && manifest.url) return manifest.url;
  if (arch === 'x64' && manifest.urlX64) return manifest.urlX64;
  return manifest.url || manifest.urlX64 || null;
}

async function checkForUpdate({ silent = false, dryRun = false } = {}) {
  // silent: 「最新です」「エラー」などの情報ダイアログは出さない（起動時の静かなチェック用）。
  //         ただし新版が見つかった場合は通知ダイアログを出す。
  // dryRun: いかなるダイアログも出さない（テスト・プログラマティック呼出し用）。
  if (dryRun) silent = true;
  const cfg = settings.getAll();
  const url = cfg.updateUrl;
  const currentVersion = app.getVersion();

  if (!url) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'info',
        title: 'アップデートURL未設定',
        message: '設定画面で「アップデート確認URL」を指定してください。',
        detail: 'latest.json を配信するURLが必要です（Dropbox公開リンク、GitHub Releasesなど）。',
      });
    }
    return { ok: false, error: 'update URL not configured' };
  }

  let manifest;
  try {
    manifest = await fetchJson(url);
  } catch (e) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'error',
        title: 'アップデート確認失敗',
        message: 'アップデート情報の取得に失敗しました。',
        detail: String(e?.message || e),
      });
    }
    return { ok: false, error: String(e?.message || e) };
  }

  const latestVersion = manifest.version;
  if (!latestVersion) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'error',
        title: 'アップデート確認失敗',
        message: 'latest.json に version フィールドがありません。',
      });
    }
    return { ok: false, error: 'invalid manifest' };
  }

  const cmp = compareSemver(latestVersion, currentVersion);
  if (cmp <= 0) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'info',
        title: 'アップデート確認',
        message: '最新版を使用中です。',
        detail: `現在のバージョン: ${currentVersion}`,
      });
    }
    return { ok: true, hasUpdate: false, currentVersion, latestVersion };
  }

  const dmgUrl = pickDmgUrl(manifest);
  if (!dmgUrl) {
    if (!silent) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'ダウンロードURL未設定',
        message: `新版 ${latestVersion} が利用可能ですが、ダウンロードURLが見つかりません。`,
        detail: 'latest.json の url / urlX64 フィールドを確認してください。',
      });
    }
    return { ok: true, hasUpdate: true, latestVersion, currentVersion, dmgUrl: null };
  }

  if (dryRun) {
    return { ok: true, hasUpdate: true, latestVersion, currentVersion, dmgUrl };
  }

  const choice = await dialog.showMessageBox({
    type: 'info',
    title: 'アップデートが利用可能',
    message: `新しいバージョン ${latestVersion} が公開されました`,
    detail:
      `現在: ${currentVersion}\n最新: ${latestVersion}\n` +
      (manifest.notes ? `\n変更点:\n${manifest.notes}\n` : '') +
      (manifest.pubDate ? `\n公開日: ${manifest.pubDate}` : ''),
    buttons: ['ブラウザでダウンロードを開く', '今は更新しない'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response === 0) {
    await shell.openExternal(dmgUrl);
    dialog.showMessageBox({
      type: 'info',
      title: 'ダウンロード開始',
      message: 'DMGファイルのダウンロードを開始しました',
      detail:
        '1. ダウンロード完了後、DMGを開く\n' +
        '2. アプリを /Applications にドラッグしてコピー（上書き）\n' +
        '3. このアプリを終了 → /Applications から新バージョンを起動\n\n' +
        '※ 初回のみ右クリック→「開く」が必要な場合があります。',
    });
  }
  return { ok: true, hasUpdate: true, latestVersion, currentVersion, dmgUrl };
}

ipcMain.handle('updater:check', async (_e, args = {}) => {
  return await checkForUpdate({ silent: !!args.silent, dryRun: !!args.dryRun });
});

// 起動時にサイレントチェック（URLが設定されていれば）
function scheduleStartupCheck() {
  setTimeout(() => {
    const cfg = settings.getAll();
    if (cfg.updateUrl) {
      checkForUpdate({ silent: false }).catch(() => {});
    }
  }, 5000); // 起動5秒後
}

app.whenReady().then(() => {
  if (!app.isPackaged && !process.env.SDM_TEST_UPDATER) {
    // 開発モードではスキップ（SDM_TEST_UPDATER=1 で強制有効化可）
    return;
  }
  scheduleStartupCheck();
});

module.exports = { checkForUpdate, compareSemver };
