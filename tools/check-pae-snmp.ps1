param(
  [string[]]$Hosts = @(
    "192.168.210.130",
    "192.168.210.131",
    "192.168.210.132",
    "192.168.210.133",
    "192.168.210.134",
    "192.168.210.135",
    "192.168.100.151"
  ),
  [string]$Community = "public",
  [ValidateSet("1", "2c")]
  [string]$Version = "2c",
  [int]$Port = 161,
  [int]$Timeout = 3000,
  [string]$TcpPorts = "8010,950",
  [switch]$Walk,
  [string]$Oid = "1.3.6.1",
  [int]$Limit = 80,
  [switch]$NoTcp
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js tidak ditemukan. Install Node.js LTS dulu, atau jalankan dari PC yang sudah punya Node/Bun."
}

$scriptPath = Join-Path $PSScriptRoot "check-pae-snmp.js"
$argsList = @(
  $scriptPath,
  "--hosts", ($Hosts -join ","),
  "--community", $Community,
  "--version", $Version,
  "--port", "$Port",
  "--timeout", "$Timeout",
  "--tcp-ports", $TcpPorts,
  "--oid", $Oid,
  "--limit", "$Limit"
)

if ($Walk) {
  $argsList += "--walk"
}

if ($NoTcp) {
  $argsList += "--no-tcp"
}

& node @argsList
