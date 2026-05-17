/**
 * 公証: Apple Notary Service に提出 → 承認 → staple
 * 認証は keychain profile `vetcalc-notary`（既存 VetCalc と共用）。
 * SKIP_NOTARIZATION=1 でスキップ可能。
 */
const path = require('path');
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.SKIP_NOTARIZATION === '1') {
    console.log('[notarize] SKIP_NOTARIZATION=1 — skipped');
    return;
  }

  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const appBundleId = packager.appInfo.id;

  console.log(`[notarize] submitting ${appPath} (bundleId=${appBundleId})…`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appBundleId,
    keychainProfile: 'vetcalc-notary',
  });

  console.log('[notarize] done');
};
