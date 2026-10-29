@echo off
setlocal
title Setup Manga Translator Environment

echo ================================================================
echo    Setting up Python Virtual Environment for CUDA 12
echo ================================================================

cd /d "%~dp0"

if not exist ".venv" goto CREATE_VENV
echo [1/3] Existing virtual environment found.
goto ACTIVATE_VENV

:CREATE_VENV
echo [1/3] Creating virtual environment .venv ...
python -m venv .venv

:ACTIVATE_VENV
call .venv\Scripts\activate.bat

echo [2/3] Upgrading pip, setuptools, and wheel...
python -m pip install --upgrade pip setuptools wheel

echo [3/3] Installing PyTorch with CUDA 12.1 wheel...
python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

echo Installing backend dependencies...
python -m pip install -r requirements.txt

echo.
echo ================================================================
echo    Setup Complete! You can now start the server with:
echo    run_server.bat
echo ================================================================
pause
