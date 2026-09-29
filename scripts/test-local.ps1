$ErrorActionPreference = 'Stop'
$projectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$started = $false
Push-Location -LiteralPath $projectPath
try {
    & (Join-Path $PSScriptRoot 'solana.ps1') build
    & npm run setup:local
    if ($LASTEXITCODE -ne 0) { throw 'Local fixture setup failed' }
    & (Join-Path $PSScriptRoot 'solana.ps1') start
    $started = $true
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18999' -Method Post `
                -ContentType 'application/json' -Body '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' -TimeoutSec 2
            if ($health.result -eq 'ok') { $ready = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (!$ready) {
        & (Join-Path $PSScriptRoot 'solana.ps1') logs
        throw 'Local validator did not become healthy'
    }
    & npm run test:local
    if ($LASTEXITCODE -ne 0) { throw 'Local integration tests failed' }
} finally {
    if ($started) { & (Join-Path $PSScriptRoot 'solana.ps1') stop }
    Pop-Location
}
