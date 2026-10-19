// Explicit replacement prevents Mac-only helpers and model packs entering Windows.
const { build } = require('../package.json');
module.exports = {
  ...build,
  artifactName: 'Open-Memo-${version}-windows-${arch}-setup.${ext}',
  afterPack: null,
  extraResources: [
    { from: '.build/windows/dictation', to: 'dictation', filter: ['memo-dictation.exe', 'THIRD_PARTY_NOTICES.txt'] },
    { from: '.build/windows/whisper', to: 'whisper', filter: ['whisper-cli.exe', '*.dll', 'ggml-small.en-q5_1.bin', 'manifest.json', 'LICENSE-*.txt'] },
  ],
  win: { target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
};
