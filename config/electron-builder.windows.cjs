// Explicit replacement prevents Mac-only helpers and model packs entering Windows.
const { build } = require('../package.json');
const azureFields = {
  endpoint: process.env.WIN_AZURE_ENDPOINT,
  codeSigningAccountName: process.env.WIN_AZURE_ACCOUNT_NAME,
  certificateProfileName: process.env.WIN_AZURE_CERTIFICATE_PROFILE,
  publisherName: process.env.WIN_AZURE_PUBLISHER_NAME,
};
const useAzure = Object.values(azureFields).some(Boolean);
if (useAzure && !Object.values(azureFields).every(Boolean)) {
  throw new Error('Configure all four WIN_AZURE signing fields before building.');
}
if (useAzure && process.env.WIN_CSC_LINK) {
  throw new Error('Choose Azure signing or WIN_CSC_LINK, not both.');
}
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
  win: { ...(useAzure ? { azureSignOptions: azureFields } : {}), icon: 'assets/app-icons/app-icon.ico', target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false },
};
