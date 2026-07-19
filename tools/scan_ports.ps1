param (
    [string]$IPAddress = ""
)

if ([string]::IsNullOrWhiteSpace($IPAddress)) {
    $IPAddress = Read-Host "Masukkan IP Address alat (contoh: 192.168.1.100)"
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Scanning Port Terbuka di IP: $IPAddress" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Daftar port yang biasa dipakai untuk ADSB, Moxa, dan alat Navigasi Udara
$commonPorts = @(
    80, 443,      # Web / HTTP
    950, 951,     # Moxa NPort Raw TCP
    4000, 4001, 4002, # Serial to Ethernet (Moxa / Perle)
    10001, 10002, # Lantronix / Serial Server
    21000, 21001, # ATC Serial
    30005,        # dump1090 Beast Format
    50000         # Asterix format port biasa
)

Write-Host "Mengecek port-port langganan: $($commonPorts -join ', ')...`n" -ForegroundColor Yellow

$found = 0
foreach ($port in $commonPorts) {
    try {
        $tcpTest = Test-NetConnection -ComputerName $IPAddress -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($tcpTest) {
            Write-Host "    [+] PORT DITEMUKAN TERBUKA: $port" -ForegroundColor Green
            $found++
        }
    } catch {
        # Abaikan error
    }
}

if ($found -eq 0) {
    Write-Host "`n[-] Tidak ada port langganan yang terbuka. Mungkin port-nya unik atau diblokir firewall (ping saja tidak cukup)." -ForegroundColor Red
} else {
    Write-Host "`n[+] Selesai! Silakan gunakan salah satu port hijau di atas untuk dicoba di aplikasi." -ForegroundColor Green
}

Write-Host "`n========================================" -ForegroundColor Cyan
Read-Host "Tekan Enter untuk keluar..."
