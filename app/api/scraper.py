"""Scraper orchestration logic with atomic termination and multi-process safety."""
import asyncio
import time
from pathlib import Path
from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.core.database import get_session, async_session_factory
from app.models.models import Food, Meal, MealIngredient
from app.scrapers.allrecipes import AllRecipesScraper
from app.scrapers.samsungfood import SamsungFoodScraper
from app.scrapers.monngon import MonNgonScraper
from app.scrapers.cookpad import CookpadScraper
from app.scrapers.recipetineats import RecipeTinEatsScraper
from app.scrapers.bonappetit import BonAppetitScraper
from app.core.logger import logger

router = APIRouter(prefix="/api/scrape", tags=["scraper"])

SCRAPERS = [
    AllRecipesScraper(),
    SamsungFoodScraper(),
    MonNgonScraper(),
    CookpadScraper(),
    RecipeTinEatsScraper(),
    BonAppetitScraper()
]

async def translate_to_vi(text: str) -> str:
    """Translate search query to Vietnamese using the centralized translation utility."""
    from app.api.utils import translate_food_name
    translated = await translate_food_name(text, "vi")
    return translated if translated else text

# State management for long-running scrape operations
class ScrapeManager:
    def __init__(self):
        self.progress = 0
        self.is_running = False
        self.message = "Idle"
        self.found_count = 0
        self.skipped_count = 0
        self.duplicate_count = 0
        self.saved_count = 0
        self.start_time = 0
        self._flag_path = Path("logs/terminate.flag")

    @property
    def should_terminate(self) -> bool:
        """Check if termination flag file exists."""
        return self._flag_path.exists()

    @should_terminate.setter
    def should_terminate(self, value: bool):
        """Create or remove termination flag file."""
        if value:
            self._flag_path.parent.mkdir(parents=True, exist_ok=True)
            self._flag_path.touch()
        elif self._flag_path.exists():
            self._flag_path.unlink()

scrape_manager = ScrapeManager()

@router.get("/status")
async def get_scrape_status():
    """Get current scraping progress."""
    return {
        "progress": scrape_manager.progress,
        "is_running": scrape_manager.is_running,
        "message": scrape_manager.message,
        "found": scrape_manager.found_count,
        "skipped": scrape_manager.skipped_count,
        "duplicated": scrape_manager.duplicate_count,
        "saved": scrape_manager.saved_count,
        "should_terminate": scrape_manager.should_terminate,
        "version": "v3-atomic"
    }

@router.get("/version")
async def get_version():
    return {"version": "v3-atomic"}

@router.post("/terminate")
async def terminate_scrape():
    """Signal the scraping process to stop immediately."""
    if not scrape_manager.is_running:
        return {"message": "No active scrape to terminate."}
    
    scrape_manager.should_terminate = True
    logger.info("Termination signal received for scraping process.")
    return {"message": "Termination signal sent."}

async def search_for_query(
    query: str, 
    max_per_source: int = 2,
    query_index: int = 1,
    total_queries: int = 1
) -> dict:
    """Phase 1: Search and collect results in memory (No DB writes)."""
    clean_query = query.strip()
    is_vi = any(c > '\u007F' for c in clean_query)
    vi_query = clean_query if is_vi else await translate_to_vi(clean_query)
    
    active_scrapers = SCRAPERS
    if is_vi:
        active_scrapers = [s for s in SCRAPERS if isinstance(s, (MonNgonScraper, CookpadScraper))]

    completed_sources = 0
    total_sources = max(1, len(active_scrapers))
    query_base_pct = ((query_index - 1) / total_queries) * 100
    query_weight = (1 / total_queries) * 100
    step_info = f"[{query_index}/{total_queries}]" if total_queries > 1 else ""

    all_results = []
    total_active = len(active_scrapers)
    
    # Process scrapers sequentially to show "Searching [Site]..." in orders as requested
    for i, scraper in enumerate(active_scrapers):
        if scrape_manager.should_terminate:
            logger.info(f"Termination detected: Stopping ordered search at {scraper.SITE_NAME}")
            break
            
        q = vi_query if isinstance(scraper, (MonNgonScraper, CookpadScraper)) else clean_query
        site_index_info = f"({i+1}/{total_active})"
        scrape_manager.message = f"{step_info} '{clean_query}': Searching {scraper.SITE_NAME} {site_index_info}..."
        
        try:
            # Site-specific limit: Cookpad and Monngon get 5, others use max_per_source (default 3)
            site_limit = 5 if isinstance(scraper, (MonNgonScraper, CookpadScraper)) else max_per_source
            
            # Perform the search for this specific site
            res = await scraper.search(q, site_limit)
            
            if scrape_manager.should_terminate:
                logger.info(f"Termination detected AFTER search for {scraper.SITE_NAME}")
                break
                
            all_results.append(res)
            
            # Update progress incrementally
            completed_sources += 1
            scrape_manager.progress = int(query_base_pct + (completed_sources / total_sources) * query_weight)
            
        except Exception as e:
            logger.error(f"Scraper '{scraper.SITE_NAME}' failed for '{clean_query}': {e}")
            completed_sources += 1
            scrape_manager.progress = int(query_base_pct + (completed_sources / total_sources) * query_weight)

    if scrape_manager.should_terminate:
        return {"results": [], "found": 0, "duration": 0, "query": clean_query}

    found_list = []
    for results in all_results:
        found_list.extend(results)
    
    if scrape_manager.should_terminate:
        return {"results": [], "found": 0, "duration": 0, "query": clean_query}

    found_list = []
    for results in all_results:
        found_list.extend(results)

    scrape_manager.found_count += len(found_list)
    return {
        "results": found_list,
        "found": len(found_list),
        "duration": 0, # Calculated at caller level
        "query": clean_query,
        "step_info": step_info
    }

async def save_scraped_results(
    search_data: dict,
    session: AsyncSession
) -> dict:
    """Phase 2: Save raw search results to the database (Atomic transaction)."""
    if scrape_manager.should_terminate:
        await session.rollback()
        return {"saved": 0, "skipped": 0, "duplicated": 0}

    results = search_data["results"]
    clean_query = search_data["query"]
    step_info = search_data.get("step_info", "")
    
    scrape_manager.message = f"{step_info} '{clean_query}': Saving results..."

    from app.api.utils import get_avoid_food_names, check_ingredient_avoid
    avoid_names = await get_avoid_food_names(session)

    saved_count = 0
    skipped_count = 0
    duplicate_count = 0
    saved_list = []
    
    confectionery_keywords = ["kẹo", "candy", "dessert", "confectionery", "marshmallow", "bánh ngọt", "ice cream", "bánh kem"]

    for meal_data in results:
        if scrape_manager.should_terminate:
            logger.info(f"Termination detected DURING saving loop for '{clean_query}'. Rolling back.")
            await session.rollback()
            return {"saved": 0, "skipped": 0, "duplicated": 0}

        # Duplicate check
        existing = await session.execute(select(Meal).where(Meal.source_url == meal_data.source_url))
        if existing.scalar_one_or_none():
            duplicate_count += 1
            scrape_manager.duplicate_count += 1
            continue

        # Confectionery check
        name_lower = meal_data.name.lower()
        ingredient_names = [ing.get("name", "").lower() for ing in meal_data.ingredients]
        
        is_candy = any(kw in name_lower for kw in confectionery_keywords) or \
                   any(any(kw in ing for kw in confectionery_keywords) for ing in ingredient_names)
        
        if is_candy:
            skipped_count += 1
            scrape_manager.skipped_count += 1
            logger.info(f"Skipping confectionery: '{meal_data.name}'")
            continue

        # Avoid-list check: Skip if more than 25% of ingredients are on the avoid list
        num_ingredients = len(ingredient_names)
        if num_ingredients > 0:
            avoid_count = sum(1 for ing_name in ingredient_names if check_ingredient_avoid(ing_name, avoid_names))
            avoid_ratio = avoid_count / num_ingredients
            if avoid_ratio > 0.25:
                skipped_count += 1
                scrape_manager.skipped_count += 1
                logger.info(f"Skipping '{meal_data.name}': {avoid_ratio:.1%} avoid ingredients (Threshold: 25%)")
                continue

        db_meal = Meal(
            name=meal_data.name, description=meal_data.description,
            image_url=meal_data.image_url, source_url=meal_data.source_url,
            source_site=meal_data.source_site, calories=meal_data.calories,
            cook_time_hours=meal_data.cook_time_hours, servings=meal_data.servings,
            language=meal_data.language,
        )
        session.add(db_meal)
        await session.flush()

        for ing in meal_data.ingredients:
            session.add(MealIngredient(
                meal_id=db_meal.id,
                name=ing.get("name", ""),
                quantity=ing.get("quantity", ""),
                unit=ing.get("unit", ""),
                comment=ing.get("comment", "")
            ))
        await session.flush()

        # Calculate calories for the new meal using the improved FDC logic
        from app.api.fdc import calculate_meal_calories
        await calculate_meal_calories(db_meal.id, session, use_api=True)

        saved_count += 1
        scrape_manager.saved_count += 1
        saved_list.append({"name": meal_data.name, "source": meal_data.source_site})
        logger.info(f"Successfully saved recipe: '{meal_data.name}' from {meal_data.source_site}")

    return {"saved": saved_count, "skipped": skipped_count, "duplicated": duplicate_count, "results": saved_list}

async def run_scrape_for_query(
    query: str, 
    session: AsyncSession, 
    max_per_source: int = 2,
    query_index: int = 1,
    total_queries: int = 1
):
    """Main entry point for a single query scrape (Search + Save)."""
    start_time = time.time()
    search_data = await search_for_query(query, max_per_source, query_index, total_queries)
    if scrape_manager.should_terminate:
        return {"saved": 0, "found": 0, "skipped": 0, "duplicated": 0, "duration": 0}
        
    save_result = await save_scraped_results(search_data, session)
    if not scrape_manager.should_terminate:
        await session.commit()
        
    duration = int(time.time() - start_time)
    logger.info(f"Scrape query '{query}' finished: Found {search_data['found']}, Skipped {save_result['skipped']}, Duplicated {save_result['duplicated']}, Saved {save_result['saved']} in {duration}s")
    
    return {
        **save_result,
        "found": search_data["found"],
        "duration": duration
    }

@router.post("/search")
async def scrape_search(
    query: str,
    max_per_source: int = 3,
    session: AsyncSession = Depends(get_session),
):
    """Search all scraper sources for recipes matching a query (Standard API)."""
    if scrape_manager.is_running:
        return {"message": "Another scrape is in progress."}
    
    scrape_manager.is_running = True
    scrape_manager.progress = 10
    scrape_manager.should_terminate = False
    scrape_manager.found_count = 0
    scrape_manager.skipped_count = 0
    scrape_manager.duplicate_count = 0
    scrape_manager.saved_count = 0
    scrape_manager.message = f"Searching recipes for '{query}'..."
    try:
        result = await run_scrape_for_query(query, session, max_per_source, query_index=1, total_queries=1)
        return result
    finally:
        scrape_manager.is_running = False
        scrape_manager.progress = 100
        scrape_manager.message = "Scraping complete."

@router.post("/url")
async def scrape_from_url(
    url: str
):
    """Scrape a single recipe from a specific URL."""
    try:
        from recipe_scrapers import scrape_html
        from curl_cffi.requests import AsyncSession
        import re

        # Basic URL validation
        if not re.match(r'^https?://', url):
            raise HTTPException(status_code=400, detail="Invalid URL format. Must start with http:// or https://")

        logger.info(f"Manual scrape requested for URL: {url}")
        
        # Use a scraper instance to leverage existing logic
        # We can use any scraper since _scrape_recipe_details is mostly generic
        base = SCRAPERS[0] 
        
        async with AsyncSession() as s:
            try:
                resp = await s.get(url, impersonate="chrome120", timeout=15)
                if resp.status_code != 200:
                    raise HTTPException(status_code=400, detail=f"Failed to fetch URL. Status: {resp.status_code}")
                html = resp.text
            except Exception as e:
                logger.error(f"Fetch error for {url}: {e}")
                raise HTTPException(status_code=400, detail=f"Could not connect to the URL: {str(e)}")

        # Detect which scraper to use
        from urllib.parse import urlparse
        domain = urlparse(url).netloc
        scraper_inst = None
        for s in SCRAPERS:
            if s.BASE_URL and any(site in url for site in [s.BASE_URL, s.SITE_NAME]):
                scraper_inst = s
                break
        
        # If we have a custom scraper instance, use its specialized logic
        if scraper_inst:
            try:
                # Use the scraper's built-in details method which includes custom fallbacks
                async with AsyncSession() as s:
                    details = await scraper_inst._scrape_recipe_details(s, url)
                    if details.get("name"):
                        return {
                            "status": "success",
                            "meal": {
                                "name": details["name"],
                                "description": details.get("description", ""),
                                "image_url": details.get("image_url", ""),
                                "source_url": url,
                                "source_site": scraper_inst.SITE_NAME,
                                "cook_time_hours": details.get("cook_time_hours", 0.0),
                                "servings": details.get("servings", ""),
                                "ingredients": details.get("ingredients", [])
                            }
                        }
            except Exception as e:
                logger.error(f"Specialized scraper failed for {url}: {e}")

        # Fallback to generic recipe-scrapers if no custom scraper matched or it failed
        try:
            # We use recipe-scrapers to see if it's supported
            from recipe_scrapers import scraper_exists_for
            
            scraper = scrape_html(html=html, org_url=url, supported_only=False)
            
            # Extract data
            name = ""
            try: name = scraper.title()
            except: pass
            
            # If still no name, try BeautifulSoup title or meta tags as ultimate fallback
            if not name:
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(html, 'html.parser')
                name = (soup.find("meta", property="og:title") or {}).get("content") or \
                       (soup.find("title").text if soup.find("title") else "")
                name = name.strip()

            if not name:
                raise HTTPException(status_code=400, detail="Could not extract recipe name from this URL. The site might be protected or unsupported.")

            image_url = ""
            try: image_url = scraper.image()
            except: pass

            ingredients = []
            try:
                ing_list = scraper.ingredients()
                for item in ing_list:
                    if item:
                        ingredients.append(base._parse_ingredient(item))
            except: pass

            cook_time_hours = 0.0
            try:
                total_time = scraper.total_time()
                if total_time:
                    cook_time_hours = round(total_time / 60.0, 2)
            except: pass
            
            description = ""
            try: description = scraper.description()
            except: pass

            servings = ""
            try:
                raw_servings = scraper.servings()
                servings = base._clean_servings(raw_servings)
            except:
                try:
                    raw_yields = scraper.yields()
                    servings = base._clean_servings(raw_yields)
                except:
                    pass

            return {
                "status": "success",
                "meal": {
                    "name": name,
                    "description": description,
                    "image_url": image_url,
                    "source_url": url,
                    "source_site": domain,
                    "cook_time_hours": cook_time_hours,
                    "servings": servings,
                    "ingredients": ingredients
                }
            }

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Scrape error for {url}: {e}")
            raise HTTPException(status_code=400, detail=f"Error parsing recipe data: {str(e)}")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Global scrape error: {e}")
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@router.post("/populate")
async def populate_meals():
    """Bulk-populate the Meal Library using parallel ingredient processing."""
    if scrape_manager.is_running:
        return {"message": "Scrape already in progress."}

    scrape_manager.is_running = True
    scrape_manager.progress = 10
    scrape_manager.should_terminate = False
    scrape_manager.message = "Initializing bulk scrape..."
    scrape_manager.found_count = 0
    scrape_manager.skipped_count = 0
    scrape_manager.duplicate_count = 0
    scrape_manager.saved_count = 0
    scrape_manager.start_time = time.time()
    
    logger.info("API [populate_meals] parallel population started.")
    
    try:
        async with async_session_factory() as session:
            count_result = await session.execute(select(func.count(Meal.id)))
            total_meals = count_result.scalar()
        
            if total_meals >= 1000:
                scrape_manager.is_running = False
                return {"message": "Hard limit reached", "total": total_meals}

            # Fetch dynamic queries
            breakfast_res = await session.execute(
                select(Food.name)
                .where(Food.reflux.in_(["remedy", "ok"]))
                .where(Food.meal_type.in_(["breakfast", "both"]))
                .order_by(func.random())
                .limit(10)
            )
            breakfast_queries = [row[0] for row in breakfast_res.fetchall()]
            
            lunch_res = await session.execute(
                select(Food.name)
                .where(Food.reflux.in_(["remedy", "ok"]))
                .where(Food.meal_type.in_(["lunch/dinner", "both"]))
                .order_by(func.random())
                .limit(10)
            )
            lunch_queries = [row[0] for row in lunch_res.fetchall()]
            
            dynamic_queries = list(set(breakfast_queries + lunch_queries))
            num_queries = len(dynamic_queries)
            
            if num_queries == 0:
                scrape_manager.is_running = False
                return {"message": "No safe ingredients found in database."}

        completed_queries = 0
        semaphore = asyncio.Semaphore(3)

        async def process_query(query: str):
            nonlocal completed_queries
            if scrape_manager.should_terminate: return
            async with semaphore:
                async with async_session_factory() as task_session:
                    try:
                        await run_scrape_for_query(
                            query, task_session, max_per_source=3,
                            query_index=completed_queries + 1, total_queries=num_queries
                        )
                    except Exception as e:
                        logger.error(f"Task failed for '{query}': {e}")
                    finally:
                        completed_queries += 1

        tasks = [process_query(q) for q in dynamic_queries]
        await asyncio.gather(*tasks)
        
        duration = int(time.time() - scrape_manager.start_time)
        return {
            "message": "Bulk population finished.",
            "duration": duration,
            "found": scrape_manager.found_count,
            "skipped": scrape_manager.skipped_count,
            "duplicated": scrape_manager.duplicate_count,
            "saved": scrape_manager.saved_count
        }
    except Exception as e:
        logger.error(f"Bulk population failed: {e}")
        return {"message": f"Error: {str(e)}"}
    finally:
        scrape_manager.is_running = False
        if not scrape_manager.should_terminate:
            scrape_manager.progress = 100
            scrape_manager.message = "Bulk population complete."
        else:
            scrape_manager.message = "Process terminated."
