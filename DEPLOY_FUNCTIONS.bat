@echo off
REM ─── Deploy Cloud Function deleteGuest a PROD ─────────────────────────────
REM Ejecutar desde C:\CHECKINSMART\_platform\
REM
REM Nota 2026-05-06: el proyecto LEGACY (area-malaga-beach) fue eliminado en
REM GCP. La sección legacy queda comentada. Restaurar si se reactiva el
REM proyecto. Si quieres desplegar OTRA función distinta, cambia
REM "deleteGuest" por el nombre de la función.

title Deploy Cloud Function — CheckinSmart (PROD)
cd /d "%~dp0"

set "NODE=C:\CHECKINSMART\tools\node\node.exe"
set "FB=C:\CHECKINSMART\tools\node_modules\firebase-tools\lib\bin\firebase.js"
set "FUNCTIONS_DISCOVERY_TIMEOUT=60"

if not exist "%NODE%" (
  echo [ERROR] No se encuentra Node portable en %NODE%
  pause & exit /b 1
)
if not exist "%FB%" (
  echo [ERROR] No se encuentra firebase-tools en %FB%
  pause & exit /b 1
)

echo.
echo ════════════════════════════════════════════════
echo  Deploy deleteGuest ^> PROD (checkingsmart-564a0)
echo ════════════════════════════════════════════════
set "GOOGLE_APPLICATION_CREDENTIALS=%~dp0service-account-prod.json"
"%NODE%" "%FB%" deploy --only functions:deleteGuest --project prod --non-interactive --force
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Deploy PROD fallido
    pause
    exit /b 1
)

REM ── LEGACY (area-malaga-beach) — proyecto eliminado en GCP, sección desactivada
REM echo.
REM echo ════════════════════════════════════════════════
REM echo  Deploy deleteGuest ^> LEGACY (area-malaga-beach)
REM echo ════════════════════════════════════════════════
REM set "GOOGLE_APPLICATION_CREDENTIALS=%~dp0service-account-legacy.json"
REM "%NODE%" "%FB%" deploy --only functions:deleteGuest --project legacy --non-interactive --force

echo.
echo ============================================
echo  OK — Funcion deleteGuest desplegada en PROD
echo ============================================
pause
