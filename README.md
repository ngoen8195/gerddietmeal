# GERD Diet Meal Planner

A sophisticated web application designed for acid reflux management. This tool helps users plan GERD-safe meals weekly, manage a food library with reflux-safe status, and search for recipes from multiple sources.

## Features

- **Weekly Meal Planner:** Generate and manage a weekly schedule of GERD-safe meals.
- **Food Library:** Track foods categorized by their reflux safety (Safe, Avoid, Remedy).
- **Meal Library & Scraper:** Import recipes directly from URLs (AllRecipes, Cookpad, etc.) and calculate calories.
- **Data Persistence:** Uses a local SQLite database for fast, offline-capable storage.

## One-Click Run (Recommended)

If you have Python installed, you can run the app with a single click:

- **Windows:** Double-click `run.bat`
- **Linux/macOS:** Run `bash run.sh`

These scripts will automatically:
1. Check for Python.
2. Create a virtual environment (`.venv`).
3. Install all necessary dependencies.
4. Launch the server and open the app in your browser.

## Manual Installation

If you prefer to set it up manually:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/GERDdietmeal.git
   cd GERDdietmeal
   ```

~~2. **Create and activate a virtual environment:**~~
   ```bash
   python -m venv .venv
   # Windows
   .venv\Scripts\activate
   # Linux/macOS
   source .venv/bin/activate
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the application:**
   ```bash
   python -m uvicorn app.main:app --reload
   ```
   The app will be available at `http://127.0.0.1:8000`.

---
*Note: The application stores data in `data.db` in the root directory. This file is excluded from version control to protect your personal meal plans.*
