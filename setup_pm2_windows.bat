@echo off
title Setup PM2 Startup - Monitoring ARIFIN
color 0A

echo.
echo  ============================================
echo   Setup PM2 Startup - Monitoring ARIFIN
echo   Windows Auto-Start Configuration
echo  ============================================
echo.

:: Check if PM2 is installed
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] PM2 tidak ditemukan. Install dulu dengan: npm install -g pm2
    echo.
    pause
    exit /b 1
)

echo [INFO] PM2 ditemukan. Melanjutkan setup...
echo.

:: Stop any existing processes
echo [STEP 1] Menghentikan proses yang ada...
npx pm2 stop all 2>nul
npx pm2 delete all 2>nul

:: Start the application
echo [STEP 2] Menjalankan aplikasi...
npx pm2 start ecosystem.windows.config.js --env production

:: Save the current process list
echo [STEP 3] Menyimpan konfigurasi PM2...
npx pm2 save

:: Setup Windows startup (using Task Scheduler)
echo [STEP 4] Setup Windows Task Scheduler untuk auto-start...
schtasks /create /tn "MonitoringARIFIN_PM2" /tr "cmd /c cd /d \"%~dp0\" && npx pm2 resurrect" /sc onlogon /rl highest /f

echo.
echo  ============================================
echo   Setup Selesai!
echo  ============================================
echo.
echo  Aplikasi akan otomatis start saat:
echo  - Windows boot/login
echo  - Jika aplikasi crash (PM2 auto-restart)
echo.
echo  Perintah yang berguna:
echo  - npm run pm2:logs:windows    : Lihat log aplikasi
echo  - npm run pm2:monit:windows   : Monitor CPU/Memory
echo  - npm run pm2:stop:windows    : Stop aplikasi
echo.
echo  Tekan tombol apapun untuk keluar...
pause >nul