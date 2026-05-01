@echo off
title AirNav Monitoring - Sentani Airport (WAJJ)
color 0A

echo.
echo  ============================================
echo   AirNav Indonesia - Sentani Airport (WAJJ)
echo   Navaid Monitoring System
echo  ============================================
echo.
echo  Starting server...
echo  Buka browser ke: http://localhost:3100
echo.

:: Pindah ke folder aplikasi (sesuaikan path jika perlu)
cd /d "%~dp0"

:: Buka browser otomatis setelah 3 detik
start /min "" timeout /t 3 /nobreak >nul & start http://localhost:3100

:: Jalankan server
bun src/server.ts

echo.
echo  Server berhenti. Tekan tombol apapun untuk keluar...
pause >nul
