param (
    [string]$IPAddress = "",
    [int]$Port = 0
)

if ([string]::IsNullOrWhiteSpace($IPAddress)) {
    $IPAddress = Read-Host "Masukkan IP Address ADSB (Bisa Unicast atau Multicast misal: 239.x.x.x)"
}

if ($Port -eq 0) {
    $portStr = Read-Host "Masukkan Port ADSB (contoh: 50000 atau 4001)"
    if (![int]::TryParse($portStr, [ref]$Port)) {
        Write-Host "Port tidak valid. Menggunakan port default 50000." -ForegroundColor Yellow
        $Port = 50000
    }
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Memeriksa Koneksi ke ADSB: $IPAddress Port: $Port" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# Cek apakah IP Multicast (Oktet pertama 224-239)
$ipObj = $null
$isMulticast = $false
if ([System.Net.IPAddress]::TryParse($IPAddress, [ref]$ipObj)) {
    $firstOctet = [int]$ipObj.GetAddressBytes()[0]
    if ($firstOctet -ge 224 -and $firstOctet -le 239) {
        $isMulticast = $true
    }
}

if ($isMulticast) {
    Write-Host "[*] Terdeteksi IP Multicast ($IPAddress)." -ForegroundColor Magenta
    Write-Host "[1] Mengecek Multicast UDP (Mendengarkan selama 10 detik)..." -ForegroundColor Yellow
    
    try {
        $udpClient = New-Object System.Net.Sockets.UdpClient
        $udpClient.Client.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
        $localEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, $Port)
        $udpClient.Client.Bind($localEp)
        
        $udpClient.JoinMulticastGroup($ipObj)
        $udpClient.Client.ReceiveTimeout = 10000 # 10 detik timeout
        
        Write-Host "    Mendengarkan data UDP di grup multicast $IPAddress port $Port..." -ForegroundColor Gray
        $remoteEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        
        $bytes = $udpClient.Receive([ref]$remoteEp)
        $senderIP = $remoteEp.Address.ToString()
        
        Write-Host "    [+] MULTICAST BERHASIL: Menerima $($bytes.Length) bytes data dari sumber $senderIP" -ForegroundColor Green
        
        # Tampilkan sedikit snippet data Hex
        $hexStr = [System.BitConverter]::ToString($bytes)
        if ($hexStr.Length -gt 60) { $hexStr = $hexStr.Substring(0, 60) + "..." }
        Write-Host "    Data (Hex): $hexStr" -ForegroundColor DarkGray
        
        $udpClient.DropMulticastGroup($ipObj)
        $udpClient.Close()
    } catch {
        Write-Host "    [-] MULTICAST GAGAL: Tidak ada data yang diterima dalam 10 detik atau akses ditolak." -ForegroundColor Red
        Write-Host "    Error detail: $($_.Exception.Message)" -ForegroundColor Red
        if ($null -ne $udpClient) { $udpClient.Close() }
    }
} else {
    # 1. PING TEST UNTUK UNICAST
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
}

# 3. FIREWALL CHECK (Lokal PC Windows)
Write-Host "`n[3] Mengecek Rule Firewall di PC ini..." -ForegroundColor Yellow
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
