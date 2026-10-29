Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   Manga Local Translator - High Performance CUDA Server" -ForegroundColor Cyan
Write-Host "   Target: Windows 11 | NVIDIA RTX 40-Series" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

Set-Location $PSScriptRoot

$pythonExec = "python"
if (Test-Path ".venv\Scripts\python.exe") {
    Write-Host "[INFO] Using virtual environment (.venv)..." -ForegroundColor Green
    $pythonExec = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
} elseif (Test-Path "venv\Scripts\python.exe") {
    Write-Host "[INFO] Using virtual environment (venv)..." -ForegroundColor Green
    $pythonExec = Join-Path $PSScriptRoot "venv\Scripts\python.exe"
} else {
    Write-Host "[WARNING] No virtual environment detected in backend directory." -ForegroundColor Yellow
    Write-Host "[WARNING] Using global Python environment." -ForegroundColor Yellow
}

$env:CUDA_VISIBLE_DEVICES = "0"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"

Write-Host "[INFO] Launching FastAPI Uvicorn Server on http://localhost:8000 ..." -ForegroundColor Cyan
Write-Host "[INFO] Health check available at http://localhost:8000/health" -ForegroundColor Cyan
Write-Host ""

& $pythonExec -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
