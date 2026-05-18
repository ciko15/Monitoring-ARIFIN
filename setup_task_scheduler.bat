@echo off
echo Setting up Windows Task Scheduler for PM2 auto-start...

:: Create the scheduled task
schtasks /create /tn "MonitoringARIFIN_PM2" /tr "cmd.exe /c cd /d \"C:\Users\CNSA SENTANI\Downloads\Monitoring-ARIFIN-main\" && npx pm2 resurrect" /sc onlogon /rl highest /f

if %errorlevel%==0 (
    echo [SUCCESS] Task Scheduler created successfully!
    echo Task will run on user login to restore PM2 processes.
) else (
    echo [ERROR] Failed to create Task Scheduler task.
    echo You may need to run this as Administrator.
)

pause