@echo off
rem Double-click to download the latest version and restart the tracker.
cd /d "%~dp0"
if not exist ".git" (
  echo This folder wasn't set up with git clone, so it can't update itself.
  echo See "Automatic updates" in README.md.
  pause
  exit /b 1
)

echo Getting the latest version...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo Update failed. See the message above.
  pause
  exit /b 1
)

echo Restarting the tracker...
taskkill /FI "WINDOWTITLE eq BidRL Deal Tracker*" /T /F >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
timeout /t 2 /nobreak >nul
call "%~dp0start.bat"
