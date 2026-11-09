param([int]$Port = 3000)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (!$nodeCommand) {
    $workspace = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $portable = Join-Path $workspace 'work\node-v22.23.4-win-x64'
    if (!(Test-Path (Join-Path $portable 'node.exe'))) { throw 'Instale Node.js 22 ou superior de https://nodejs.org e execute novamente.' }
    $env:PATH = "$portable;$env:PATH"
}
if (!(Test-Path node_modules)) {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependencias.' }
}
$env:PORT = [string]$Port
if (Test-Path .env) { & node.exe --env-file=.env server.js }
else { & node.exe server.js }
exit $LASTEXITCODE
