#!/bin/bash

# GERD Diet Meal Planner - One-Click Launcher for Linux/macOS
# This script automates the setup of the virtual environment and starts the server.

echo "======================================================"
echo "         GERD Diet Meal Planner Launcher"
echo "======================================================"
echo ""

# 1. Check for Python
echo "[1/3] Checking for Python..."
if ! command -v python3 &> /dev/null
then
    echo ""
    echo "ERROR: Python 3 is not installed."
    echo "Please install Python 3.9 or newer using your package manager."
    echo ""
    exit 1
fi

# 2. Setup Virtual Environment
if [ ! -d ".venv" ]; then
    echo "[2/3] First time setup: Creating virtual environment..."
    python3 -m venv .venv
    if [ $? -ne 0 ]; then
        echo ""
        echo "ERROR: Failed to create virtual environment."
        exit 1
    fi
    
    echo ""
    echo "Installing dependencies (this may take a minute)..."
    .venv/bin/python -m pip install --upgrade pip
    .venv/bin/pip install -r requirements.txt
    if [ $? -ne 0 ]; then
        echo ""
        echo "ERROR: Failed to install dependencies."
        exit 1
    fi
else
    echo "[2/3] Virtual environment found."
fi

# 3. Run Application
echo "[3/3] Starting the application..."
echo ""
echo "The app will open in your browser shortly."
echo "To stop the server, press Ctrl+C."
echo ""

# Open browser (handles macOS and Linux)
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://127.0.0.1:8000"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "http://127.0.0.1:8000" 2>/dev/null
fi

# Run the server
.venv/bin/python -m uvicorn app.main:app
