@echo off
echo ====================================================
echo   Monitoring ARIFIN - Windows Setup Auto-Installer
echo ====================================================
echo.

:: 1. Check for Bun
where bun >nul 2>nul
if %errorlevel% neq 0 (
    echo [SYSTEM] Bun tidak ditemukan. Menginstall Bun...
    powershell -c "irm bun.sh/install.ps1 | iex"
    echo [SYSTEM] Bun berhasil diinstall. Silakan buka terminal baru jika script ini gagal di tahap berikutnya.
) else (
    echo [OK] Bun sudah terpasang.
)

:: 2. Check for Node/NPM (required for PM2)
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] NPM/Node.js tidak ditemukan! Silakan install Node.js terlebih dahulu dari https://nodejs.org/
    pause
    exit /b
)

:: 3. Install PM2 and Windows Startup Service
echo [SYSTEM] Mengecek PM2...
where pm2 >nul 2>nul
if %errorlevel% neq 0 (
    echo [SYSTEM] Menginstall PM2 secara global...
    call npm install -g pm2 pm2-windows-startup
    call pm2-startup install
) else (
    echo [OK] PM2 sudah terpasang.
)

:: 4. Install Project Dependencies
echo [SYSTEM] Menginstall dependencies project...
call bun install

:: 5. Start Application with Windows Config
echo [SYSTEM] Menjalankan aplikasi via PM2...
call pm2 start ecosystem.windows.config.js
call pm2 save

echo.
echo ====================================================
echo   SETUP SELESAI! 
echo   Aplikasi sekarang berjalan di background.
echo   - Cek status: pm2 status
echo   - Cek log: pm2 logs monitoring-arifin
echo ====================================================
pause
