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

  // A release must fail if bundle metadata cannot be cleaned before signing.
  await sh('xattr', ['-cr', appPath]);
  await sh('dot_clean', ['-m', appPath]);
  console.log('✓ Extended attributes cleaned');

  // Verify the self-contained Nemotron resources before signing. A release
  // must never silently depend on a developer's Python or model directory.
  const nemotronPath = path.join(appPath, 'Contents', 'Resources', 'nemotron');
  const nemotronRequired = [
    path.join(nemotronPath, 'runtime', 'bin', 'python3.12'),
    path.join(nemotronPath, 'memo_nemotron.py'),
    path.join(nemotronPath, 'model', 'genai_config.json'),
    path.join(nemotronPath, 'model', 'encoder.onnx'),
    path.join(nemotronPath, 'model', 'encoder.onnx.data'),
    path.join(nemotronPath, 'model', 'decoder.onnx'),
    path.join(nemotronPath, 'model', 'decoder.onnx.data'),
    path.join(nemotronPath, 'model', 'joint.onnx'),
    path.join(nemotronPath, 'model', 'joint.onnx.data'),
    path.join(nemotronPath, 'model', 'tokenizer.json'),
    path.join(nemotronPath, 'model', 'model_config.json'),
    path.join(nemotronPath, 'model', '.memo-model-revision'),
    path.join(nemotronPath, 'VERSIONS'),
  ];
  const missingNemotronFiles = nemotronRequired.filter((required) => !fs.existsSync(required));
  if (missingNemotronFiles.length > 0) {
    throw new Error(`Nemotron bundle is incomplete:\n${missingNemotronFiles.join('\n')}`);
  }
  fs.chmodSync(nemotronRequired[0], 0o755);
  console.log('✓ Bundled Nemotron runtime and model verified');

  // Python and ONNX Runtime contain nested Mach-O binaries. Sign them from
  // the leaves inward before electron-builder signs the enclosing app.
  if (shouldSign) {
    const signer = process.env.CSC_NAME || process.env.CODE_SIGN_IDENTITY || 'Developer ID Application';
    const nativeLibraries = walkFiles(path.join(nemotronPath, 'runtime'))
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
      nemotronRequired[0],
    ]);
    console.log(`✓ Signed ${nativeLibraries.length} Nemotron native libraries and bundled Python`);
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
