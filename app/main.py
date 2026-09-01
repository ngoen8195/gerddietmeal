"""GERD Diet Meal Planner — FastAPI Application Entry Point.""" # Force reload for new parser
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse

import asyncio
from app.core.database import init_db
from app.api import foods, meals, favorites, meal_plan, fdc, scraper
from app.api.fdc import check_and_trigger_fdc_auto_sync

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup and trigger non-blocking FDC auto-sync."""
    await init_db()
    asyncio.create_task(check_and_trigger_fdc_auto_sync())
    yield



app = FastAPI(
    title="GERD Diet Meal Planner",
    description="Sophisticated meal planning for acid reflux management",
    version="1.0.0",
    lifespan=lifespan,
)

# Mount static files
app.mount("/static", StaticFiles(directory=os.path.join(PROJECT_ROOT, "static")), name="static")
app.mount("/resources", StaticFiles(directory=os.path.join(PROJECT_ROOT, "resources")), name="resources")

# Templates
templates = Jinja2Templates(directory=os.path.join(PROJECT_ROOT, "templates"))

# Register API routers
app.include_router(foods.router)
app.include_router(meals.router)
app.include_router(favorites.router)
app.include_router(meal_plan.router)
app.include_router(fdc.router)
app.include_router(scraper.router)


@app.get("/", response_class=HTMLResponse)
async def root(request: Request):
    return templates.TemplateResponse(request, "index.html")
