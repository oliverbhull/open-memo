const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { stdio: 'inherit' }, (error) => {
      if (error) reject(error); else resolve();
    });
  });
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' || process.env.MANUAL_SIGN === '1') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const dictationBin = path.join(appPath, 'Contents', 'Resources', 'dictation', 'memo-dictation');
  if (!fs.existsSync(dictationBin)) throw new Error('memo-dictation is missing before final signing');

  const signer = process.env.CSC_NAME || process.env.CODE_SIGN_IDENTITY || 'Developer ID Application';
  await sh('codesign', [
    '--force',
    '--options', 'runtime',
    '--identifier', 'com.memo.desktop.dictation',
    '--entitlements', path.resolve('config/entitlements.dictation.plist'),
    '--sign', signer,
    dictationBin,
  ]);

  // Re-seal the outer bundle after changing nested code. Omitting --deep keeps
  // Electron Builder's signatures on every other nested component intact.
  await sh('codesign', [
    '--force',
    '--options', 'runtime',
    '--entitlements', path.resolve('config/entitlements.mac.plist'),
    '--sign', signer,
    appPath,
  ]);

  await sh('codesign', ['--verify', '--strict', '--verbose=2', dictationBin]);
  await sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  console.log('✓ Finalized memo-dictation identity and re-sealed Memo.app');
};
