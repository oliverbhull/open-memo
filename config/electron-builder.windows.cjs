// Explicit replacement prevents Mac-only helpers and model packs entering Windows.
const { build } = require('../package.json');
module.exports = {
  ...build,
  artifactName: 'Open-Memo-${version}-windows-${arch}-setup.${ext}',
  afterPack: null,
  forceCodeSigning: process.env.MEMO_REQUIRE_WINDOWS_SIGNING === '1',
  files: [...build.files, 'assets/app-icons/app-icon.ico'],
  extraResources: [
    { from: 'assets/app-icons/app-icon.ico', to: 'app-icon.ico' },
    { from: '.build/windows/dictation', to: 'dictation', filter: ['memo-dictation.exe', 'THIRD_PARTY_NOTICES.txt'] },
    { from: '.build/windows/whisper', to: 'whisper', filter: ['whisper-cli.exe', 'memo-whisper-worker.exe', '*.dll', 'ggml-base.en-q5_1.bin', 'manifest.json', 'LICENSE-*.txt'] },
    { from: '.build/windows/nemotron', to: 'nemotron', filter: ['memo-nemotron-worker.exe', '*.dll', 'nemotron-en-q8.gguf', 'manifest.json', 'MODEL-CARD.md', 'NVIDIA-Open-Model-License.html', 'Notice.txt', 'licenses/**'] },
    { from: '.build/windows/pnc', to: 'pnc', filter: ['**/*'] },
  ],
  win: { icon: 'assets/app-icons/app-icon.ico', target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
};
