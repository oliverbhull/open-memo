const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('fs');

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { stdio: 'inherit', ...opts }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const shouldSign = process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false' && process.env.MANUAL_SIGN !== '1';
  const sttBinPath = path.join(appPath, 'Contents', 'Resources', 'dictation', 'memo-dictation');
  if (!fs.existsSync(sttBinPath)) {
    throw new Error('memo-dictation was not copied from extraResources');
  }
  fs.chmodSync(sttBinPath, 0o755);
  console.log(`✓ memo-dictation verified (${fs.statSync(sttBinPath).size} bytes)`);

  const deviceSyncHelper = path.join(appPath, 'Contents', 'Resources', 'device-sync', 'device_sync.py');
  if (!fs.existsSync(deviceSyncHelper)) {
    throw new Error('Memo device sync helper was not copied from extraResources');
  }
  console.log('✓ Memo device sync helper verified');

  const bleBridge = path.join(appPath, 'Contents', 'Resources', 'device-sync', 'memo-ble-bridge');
  if (!fs.existsSync(bleBridge)) {
    throw new Error('Memo BLE bridge was not copied from extraResources');
  }
  fs.chmodSync(bleBridge, 0o755);
  console.log(`✓ Memo BLE bridge verified (${fs.statSync(bleBridge).size} bytes)`);

  // A release must fail if bundle metadata cannot be cleaned before signing.
  await sh('xattr', ['-cr', appPath]);
  await sh('dot_clean', ['-m', appPath]);
  console.log('✓ Extended attributes cleaned');

  // Verify the self-contained conomo runtime bundle before signing.
  const conomoPath = path.join(appPath, 'Contents', 'Resources', 'conomo');
  const conomoWorker = path.join(conomoPath, 'conomo');
  const devicePython = path.join(conomoPath, 'device-runtime', 'bin', 'python3.12');
  const conomoRequired = [
    conomoWorker,
    devicePython,
    path.join(conomoPath, 'compiled'),
    path.join(conomoPath, 'tokenizer.json'),
    path.join(conomoPath, 'manifest.json'),
    path.join(conomoPath, 'LICENSE-APACHE-2.0.txt'),
    path.join(conomoPath, 'NOTICE.txt'),
    path.join(conomoPath, 'VERSIONS'),
  ];
  const missingFiles = conomoRequired.filter((required) => !fs.existsSync(required));
  if (missingFiles.length > 0) throw new Error(`conomo bundle is incomplete:\n${missingFiles.join('\n')}`);
  fs.chmodSync(conomoWorker, 0o755);
  fs.chmodSync(devicePython, 0o755);
  await sh(devicePython, ['-B', '-c', 'import serial; print(serial.VERSION)'], {
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const conomoModels = fs.readdirSync(path.join(conomoPath, 'compiled'))
    .filter((name) => name.endsWith('.mlmodelc'));
  if (conomoModels.length !== 1) throw new Error('Conomo bundle must contain exactly one compiled Core ML model');
  const conomoManifest = JSON.parse(fs.readFileSync(path.join(conomoPath, 'manifest.json'), 'utf8'));
  if (shouldSign && conomoManifest.fixture === true) {
    throw new Error('Refusing to sign a release containing the protocol-only Conomo fixture');
  }
  if (conomoManifest.quantization !== 'int4' || !(conomoManifest.int4_operations > 0)) {
    throw new Error('Packaged Conomo model is not verified as INT4');
  }
  console.log('✓ Bundled Conomo Core ML INT4 runtime verified');

  const pncPath = path.join(appPath, 'Contents', 'Resources', 'pnc');
  const pncCompiledModels = fs.readdirSync(path.join(pncPath, 'compiled'))
    .filter((name) => name.endsWith('.mlmodelc'));
  if (pncCompiledModels.length !== 1) throw new Error('PnC bundle must contain exactly one compiled Core ML model');
  const pncWorker = path.join(pncPath, 'memo-pnc');
  const pncRequired = [
    pncWorker,
    path.join(pncPath, 'compiled', pncCompiledModels[0]),
    path.join(pncPath, 'tokenizer.vocab'),
    path.join(pncPath, 'manifest.json'),
    path.join(pncPath, 'VERSIONS'),
    path.join(pncPath, 'NOTICE.md'),
  ];
  const missingPncFiles = pncRequired.filter((required) => !fs.existsSync(required));
  if (missingPncFiles.length > 0) throw new Error(`PnC bundle is incomplete:\n${missingPncFiles.join('\n')}`);
  fs.chmodSync(pncWorker, 0o755);
  console.log('✓ Bundled DistilBERT punctuation and capitalization model verified');

  // The device-sync Python runtime and conomo worker are nested native code.
  if (shouldSign) {
    const signer = process.env.CSC_NAME || process.env.CODE_SIGN_IDENTITY || 'Developer ID Application';
    const nativeLibraries = walkFiles(path.join(conomoPath, 'device-runtime'))
      .filter((filePath) => filePath.endsWith('.so') || filePath.endsWith('.dylib'));
    for (const nativeLibrary of nativeLibraries) {
      await sh('codesign', [
        '--force',
        '--options', 'runtime',
        '--sign', signer,
        nativeLibrary,
      ]);
    }
    await sh('codesign', [
      '--force',
      '--options', 'runtime',
      '--entitlements', path.resolve('config/entitlements.mac.plist'),
      '--sign', signer,
      devicePython,
    ]);
    await sh('codesign', [
      '--force', '--options', 'runtime',
      '--entitlements', path.resolve('config/entitlements.mac.plist'),
      '--sign', signer, conomoWorker,
    ]);
    await sh('codesign', [
      '--force', '--options', 'runtime',
      '--entitlements', path.resolve('config/entitlements.mac.plist'),
      '--sign', signer, pncWorker,
    ]);
    console.log(`✓ Signed ${nativeLibraries.length} device runtime libraries, Python, conomo worker, and PnC worker`);
    await sh('codesign', [
      '--force',
      '--options', 'runtime',
      '--entitlements', path.resolve('config/entitlements.mac.plist'),
      '--sign', signer,
      bleBridge,
    ]);
    await sh('codesign', ['--verify', '--verbose', bleBridge]);
    console.log('✓ Memo BLE bridge signed');
  }

  // The custom signer applies the dictation helper's fixed identity and
  // entitlements during Electron Builder's signing pass, before notarization.
  if (!shouldSign) {
    console.log('⚠ Skipping native signing for unsigned build');
  }
};
