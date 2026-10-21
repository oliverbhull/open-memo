param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../.build/windows'),
    [string]$CacheRoot = '',
    [switch]$SkipSmokeTest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot/download-asset.ps1"
if ($env:OS -ne 'Windows_NT') { throw 'Windows x64 is required to stage punctuation.' }
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (!$CacheRoot) { $CacheRoot = Join-Path $OutputRoot 'cache/pnc' }
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$lockPath = Join-Path $PSScriptRoot 'pnc-dependencies.lock.json'
$lock = Get-Content $lockPath -Raw | ConvertFrom-Json
$bundle = Join-Path $OutputRoot 'pnc'
$python = Join-Path $bundle 'python'
$sitePackages = Join-Path $python 'Lib/site-packages'
$models = Join-Path $OutputRoot 'edge-punct-casing/model'
New-Item -ItemType Directory -Force $CacheRoot, $bundle, $python, $sitePackages, $models | Out-Null

function Get-Sha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $digest.Dispose(); $stream.Dispose() }
}
function Get-Artifact($Artifact) {
    $file = Join-Path $CacheRoot $Artifact.filename
    if (!(Test-Path -LiteralPath $file) -or (Get-Sha256 $file) -ne $Artifact.sha256) {
        $partial = "$file.partial"
        Save-BackendAsset $Artifact.url $partial
        if ((Get-Sha256 $partial) -ne $Artifact.sha256) {
            Remove-Item -LiteralPath $partial -Force
            throw "Checksum mismatch: $($Artifact.filename)"
        }
        Move-Item -LiteralPath $partial -Destination $file -Force
    }
    return $file
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Expand-VerifiedZip([string]$Archive, [string]$Destination) {
    # Wheels are zip files; avoid pip, network dependency resolution, and host Python.
    $root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
            if (!$target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes staging root.' }
            if (!$entry.Name) { New-Item -ItemType Directory -Force $target | Out-Null; continue }
            New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($target)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    } finally { $zip.Dispose() }
}
$pythonArchive = Get-Artifact $lock.python
Expand-VerifiedZip $pythonArchive $python
foreach ($wheel in $lock.wheels) { Expand-VerifiedZip (Get-Artifact $wheel) $sitePackages }
# The embeddable runtime ignores the user's environment and installed Python.
$pythonVersionParts = $lock.python.version.Split('.')
$stdlib = "python$($pythonVersionParts[0])$($pythonVersionParts[1]).zip"
$pth = Join-Path $python "python$($pythonVersionParts[0])$($pythonVersionParts[1])._pth"
[IO.File]::WriteAllText($pth, "$stdlib`r`n.`r`nLib/site-packages`r`nimport site`r`n", [Text.Encoding]::ASCII)

$modelArchive = Get-Artifact $lock.model
$modelFile = Join-Path $models 'model.int8.onnx'
$vocabulary = Join-Path $models 'bpe.vocab'
if (!(Test-Path $modelFile) -or !(Test-Path $vocabulary) -or
    (Get-Sha256 $modelFile) -ne $lock.model.modelSha256 -or
    (Get-Sha256 $vocabulary) -ne $lock.model.vocabSha256) {
    $extract = Join-Path $CacheRoot 'model-extracted'
    New-Item -ItemType Directory -Force $extract | Out-Null
    & tar.exe -xf $modelArchive -C $extract
    if ($LASTEXITCODE -ne 0) { throw 'Extracting pinned punctuation model failed.' }
    $source = Join-Path $extract 'sherpa-onnx-online-punct-en-2024-08-06'
    Copy-Item -LiteralPath (Join-Path $source 'model.int8.onnx') -Destination $modelFile -Force
    Copy-Item -LiteralPath (Join-Path $source 'bpe.vocab') -Destination $vocabulary -Force
}
if ((Get-Sha256 $modelFile) -ne $lock.model.modelSha256 -or (Get-Sha256 $vocabulary) -ne $lock.model.vocabSha256) {
    throw 'Punctuation model/vocabulary checksum mismatch.'
}
Copy-Item -LiteralPath $modelFile, $vocabulary -Destination $bundle -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/python/edge-punct-worker.py') -Destination (Join-Path $bundle 'worker.py') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE-Edge-Punct-Casing.txt') -Destination $bundle -Force
Copy-Item -LiteralPath $lockPath -Destination (Join-Path $bundle 'dependencies.lock.json') -Force
$licenses = Join-Path $bundle 'licenses'
New-Item -ItemType Directory -Force $licenses | Out-Null
# Retain the complete CPython license and every license shipped by the wheels.
Copy-Item -LiteralPath (Join-Path $python 'LICENSE.txt') -Destination (Join-Path $licenses 'LICENSE-Python.txt') -Force
foreach ($license in $lock.licenses) {
    $source = Join-Path (Join-Path $PSScriptRoot 'pnc-licenses') $license.filename
    if ((Get-Sha256 $source) -ne $license.sha256) { throw "Bundled license checksum mismatch: $($license.filename)" }
    Copy-Item -LiteralPath $source -Destination $licenses -Force
}
Get-ChildItem -LiteralPath $sitePackages -Directory -Filter '*.dist-info' | ForEach-Object {
    $distribution = $_
    Get-ChildItem -LiteralPath $distribution.FullName -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE)' } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licenses "$($distribution.Name)-$($_.Name)") -Force
    }
}
$manifest = [ordered]@{
    schemaVersion = 1; engine = 'edge-punct-casing'; pythonVersion = $lock.python.version
    sherpaOnnxVersion = $lock.wheels[0].version; onnxRuntimeVersion = $lock.onnxRuntimeVersion
    modelSha256 = $lock.model.modelSha256
    vocabSha256 = $lock.model.vocabSha256; dependencyLockSha256 = (Get-Sha256 $lockPath)
    modelSource = $lock.model.url
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $bundle 'manifest.json') -Encoding UTF8
if (!$SkipSmokeTest) {
    $executable = Join-Path $python 'python.exe'
    & $executable -c "import sherpa_onnx; assert sherpa_onnx.__version__ == '1.13.8'"
    if ($LASTEXITCODE -ne 0) { throw 'Pinned sherpa-onnx runtime failed to import.' }
    $request = '{"id":"verify","text":"how are you i am fine thank you"}'
    $output = @($request | & $executable (Join-Path $bundle 'worker.py') --model-path (Join-Path $bundle 'model.int8.onnx') --vocabulary-path (Join-Path $bundle 'bpe.vocab') --worker)
    if ($LASTEXITCODE -ne 0 -or $output.Count -lt 2 -or $output[0] -ne 'READY') { throw 'Punctuation worker did not become ready.' }
    $result = $output[-1] | ConvertFrom-Json
    if ($result.id -ne 'verify' -or $result.text -ne 'How are you? I am fine. Thank you.' -or $result.error) {
        throw "Punctuation smoke test returned unexpected text: $($output[-1])"
    }
}
Write-Host "Windows punctuation runtime staged and verified: $bundle"
