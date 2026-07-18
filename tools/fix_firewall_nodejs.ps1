# Meminta hak akses Administrator otomatis
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Membutuhkan akses Administrator. Silakan klik 'Yes' pada jendela konfirmasi..." -ForegroundColor Yellow
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " MENAMBAHKAN NODE.JS KE WINDOWS FIREWALL" -ForegroundColor Cyan
Write-Host "===============================================`n" -ForegroundColor Cyan

# Mencari lokasi node.exe dari environment variabel PATH
$nodePaths = @()
$envPaths = ($env:PATH -split ';')
foreach ($path in $envPaths) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    try {
        $nodeExe = Join-Path -Path $path -ChildPath "node.exe"
        if (Test-Path $nodeExe) {
            if ($nodePaths -notcontains $nodeExe) {
                $nodePaths += $nodeExe
            }
        }
    } catch {}
}

# Jika tidak ditemukan di PATH, coba lokasi default
if ($nodePaths.Count -eq 0) {
    $defaultPath1 = "C:\Program Files\nodejs\node.exe"
    $defaultPath2 = "C:\Program Files (x86)\nodejs\node.exe"
    
    if (Test-Path $defaultPath1) { $nodePaths += $defaultPath1 }
    if (Test-Path $defaultPath2) { $nodePaths += $defaultPath2 }
}

if ($nodePaths.Count -eq 0) {
    Write-Host "[-] GAGAL: Node.js (node.exe) tidak ditemukan di komputer ini." -ForegroundColor Red
    Write-Host "[-] Silakan masukkan aturan Firewall secara manual." -ForegroundColor Red
    Read-Host "Tekan Enter untuk keluar..."
    exit
}

$added = 0
foreach ($path in $nodePaths) {
    Write-Host "[*] Menambahkan pengecualian Firewall untuk: $path" -ForegroundColor Yellow
    $ruleNameTCP = "Node.js ARIFIN Allow (TCP) - $path"
    $ruleNameUDP = "Node.js ARIFIN Allow (UDP) - $path"
    
    # Hapus rule lama jika sudah ada (agar bersih)
    Remove-NetFirewallRule -DisplayName $ruleNameTCP -ErrorAction SilentlyContinue | Out-Null
    Remove-NetFirewallRule -DisplayName $ruleNameUDP -ErrorAction SilentlyContinue | Out-Null
    
    # Buat rule baru untuk TCP dan UDP (Multicast butuh UDP)
    New-NetFirewallRule -DisplayName $ruleNameTCP -Direction Inbound -Program $path -Profile Any -Action Allow -Protocol TCP | Out-Null
    New-NetFirewallRule -DisplayName $ruleNameUDP -Direction Inbound -Program $path -Profile Any -Action Allow -Protocol UDP | Out-Null
    $added++
}

if ($added -gt 0) {
    Write-Host "`n[+] BERHASIL! Windows Firewall sudah membuka jalur (TCP/UDP) untuk Node.js." -ForegroundColor Green
    Write-Host "    Aplikasi ARIFIN (Node.js) sekarang sudah bisa menerima data Multicast ADSB." -ForegroundColor Green
}

Write-Host "`n===============================================" -ForegroundColor Cyan
Write-Host " PENTING: Silakan RESTART (Tutup lalu jalankan kembali) aplikasi PM2/ARIFIN Anda." -ForegroundColor Yellow
Write-Host "===============================================`n" -ForegroundColor Cyan

Read-Host "Tekan Enter untuk keluar..."
