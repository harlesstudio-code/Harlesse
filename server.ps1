param(
    [int]$Port = 0,
    [switch]$NoBrowser,
    [switch]$ShareMode,
    [switch]$Lan
)

$ErrorActionPreference = "Stop"

# Ensure TLS 1.2+ for Roblox Open Cloud HTTPS requests on Windows PowerShell 5.1
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$script:RootDir = $PSScriptRoot
$script:PublicDir = Join-Path $script:RootDir "public"
$script:EnvFile = Join-Path $script:RootDir ".env"
$script:EnvExampleFile = Join-Path $script:RootDir ".env.example"
$script:MaxAudioBytes = 20 * 1024 * 1024
$script:ForceShareMode = [bool]$ShareMode

function Initialize-EnvFile {
    if (-not (Test-Path $script:EnvFile) -and (Test-Path $script:EnvExampleFile)) {
        Copy-Item -Path $script:EnvExampleFile -Destination $script:EnvFile -Force
    }
}

function Read-DotEnv {
    $cfg = @{
        PORT                  = "3456"
        APP_MODE              = "personal"
        ROBLOX_API_KEY        = ""
        ROBLOX_DEFAULT_TARGET = "user"
        ROBLOX_USER_ID        = ""
        ROBLOX_GROUP_ID       = ""
    }

    if (-not (Test-Path $script:EnvFile)) {
        return $cfg
    }

    $lines = Get-Content -Path $script:EnvFile -Encoding UTF8
    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
            continue
        }
        $eqIdx = $line.IndexOf("=")
        if ($eqIdx -lt 1) {
            continue
        }
        $key = $line.Substring(0, $eqIdx).Trim()
        $val = $line.Substring($eqIdx + 1).Trim()
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            if ($val.Length -ge 2) {
                $val = $val.Substring(1, $val.Length - 2)
            }
        }
        $cfg[$key] = $val
    }
    return $cfg
}

function Save-DotEnv {
    param(
        [hashtable]$Updates
    )

    Initialize-EnvFile
    $existingLines = @()
    if (Test-Path $script:EnvFile) {
        $existingLines = Get-Content -Path $script:EnvFile -Encoding UTF8
    }

    $handled = @{}
    $newLines = New-Object System.Collections.Generic.List[string]

    foreach ($rawLine in $existingLines) {
        $trimmed = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#") -or ($trimmed.IndexOf("=") -lt 1)) {
            $newLines.Add($rawLine)
            continue
        }
        $eqIdx = $trimmed.IndexOf("=")
        $key = $trimmed.Substring(0, $eqIdx).Trim()
        if ($Updates.ContainsKey($key)) {
            $cleanVal = [string]$Updates[$key]
            $cleanVal = $cleanVal -replace "[\r\n]", ""
            $newLines.Add("$key=$cleanVal")
            $handled[$key] = $true
        } else {
            $newLines.Add($rawLine)
        }
    }

    foreach ($key in $Updates.Keys) {
        if (-not $handled.ContainsKey($key)) {
            $cleanVal = ([string]$Updates[$key]) -replace "[\r\n]", ""
            $newLines.Add("$key=$cleanVal")
        }
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($script:EnvFile, $newLines.ToArray(), $utf8NoBom)
}

function Resolve-FfmpegPath {
    $localBin = Join-Path $script:RootDir "bin\ffmpeg.exe"
    if (Test-Path $localBin) {
        return $localBin
    }
    $cmd = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    return $null
}

function Get-MaskedSecret {
    param([string]$Secret)
    if ([string]::IsNullOrWhiteSpace($Secret)) {
        return ""
    }
    if ($Secret.Length -le 6) {
        return ("*" * $Secret.Length)
    }
    $tail = $Secret.Substring($Secret.Length - 4)
    return "••••••••$tail"
}

function Read-RequestBytes {
    param([System.Net.HttpListenerRequest]$Request)
    $ms = New-Object System.IO.MemoryStream
    try {
        $Request.InputStream.CopyTo($ms)
        return $ms.ToArray()
    } finally {
        $ms.Dispose()
    }
}

function Read-RequestUtf8Text {
    param([System.Net.HttpListenerRequest]$Request)
    $bytes = Read-RequestBytes -Request $Request
    return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function Send-BytesResponse {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$StatusCode,
        [byte[]]$Bytes,
        [string]$ContentType,
        [hashtable]$ExtraHeaders = $null
    )
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.Headers["Cache-Control"] = "no-store"
    if ($ExtraHeaders) {
        foreach ($h in $ExtraHeaders.Keys) {
            $Response.Headers[$h] = [string]$ExtraHeaders[$h]
        }
    }
    $Response.ContentLength64 = $Bytes.LongLength
    if ($Bytes.LongLength -gt 0) {
        $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    }
    $Response.OutputStream.Close()
}

function Send-JsonResponse {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$StatusCode,
        [object]$Payload
    )
    $json = $Payload | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Send-BytesResponse -Response $Response -StatusCode $StatusCode -Bytes $bytes -ContentType "application/json; charset=utf-8"
}

function Get-MimeTypeForPath {
    param([string]$Path)
    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { return "text/html; charset=utf-8" }
        ".css"  { return "text/css; charset=utf-8" }
        ".js"   { return "application/javascript; charset=utf-8" }
        ".json" { return "application/json; charset=utf-8" }
        ".svg"  { return "image/svg+xml" }
        ".png"  { return "image/png" }
        ".jpg"  { return "image/jpeg" }
        ".ico"  { return "image/x-icon" }
        default { return "application/octet-stream" }
    }
}

function Send-StaticFile {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [string]$UrlPath
    )
    $rel = $UrlPath.TrimStart("/")
    if ([string]::IsNullOrWhiteSpace($rel)) {
        $rel = "index.html"
    }
    $rel = $rel -replace "/", [System.IO.Path]::DirectorySeparatorChar
    $baseFull = [System.IO.Path]::GetFullPath($script:PublicDir)
    $targetFull = [System.IO.Path]::GetFullPath((Join-Path $baseFull $rel))

    if (-not $targetFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-JsonResponse -Response $Response -StatusCode 403 -Payload @{ ok = $false; error = "Forbidden" }
        return
    }
    if (-not (Test-Path -Path $targetFull -PathType Leaf)) {
        Send-JsonResponse -Response $Response -StatusCode 404 -Payload @{ ok = $false; error = "Not found" }
        return
    }

    $bytes = [System.IO.File]::ReadAllBytes($targetFull)
    $mime = Get-MimeTypeForPath -Path $targetFull
    Send-BytesResponse -Response $Response -StatusCode 200 -Bytes $bytes -ContentType $mime
}

function Parse-MetaHeader {
    param([System.Net.HttpListenerRequest]$Request)
    $b64 = $Request.Headers["X-Harles-Meta"]
    if ([string]::IsNullOrWhiteSpace($b64)) {
        return $null
    }
    $rawJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
    return ($rawJson | ConvertFrom-Json)
}

function Invoke-FfmpegTransform {
    param(
        [string]$FfmpegPath,
        [byte[]]$InputBytes,
        [string]$InputExt,
        [double]$Speed,
        [bool]$PreservePitch,
        [string]$OutputFormat
    )
    $tmpDir = Join-Path $script:RootDir "tmp"
    if (-not (Test-Path $tmpDir)) {
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    }
    $id = [System.Guid]::NewGuid().ToString("N")
    $safeExt = ($InputExt -replace "[^a-zA-Z0-9]", "").ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($safeExt)) { $safeExt = "wav" }
    $outExt = if ($OutputFormat -eq "mp3") { "mp3" } else { "ogg" }

    $inFile = Join-Path $tmpDir "$id.$safeExt"
    $outFile = Join-Path $tmpDir "$id.out.$outExt"

    try {
        [System.IO.File]::WriteAllBytes($inFile, $InputBytes)

        # Build FFmpeg audio speed filter
        if ($PreservePitch) {
            $rem = $Speed
            $filters = New-Object System.Collections.Generic.List[string]
            while ($rem -gt 2.0) {
                $filters.Add("atempo=2.0")
                $rem = $rem / 2.0
            }
            while ($rem -lt 0.5) {
                $filters.Add("atempo=0.5")
                $rem = $rem / 0.5
            }
            $filters.Add(("atempo={0:F4}" -f $rem).Replace(",", "."))
            $filterExpr = $filters -join ","
        } else {
            $speedInvariant = ("{0:F4}" -f $Speed).Replace(",", ".")
            $filterExpr = "asetrate=44100*$speedInvariant,aresample=44100"
        }

        $codecArgs = if ($outExt -eq "mp3") {
            @("-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100")
        } else {
            @("-c:a", "libvorbis", "-q:a", "5", "-ar", "44100")
        }

        $argList = @(
            "-y", "-hide_banner", "-loglevel", "error",
            "-i", $inFile,
            "-vn",
            "-filter:a", $filterExpr
        ) + $codecArgs + @($outFile)

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $FfmpegPath
        $psi.Arguments = ($argList | ForEach-Object { if ($_ -match "\s") { "`"$_`"" } else { $_ } }) -join " "
        $psi.UseShellExecute = $false
        $psi.RedirectStandardError = $true
        $psi.RedirectStandardOutput = $true
        $psi.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($psi)
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()

        if ($proc.ExitCode -ne 0 -or -not (Test-Path $outFile)) {
            throw "FFmpeg failed: $stderr"
        }

        return [System.IO.File]::ReadAllBytes($outFile)
    } finally {
        Remove-Item -Path $inFile -ErrorAction SilentlyContinue
        Remove-Item -Path $outFile -ErrorAction SilentlyContinue
    }
}

function Test-IsSharedContext {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [hashtable]$EnvCfg
    )

    if ($script:ForceShareMode -or ($EnvCfg["APP_MODE"] -eq "shared")) {
        return $true
    }

    # Any reverse proxy / tunnel header forces isolated BYOK shared mode
    foreach ($hdr in @("X-Forwarded-For", "CF-Connecting-IP", "Forwarded", "X-Real-IP")) {
        if (-not [string]::IsNullOrWhiteSpace($Request.Headers[$hdr])) {
            return $true
        }
    }

    # Any non-loopback client IP forces shared mode so LAN visitors cannot touch .env
    try {
        $ip = $Request.RemoteEndPoint.Address
        if ($ip -and -not [System.Net.IPAddress]::IsLoopback($ip)) {
            return $true
        }
    } catch {}

    # Any non-localhost Host header (such as tunnel domain or LAN IP) forces shared mode
    $hostHeader = ([string]$Request.Headers["Host"]).Trim().ToLowerInvariant()
    if (-not [string]::IsNullOrWhiteSpace($hostHeader)) {
        if ($hostHeader -notmatch '^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$') {
            return $true
        }
    }

    return $false
}

function Resolve-EffectiveApiKey {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [bool]$IsShared,
        [hashtable]$EnvCfg
    )
    $headerKey = ([string]$Request.Headers["X-Roblox-Api-Key"]).Trim()
    if (-not [string]::IsNullOrWhiteSpace($headerKey)) {
        return $headerKey
    }
    if ($IsShared) {
        return ""
    }
    return ([string]$EnvCfg["ROBLOX_API_KEY"]).Trim()
}

function Start-RobloxUpload {
    param(
        [string]$ApiKey,
        [string]$DisplayName,
        [string]$Description,
        [string]$CreatorType,
        [string]$CreatorId,
        [string]$MimeType,
        [string]$FileName,
        [byte[]]$AudioBytes
    )

    $creatorObj = if ($CreatorType -eq "group") {
        @{ groupId = $CreatorId }
    } else {
        @{ userId = $CreatorId }
    }

    $metadata = @{
        assetType       = "Audio"
        displayName     = $DisplayName
        description     = $Description
        creationContext = @{
            creator = $creatorObj
        }
    }
    $metadataJson = $metadata | ConvertTo-Json -Depth 6 -Compress

    $safeName = ($FileName -replace '[^a-zA-Z0-9._-]', '_')
    if ([string]::IsNullOrWhiteSpace($safeName)) {
        $safeName = "audio.wav"
    }

    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(90)

    try {
        $multipart = New-Object System.Net.Http.MultipartFormDataContent
        $jsonContent = New-Object System.Net.Http.StringContent($metadataJson, [System.Text.Encoding]::UTF8, "application/json")
        $jsonDisp = New-Object System.Net.Http.Headers.ContentDispositionHeaderValue("form-data")
        $jsonDisp.Name = '"request"'
        $jsonContent.Headers.ContentDisposition = $jsonDisp
        $multipart.Add($jsonContent)

        $fileContent = New-Object System.Net.Http.ByteArrayContent(,$AudioBytes)
        $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($MimeType)
        $fileDisp = New-Object System.Net.Http.Headers.ContentDispositionHeaderValue("form-data")
        $fileDisp.Name = '"fileContent"'
        $fileDisp.FileName = "`"$safeName`""
        $fileContent.Headers.ContentDisposition = $fileDisp
        $multipart.Add($fileContent)

        $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "https://apis.roblox.com/assets/v1/assets")
        $req.Headers.TryAddWithoutValidation("x-api-key", $ApiKey) | Out-Null
        $req.Content = $multipart

        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $respBody = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $statusCode = [int]$resp.StatusCode

        if (-not $resp.IsSuccessStatusCode) {
            $errDetail = $respBody
            try {
                $parsedErr = $respBody | ConvertFrom-Json
                if ($parsedErr.message) { $errDetail = $parsedErr.message }
            } catch {}
            return @{
                ok      = $false
                status  = $statusCode
                error   = "Roblox API menolak upload (HTTP $statusCode): $errDetail"
                details = $respBody
            }
        }

        $createData = $respBody | ConvertFrom-Json
        if ($createData.done -eq $true) {
            if ($createData.error) {
                return @{
                    ok      = $false
                    status  = 400
                    error   = "Operasi Roblox gagal: $($createData.error.message)"
                    details = $createData.error
                }
            }
            return @{
                ok            = $true
                done          = $true
                assetId       = [string]$createData.response.assetId
                displayName   = $DisplayName
                operationPath = [string]$createData.path
                response      = $createData.response
            }
        }

        $opPath = [string]$createData.path
        if ([string]::IsNullOrWhiteSpace($opPath)) {
            return @{
                ok      = $false
                status  = 502
                error   = "Respons Roblox tidak menyertakan operation path."
                details = $respBody
            }
        }

        return @{
            ok            = $true
            done          = $false
            displayName   = $DisplayName
            operationPath = $opPath
        }
    } finally {
        $client.Dispose()
    }
}

function Get-RobloxOperationStatus {
    param(
        [string]$ApiKey,
        [string]$OperationPath
    )

    if ($OperationPath -notmatch '^operations/[a-zA-Z0-9_-]+$') {
        return @{
            ok     = $false
            status = 400
            error  = "Operation path tidak valid."
        }
    }

    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(30)

    try {
        $pollUrl = "https://apis.roblox.com/assets/v1/$OperationPath"
        $pollReq = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $pollUrl)
        $pollReq.Headers.TryAddWithoutValidation("x-api-key", $ApiKey) | Out-Null

        $pollResp = $client.SendAsync($pollReq).GetAwaiter().GetResult()
        $pollBody = $pollResp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $statusCode = [int]$pollResp.StatusCode

        if (-not $pollResp.IsSuccessStatusCode) {
            $errDetail = $pollBody
            try {
                $parsedErr = $pollBody | ConvertFrom-Json
                if ($parsedErr.message) { $errDetail = $parsedErr.message }
            } catch {}
            return @{
                ok     = $false
                status = $statusCode
                error  = "Gagal mengecek status operasi Roblox (HTTP $statusCode): $errDetail"
            }
        }

        $opResult = $pollBody | ConvertFrom-Json
        if ($opResult.done -eq $true) {
            if ($opResult.error) {
                return @{
                    ok      = $false
                    done    = $true
                    status  = 400
                    error   = "Moderasi/proses Roblox gagal: $($opResult.error.message)"
                    details = $opResult.error
                }
            }
            return @{
                ok            = $true
                done          = $true
                assetId       = [string]$opResult.response.assetId
                operationPath = $OperationPath
                response      = $opResult.response
            }
        }

        return @{
            ok            = $true
            done          = $false
            operationPath = $OperationPath
        }
    } finally {
        $client.Dispose()
    }
}

Initialize-EnvFile
$envCfg = Read-DotEnv
$resolvedPort = if ($Port -gt 0) { $Port } elseif ($envCfg["PORT"] -as [int]) { [int]$envCfg["PORT"] } else { 3456 }
$localUrl = "http://127.0.0.1:$resolvedPort/"
$prefix = if ($Lan) { "http://+:$resolvedPort/" } else { $localUrl }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    if ($Lan) {
        Write-Host ""
        Write-Host "  [!] Gagal membuka listener LAN ($prefix) tanpa hak Administrator." -ForegroundColor Yellow
        Write-Host "  Solusi 1 (Tanpa Admin): Gunakan tunnel ke 127.0.0.1:$resolvedPort (mis. cloudflared tunnel --url http://127.0.0.1:$resolvedPort)" -ForegroundColor Cyan
        Write-Host "  Solusi 2 (Khusus WiFi LAN): Jalankan Command Prompt sebagai Administrator lalu ketik:" -ForegroundColor Cyan
        Write-Host "    netsh http add urlacl url=http://+:$resolvedPort/ user=Everyone" -ForegroundColor White
        Write-Host ""
    }
    throw
}

$ffmpegPath = Resolve-FfmpegPath
$modeLabel = if ($script:ForceShareMode -or $envCfg["APP_MODE"] -eq "shared") { "SHARED (BYOK - Aman untuk Link Teman & HP)" } else { "PERSONAL (Auto-BYOK saat diakses dari HP/Link luar)" }
Write-Host ""
Write-Host "  ==========================================================" -ForegroundColor DarkYellow
Write-Host "   Harles Studio - Roblox Audio Speed & Open Cloud Lab" -ForegroundColor White
Write-Host "   Mode    : $modeLabel" -ForegroundColor Magenta
Write-Host "   Local   : $localUrl" -ForegroundColor Green
if ($Lan) {
    $lanIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -ExpandProperty IPAddress
    foreach ($ip in $lanIps) {
        Write-Host "   HP/WiFi : http://${ip}:$resolvedPort/" -ForegroundColor Green
    }
}
Write-Host "   FFmpeg  : $(if ($ffmpegPath) { $ffmpegPath } else { 'Not installed (Browser Web Audio engine active)' })" -ForegroundColor Cyan
Write-Host "   Tekan Ctrl+C di jendela ini untuk berhenti." -ForegroundColor Gray
Write-Host "  ==========================================================" -ForegroundColor DarkYellow
Write-Host ""

if (-not $NoBrowser) {
    Start-Process $localUrl | Out-Null
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response
        $path = $req.Url.AbsolutePath

        try {
            $cfg = Read-DotEnv
            $isShared = Test-IsSharedContext -Request $req -EnvCfg $cfg

            if ($req.HttpMethod -eq "GET" -and $path -eq "/api/health") {
                Send-JsonResponse -Response $res -StatusCode 200 -Payload @{
                    ok      = $true
                    service = "harles-studio"
                    mode    = if ($isShared) { "shared" } else { "personal" }
                    ffmpeg  = [bool](Resolve-FfmpegPath)
                }
                continue
            }

            if ($req.HttpMethod -eq "GET" -and $path -eq "/api/config") {
                if ($isShared) {
                    Send-JsonResponse -Response $res -StatusCode 200 -Payload @{
                        ok              = $true
                        mode            = "shared"
                        hasApiKey       = $false
                        maskedKey       = ""
                        defaultTarget   = "user"
                        userId          = ""
                        groupId         = ""
                        ffmpegAvailable = [bool](Resolve-FfmpegPath)
                    }
                } else {
                    $apiKey = $cfg["ROBLOX_API_KEY"]
                    Send-JsonResponse -Response $res -StatusCode 200 -Payload @{
                        ok              = $true
                        mode            = "personal"
                        hasApiKey       = -not [string]::IsNullOrWhiteSpace($apiKey)
                        maskedKey       = Get-MaskedSecret -Secret $apiKey
                        defaultTarget   = if ($cfg["ROBLOX_DEFAULT_TARGET"] -eq "group") { "group" } else { "user" }
                        userId          = [string]$cfg["ROBLOX_USER_ID"]
                        groupId         = [string]$cfg["ROBLOX_GROUP_ID"]
                        ffmpegAvailable = [bool](Resolve-FfmpegPath)
                    }
                }
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/config") {
                if ($isShared) {
                    Send-JsonResponse -Response $res -StatusCode 403 -Payload @{
                        ok    = $false
                        error = "Mode Berbagi aktif: .env pemilik server dikunci. Tempel API Key kamu langsung di browser untuk sesi ini."
                    }
                    continue
                }

                $bodyText = Read-RequestUtf8Text -Request $req
                $data = $bodyText | ConvertFrom-Json
                $updates = @{}

                if ($null -ne $data.defaultTarget) {
                    $updates["ROBLOX_DEFAULT_TARGET"] = if ($data.defaultTarget -eq "group") { "group" } else { "user" }
                }
                if ($null -ne $data.userId) {
                    $updates["ROBLOX_USER_ID"] = ([string]$data.userId).Trim()
                }
                if ($null -ne $data.groupId) {
                    $updates["ROBLOX_GROUP_ID"] = ([string]$data.groupId).Trim()
                }
                if ($null -ne $data.apiKey -and -not [string]::IsNullOrWhiteSpace([string]$data.apiKey)) {
                    $updates["ROBLOX_API_KEY"] = ([string]$data.apiKey).Trim()
                } elseif ($data.clearApiKey -eq $true) {
                    $updates["ROBLOX_API_KEY"] = ""
                }

                Save-DotEnv -Updates $updates
                $cfg = Read-DotEnv
                $apiKey = $cfg["ROBLOX_API_KEY"]

                Send-JsonResponse -Response $res -StatusCode 200 -Payload @{
                    ok              = $true
                    mode            = "personal"
                    hasApiKey       = -not [string]::IsNullOrWhiteSpace($apiKey)
                    maskedKey       = Get-MaskedSecret -Secret $apiKey
                    defaultTarget   = if ($cfg["ROBLOX_DEFAULT_TARGET"] -eq "group") { "group" } else { "user" }
                    userId          = [string]$cfg["ROBLOX_USER_ID"]
                    groupId         = [string]$cfg["ROBLOX_GROUP_ID"]
                    ffmpegAvailable = [bool](Resolve-FfmpegPath)
                }
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/audio/ffmpeg") {
                $ff = Resolve-FfmpegPath
                if (-not $ff) {
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{
                        ok    = $false
                        error = "FFmpeg tidak ditemukan di sistem atau folder bin/."
                    }
                    continue
                }
                $meta = Parse-MetaHeader -Request $req
                if (-not $meta) {
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{ ok = $false; error = "Metadata header X-Harles-Meta tidak valid." }
                    continue
                }
                $audioBytes = Read-RequestBytes -Request $req
                $speed = [double]$meta.speed
                if ($speed -lt 0.25 -or $speed -gt 4.0) { $speed = 1.0 }
                $preservePitch = [bool]$meta.preservePitch
                $outFormat = if ($meta.outputFormat -eq "mp3") { "mp3" } else { "ogg" }
                $inExt = if ($meta.inputExt) { [string]$meta.inputExt } else { "wav" }

                $outBytes = Invoke-FfmpegTransform -FfmpegPath $ff -InputBytes $audioBytes -InputExt $inExt -Speed $speed -PreservePitch $preservePitch -OutputFormat $outFormat
                $mime = if ($outFormat -eq "mp3") { "audio/mpeg" } else { "audio/ogg" }
                Send-BytesResponse -Response $res -StatusCode 200 -Bytes $outBytes -ContentType $mime
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/roblox/upload") {
                $apiKey = Resolve-EffectiveApiKey -Request $req -IsShared $isShared -EnvCfg $cfg
                if ([string]::IsNullOrWhiteSpace($apiKey)) {
                    $msg = if ($isShared) {
                        "Masukkan Roblox Open Cloud API Key milikmu di form Roblox Target (tersimpan hanya di browser kamu)."
                    } else {
                        "ROBLOX_API_KEY belum diisi. Simpan API Key di panel Roblox Target atau file .env lokal."
                    }
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{
                        ok    = $false
                        error = $msg
                    }
                    continue
                }

                $meta = Parse-MetaHeader -Request $req
                if (-not $meta) {
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{
                        ok    = $false
                        error = "Header metadata X-Harles-Meta tidak ditemukan."
                    }
                    continue
                }

                $creatorType = if ($meta.creatorType -eq "group") { "group" } else { "user" }
                $creatorId = ([string]$meta.creatorId).Trim()
                if (-not $isShared -and [string]::IsNullOrWhiteSpace($creatorId)) {
                    $creatorId = if ($creatorType -eq "group") { [string]$cfg["ROBLOX_GROUP_ID"] } else { [string]$cfg["ROBLOX_USER_ID"] }
                }
                if (-not ($creatorId -match "^\d+$")) {
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{
                        ok    = $false
                        error = "Target $($creatorType.ToUpper()) ID wajib berupa angka yang valid."
                    }
                    continue
                }

                $displayName = ([string]$meta.displayName).Trim()
                if ([string]::IsNullOrWhiteSpace($displayName)) {
                    $displayName = "Harles Studio Audio"
                }
                if ($displayName.Length -gt 50) {
                    $displayName = $displayName.Substring(0, 50).Trim()
                }
                $description = if ($meta.description) { [string]$meta.description } else { "Uploaded via Harles Studio" }
                $mimeType = if ($meta.mimeType) { [string]$meta.mimeType } else { "audio/wav" }
                $allowedMimes = @("audio/wav", "audio/ogg", "audio/mpeg", "audio/flac")
                if ($allowedMimes -notcontains $mimeType) {
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{
                        ok    = $false
                        error = "Format MIME tidak didukung Roblox ($mimeType). Gunakan WAV, OGG, MP3, atau FLAC."
                    }
                    continue
                }

                $audioBytes = Read-RequestBytes -Request $req
                if ($audioBytes.Length -eq 0) {
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{ ok = $false; error = "File audio kosong." }
                    continue
                }
                if ($audioBytes.Length -gt $script:MaxAudioBytes) {
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{
                        ok    = $false
                        error = "Ukuran file melebihi batas maksimal 20 MB dari Roblox Open Cloud."
                    }
                    continue
                }

                $fileName = if ($meta.fileName) { [string]$meta.fileName } else { "audio.wav" }
                $result = Start-RobloxUpload `
                    -ApiKey $apiKey `
                    -DisplayName $displayName `
                    -Description $description `
                    -CreatorType $creatorType `
                    -CreatorId $creatorId `
                    -MimeType $mimeType `
                    -FileName $fileName `
                    -AudioBytes $audioBytes

                $code = if ($result.ok) { 200 } elseif ($result.status) { [int]$result.status } else { 500 }
                Send-JsonResponse -Response $res -StatusCode $code -Payload $result
                continue
            }

            if ($req.HttpMethod -eq "GET" -and $path -eq "/api/roblox/operation") {
                $apiKey = Resolve-EffectiveApiKey -Request $req -IsShared $isShared -EnvCfg $cfg
                if ([string]::IsNullOrWhiteSpace($apiKey)) {
                    Send-JsonResponse -Response $res -StatusCode 400 -Payload @{
                        ok    = $false
                        error = "API Key tidak tersedia untuk mengecek operasi Roblox."
                    }
                    continue
                }
                $opPath = ([string]$req.QueryString["path"]).Trim()
                $result = Get-RobloxOperationStatus -ApiKey $apiKey -OperationPath $opPath
                $code = if ($result.ok) { 200 } elseif ($result.status) { [int]$result.status } else { 500 }
                Send-JsonResponse -Response $res -StatusCode $code -Payload $result
                continue
            }

            if ($req.HttpMethod -eq "GET") {
                Send-StaticFile -Response $res -UrlPath $path
                continue
            }

            Send-JsonResponse -Response $res -StatusCode 405 -Payload @{ ok = $false; error = "Method Not Allowed" }
        } catch {
            Write-Host "[Error] $path : $($_.Exception.Message)" -ForegroundColor Red
            try {
                Send-JsonResponse -Response $res -StatusCode 500 -Payload @{
                    ok    = $false
                    error = $_.Exception.Message
                }
            } catch {}
        }
    }
} finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
    $listener.Close()
}
