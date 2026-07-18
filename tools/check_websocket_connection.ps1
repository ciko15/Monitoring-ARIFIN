param (
    [string]$Url = ""
)

if ([string]::IsNullOrWhiteSpace($Url)) {
    $Url = Read-Host "Masukkan URL WebSocket (contoh: ws://192.168.1.100:8080/ws)"
}

if (-not $Url.StartsWith("ws://") -and -not $Url.StartsWith("wss://")) {
    $Url = "ws://" + $Url
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Mencoba Konek ke WebSocket: $Url" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

try {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $uri = New-Object System.Uri($Url)
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter(5000) # 5 detik batas waktu koneksi

    Write-Host "[1] Menghubungkan ke $Url ..." -ForegroundColor Yellow
    $connectTask = $ws.ConnectAsync($uri, $cts.Token)
    $connectTask.Wait()

    if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        Write-Host "    [+] BERHASIL TERSAMBUNG KE WEBSOCKET!" -ForegroundColor Green
        Write-Host "`n[2] Mendengarkan data selama 10 detik..." -ForegroundColor Yellow
        
        $buffer = New-Object byte[] 8192
        $segment = New-Object System.ArraySegment[byte]($buffer)
        
        $listenCts = New-Object System.Threading.CancellationTokenSource
        $listenCts.CancelAfter(10000) # Dengarkan selama 10 detik

        try {
            while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open -and -not $listenCts.IsCancellationRequested) {
                $receiveTask = $ws.ReceiveAsync($segment, $listenCts.Token)
                $receiveTask.Wait()
                
                $result = $receiveTask.Result
                if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Text) {
                    $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
                    Write-Host "    [Data Teks] Menerima $($result.Count) bytes: $text" -ForegroundColor DarkGray
                } elseif ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Binary) {
                    $hexStr = [System.BitConverter]::ToString($buffer, 0, $result.Count)
                    if ($hexStr.Length -gt 60) { $hexStr = $hexStr.Substring(0, 60) + "..." }
                    Write-Host "    [Data Biner] Menerima $($result.Count) bytes (Hex): $hexStr" -ForegroundColor Magenta
                } elseif ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                    Write-Host "    [*] Server memutus koneksi WebSocket secara sepihak." -ForegroundColor Red
                    break
                }
            }
        } catch {
            if ($_.Exception.InnerException -is [System.Threading.Tasks.TaskCanceledException] -or $_.Exception.InnerException.GetType().Name -eq "TaskCanceledException") {
                Write-Host "    [OK] Selesai mendengarkan (Waktu 10 detik telah habis)." -ForegroundColor Green
            } else {
                Write-Host "    [-] Error saat mendengarkan data: $($_.Exception.InnerException.Message)" -ForegroundColor Red
            }
        }

        # Tutup koneksi setelah selesai
        if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            $closeCts = New-Object System.Threading.CancellationTokenSource
            $closeCts.CancelAfter(2000)
            $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "Client closing", $closeCts.Token).Wait()
        }
    } else {
        Write-Host "    [-] Gagal terhubung. Status: $($ws.State)" -ForegroundColor Red
    }
} catch {
    $errMsg = $_.Exception.InnerException.Message
    if ([string]::IsNullOrEmpty($errMsg)) { $errMsg = $_.Exception.Message }
    Write-Host "    [-] GAGAL KONEK. Error: $errMsg" -ForegroundColor Red
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host " Pengecekan Selesai." -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan
Read-Host "Tekan Enter untuk keluar..."
