@echo off
rem Double-click to start BidRL Deal Tracker and open it in your browser.
rem If it's already running, this just opens the page.
cd /d "%~dp0"
set URL=http://127.0.0.1:3000

curl -s -o nul %URL%/api/status && goto open

start "BidRL Deal Tracker (close this window to stop it)" /min cmd /k npm start

for /l %%i in (1,1,30) do (
  curl -s -o nul %URL%/api/status && goto open
  timeout /t 1 /nobreak >nul
)
echo The tracker didn't start. Open the minimized "BidRL Deal Tracker" window to see why.
pause
exit /b 1

:open
start "" %URL%
