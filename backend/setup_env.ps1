# Setup script for PowerShell
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   Setting up Python Virtual Environment for CUDA 12" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
    Write-Host "[1/3] Creating virtual environment .venv ..." -ForegroundColor Green
    python -m venv .venv
} else {
    Write-Host "[1/3] Existing virtual environment found." -ForegroundColor Yellow
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

Write-Host "[2/3] Upgrading pip, setuptools, and wheel..." -ForegroundColor Green
& $venvPython -m pip install --upgrade pip setuptools wheel

Write-Host "[3/3] Installing PyTorch with CUDA 12.1 wheel..." -ForegroundColor Green
& $venvPython -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

Write-Host "Installing backend dependencies from requirements.txt..." -ForegroundColor Green
& $venvPython -m pip install -r requirements.txt

Write-Host "`nSetup complete! You can now start the server with: .\run_server.ps1" -ForegroundColor Green

