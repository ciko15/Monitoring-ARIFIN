param(
  [string]$HostIp = "192.168.210.130",
  [int]$Port = 80,
  [string]$Username = "admin",
  [string]$Password = "admin",
  [string]$Path = "/ws",
  [int]$Seconds = 20,
  [switch]$Json,
  [switch]$Raw
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js tidak ditemukan. Install Node.js LTS dulu, atau jalankan dari PC yang sudah punya Node/Bun."
}

$scriptPath = Join-Path $PSScriptRoot "check-pae-t6tv.js"
$argsList = @(
  $scriptPath,
  "--host", $HostIp,
  "--port", "$Port",
  "--username", $Username,
  "--password", $Password,
  "--path", $Path,
  "--seconds", "$Seconds"
)

if ($Json) {
  $argsList += "--json"
}

if ($Raw) {
  $argsList += "--raw"
}

& node @argsList
