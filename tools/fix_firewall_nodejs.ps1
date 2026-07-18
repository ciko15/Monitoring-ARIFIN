# Meminta hak akses Administrator otomatis
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Membutuhkan akses Administrator. Silakan klik 'Yes' pada jendela konfirmasi..." -ForegroundColor Yellow
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " MENAMBAHKAN NODE.JS / BUN KE WINDOWS FIREWALL" -ForegroundColor Cyan
Write-Host "===============================================`n" -ForegroundColor Cyan

# Mencari lokasi node.exe dan bun.exe dari environment variabel PATH
$exePaths = @()
$envPaths = ($env:PATH -split ';')
$targets = @("node.exe", "bun.exe")

foreach ($path in $envPaths) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    try {
        foreach ($target in $targets) {
            $exe = Join-Path -Path $path -ChildPath $target
            if (Test-Path $exe) {
                if ($exePaths -notcontains $exe) {
                    $exePaths += $exe
                }
            }
        }
    } catch {}
}

# Jika tidak ditemukan di PATH, coba lokasi default
if ($exePaths.Count -eq 0) {
    $defaultPaths = @(
        "C:\Program Files\nodejs\node.exe",
        "C:\Program Files (x86)\nodejs\node.exe",
        "$env:USERPROFILE\.bun\bin\bun.exe"
    )
    
    foreach ($dp in $defaultPaths) {
        if (Test-Path $dp) { $exePaths += $dp }
    }
}

if ($exePaths.Count -eq 0) {
    Write-Host "[-] GAGAL: Node.js (node.exe) atau Bun (bun.exe) tidak ditemukan." -ForegroundColor Red
    Write-Host "[-] Silakan masukkan aturan Firewall secara manual lewat Windows Defender Firewall." -ForegroundColor Red
    Read-Host "Tekan Enter untuk keluar..."
    exit
}

$added = 0
foreach ($path in $exePaths) {
    Write-Host "[*] Menambahkan pengecualian Firewall untuk: $path" -ForegroundColor Yellow
    
    # Nama rule tergantung programnya
    $progName = if ($path -match "bun.exe") { "Bun" } else { "Node.js" }
    $ruleNameTCP = "$progName ARIFIN Allow (TCP) - $path"
    $ruleNameUDP = "$progName ARIFIN Allow (UDP) - $path"
    
    # Hapus rule lama jika sudah ada (agar bersih)
    Remove-NetFirewallRule -DisplayName $ruleNameTCP -ErrorAction SilentlyContinue | Out-Null
    Remove-NetFirewallRule -DisplayName $ruleNameUDP -ErrorAction SilentlyContinue | Out-Null
    
    # Buat rule baru untuk TCP dan UDP (Multicast butuh UDP)
    New-NetFirewallRule -DisplayName $ruleNameTCP -Direction Inbound -Program $path -Profile Any -Action Allow -Protocol TCP | Out-Null
    New-NetFirewallRule -DisplayName $ruleNameUDP -Direction Inbound -Program $path -Profile Any -Action Allow -Protocol UDP | Out-Null
    $added++
}

if ($added -gt 0) {
    Write-Host "`n[+] BERHASIL! Windows Firewall sudah membuka jalur (TCP/UDP) untuk Node.js / Bun." -ForegroundColor Green
    Write-Host "    Aplikasi ARIFIN sekarang sudah bisa menerima data Multicast ADSB." -ForegroundColor Green
}

Write-Host "`n===============================================" -ForegroundColor Cyan
Write-Host " PENTING: Silakan RESTART (Tutup lalu jalankan kembali) aplikasi PM2/ARIFIN Anda." -ForegroundColor Yellow
Write-Host "===============================================`n" -ForegroundColor Cyan

Read-Host "Tekan Enter untuk keluar..."
