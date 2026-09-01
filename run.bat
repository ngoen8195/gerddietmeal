@echo off
setlocal enabledelayedexpansion

:: GERD Diet Meal Planner - One-Click Launcher for Windows
:: This script automates the setup of the virtual environment and starts the server.

title GERD Diet Meal Planner Launcher

echo ======================================================
echo          GERD Diet Meal Planner Launcher
echo ======================================================
echo.

:: 1. Check for Python
echo [1/3] Checking for Python...

py --version >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON_EXE=py"
    goto :found_python
)

python --version >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON_EXE=python"
    goto :found_python
)

echo.
echo ERROR: Python was not found (checked 'py' and 'python').
echo Please install Python 3.9+ and ensure it's in your PATH.
pause
exit /b

:found_python
echo Found Python: %PYTHON_EXE%

:: 2. Setup Virtual Environment
if exist ".venv\Scripts\python.exe" goto :venv_exists

echo [2/3] First time setup: Creating virtual environment...
%PYTHON_EXE% -m venv .venv
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to create virtual environment.
    pause
    exit /b
)

echo.
echo Installing dependencies (this may take a minute)...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\pip.exe" install -r requirements.txt
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Failed to install dependencies.
    pause
    exit /b
)

:venv_exists
echo [2/3] Virtual environment ready.

:: 3. Run Application
echo [3/3] Starting the application...
echo.

echo The app will open in your browser shortly.
echo To stop the server, close this window or press Ctrl+C.
echo.

:: Start browser
echo Opening browser at http://127.0.0.1:8000...
start "" "http://127.0.0.1:8000"

:: Run the server
echo Starting Uvicorn server...
".venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Application stopped unexpectedly (Exit Code: %errorlevel%).
    pause
) else (
    echo.
    echo Server shut down normally.
    pause
)
