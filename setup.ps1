# Installs the Dota 2 Game State Integration config so Dota sends live game data to the coach.
# Safe to run many times: it only (re)writes one small .cfg file inside the Dota folder.
# -LaunchDota also starts Dota 2 with -gamestateintegration if it isn't running yet.
param([switch]$LaunchDota)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = [IO.File]::ReadAllText((Join-Path $root 'config.json')) | ConvertFrom-Json
$cacheDir = Join-Path $root 'cache'
New-Item -ItemType Directory -Force $cacheDir | Out-Null
$utf8 = New-Object Text.UTF8Encoding $false

function Find-DotaFolder {
    if ($config.dotaPath -and (Test-Path $config.dotaPath)) { return $config.dotaPath }
    $steam = 'C:\Program Files (x86)\Steam'
    try { $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath -replace '/', '\' } catch {}
    $libs = @($steam)
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path $vdf) {
        foreach ($m in [regex]::Matches([IO.File]::ReadAllText($vdf), '"path"\s+"([^"]+)"')) {
            $libs += ($m.Groups[1].Value -replace '\\\\', '\')
        }
    }
    foreach ($lib in ($libs | Select-Object -Unique)) {
        $p = Join-Path $lib 'steamapps\common\dota 2 beta\game\dota'
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Test-LaunchOption {
    $steam = 'C:\Program Files (x86)\Steam'
    try { $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath -replace '/', '\' } catch {}
    foreach ($user in (Get-ChildItem (Join-Path $steam 'userdata') -Directory -ErrorAction SilentlyContinue)) {
        $lc = Join-Path $user.FullName 'config\localconfig.vdf'
        if ((Test-Path $lc) -and (Select-String -Path $lc -Pattern 'gamestateintegration' -Quiet)) { return $true }
    }
    return $false
}

Write-Host ''
Write-Host '  Dota 2 ADHD Coach - setup' -ForegroundColor Cyan
$dota = Find-DotaFolder
$cfgFile = $null
if (-not $dota) {
    Write-Host '  [X] Could not find Dota 2. Put its "game\dota" folder path in config.json -> "dotaPath".' -ForegroundColor Red
} else {
    $cfgDir = Join-Path $dota 'cfg\gamestate_integration'
    New-Item -ItemType Directory -Force $cfgDir | Out-Null
    $cfgFile = Join-Path $cfgDir 'gamestate_integration_adhd_coach.cfg'
    $cfg = @"
"Dota 2 ADHD Coach"
{
    "uri"           "http://127.0.0.1:$($config.port)/"
    "timeout"       "5.0"
    "buffer"        "0.1"
    "throttle"      "0.2"
    "heartbeat"     "10.0"
    "data"
    {
        "provider"      "1"
        "map"           "1"
        "player"        "1"
        "hero"          "1"
        "abilities"     "1"
        "items"         "1"
        "events"        "1"
        "buildings"     "1"
        "draft"         "1"
        "wearables"     "0"
    }
    "auth"
    {
        "token"         "$($config.token)"
    }
}
"@
    [IO.File]::WriteAllText($cfgFile, $cfg, $utf8)
    Write-Host "  [OK] Dota 2 connection installed: $cfgFile" -ForegroundColor Green
}

$launchOk = Test-LaunchOption
if ($launchOk) {
    Write-Host '  [OK] Launch option -gamestateintegration found.' -ForegroundColor Green
} else {
    Write-Host '  [!] One manual step: Steam > right-click Dota 2 > Properties > Launch Options > add:' -ForegroundColor Yellow
    Write-Host '        -gamestateintegration' -ForegroundColor Yellow
}

if ($LaunchDota -and $dota) {
    $running = Get-CimInstance Win32_Process -Filter "Name='dota2.exe'" -ErrorAction SilentlyContinue
    if (-not $running) {
        $steamExe = 'C:\Program Files (x86)\Steam\steam.exe'
        try { $steamExe = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamExe -replace '/', '\' } catch {}
        & $steamExe -applaunch 570 -gamestateintegration
        Write-Host '  [OK] Starting Dota 2 with -gamestateintegration ...' -ForegroundColor Green
        $launchOk = $true
    } elseif ($running.CommandLine -notmatch 'gamestateintegration') {
        Write-Host '  [!] Dota 2 is already open WITHOUT -gamestateintegration. Close it and run START.bat again.' -ForegroundColor Yellow
    }
}

$info = [ordered]@{ dotaPath = $dota; cfgFile = $cfgFile; launchOptionFound = $launchOk; at = (Get-Date).ToString('s') }
[IO.File]::WriteAllText((Join-Path $cacheDir 'setup.json'), ($info | ConvertTo-Json), $utf8)
Write-Host ''
