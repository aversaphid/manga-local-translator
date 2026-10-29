@echo off
setlocal enabledelayedexpansion
title Manga Local Translator - CUDA Backend Server

echo ================================================================
echo    Manga Local Translator - High Performance CUDA Server
echo    Target: Windows 11 ^| NVIDIA RTX 40-Series (12GB VRAM)
echo ================================================================

cd /d "%~dp0"

:: Check if virtual environment exists
if exist ".venv\Scripts\activate.bat" (
    echo [INFO] Activating virtual environment (.venv)...
    call .venv\Scripts\activate.bat
) else if exist "venv\Scripts\activate.bat" (
    echo [INFO] Activating virtual environment (venv)...
    call venv\Scripts\activate.bat
) else (
    echo [WARNING] No virtual environment detected in backend/.
    echo [WARNING] Running using global Python environment.
    echo [TIP] To create a dedicated venv, run:
    echo        python -m venv .venv
    echo        .venv\Scripts\activate
    echo        pip install -r requirements.txt
    echo.
)

:: Set CUDA environment variables
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

