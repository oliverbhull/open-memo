$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Build Windows backends on Windows x64.' }
$repoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $repoRoot
function Invoke-Checked([string]$program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
}
# Use .NET directly: nested Windows PowerShell can lack the Utility module
# that exports Get-FileHash on hosted runners.
function Get-Sha256([string]$path) {
    $stream = [System.IO.File]::OpenRead($path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}
$stage = Join-Path $repoRoot '.build/windows'
$dictation = Join-Path $stage 'dictation'
$whisper = Join-Path $stage 'whisper'
New-Item -ItemType Directory -Force $dictation, $whisper | Out-Null
# One pinned CPU build; no CUDA, GPU drivers, Python, or developer tools on user PCs.
$revision = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
$source = Join-Path $repoRoot ".build/whisper-source-$revision"
if (!(Test-Path "$source/.git")) {
    Invoke-Checked git @('init', $source)
    Invoke-Checked git @('-C', $source, 'remote', 'add', 'origin', 'https://github.com/ggml-org/whisper.cpp.git')
    Invoke-Checked git @('-C', $source, 'fetch', '--depth', '1', 'origin', $revision)
    Invoke-Checked git @('-C', $source, 'checkout', '--detach', 'FETCH_HEAD')
}
$actualRevision = & git -C $source rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actualRevision.Trim() -ne $revision) { throw 'Whisper source revision mismatch.' }
$dirtySource = & git -C $source status --porcelain
if ($dirtySource) { throw 'Whisper source checkout was modified; refusing to package it.' }
$buildDir = Join-Path $repoRoot '.build/whisper-windows-build'
Invoke-Checked cmake @('-S', $source, '-B', $buildDir, '-A', 'x64', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON')
Invoke-Checked cmake @('--build', $buildDir, '--config', 'Release', '--target', 'whisper-cli', '--parallel', '4')
Copy-Item "$buildDir/bin/Release/whisper-cli.exe" $whisper -Force
# Copy any runtime DLLs if an upstream build option introduces them.
Get-ChildItem "$buildDir/bin/Release" -Filter '*.dll' | Copy-Item -Destination $whisper -Force
Copy-Item "$source/LICENSE" "$whisper/LICENSE-whisper.cpp.txt" -Force
Copy-Item "$PSScriptRoot/LICENSE-whisper-model.txt" $whisper -Force
$model = Join-Path $whisper 'ggml-small.en-q5_1.bin'
$modelHash = 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30'
if (!(Test-Path $model) -or (Get-Sha256 $model) -ne $modelHash) {
    $partial = "$model.partial"
    Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin' -OutFile $partial
    if ((Get-Sha256 $partial) -ne $modelHash) {
        Remove-Item $partial -Force
        throw 'Whisper small.en q5_1 checksum mismatch.'
    }
    Move-Item $partial $model -Force
}
$env:RUSTFLAGS = '-C target-feature=+crt-static'
$env:CARGO_TARGET_DIR = Join-Path $repoRoot '.build/dictation-windows-target'
Invoke-Checked cargo @('build', '--locked', '--release', '--manifest-path', 'sidecars/dictation/Cargo.toml', '--bin', 'memo-dictation')
Copy-Item "$env:CARGO_TARGET_DIR/release/memo-dictation.exe" $dictation -Force
Copy-Item 'sidecars/dictation/THIRD_PARTY_NOTICES.txt' $dictation -Force
@{ engine = 'whisper.cpp'; revision = $revision; model = 'small.en-q5_1'; modelSha256 = $modelHash } |
    ConvertTo-Json | Set-Content "$whisper/manifest.json"
# Exercise the actual bundled model with upstream speech audio before packaging.
Invoke-Checked "$whisper/whisper-cli.exe" @('-m', $model, '-f', "$source/samples/jfk.wav", '-l', 'en', '-t', '4', '-ng', '-nt', '-otxt', '-of', "$stage/smoke")
$transcript = Get-Content "$stage/smoke.txt" -Raw
if ($transcript -notmatch 'country') { throw 'Whisper speech smoke test did not return the expected passage.' }
Remove-Item "$stage/smoke.txt"
Write-Host 'Windows dictation and small.en q5_1 staged and smoke-tested.'
