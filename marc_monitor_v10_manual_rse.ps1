# =============================================================================
# MARC VHF Monitor v10 - RSE Manual List + Radio Auto-Discover
# Park Air T6 Protocol via Moxa Real COM Mode
#
# ★★★ BAGIAN YANG PERLU DIGANTI TIAP LOKASI ADA DI PARAM (bawah) DAN $RSE_LIST ★★★
# Cari tanda "★ GANTI DI SINI" untuk semua titik yang perlu disesuaikan.
# =============================================================================

param(
    [string]$MoxaIP = "192.168.100.151",   # ★ GANTI DI SINI - IP Moxa lokasi ini
    [int]$MoxaPort = 950,                  # ★ GANTI DI SINI - port TCP Moxa (biasanya 950, TAPI CEK dulu, bisa beda!)
    [int]$PortStart = 2,                   # ★ CEK - port radio terkecil yang mau di-scan (default 2, sesuai standar Sentani)
    [int]$PortEnd = 12,                    # ★ CEK - port radio terbesar yang mau di-scan (naikkan kalau RSE lokasi ini radionya lebih banyak dari 8)
    [int]$DiscoverTimeoutMs = 400,         # tidak perlu diganti, kecuali koneksi lambat/lag (naikkan ke 800-1000 kalau sering miss)
    [int]$PollInterval = 30                # tidak perlu diganti, cuma interval refresh dashboard (detik)
)

# =============================================================================
# ★ GANTI DI SINI — Daftar RSE ID (desimal) yang mau di-monitor di lokasi ini.
# Tinggal isi/hapus sesuai jumlah RSE di lokasi ini (Rama sudah tau ada berapa).
# Radio di dalam tiap RSE akan di-DISCOVER OTOMATIS, tidak perlu isi manual.
# =============================================================================
$RSE_LIST = @(
    90,
    91,
    93,
    94,
    95,
    96,
    97
)
# =============================================================================

# =============================================================================
# PROTOKOL CONSTANTS (terverifikasi dari CommsLog + source code production)
# =============================================================================
[byte]$VER = 0x30
[byte]$T6_PREFIX = 0x53
[byte]$CMD_ALL_SETTINGS = 0x28   # CR2_ALL_SETTINGS_REQUEST - trigger RSE balas semua radio-nya
[byte]$CMD_SETTINGS1 = 0xEB
[byte]$CMD_SETTINGS2 = 0xE9
[byte]$CMD_TX_BITE   = 0xEF
[byte]$CMD_RX_BITE   = 0xED
[byte]$RPL_SETTINGS1 = 0xEA
[byte]$RPL_SETTINGS2 = 0xE8
[byte]$RPL_TX_BITE   = 0xEE
[byte]$RPL_RX_BITE   = 0xEC

$MASTER_SRC_H = 0x10   # ★ KEMUNGKINAN GANTI - address "kita" sebagai master. Nilai ini (0x1000=4096)
$MASTER_SRC_L = 0x00   #   terverifikasi benar utk Sentani (lihat CommsLog "s4096"). Kalau di lokasi baru
                        #   script ini TIDAK dapat balasan sama sekali padahal RSE/port sudah benar,
                        #   coba cek CommsLog aplikasi original lokasi itu, cari pola "s[angka]" di baris
                        #   Tx (kirim), itu kemungkinan address master yang harus dipakai di sini.

# =============================================================================
# SLIP + CRC16 (SAMA seperti script sebelumnya, sudah teruji)
# =============================================================================
function Get-CRC16 {
    param([byte[]]$Data)
    [int]$crc = 0
    foreach ($b in $Data) {
        $crc = $crc -bxor ([int]$b * 256)
        for ($i = 0; $i -lt 8; $i++) {
            if ($crc -band 0x8000) { $crc = (($crc * 2) -bxor 0x1021) -band 0xFFFF }
            else { $crc = ($crc * 2) -band 0xFFFF }
        }
    }
    return [int]$crc
}

function Invoke-SlipEncode {
    param([byte[]]$Data)
    $r = [System.Collections.Generic.List[byte]]::new()
    foreach ($b in $Data) {
        if ($b -eq 0xC0) { $r.Add([byte]0xDB); $r.Add([byte]0xDC) }
        elseif ($b -eq 0xDB) { $r.Add([byte]0xDB); $r.Add([byte]0xDD) }
        else { $r.Add([byte]$b) }
    }
    return [byte[]]$r.ToArray()
}

function Invoke-SlipDecode {
    param([byte[]]$Data)
    $r = [System.Collections.Generic.List[byte]]::new()
    $i = 0
    while ($i -lt $Data.Length) {
        if ($Data[$i] -eq 0xDB -and ($i + 1) -lt $Data.Length) {
            if ($Data[$i+1] -eq 0xDC) { $r.Add([byte]0xC0); $i += 2; continue }
            elseif ($Data[$i+1] -eq 0xDD) { $r.Add([byte]0xDB); $i += 2; continue }
        }
        $r.Add([byte]$Data[$i]); $i++
    }
    return [byte[]]$r.ToArray()
}

$script:SeqNum = 0
function Get-NextSeq { $script:SeqNum = ($script:SeqNum + 1) % 256; return [byte]$script:SeqNum }

function Build-WirePacket {
    # $DestId = RSE ID tujuan (bukan lagi fixed 0x5A!)
    param([int]$DestId, [byte[]]$Payload)
    [byte]$seq = Get-NextSeq
    [byte]$destH = ($DestId -shr 8) -band 0xFF
    [byte]$destL = $DestId -band 0xFF
    $forCrc = [System.Collections.Generic.List[byte]]::new()
    $forCrc.Add($destH); $forCrc.Add($destL)
    $forCrc.Add([byte]$MASTER_SRC_H); $forCrc.Add([byte]$MASTER_SRC_L)
    $forCrc.Add($seq)
    foreach ($b in $Payload) { $forCrc.Add([byte]$b) }
    [int]$crc = Get-CRC16 -Data ([byte[]]$forCrc.ToArray())
    $frame = [System.Collections.Generic.List[byte]]::new()
    $frame.Add($VER)
    foreach ($b in $forCrc) { $frame.Add([byte]$b) }
    $frame.Add([byte](($crc -shr 8) -band 0xFF))
    $frame.Add([byte]($crc -band 0xFF))
    $encoded = Invoke-SlipEncode -Data ([byte[]]$frame.ToArray())
    $wire = [System.Collections.Generic.List[byte]]::new()
    $wire.Add([byte]0xC0)
    foreach ($b in $encoded) { $wire.Add([byte]$b) }
    $wire.Add([byte]0xC0)
    return [byte[]]$wire.ToArray()
}

function Build-T6Cmd {
    param([int]$DestId, [byte]$RadioPort, [byte]$Command)
    return Build-WirePacket -DestId $DestId -Payload ([byte[]]@([byte]$T6_PREFIX, [byte]$RadioPort, [byte]$Command))
}

function Parse-AllFrames {
    param([byte[]]$Buffer, [int]$Length)
    $frames = [System.Collections.Generic.List[object]]::new()
    $current = [System.Collections.Generic.List[byte]]::new()
    for ($i = 0; $i -lt $Length; $i++) {
        if ($Buffer[$i] -eq 0xC0) {
            if ($current.Count -gt 0) {
                $decoded = Invoke-SlipDecode -Data ([byte[]]$current.ToArray())
                if ($decoded.Length -ge 8) { $frames.Add($decoded) }
                $current.Clear()
            }
        } else { $current.Add([byte]$Buffer[$i]) }
    }
    return $frames
}

function Decode-FrameHeader {
    param([byte[]]$Frame)
    if ($Frame.Length -lt 8) { return $null }
    [int]$dest = ([int]$Frame[1] -shl 8) -bor [int]$Frame[2]
    [int]$src  = ([int]$Frame[3] -shl 8) -bor [int]$Frame[4]
    [int]$seq  = [int]$Frame[5]
    $payload = New-Object byte[] ($Frame.Length - 8)
    [Array]::Copy($Frame, 6, $payload, 0, $payload.Length)
    return @{ Dest = $dest; Src = $src; Seq = $seq; Payload = $payload }
}

function Decode-Freq {
    param([byte]$B0, [byte]$B1, [byte]$B2)
    [int]$d1 = ([int]$B0 -shr 4) -band 0xF; [int]$d2 = [int]$B0 -band 0xF
    [int]$d3 = ([int]$B1 -shr 4) -band 0xF; [int]$d4 = [int]$B1 -band 0xF
    [int]$d5 = ([int]$B2 -shr 4) -band 0xF; [int]$d6 = [int]$B2 -band 0xF
    return "${d1}${d2}${d3}.${d4}${d5}${d6}"
}

# =============================================================================
# FASE 1: DISCOVERY - cari RSE ID mana yang aktif + radio di dalamnya
# =============================================================================
function Invoke-Discovery {
    param($Stream, [int[]]$RSEList, [int]$PortStart, [int]$PortEnd, [int]$TimeoutMs)

    Write-Host ""
    Write-Host "=== FASE 1: DISCOVERY RADIO (per RSE ID, brute-force port $PortStart-$PortEnd) ===" -ForegroundColor Cyan
    Write-Host "RSE yang akan dicek: $($RSEList -join ', ')" -ForegroundColor DarkGray
    Write-Host "Metode: Settings1 + BITE per port (sama seperti script yang sudah terbukti jalan)" -ForegroundColor DarkGray
    Write-Host ""

    $discoveredRSE = @{}
    $buffer = New-Object byte[] 65536

    foreach ($dest in $RSEList) {
        Write-Host "  RSE ${dest}:" -ForegroundColor Yellow
        $foundAny = $false

        for ($port = $PortStart; $port -le $PortEnd; $port++) {
            # Coba Settings1 dulu (freq) - request ini yang paling ringan & universal
            $pkt1 = Build-T6Cmd -DestId $dest -RadioPort ([byte]$port) -Command $CMD_SETTINGS1
            try { $Stream.Write($pkt1, 0, $pkt1.Length); $Stream.Flush() } catch { continue }

            $frameBuf = [System.Collections.Generic.List[byte]]::new()
            $inFrame = $false
            $replied = $false
            $replyType = "UNKNOWN"
            $deadline = (Get-Date).AddMilliseconds($TimeoutMs)

            while ((Get-Date) -lt $deadline) {
                if ($Stream.DataAvailable) {
                    $n = $Stream.Read($buffer, 0, $buffer.Length)
                    for ($k = 0; $k -lt $n; $k++) {
                        $b = $buffer[$k]
                        if ($b -eq 0xC0) {
                            if ($inFrame -and $frameBuf.Count -gt 0) {
                                $decoded = Invoke-SlipDecode -Data ([byte[]]$frameBuf.ToArray())
                                if ($decoded.Length -ge 8) {
                                    $h = Decode-FrameHeader -Frame $decoded
                                    if ($null -ne $h -and $h.Src -eq $dest) {
                                        $p = $h.Payload
                                        if ($p.Length -ge 3 -and $p[0] -eq $T6_PREFIX -and [int]$p[1] -eq $port) {
                                            $replied = $true
                                        }
                                    }
                                }
                                $frameBuf.Clear()
                            }
                            $inFrame = $true
                        } elseif ($inFrame) { $frameBuf.Add($b) }
                    }
                    if ($replied) { break }
                } else {
                    Start-Sleep -Milliseconds 10
                }
            }

            if ($replied) {
                # Tentukan RX/TX: coba RX BITE, kalau ADA balasan RPL_RX_BITE untuk port ini -> RX
                $pktRx = Build-T6Cmd -DestId $dest -RadioPort ([byte]$port) -Command $CMD_RX_BITE
                try { $Stream.Write($pktRx, 0, $pktRx.Length); $Stream.Flush() } catch {}

                $isRx = $false
                $rxFrameBuf = [System.Collections.Generic.List[byte]]::new()
                $rxInFrame = $false
                $rxDeadline = (Get-Date).AddMilliseconds($TimeoutMs)
                while ((Get-Date) -lt $rxDeadline) {
                    if ($Stream.DataAvailable) {
                        $n2 = $Stream.Read($buffer, 0, $buffer.Length)
                        for ($k2 = 0; $k2 -lt $n2; $k2++) {
                            $b2 = $buffer[$k2]
                            if ($b2 -eq 0xC0) {
                                if ($rxInFrame -and $rxFrameBuf.Count -gt 0) {
                                    $decoded2 = Invoke-SlipDecode -Data ([byte[]]$rxFrameBuf.ToArray())
                                    if ($decoded2.Length -ge 8) {
                                        $h2 = Decode-FrameHeader -Frame $decoded2
                                        if ($null -ne $h2 -and $h2.Src -eq $dest) {
                                            $p2 = $h2.Payload
                                            if ($p2.Length -ge 3 -and $p2[0] -eq $T6_PREFIX -and [int]$p2[1] -eq $port -and [int]$p2[2] -eq [int]$RPL_RX_BITE) {
                                                $isRx = $true
                                            }
                                        }
                                    }
                                    $rxFrameBuf.Clear()
                                }
                                $rxInFrame = $true
                            } elseif ($rxInFrame) { $rxFrameBuf.Add($b2) }
                        }
                        if ($isRx) { break }
                    } else {
                        Start-Sleep -Milliseconds 10
                    }
                }
                $type = if ($isRx) { "RX" } else { "TX" }

                if (-not $discoveredRSE.ContainsKey($dest)) { $discoveredRSE[$dest] = @{ Radios = @{} } }
                $discoveredRSE[$dest].Radios[$port] = @{ Type = $type }
                $foundAny = $true
                Write-Host "    Port $port -> ADA ($type)" -ForegroundColor Green
            }
        }

        if (-not $foundAny) {
            Write-Host "    Tidak ada radio ditemukan di RSE ini (port $PortStart-$PortEnd)" -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    if ($discoveredRSE.Count -eq 0) {
        Write-Host "Tidak ada RSE yang merespon dari daftar `$RSE_LIST." -ForegroundColor Red
        Write-Host "Coba: (1) perbesar -PortEnd, (2) perbesar -DiscoverTimeoutMs, (3) cek IP/port Moxa benar" -ForegroundColor Yellow
    } else {
        Write-Host "=== DISCOVERY SELESAI: $($discoveredRSE.Count) dari $($RSEList.Count) RSE aktif ===" -ForegroundColor Green
    }
    Write-Host ""

    return $discoveredRSE
}

# =============================================================================
# DECODE PARAMETER (formula sudah tervalidasi dari source code production)
# =============================================================================
function Update-RadioState {
    param($RadioState, [byte]$Cmd, [byte[]]$Data)

    if ($Cmd -eq $RPL_SETTINGS1 -and $Data.Length -ge 8) {
        $freq = Decode-Freq -B0 $Data[0] -B1 $Data[1] -B2 $Data[2]
        if ([double]$freq -ge 100.0 -and [double]$freq -le 200.0) {
            $RadioState.Freq = $freq
        }
        $RadioState.Status = "READY"
    }
    elseif ($Cmd -eq $RPL_TX_BITE -and $Data.Length -ge 9) {
        $statusByte = $Data[0]
        $RadioState.Mode = if ($statusByte -eq 0x20) { "On Air" } elseif ($statusByte -eq 0x40) { "Standby" } else { "?" }
        $RadioState.SupplyV = [int]$Data[4]
        [int]$paTempRaw = [int]$Data[5]
        $RadioState.PaTemp = if ($paTempRaw -gt 127) { $paTempRaw - 256 } else { $paTempRaw }
        $RadioState.FwdPower = [int]$Data[6]
        $RadioState.ReflPower = [int]$Data[7]
        $RadioState.ModDepth = [int]$Data[8]
        $RadioState.Status = "READY"
    }
    elseif ($Cmd -eq $RPL_RX_BITE -and $Data.Length -ge 6) {
        $RadioState.SupplyV = [int]$Data[2]
        [int]$sensRaw = [int]$Data[5]
        if ($sensRaw -gt 0) { $RadioState.Sensitivity = -($sensRaw - 43) }
        $RadioState.Status = "READY"
    }
    elseif ($Cmd -eq $RPL_SETTINGS2 -and $Data.Length -ge 9) {
        [int]$sqRaw = [int]$Data[8]
        $RadioState.Squelch = if ($sqRaw -gt 127) { $sqRaw - 256 } else { $sqRaw }
    }
}

function Read-AndProcess {
    param($Stream, $RSERegistry)
    $buffer = New-Object byte[] 65536
    if ($Stream.DataAvailable) {
        $n = $Stream.Read($buffer, 0, $buffer.Length)
        if ($n -gt 0) {
            $frames = Parse-AllFrames -Buffer $buffer -Length $n
            foreach ($f in $frames) {
                $h = Decode-FrameHeader -Frame $f
                if ($null -eq $h) { continue }
                $destId = $h.Src   # reply datang DARI RSE, jadi Src reply = RSE ID
                $payload = $h.Payload
                if ($payload.Length -lt 3 -or $payload[0] -ne $T6_PREFIX) { continue }
                [int]$port = [int]$payload[1]
                [byte]$cmd = $payload[2]
                $data = New-Object byte[] ($payload.Length - 3)
                if ($data.Length -gt 0) { [Array]::Copy($payload, 3, $data, 0, $data.Length) }

                if ($RSERegistry.ContainsKey($destId) -and $RSERegistry[$destId].Radios.ContainsKey($port)) {
                    $RSERegistry[$destId].Radios[$port].LastSeen = Get-Date
                    Update-RadioState -RadioState $RSERegistry[$destId].Radios[$port] -Cmd $cmd -Data $data
                }
            }
        }
    }
}

function Show-Dashboard {
    param($RSERegistry, [int]$PollCount)
    Clear-Host
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "=========================================================================================" -ForegroundColor Cyan
    Write-Host " MARC VHF MONITOR - RSE Manual (v10)                                    $ts" -ForegroundColor Cyan
    Write-Host " Moxa: ${MoxaIP}:${MoxaPort} | RSE ditemukan: $($RSERegistry.Count) | Poll: #$PollCount" -ForegroundColor Cyan
    Write-Host "=========================================================================================" -ForegroundColor Cyan

    foreach ($destId in @($RSERegistry.Keys | Sort-Object)) {
        Write-Host ""
        Write-Host " RSE $destId" -ForegroundColor Yellow
        Write-Host " RADIO         TYPE  FREQ      STATUS/MODE  Vdc PAtmp FwdP RefP  Mod  Squelch  Sens" -ForegroundColor White
        Write-Host ("-" * 90) -ForegroundColor DarkGray

        foreach ($port in @($RSERegistry[$destId].Radios.Keys | Sort-Object)) {
            $r = $RSERegistry[$destId].Radios[$port]
            $color = if ($r.LastSeen) { "Green" } else { "Red" }

            $freq = if ($r.Freq) { $r.Freq } else { "-" }
            $status = if ($r.Type -eq "TX") { $(if ($r.Mode) { $r.Mode } else { "-" }) } else { $(if ($r.Status) { $r.Status } else { "-" }) }
            $vdc = if ($null -ne $r.SupplyV) { "$($r.SupplyV)V" } else { "-" }
            $paT = if ($null -ne $r.PaTemp) { "$($r.PaTemp)C" } else { "-" }
            $fwd = if ($null -ne $r.FwdPower) { "$($r.FwdPower)W" } else { "-" }
            $ref = if ($null -ne $r.ReflPower) { "$($r.ReflPower)W" } else { "-" }
            $mod = if ($null -ne $r.ModDepth) { "$($r.ModDepth)%" } else { "-" }
            $sq  = if ($null -ne $r.Squelch) { "$($r.Squelch)" } else { "-" }
            $sens = if ($null -ne $r.Sensitivity) { "$($r.Sensitivity)dBm" } else { "-" }

            $line = "  Port {0,-4} {1,-5} {2,-9} {3,-12} {4,4} {5,5} {6,4} {7,4} {8,4} {9,7} {10,6}" -f `
                $port, $r.Type, $freq, $status, $vdc, $paT, $fwd, $ref, $mod, $sq, $sens
            Write-Host $line -ForegroundColor $color
        }
    }
    Write-Host ""
    Write-Host ("-" * 90) -ForegroundColor DarkGray
}

# =============================================================================
# MAIN PROGRAM
# =============================================================================
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " MARC VHF Monitor v10 - RSE Manual List" -ForegroundColor Cyan
Write-Host " Moxa: ${MoxaIP}:${MoxaPort}" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.ReceiveBufferSize = 65536
    Write-Host "`nMenghubungkan ke Moxa..." -ForegroundColor Yellow
    $client.Connect($MoxaIP, $MoxaPort)
    $stream = $client.GetStream()
    Write-Host "Terhubung!" -ForegroundColor Green

    Start-Sleep -Milliseconds 300
    if ($stream.DataAvailable) {
        $drain = New-Object byte[] 65536
        [void]$stream.Read($drain, 0, $drain.Length)
    }

    # ===== FASE 1: DISCOVERY (pakai daftar RSE manual + brute-force port) =====
    $RSERegistry = Invoke-Discovery -Stream $stream -RSEList $RSE_LIST -PortStart $PortStart -PortEnd $PortEnd -TimeoutMs $DiscoverTimeoutMs

    $skipMonitoring = $false
    if ($RSERegistry.Count -eq 0) {
        Write-Host "Tidak ada RSE ditemukan. Cek RSE_LIST atau koneksi. Monitoring dilewati." -ForegroundColor Red
        $skipMonitoring = $true
    }

    if (-not $skipMonitoring) {
        # Inisialisasi state tiap radio
        foreach ($destId in @($RSERegistry.Keys)) {
            foreach ($port in @($RSERegistry[$destId].Radios.Keys)) {
                $t = $RSERegistry[$destId].Radios[$port].Type
                $RSERegistry[$destId].Radios[$port] = @{
                    Type = $t; Freq = $null; Mode = $null; Status = $null
                    SupplyV = $null; PaTemp = $null; FwdPower = $null; ReflPower = $null; ModDepth = $null
                    Sensitivity = $null; Squelch = $null; LastSeen = $null
                }
            }
        }

        Write-Host "Tekan ENTER untuk mulai monitoring rutin (interval ${PollInterval}s)..." -ForegroundColor Yellow
        Read-Host | Out-Null

        # ===== FASE 2: MONITORING LOOP =====
        $pollCount = 0
        while ($true) {
            $pollCount++

        foreach ($destId in @($RSERegistry.Keys)) {
            foreach ($port in @($RSERegistry[$destId].Radios.Keys)) {
                $type = $RSERegistry[$destId].Radios[$port].Type

                $pkt1 = Build-T6Cmd -DestId $destId -RadioPort ([byte]$port) -Command $CMD_SETTINGS1
                try { $stream.Write($pkt1, 0, $pkt1.Length) } catch {}
                Start-Sleep -Milliseconds 50

                if ($type -eq "RX") {
                    $pkt2 = Build-T6Cmd -DestId $destId -RadioPort ([byte]$port) -Command $CMD_RX_BITE
                } else {
                    $pkt2 = Build-T6Cmd -DestId $destId -RadioPort ([byte]$port) -Command $CMD_TX_BITE
                }
                try { $stream.Write($pkt2, 0, $pkt2.Length) } catch {}
                Start-Sleep -Milliseconds 50

                Read-AndProcess -Stream $stream -RSERegistry $RSERegistry
            }
        }

        $readUntil = (Get-Date).AddSeconds(2)
        while ((Get-Date) -lt $readUntil) {
            Read-AndProcess -Stream $stream -RSERegistry $RSERegistry
            Start-Sleep -Milliseconds 100
        }

        Show-Dashboard -RSERegistry $RSERegistry -PollCount $pollCount

        $waitUntil = (Get-Date).AddSeconds($PollInterval - 3)
        while ((Get-Date) -lt $waitUntil) {
            Read-AndProcess -Stream $stream -RSERegistry $RSERegistry
            Start-Sleep -Milliseconds 200
        }
        }
    }
} catch {
    Write-Host ""
    Write-Host "ERROR: $_" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
} finally {
    if ($client) { $client.Close() }
    Write-Host "Koneksi ditutup." -ForegroundColor Red
}

# Supaya window tidak langsung tertutup, baik selesai normal maupun kena error
Write-Host ""
Write-Host "=== Script selesai / berhenti. Tekan ENTER untuk keluar. ===" -ForegroundColor Yellow
Read-Host | Out-Null
