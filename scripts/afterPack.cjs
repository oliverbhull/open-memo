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
  const sttBinPath = path.join(appPath, 'Contents', 'Resources', 'sttbin', 'memo-stt');
  if (!fs.existsSync(sttBinPath)) {
    throw new Error('memo-stt was not copied from extraResources');
  }
  fs.chmodSync(sttBinPath, 0o755);
  console.log(`✓ memo-stt verified (${fs.statSync(sttBinPath).size} bytes)`);

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

  // Verify the self-contained Granite Core ML resources before signing.
  const granitePath = path.join(appPath, 'Contents', 'Resources', 'granite');
  const compiledModels = fs.readdirSync(path.join(granitePath, 'compiled'))
    .filter((name) => name.endsWith('.mlmodelc'));
  if (compiledModels.length !== 1) throw new Error('Granite bundle must contain exactly one compiled Core ML model');
  const graniteWorker = path.join(granitePath, 'memo-granite-asr');
  const devicePython = path.join(granitePath, 'device-runtime', 'bin', 'python3.12');
  const graniteRequired = [
    graniteWorker,
    devicePython,
    path.join(granitePath, 'compiled', compiledModels[0]),
    path.join(granitePath, 'tokenizer.json'),
    path.join(granitePath, 'manifest.json'),
    path.join(granitePath, 'VERSIONS'),
  ];
  const missingGraniteFiles = graniteRequired.filter((required) => !fs.existsSync(required));
  if (missingGraniteFiles.length > 0) throw new Error(`Granite bundle is incomplete:\n${missingGraniteFiles.join('\n')}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(granitePath, 'manifest.json'), 'utf8'));
  if (manifest.quantization !== 'int4' || !(manifest.int4_operations > 0)) {
    throw new Error('Packaged Granite model is not verified as INT4');
  }
  fs.chmodSync(graniteWorker, 0o755);
  fs.chmodSync(devicePython, 0o755);
  await sh(devicePython, ['-B', '-c', 'import serial; print(serial.VERSION)'], {
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  console.log('✓ Bundled Granite Core ML INT4 runtime and model verified');

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

  // The device-sync Python runtime and Granite worker are nested native code.
  if (shouldSign) {
    const signer = process.env.CSC_NAME || process.env.CODE_SIGN_IDENTITY || 'Developer ID Application';
    const nativeLibraries = walkFiles(path.join(granitePath, 'device-runtime'))
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
      '--sign', signer, graniteWorker,
    ]);
    await sh('codesign', [
      '--force', '--options', 'runtime',
      '--entitlements', path.resolve('config/entitlements.mac.plist'),
      '--sign', signer, pncWorker,
    ]);
    console.log(`✓ Signed ${nativeLibraries.length} device runtime libraries, Python, Granite worker, and PnC worker`);
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

  // Sign memo-stt before electron-builder signs the enclosing app.
  if (shouldSign) {
    const signer = process.env.CSC_NAME || process.env.CODE_SIGN_IDENTITY || 'Developer ID Application';
    await sh('codesign', [
      '--force',
      '--options', 'runtime',
      '--entitlements', path.resolve('config/entitlements.mac.plist'),
      '--sign', signer,
      sttBinPath,
    ]);
    await sh('codesign', ['--verify', '--verbose', sttBinPath]);
    console.log('✓ memo-stt signed with microphone entitlements');
  } else {
    console.log('⚠ Skipping native signing for unsigned build');
  }
};
