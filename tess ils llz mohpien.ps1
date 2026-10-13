function Get-Crc16AugCcitt {
    param ([byte[]]$Data)
    [uint16]$crc = 0x1D0F
    for ($i = 0; $i -lt $Data.Length; $i++) {
        $crc = $crc -bxor ([uint16]$Data[$i] -shl 8)
        for ($j = 0; $j -lt 8; $j++) {
            if (($crc -band 0x8000) -ne 0) {
                $crc = (($crc -shl 1) -bxor 0x1021) -band 0xFFFF
            }
            else {
                $crc = ($crc -shl 1) -band 0xFFFF
            }
        }
    }
    return $crc
}

function Unmask-Payload {
    param ([byte[]]$RawBody)
    if ($RawBody.Length -lt 2) { return @() }
    $data = $RawBody[1..($RawBody.Length - 1)]
    if ($data.Length -eq 0) { return @() }

    $mVal = 0
    if ($data.Length -gt 1 -and $data[1] -ne 0) {
        $mVal = $data[1] + 1
    }

    [byte[]]$plain = New-Object byte[] $data.Length
    for ($i = 0; $i -lt $data.Length; $i++) {
        $sub = [Math]::Max(($mVal - $i), 0)
        $plain[$i] = ($data[$i] - $sub + 256) % 256
    }
    return $plain
}

$Global:RegMap = @{
    10   = @{ Name = "DDM Course Line (CL)"; Scale = 100.0; Unit = "%"; Signed = $true }
    11   = @{ Name = "SDM Course Line (CL)"; Scale = 100.0; Unit = "%"; Signed = $false }
    12   = @{ Name = "RF Level CL"; Scale = 100.0; Unit = "dB"; Signed = $true }
    13   = @{ Name = "Monitor Parameter 13"; Scale = 0; Unit = "raw"; Signed = $false }
    14   = @{ Name = "Ident-AM Depth CL"; Scale = 100.0; Unit = "%"; Signed = $false }
    20   = @{ Name = "DDM Clearance (CLR)"; Scale = 100.0; Unit = "%"; Signed = $true }
    21   = @{ Name = "SDM Clearance (CLR)"; Scale = 100.0; Unit = "%"; Signed = $false }
    22   = @{ Name = "RF Level CLR"; Scale = 100.0; Unit = "dB"; Signed = $true }
    24   = @{ Name = "Ident-AM Depth CLR"; Scale = 100.0; Unit = "%"; Signed = $false }
    25   = @{ Name = "DDM Displacement (DS)"; Scale = 100.0; Unit = "%"; Signed = $true }
    26   = @{ Name = "SDM Displacement (DS)"; Scale = 100.0; Unit = "%"; Signed = $false }
    27   = @{ Name = "RF Level DS"; Scale = 100.0; Unit = "dB"; Signed = $true }
    28   = @{ Name = "Ident-AM Depth DS"; Scale = 100.0; Unit = "%"; Signed = $false }
    30   = @{ Name = "Freq Displacement CL"; Scale = 10000.0; Unit = "%"; Signed = $true }
    31   = @{ Name = "Freq Displacement CLR"; Scale = 10000.0; Unit = "%"; Signed = $true }
    32   = @{ Name = "Freq Displacement Sep"; Scale = 10000.0; Unit = "%"; Signed = $true }
    3325 = @{ Name = "Heartbeat / Sync"; Scale = 0; Unit = "hex"; Signed = $false }
    5125 = @{ Name = "Station IDENT"; Scale = 0; Unit = "str"; Signed = $false }
}

function Decode-PmdtFrame {
    param ([byte[]]$Plain)
    if ($Plain.Length -lt 6) { return $null }

    $msgType = $Plain[2]
    $seqNum = $Plain[3]

    if ($msgType -eq 0x86 -and $Plain.Length -ge 10) {
        [uint16]$regId = [BitConverter]::ToUInt16($Plain, 4)
        [uint16]$v1 = [BitConverter]::ToUInt16($Plain, 6)
        $channel = if (($v1 -band 0x000F) -in @(0x00, 0x02, 0x0C)) { "MON1" } else { "MON2" }

        if ($regId -eq 5125) {
            $asciiText = [System.Text.Encoding]::ASCII.GetString($Plain[6..9])
            return [PSCustomObject]@{
                Seq     = $seqNum
                RegHex  = ("0x{0:X4}" -f $regId)
                Channel = "-"
                Param   = "Station IDENT"
                Value   = $asciiText
                RawV1   = ("0x{0:X4}" -f $v1)
                RawV2   = "-"
            }
        }

        $meta = if ($Global:RegMap.ContainsKey([int]$regId)) { 
            $Global:RegMap[[int]$regId] 
        }
        else { 
            @{ Name = "Reg_$regId"; Scale = 1.0; Unit = ""; Signed = $false } 
        }

        $rawVal = if ($meta.Signed) { 
            [BitConverter]::ToInt16($Plain, 8) 
        }
        else { 
            [BitConverter]::ToUInt16($Plain, 8) 
        }

        $formattedVal = if ($meta.Scale -gt 0) {
            $calc = [double]$rawVal / $meta.Scale
            if ($meta.Scale -ge 1000) {
                ("{0:N4} {1}" -f $calc, $meta.Unit).Trim()
            }
            else {
                ("{0:N2} {1}" -f $calc, $meta.Unit).Trim()
            }
        }
        elseif ($meta.Unit -eq "hex") {
            ("0x{0:X4}" -f $rawVal)
        }
        else {
            "$rawVal"
        }

        return [PSCustomObject]@{
            Seq     = $seqNum
            RegHex  = ("0x{0:X4}" -f $regId)
            Channel = $channel
            Param   = $meta.Name
            Value   = $formattedVal
            RawV1   = ("0x{0:X4}" -f $v1)
            RawV2   = "$rawVal"
        }
    }
    return $null
}

# Injeksi seluruh register telemetri
$testHexFrames = @(
    "AA30008690051449534259",        # Station IDENT: ISBY (Reg 5125)
    "053a098e971005a00c0100",        # CL DDM MON1: +0.01 % (Reg 10)
    "053a098e971005a30c0000",        # CL DDM MON2: +0.00 % (Reg 10)
    "053a098e971105a00ca10f",        # CL SDM MON1: +40.01 % (Reg 11)
    "053a098e971105a30ca00f",        # CL SDM MON2: +40.00 % (Reg 11)
    "053a098e971205a00c0f00",        # CL RF Level MON1: +0.15 dB (Reg 12)
    "053a098e971205a30c0c00",        # CL RF Level MON2: +0.12 dB (Reg 12)
    "053a098e971405a00c2003",        # CL Ident AM MON1: +8.00 % (Reg 14)
    "053a098e971405a30c1f03",        # CL Ident AM MON2: +7.99 % (Reg 14)
    "F03a098e971f05a00c1707",        # DS DDM MON1: +15.57 % (Reg 25)
    "F03a098e971f05a30c1707",        # DS DDM MON2: +15.57 % (Reg 25)
    "F03a098e971a05a00ca20f",        # DS SDM MON1: +40.02 % (Reg 26)
    "F03a098e971a05a30ca30f",        # DS SDM MON2: +40.03 % (Reg 26)
    "3a098e971405a00c8008",          # CLR DDM MON1: +21.76 % (Reg 20)
    "3a098e971405a30c7a08",          # CLR DDM MON2: +21.70 % (Reg 20)
    "3a098e971505a00ca60f",          # CLR SDM MON1: +40.06 % (Reg 21)
    "3a098e971505a30ca10f",          # CLR SDM MON2: +40.01 % (Reg 21)
    "053a098e971e05a00c0000",        # Course Freq Disp MON1: +0.0000 % (Reg 30)
    "053a098e971f05a30c0100",        # Freq Disp CLR MON2: +0.0001 % (Reg 31)
    "333a098e9713050d032202",        # Param 13 MON2: 288 (Reg 13)
    "003a098e97fd0c494d3e57"         # Heartbeat Sync: 0x573E (Reg 3325)
)

$results = @()
foreach ($hex in $testHexFrames) {
    # 1. Parse hex ke bytes
    $rawBytes = [byte[]]($hex -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) })
    
    # 2. Bungkus frame 01 02 ... 01 03
    $frameNoCrc = @(0x01, 0x02) + $rawBytes + @(0x01, 0x03)
    
    # 3. Hitung CRC-16/AUG-CCITT
    $crc = Get-Crc16AugCcitt -Data $frameNoCrc
    $fullPacket = $frameNoCrc + [BitConverter]::GetBytes($crc)
    
    # 4. Validasi framing & CRC
    $crcRecv = [BitConverter]::ToUInt16($fullPacket, ($fullPacket.Length - 2))
    $framePart = $fullPacket[0..($fullPacket.Length - 3)]
    
    if ((Get-Crc16AugCcitt -Data $framePart) -eq $crcRecv) {
        # Unmasking & decode
        $bodyOnly = $rawBytes
        $plain = Unmask-Payload -RawBody $bodyOnly
        $item = Decode-PmdtFrame -Plain $plain
        if ($item) { $results += $item }
    }
}

Clear-Host
Write-Host "==========================================================================================" -ForegroundColor Cyan
Write-Host " HASIL LENGKAP DECODING PARAMETER LOCALIZER PMDT JUANDA (MON1 & MON2)" -ForegroundColor Cyan
Write-Host "==========================================================================================" -ForegroundColor Cyan

$results | Format-Table Seq, RegHex, Channel, Param, Value, RawV1, RawV2 -AutoSize