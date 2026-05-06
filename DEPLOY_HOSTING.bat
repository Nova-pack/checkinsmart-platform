@echo off
title Deploy Hosting — CheckinSmart (PROD)
cd /d "%~dp0"
echo.
echo ============================================
echo  DEPLOY HOSTING — CheckinSmart (PROD)
echo  Sube web/app/login a checkingsmart-564a0
echo  (NO toca functions ni reglas Firestore)
echo ============================================
echo.

REM Usa Node y firebase-tools portables locales (no requiere internet para descargar)
set "NODE=C:\CHECKINSMART\tools\node\node.exe"
set "FB=C:\CHECKINSMART\tools\node_modules\firebase-tools\lib\bin\firebase.js"
set "GOOGLE_APPLICATION_CREDENTIALS=%~dp0service-account-prod.json"

if not exist "%NODE%" (
  echo [ERROR] No se encuentra Node portable en %NODE%
  pause & exit /b 1
)
if not exist "%FB%" (
  echo [ERROR] No se encuentra firebase-tools en %FB%
  pause & exit /b 1
)
if not exist "%GOOGLE_APPLICATION_CREDENTIALS%" (
  echo [ERROR] Falta service-account-prod.json
  pause & exit /b 1
)

echo Desplegando solo a PROD (legacy/AMB excluido — proyecto eliminado en GCP)...
echo.

"%NODE%" "%FB%" deploy --only hosting:prod --project prod --non-interactive

echo.
if %ERRORLEVEL% EQU 0 (
  echo ============================================
  echo  OK — Deploy completado en PROD
  echo  https://checkingsmart.com  ya esta actualizado
  echo ============================================
) else (
  echo ============================================
  echo  ERROR — Deploy fallido. Revisa el log arriba.
  echo ============================================
)
echo.
pause
