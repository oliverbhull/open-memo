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
# Native CPU runtimes and a private punctuation interpreter; users need no tools.
$sdk = & "$PSScriptRoot/stage-nemotron.ps1" -OutputRoot $stage
& "$PSScriptRoot/stage-pnc.ps1" -OutputRoot $stage
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
$buildDir = Join-Path $repoRoot '.build/whisper-worker-windows-build'
# whisper.cpp declares CMake 3.5, which otherwise leaves CMP0091 unset and
# ignores CMAKE_MSVC_RUNTIME_LIBRARY. Disable dynamic MSVC OpenMP too.
$architecture = if ($env:CMAKE_GENERATOR -eq 'Ninja') { @() } else { @('-A', 'x64') }
Invoke-Checked cmake (@('-S', $PSScriptRoot, '-B', $buildDir) + $architecture + @("-DMEMO_WHISPER_SOURCE=$source", "-DMEMO_NEMO_SDK=$sdk", '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DGGML_OPENMP=OFF', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON'))
Invoke-Checked cmake @('--build', $buildDir, '--config', 'Release', '--target', 'whisper-cli', 'memo-whisper-worker', 'memo-nemotron-worker', '--parallel', '2')
$binaryDir = if (Test-Path "$buildDir/bin/Release/memo-whisper-worker.exe") { "$buildDir/bin/Release" } else { "$buildDir/bin" }
Copy-Item "$binaryDir/memo-whisper-worker.exe" $whisper -Force
Copy-Item "$binaryDir/whisper-cli.exe" $whisper -Force
Copy-Item "$binaryDir/memo-nemotron-worker.exe" "$stage/nemotron" -Force
# Copy any runtime DLLs if an upstream build option introduces them.
Get-ChildItem $binaryDir -Filter '*.dll' | Copy-Item -Destination $whisper -Force
Copy-Item "$source/LICENSE" "$whisper/LICENSE-whisper.cpp.txt" -Force
Copy-Item "$PSScriptRoot/LICENSE-whisper-model.txt" $whisper -Force
$model = Join-Path $whisper 'ggml-base.en-q5_1.bin'
$modelHash = '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f'
if (!(Test-Path $model) -or (Get-Sha256 $model) -ne $modelHash) {
    $partial = "$model.partial"
    Invoke-WebRequest -UseBasicParsing 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en-q5_1.bin' -OutFile $partial
    if ((Get-Sha256 $partial) -ne $modelHash) {
        Remove-Item $partial -Force
        throw 'Whisper base.en q5_1 checksum mismatch.'
    }
    Move-Item $partial $model -Force
}
$env:RUSTFLAGS = '-C target-feature=+crt-static'
$env:CARGO_TARGET_DIR = Join-Path $repoRoot '.build/dictation-windows-target'
Invoke-Checked cargo @('build', '--locked', '--release', '--jobs', '2', '--manifest-path', 'sidecars/dictation/Cargo.toml', '--bin', 'memo-dictation')
Copy-Item "$env:CARGO_TARGET_DIR/release/memo-dictation.exe" $dictation -Force
Copy-Item 'sidecars/dictation/THIRD_PARTY_NOTICES.txt' $dictation -Force
@{ engine = 'whisper.cpp'; revision = $revision; model = 'base.en-q5_1'; modelRevision = '5359861c739e955e79d9a303bcbc70fb988958b1'; modelSha256 = $modelHash } |
    ConvertTo-Json | Set-Content "$whisper/manifest.json"
# Hosted builders already have the VC runtime installed. Check the actual import
# table so their successful smoke test cannot hide a missing end-user dependency.
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
if ($dumpbin) { $dumpbins = @($dumpbin.Source) }
elseif (Test-Path $vswhere) { $dumpbins = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC/Tools/MSVC/**/bin/Hostx64/x64/dumpbin.exe') }
else { $dumpbins = @() }
if ($dumpbins.Count -eq 0) { throw 'Cannot locate dumpbin to verify standalone Windows backends.' }
foreach ($executable in @("$whisper/whisper-cli.exe", "$whisper/memo-whisper-worker.exe", "$dictation/memo-dictation.exe")) {
    $dependencies = & $dumpbins[0] /DEPENDENTS $executable
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect dependencies: $executable" }
    if (($dependencies -join "`n") -match '(?i)\b(?:MSVCP|VCRUNTIME|VCOMP|CONCRT)\d[^\s]*\.dll\b') {
        throw "Windows backend depends on an unbundled Visual C++ runtime: $executable ($($Matches[0]))"
    }
}
& "$PSScriptRoot/verify-runtime-imports.ps1" -Directory "$stage/nemotron" -Dumpbin $dumpbins[0]
& "$PSScriptRoot/verify-runtime-imports.ps1" -Directory "$stage/pnc/python" -Dumpbin $dumpbins[0] -Recurse
# Exercise the actual bundled model with upstream speech audio before packaging.
Invoke-Checked "$whisper/whisper-cli.exe" @('-m', $model, '-f', "$source/samples/jfk.wav", '-l', 'en', '-t', '4', '-ng', '-nt', '-otxt', '-of', "$stage/smoke")
$transcript = Get-Content "$stage/smoke.txt" -Raw
if ($transcript -notmatch 'country') { throw 'Whisper speech smoke test did not return the expected passage.' }
Remove-Item "$stage/smoke.txt"
& "$PSScriptRoot/test-whisper-worker.ps1" -Worker "$whisper/memo-whisper-worker.exe" -Model $model -Audio "$source/samples/jfk.wav"
& "$PSScriptRoot/test-whisper-worker.ps1" -Worker "$stage/nemotron/memo-nemotron-worker.exe" -Model "$stage/nemotron/nemotron-en-q8.gguf" -Audio "$source/samples/jfk.wav" -Engine Nemotron
Write-Host 'Windows Nemotron streaming, Base fallback and punctuation staged and smoke-tested.'
