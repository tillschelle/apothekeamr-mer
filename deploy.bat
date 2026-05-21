@echo off
cd /d "%~dp0"
echo.
echo Lade Änderungen hoch...
git add .
git commit -m "Update %date% %time%"
git push origin main
echo.
echo Fertig! Cloudflare deployt automatisch in ~30 Sekunden.
pause
