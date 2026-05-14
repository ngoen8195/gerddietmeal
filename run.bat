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
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Python is not installed or not in your PATH.
    echo Please install Python 3.9 or newer from https://www.python.org/
    echo Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b
)

:: 2. Setup Virtual Environment
if not exist ".venv" (
    echo [2/3] First time setup: Creating virtual environment...
    python -m venv .venv
    if !errorlevel! neq 0 (
        echo.
        echo ERROR: Failed to create virtual environment.
        pause
        exit /b
    )
    
    echo.
    echo Installing dependencies (this may take a minute)...
    .venv\Scripts\python -m pip install --upgrade pip
    .venv\Scripts\pip install -r requirements.txt
    if !errorlevel! neq 0 (
        echo.
        echo ERROR: Failed to install dependencies.
        pause
        exit /b
    )
) else (
    echo [2/3] Virtual environment found.
)

:: 3. Run Application
echo [3/3] Starting the application...
echo.
echo The app will open in your browser shortly.
echo To stop the server, close this window or press Ctrl+C.
echo.

:: Start browser after a short delay
start "" "http://127.0.0.1:8000"

:: Run the server
.venv\Scripts\python -m uvicorn app.main:app
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Application crashed or failed to start.
    pause
)

pause
