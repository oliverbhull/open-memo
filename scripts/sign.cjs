const path = require('node:path');

const DICTATION_SUFFIX = path.join('Contents', 'Resources', 'dictation', 'memo-dictation');

function isDictationBinary(filePath) {
  return filePath.endsWith(DICTATION_SUFFIX);
}

function signingOptionsForFile(defaultOptionsForFile, filePath) {
  const options = defaultOptionsForFile ? defaultOptionsForFile(filePath) : null;
  if (!isDictationBinary(filePath)) return options;

  return {
    ...(options || {}),
    entitlements: path.resolve('config/entitlements.dictation.plist'),
    additionalArguments: [
      ...((options && options.additionalArguments) || []),
      '--identifier', 'com.memo.desktop.dictation',
    ],
  };
}

module.exports = async function sign(options) {
  const { signAsync } = await import('@electron/osx-sign');
  const defaultOptionsForFile = options.optionsForFile;

  await signAsync({
    ...options,
    optionsForFile: (filePath) => signingOptionsForFile(defaultOptionsForFile, filePath),
  });
};

module.exports.isDictationBinary = isDictationBinary;
module.exports.signingOptionsForFile = signingOptionsForFile;
