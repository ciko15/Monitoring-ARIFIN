param (
    [string]$IPAddress = "",
    [int]$Port = 0
)

if ([string]::IsNullOrWhiteSpace($IPAddress)) {
    $IPAddress = Read-Host "Masukkan IP Address ADSB (contoh: 192.168.1.100)"
}

if ($Port -eq 0) {
    $portStr = Read-Host "Masukkan Port ADSB (contoh: 50000 atau 4001)"
    if (![int]::TryParse($portStr, [ref]$Port)) {
        Write-Host "Port tidak valid. Menggunakan port default 50000." -ForegroundColor Yellow
        $Port = 50000
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Memeriksa Koneksi ke ADSB: $IPAddress" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# 1. PING TEST
Write-Host "[1] Mengecek Ping (ICMP)..." -ForegroundColor Yellow
$pingResult = Test-Connection -ComputerName $IPAddress -Count 4 -Quiet
if ($pingResult) {
    Write-Host "    [+] PING BERHASIL: Perangkat terhubung ke jaringan." -ForegroundColor Green
} else {
    Write-Host "    [-] PING GAGAL: Perangkat tidak membalas ping. Cek kabel atau firewall." -ForegroundColor Red
}

# 2. TCP PORT TEST
Write-Host "`n[2] Mengecek Port TCP ($Port)..." -ForegroundColor Yellow
try {
    $tcpTest = Test-NetConnection -ComputerName $IPAddress -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($tcpTest) {
        Write-Host "    [+] TCP PORT BERHASIL: Port $Port terbuka dan bisa menerima data (TCP)." -ForegroundColor Green
    } else {
        Write-Host "    [-] TCP PORT GAGAL: Port $Port tertutup atau terblokir firewall. Jika ADSB menggunakan UDP, abaikan peringatan ini." -ForegroundColor Red
    }
} catch {
    Write-Host "    [-] Gagal mengecek TCP Port. Error: $($_.Exception.Message)" -ForegroundColor Red
}

# 3. FIREWALL CHECK (Lokal PC Windows)
Write-Host "`n[3] Mengecek Rule Firewall di PC ini (Apakah Node.js/Aplikasi diizinkan)..." -ForegroundColor Yellow
try {
    $firewallRules = Get-NetFirewallRule -Action Allow -Enabled True | Where-Object { $_.DisplayName -match "Node" -or $_.DisplayName -match "PM2" }
    if ($firewallRules) {
        Write-Host "    [+] Ditemukan rule firewall yang mengizinkan Node.js:" -ForegroundColor Green
        foreach ($rule in $firewallRules) {
            Write-Host "        - $($rule.DisplayName)" -ForegroundColor Green
        }
    } else {
        Write-Host "    [-] Tidak ditemukan rule Allow khusus untuk Node.js di Firewall. Pastikan aplikasi Anda tidak diblokir Windows Defender." -ForegroundColor Red
    }
} catch {
    Write-Host "    [!] Tidak dapat mengecek aturan Firewall (biasanya membutuhkan akses Run as Administrator)." -ForegroundColor Yellow
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Pengecekan Selesai." -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan
Read-Host "Tekan Enter untuk keluar..."
