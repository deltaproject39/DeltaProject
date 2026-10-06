# Starts Delta for the website: voice server + brush + gatekeeper + Cloudflare tunnel, then publishes
# the new tunnel address to config.json on GitHub Pages.
# Run: right-click > "Run with PowerShell" (keep the window open while Delta is online).

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$cloudflared = "$env:USERPROFILE\cloudflared\cloudflared.exe"
$log = Join-Path $env:TEMP "delta-tunnel.log"

Write-Host "Starting Delta's voice..."
$voice = Start-Process "$repo\server\.venv\Scripts\python.exe" -ArgumentList "`"$repo\server\tts_server.py`"" -PassThru -WindowStyle Hidden

Write-Host "Starting Delta's brush (sketchbook)..."
$art = Start-Process "$repo\server\.venv-art\Scripts\python.exe" -ArgumentList "`"$repo\serverrt_server.py`"" -PassThru -WindowStyle Hidden

Write-Host "Starting gatekeeper..."
$gatekeeper = Start-Process node -ArgumentList "`"$repo\server\gatekeeper.js`"" -PassThru -WindowStyle Hidden

Write-Host "Starting Cloudflare tunnel..."
Remove-Item $log -ErrorAction SilentlyContinue
$tunnel = Start-Process $cloudflared -ArgumentList "tunnel --no-autoupdate --url http://127.0.0.1:8787 --logfile `"$log`"" -PassThru -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 30 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
        $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value }
    }
}
if (-not $url) {
    Write-Host "Couldn't get a tunnel address. Check your internet connection." -ForegroundColor Red
    Stop-Process -Id $voice.Id, $art.Id, $gatekeeper.Id, $tunnel.Id -ErrorAction SilentlyContinue
    Read-Host "Press Enter to close"
    exit 1
}
Write-Host "Tunnel: $url" -ForegroundColor Green

Write-Host "Publishing new address to the website..."
Set-Content -Path "$repo\config.json" -Encoding ascii -Value "{`n  `"deltaServer`": `"$url`"`n}"
git -C $repo add config.json
git -C $repo commit -m "Update Delta tunnel address" | Out-Null
git -C $repo push

Write-Host ""
Write-Host "Delta is online! (site updates in about a minute)" -ForegroundColor Green
Write-Host "https://deltaproject39.github.io/DeltaProject/ai.html"
Write-Host "Voice Lab (this PC only): http://localhost:8788/lab"
Write-Host ""
Read-Host "Press Enter to put Delta to sleep and take her offline"

# Let her fall asleep properly (finish any note, save everything) before closing the rest.
try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/owner/sleep-and-close" -TimeoutSec 5 | Out-Null } catch {}
Wait-Process -Id $gatekeeper.Id -Timeout 10 -ErrorAction SilentlyContinue

Stop-Process -Id $voice.Id, $art.Id, $gatekeeper.Id, $tunnel.Id -ErrorAction SilentlyContinue
Write-Host "Delta is offline."
