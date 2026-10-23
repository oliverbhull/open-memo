param(
    [string]$OutputRoot = "$PSScriptRoot/../../.build/windows",
    [string]$CacheRoot = "$PSScriptRoot/../../.build/windows/cache"
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot/download-asset.ps1"
function Asset-Hash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Get-Asset([string]$Url, [string]$Path, [string]$Sha256) {
    if (!(Test-Path -LiteralPath $Path) -or (Asset-Hash $Path) -ne $Sha256) {
        Save-BackendAsset $Url "$Path.partial"
        if ((Asset-Hash "$Path.partial") -ne $Sha256) { throw "Nemotron asset checksum mismatch: $Url" }
        Move-Item -LiteralPath "$Path.partial" -Destination $Path -Force
    }
}
$version = '0.2.0'
$archiveName = "nemo-speech-$version-windows-x86_64-cpu"
$sdkHash = '82c80451086e86194aba9af19f800da77cd66d1c28d993d0efceffd6cdb49bb8'
$modelRevision = 'ebe59e5a817142986528bbbee5dba8db7b38ed50'
$modelHash = 'd9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d'
$cardHash = '7701f4b2f1c16542c8ceb2b3a61dd144032898c17f4dc9cc1bbecda6972edec8'
$stage = [IO.Path]::GetFullPath((Join-Path $OutputRoot 'nemotron'))
$cache = [IO.Path]::GetFullPath($CacheRoot)
New-Item -ItemType Directory -Force $stage, $cache | Out-Null
$archive = Join-Path $cache "$archiveName.zip"
Get-Asset "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v$version/$archiveName.zip" $archive $sdkHash
# Always extract the verified archive, never trust previously extracted SDK files.
$unpack = Join-Path $cache 'nemo-sdk'
if ((Split-Path -Parent ([IO.Path]::GetFullPath($unpack))) -ne $cache) { throw 'Invalid SDK extraction path.' }
if (Test-Path -LiteralPath $unpack) { Remove-Item -LiteralPath $unpack -Recurse -Force }
Write-Host 'Extracting verified NeMo CPU SDK.'
Expand-Archive -LiteralPath $archive -DestinationPath $unpack -Force
$sdk = Join-Path $unpack $archiveName
if (!(Test-Path "$sdk/include/nemo_speech/asr.h") -or !(Test-Path "$sdk/lib/nemo_speech_asr_c.lib")) { throw 'Incomplete NeMo SDK archive.' }
$model = Join-Path $cache 'nemotron-en-q8.gguf'
Get-Asset "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/$modelRevision/nemotron-speech-streaming-en-0.6b.q8_0.gguf" $model $modelHash
$modelCard = Join-Path $cache 'nemotron-model-card.md'
Get-Asset "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/raw/$modelRevision/README.md" $modelCard $cardHash
# Replace old backend DLLs so a prior local Vulkan experiment cannot enter a CPU release.
Get-ChildItem -LiteralPath $stage -Filter '*.dll' | Remove-Item -Force
Get-ChildItem "$sdk/bin" -Filter '*.dll' | Copy-Item -Destination $stage -Force
Copy-Item -LiteralPath $model -Destination "$stage/nemotron-en-q8.gguf" -Force
Copy-Item -LiteralPath $modelCard -Destination "$stage/MODEL-CARD.md" -Force
Copy-Item -LiteralPath "$PSScriptRoot/licenses/NVIDIA-Open-Model-License.html" -Destination $stage -Force
Copy-Item -LiteralPath "$PSScriptRoot/licenses/Nemotron-Notice.txt" -Destination "$stage/Notice.txt" -Force
New-Item -ItemType Directory -Force "$stage/licenses" | Out-Null
Copy-Item "$sdk/share/licenses/*" -Destination "$stage/licenses" -Recurse -Force
@{
    engine = 'NeMo-Speech.cpp'; version = $version; backend = 'cpu'; sdkSha256 = $sdkHash
    model = 'nvidia/nemotron-speech-streaming-en-0.6b'; modelRevision = $modelRevision
    modelSha256 = $modelHash; modelCardSha256 = $cardHash
} | ConvertTo-Json | Set-Content "$stage/manifest.json" -Encoding UTF8
# The caller uses the verified SDK headers/import library to build our adapter.
Write-Output $sdk
