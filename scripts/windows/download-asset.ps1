# Shared by the backend staging scripts, including Windows PowerShell 5.1.
# Invoke-WebRequest's progress rendering makes large model downloads very slow
# in that host. curl also lets us bound both stalled and total transfer time.
function Save-BackendAsset([string]$Url, [string]$Path) {
    Write-Host "Downloading $([IO.Path]::GetFileName($Path)): $Url"
    $started = [DateTime]::UtcNow
    & curl.exe --fail --location --silent --show-error --connect-timeout 30 `
        --max-time 600 --speed-time 60 --speed-limit 1024 `
        --retry 2 --retry-delay 5 --retry-max-time 900 --output $Path $Url
    if ($LASTEXITCODE -ne 0) {
        throw "Backend download failed (curl exit $LASTEXITCODE): $Url"
    }
    $seconds = [Math]::Round(([DateTime]::UtcNow - $started).TotalSeconds, 1)
    Write-Host "Downloaded $((Get-Item -LiteralPath $Path).Length) bytes in ${seconds}s."
}
