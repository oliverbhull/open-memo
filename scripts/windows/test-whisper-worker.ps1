param([Parameter(Mandatory)][string]$Worker, [Parameter(Mandatory)][string]$Model, [Parameter(Mandatory)][string]$Audio, [ValidateSet('Whisper','Nemotron')][string]$Engine = 'Whisper')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Read-Exact($stream, [int]$size) {
    $bytes = New-Object byte[] $size
    $offset = 0
    while ($offset -lt $size) {
        $read = $stream.ReadAsync($bytes, $offset, $size - $offset)
        if (!$read.Wait(120000)) { throw 'Whisper worker response timed out.' }
        if ($read.Result -eq 0) { throw 'Whisper worker pipe closed unexpectedly.' }
        $offset += $read.Result
    }
    return ,$bytes
}
function Read-Response($stream) {
    $header = Read-Exact $stream 5
    $size = [BitConverter]::ToUInt32($header, 1)
    if ($size -gt 4194304) { throw 'Whisper worker response exceeds protocol limit.' }
    $text = [Text.Encoding]::UTF8.GetString((Read-Exact $stream $size))
    if ($header[0] -ne 0) { throw "Whisper worker error: $text" }
    return $text
}
# Read RIFF chunks rather than assuming every WAV has a 44-byte header.
$wav = [IO.BinaryReader]::new([IO.File]::OpenRead($Audio))
try {
    if ([Text.Encoding]::ASCII.GetString($wav.ReadBytes(4)) -ne 'RIFF') { throw 'Expected RIFF WAV.' }
    $null = $wav.ReadUInt32()
    if ([Text.Encoding]::ASCII.GetString($wav.ReadBytes(4)) -ne 'WAVE') { throw 'Expected WAV audio.' }
    $pcm = $null
    $validFormat = $false
    while ($wav.BaseStream.Position -lt $wav.BaseStream.Length) {
        $chunk = [Text.Encoding]::ASCII.GetString($wav.ReadBytes(4))
        $size = $wav.ReadUInt32()
        $bytes = $wav.ReadBytes($size)
        if ($chunk -eq 'fmt ') {
            $validFormat = [BitConverter]::ToUInt16($bytes, 0) -eq 1 -and [BitConverter]::ToUInt16($bytes, 2) -eq 1 -and [BitConverter]::ToUInt32($bytes, 4) -eq 16000 -and [BitConverter]::ToUInt16($bytes, 14) -eq 16
        }
        if ($chunk -eq 'data') { $pcm = $bytes }
        if ($size % 2) { $null = $wav.ReadByte() }
    }
    if (!$validFormat -or !$pcm) { throw 'Expected mono PCM16 at 16 kHz.' }
} finally { $wav.Dispose() }
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $Worker
$info.Arguments = '"' + $Model + '"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$process = [Diagnostics.Process]::Start($info)
try {
    if ((Read-Response $process.StandardOutput.BaseStream) -ne '') { throw 'Expected empty ready frame.' }
    $previous = $null
    for ($i = 0; $i -lt 2; $i++) {
        if ($Engine -eq 'Nemotron') {
            $process.StandardInput.BaseStream.Write([byte[]]@(1,0,0,0,0), 0, 5)
            for ($offset = 0; $offset -lt $pcm.Length; $offset += 51200) {
                $size = [Math]::Min(51200, $pcm.Length - $offset)
                $process.StandardInput.BaseStream.WriteByte(2)
                $count = [BitConverter]::GetBytes([uint32]$size)
                $process.StandardInput.BaseStream.Write($count, 0, 4)
                $process.StandardInput.BaseStream.Write($pcm, $offset, $size)
            }
            $process.StandardInput.BaseStream.Write([byte[]]@(3,0,0,0,0), 0, 5)
        } else {
            $count = [BitConverter]::GetBytes([uint32]($pcm.Length / 2))
            $process.StandardInput.BaseStream.Write($count, 0, 4)
            $process.StandardInput.BaseStream.Write($pcm, 0, $pcm.Length)
        }
        $process.StandardInput.BaseStream.Flush()
        $text = (Read-Response $process.StandardOutput.BaseStream).Trim()
        if ($text -notmatch 'country') { throw "Whisper worker speech smoke failed: $text" }
        if ($i -eq 1 -and $text -ne $previous) { throw 'Whisper worker leaked transcription context between requests.' }
        $previous = $text
    }
    $process.StandardInput.Close()
    if (!$process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw 'Whisper worker did not exit cleanly after pipe closure.' }
} finally {
    if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
}
Write-Host "Persistent $Engine worker transcribed two requests and exited cleanly."
