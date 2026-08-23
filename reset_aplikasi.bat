@echo off
:: Cek apakah dijalankan sebagai Administrator
net session >nul 2>&1
if %errorLevel% == 0 (
    echo Administrator Privileges Confirmed.
) else (
    echo Meminta akses Administrator...
    powershell -Command "Start-Process '%~dpnx0' -Verb RunAs"
    exit /b
)

echo ====================================================
echo      RESET APLIKASI MONITORING CABANG (BUN/PM2)
echo ====================================================
echo.
echo 1. Mematikan proses Bun yang nyangkut...
taskkill /F /IM bun.exe >nul 2>&1
if %errorLevel% == 0 (echo [OK] bun.exe berhasil dimatikan.) else (echo [INFO] bun.exe tidak ditemukan atau sudah mati.)

echo.
echo 2. Mematikan proses Node/PM2 yang nyangkut...
taskkill /F /IM node.exe >nul 2>&1
if %errorLevel% == 0 (echo [OK] node.exe berhasil dimatikan.) else (echo [INFO] node.exe tidak ditemukan atau sudah mati.)

echo.
echo 3. Menyalakan ulang aplikasi via PM2...
cd /d C:\Monitoring-ARIFIN-main
call npm run pm2:start:windows >nul 2>&1
:: Alternatif jika npm run pm2:start:windows gagal:
:: call pm2 start all >nul 2>&1

echo.
echo ====================================================
echo PROSES SELESAI! Silakan refresh halaman web Anda.
echo ====================================================
pause
