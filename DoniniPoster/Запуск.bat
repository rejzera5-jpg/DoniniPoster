@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0setup\install.ps1" (
  echo.
  echo  Программа запущена прямо из архива ZIP.
  echo  Сначала распакуйте архив: правый клик по DoniniPoster.zip - "Извлечь все..." - в папку C:\
  echo  Потом запустите Запуск.bat из распакованной папки C:\DoniniPoster
  echo.
  pause
  exit /b 1
)
if not exist "python\.installed" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install.ps1"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "" "%~dp0python\pythonw.exe" "%~dp0run.pyw"
