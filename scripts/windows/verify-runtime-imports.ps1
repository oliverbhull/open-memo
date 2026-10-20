param(
    [Parameter(Mandatory)][string]$Directory,
    [Parameter(Mandatory)][string]$Dumpbin,
    [switch]$Recurse
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = (Resolve-Path -LiteralPath $Directory).Path
# Windows 10+ provides these OS libraries and Universal CRT API-set forwards.
# Never accept a developer machine's installed Visual C++ runtime as proof.
$systemLibraries = @('kernel32.dll','kernelbase.dll','ntdll.dll','user32.dll','gdi32.dll','advapi32.dll','shell32.dll','ole32.dll','oleaut32.dll','comdlg32.dll','comctl32.dll','shlwapi.dll','ws2_32.dll','bcrypt.dll','crypt32.dll','secur32.dll','rpcrt4.dll','version.dll','winmm.dll','imm32.dll','dbghelp.dll','psapi.dll','iphlpapi.dll','userenv.dll','powrprof.dll','msvcrt.dll','ucrtbase.dll','normaliz.dll','setupapi.dll','wintrust.dll','dnsapi.dll','netapi32.dll','wtsapi32.dll','mswsock.dll','winhttp.dll','pathcch.dll','propsys.dll','cfgmgr32.dll','shcore.dll','dxgi.dll')
$files = Get-ChildItem -LiteralPath $root -File -Recurse:$Recurse | Where-Object { $_.Extension -in @('.exe','.dll','.pyd') }
if (!$files) { throw "No native runtime files: $root" }
foreach ($file in $files) {
    $output = & $Dumpbin /DEPENDENTS $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect $($file.FullName)" }
    foreach ($line in $output) {
        if ($line -notmatch '^\s+([^\s]+\.dll)\s*$') { continue }
        $dependency = $Matches[1].ToLowerInvariant()
        if ($dependency -match '(?:vulkan|cuda|cublas|cudnn|nvrtc)') { throw "CPU package requires GPU runtime: $($file.Name) -> $dependency" }
        if ($dependency -match '^(?:api-ms-win-|ext-ms-win-)' -or $dependency -in $systemLibraries) { continue }
        if ((Test-Path -LiteralPath (Join-Path $file.DirectoryName $dependency)) -or (Test-Path -LiteralPath (Join-Path $root $dependency))) { continue }
        throw "Unbundled native dependency: $($file.FullName) -> $dependency"
    }
}
Write-Host "Verified native import closure: $root ($(@($files).Count) files)."
