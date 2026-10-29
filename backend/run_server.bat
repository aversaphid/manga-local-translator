@echo off
setlocal
title Manga Local Translator - CUDA Backend Server

echo ================================================================
echo    Manga Local Translator - High Performance CUDA Server
echo    Target: Windows 11 ^| NVIDIA RTX 40-Series
echo ================================================================

cd /d "%~dp0"

if exist ".venv\Scripts\activate.bat" goto ACTIVATE_DOT_VENV
if exist "venv\Scripts\activate.bat" goto ACTIVATE_VENV

echo [WARNING] No virtual environment detected in backend directory.
echo [WARNING] Running using global Python environment.
echo [TIP] Run setup_env.bat first to create the CUDA virtual environment.
echo.
goto START_SERVER

:ACTIVATE_DOT_VENV
echo [INFO] Activating virtual environment .venv ...
call .venv\Scripts\activate.bat
goto START_SERVER

:ACTIVATE_VENV
echo [INFO] Activating virtual environment venv ...
call venv\Scripts\activate.bat
goto START_SERVER

:START_SERVER
set CUDA_VISIBLE_DEVICES=0
set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1

echo [INFO] Launching FastAPI Uvicorn Server on http://localhost:8000 ...
echo [INFO] Health check available at http://localhost:8000/health
echo.

python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Server terminated with error code %ERRORLEVEL%.
    pause
)
