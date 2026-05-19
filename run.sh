#!/bin/bash

# GERD Diet Meal Planner - One-Click Launcher for Linux/macOS
# This script automates the setup of the virtual environment and starts the server.

echo "======================================================"
echo "         GERD Diet Meal Planner Launcher"
echo "======================================================"
echo ""

# 1. Check for Python
echo "[1/3] Checking for Python..."
PYTHON_EXE=""

if command -v python3 &> /dev/null; then
    PYTHON_EXE="python3"
elif command -v python &> /dev/null; then
    PYTHON_EXE="python"
else
    echo ""
    echo "ERROR: Python was not found."
    echo "Please install Python 3.9 or newer."
    exit 1
fi
echo "Found Python: $PYTHON_EXE"

# 2. Setup Virtual Environment
if [ ! -d ".venv" ]; then
    echo "[2/3] First time setup: Creating virtual environment..."
    $PYTHON_EXE -m venv .venv
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to create virtual environment."
        exit 1
    fi
    
    echo "Installing dependencies (this may take a minute)..."
    .venv/bin/python -m pip install --upgrade pip
    .venv/bin/pip install -r requirements.txt
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to install dependencies."
        exit 1
    fi
else
    echo "[2/3] Virtual environment ready."
fi

# 3. Run Application
echo "[3/3] Starting the application..."
echo ""
echo "The app will open in your browser shortly."
echo "To stop the server, press Ctrl+C."
echo ""

# Open browser after a 2-second delay in the background
echo "Opening browser at http://127.0.0.1:8000..."
(
    sleep 2
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open "http://127.0.0.1:8000"
    elif command -v xdg-open &> /dev/null; then
        xdg-open "http://127.0.0.1:8000" &> /dev/null
    else
        # Fallback to python webbrowser module
        .venv/bin/python -m webbrowser "http://127.0.0.1:8000" &> /dev/null
    fi
) &

# Run the server
echo "Starting Uvicorn server..."
.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
