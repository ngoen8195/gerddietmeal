"""Web Recipe Scraper for GERD Diet Meal.

Improved version with robust headers, updated search URLs, 
query translation for VN sites, and multi-source fallback logic.
"""

import json
import logging
import random
import re
import time
import hashlib
from pathlib import Path
from typing import Optional, List, Dict
from urllib.parse import quote_plus, urljoin

import requests
from bs4 import BeautifulSoup
from PySide6.QtCore import QThread, Signal

from db_manager import DatabaseManager
from translator import IngredientTranslator

logger = logging.getLogger(__name__)

# Modern browser headers
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}

_REQUEST_TIMEOUT = 20
_THROTTLE_RANGE = (2.0, 4.0)

# Updated search templates
_SOURCES = {   
    "monngonmoingay.com": "https://monngonmoingay.com/tim-kiem-mon-ngon/?tim=1&keyword={query}",
    "allrecipes.com": "https://www.allrecipes.com/search?q={query}",
    "cookpad_vn": "https://cookpad.com/vn/tim-kiem/{query}",
    "tasteofhome.com": "https://www.tasteofhome.com/?s={query}",
    "myrecipes.com": "https://www.myrecipes.com/search?q={query}",
    "samsungfood.com": "https://app.samsungfood.com/search/recipes?search_query={query}",
}


def _get_soup(url: str) -> Optional[BeautifulSoup]:
    """Fetch URL and return parsed BeautifulSoup, or None on error."""
    try:
        headers = _HEADERS.copy()
        # Add referer from same domain if possible, else generic
        headers["Referer"] = "/".join(url.split("/")[:3]) + "/"
        
        resp = requests.get(
            url,
            headers=headers,
            timeout=_REQUEST_TIMEOUT,
            allow_redirects=True
        )
        if resp.status_code == 403:
            logger.debug("403 Forbidden for %s. Site is blocking.", url)
            return None
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    except requests.RequestException as exc:
        logger.debug("Failed to fetch %s: %s", url, exc)
        return None


def _clean_text(text: Optional[str]) -> str:
    """Strip and collapse whitespace."""
    if not text:
        return ""
    return re.sub(r"\s+", " ", text.strip())


class RecipeScraper:
    """Searches, scrapes, validates, and saves recipes."""

    def __init__(self, db: DatabaseManager, translator: IngredientTranslator) -> None:
        self.db = db
        self.translator = translator
        self._images_dir = Path(__file__).parent / "resources" / "meal_images"
        self._default_image = str(
            Path(__file__).parent / "resources" / "default_meal_image.png"
        )
        self._images_dir.mkdir(parents=True, exist_ok=True)

    def search_and_save(
        self,
        safe_foods: list[str],
        count: int = 10,
        progress_callback=None,
        cancel_check=None,
    ) -> list[int]:
        """Search for recipes using safe food combos, validate, and save."""
        saved_ids: list[int] = []
        
        # Build search queries
        queries = self._build_search_queries(safe_foods, count * 3)
        if not queries:
            queries = ["chicken", "rice", "broccoli", "white fish"]

        random.shuffle(queries)

        for query in queries:
            if len(saved_ids) >= count:
                break
            if cancel_check and cancel_check():
                break

            # Try ALL sources for this query until we find something
            source_list = list(_SOURCES.keys())
            random.shuffle(source_list)
            
            for source_name in source_list:
                if len(saved_ids) >= count:
                    break
                if cancel_check and cancel_check():
                    break
                
                if progress_callback:
                    progress_callback(len(saved_ids), count, f"Searching {source_name}: {query}")

                recipes = self._search_source(source_name, query)
                if not recipes:
                    continue
                
                logger.info("Found %d results from %s for %s", len(recipes), source_name, query)
                
                for recipe in recipes:
                    if len(saved_ids) >= count:
                        break
                    if cancel_check and cancel_check():
                        break

                    meal_id = self.save_recipe(recipe)
                    if meal_id is not None:
                        saved_ids.append(meal_id)
                        if progress_callback:
                            progress_callback(
                                len(saved_ids), count,
                                f"Saved: {recipe.get('name', '?')}"
                            )
                    
                    time.sleep(random.uniform(0.5, 1.5))

                # Delay between sources
                time.sleep(random.uniform(*_THROTTLE_RANGE))

        return saved_ids

    def save_recipe(self, recipe: dict) -> Optional[int]:
        """Validate, deduplicate, and save a recipe. Returns meal_id or None."""
        name = recipe.get("name", "").strip()
        recipe_url = recipe.get("recipe_url")
        if not name or not recipe_url:
            return None

        # Deduplicate
        name_normalized = name.strip().lower()
        if self.db.meal_exists(recipe_url, name_normalized):
            return None

        # Fetch detail if ingredients are missing
        if not recipe.get("ingredients"):
            detail = self._fetch_recipe_detail(recipe_url, recipe.get("source_site", ""))
            if not detail:
                return None
            recipe.update(detail)

        raw_ingredients = recipe.get("ingredients", [])
        if not raw_ingredients:
            return None

        source_site = recipe.get("source_site", "")
        is_vietnamese = "monngonmoingay" in source_site or "cookpad" in source_site
        language = "vi" if is_vietnamese else "en"

        # Translate/Normalize
        if is_vietnamese:
            ingredients = self.translator.translate_list(raw_ingredients)
        else:
            ingredients = [
                self.translator.normalize_ingredient(ing)
                for ing in raw_ingredients
            ]

        # Validate
        if not self._validate_recipe(ingredients):
            return None

        # Calorie Calc
        total_cal = 0
        for ing in ingredients:
            cal = self.db.get_cached_calories(ing)
            if cal:
                total_cal += int(cal)
        if total_cal == 0:
            total_cal = random.randint(300, 600)

        # Save to DB
        meal_id = self.db.add_meal(
            name=name,
            description=recipe.get("description"),
            image_path=self._default_image,
            ingredients=ingredients,
            time_hours=recipe.get("time_hours", 1.0),
            calories=total_cal,
            recipe_url=recipe_url,
            source_site=source_site,
            language=language,
        )

        if meal_id is None:
            return None

        # Image download
        image_url = recipe.get("image_url")
        if image_url:
            image_path = self._download_image(image_url, meal_id, name)
            self.db.update_meal(meal_id, image_path=image_path)

        self.db.add_meal_foods(meal_id, ingredients)
        return meal_id

    def _validate_recipe(self, ingredients: list[str]) -> bool:
        """Accept if <= 20% of ingredients are in the avoid list."""
        if not ingredients:
            return False
        avoid_set = self.db.get_avoid_food_names()
        # Case-insensitive comparison
        avoid_set_lower = {f.lower() for f in avoid_set}
        avoid_count = sum(1 for ing in ingredients if ing.strip().lower() in avoid_set_lower)
        return (avoid_count / len(ingredients)) <= 0.20

    def _download_image(self, url: str, meal_id: int, meal_name: str) -> str:
        """Download image and save with required naming convention."""
        try:
            resp = requests.get(url, headers=_HEADERS, timeout=10)
            resp.raise_for_status()
            
            # Use a short hash or auto-increment if needed, but here we just follow requirements
            safe_name = re.sub(r"[^\w]", "_", meal_name)[:30]
            # [meal_id]_[meal_name]_[auto_increment_number] - simplified for now
            filename = f"{meal_id}_{safe_name}_1.jpg"
            path = self._images_dir / filename
            path.write_bytes(resp.content)
            return str(path)
        except Exception as e:
            logger.debug("Image download failed for %s: %s", url, e)
            return self._default_image

    def _get_image_from_ld(self, image_data) -> Optional[str]:
        """Extract image URL from JSON-LD structure."""
        if not image_data: return None
        if isinstance(image_data, list) and len(image_data) > 0: 
            image_data = image_data[0]
        if isinstance(image_data, dict): 
            return image_data.get("url")
        if isinstance(image_data, str): 
            return image_data
        return None

    # ── Source Specific Parsers ────────────────────────────────

    def _search_source(self, source_name: str, query: str) -> List[Dict]:
        url_template = _SOURCES.get(source_name)
        if not url_template:
            return []
        
        # Translate query if site is Vietnamese
        search_query = query
        if "monngonmoingay" in source_name or "cookpad_vn" in source_name:
            search_query = self.translator.translate_to_vi(query)
            logger.debug("Translated query '%s' to '%s' for %s", query, search_query, source_name)

        search_url = url_template.format(query=quote_plus(search_query))
        soup = _get_soup(search_url)
        if not soup:
            return []

        results = []
        # ── Search Result Selectors ──
        if source_name == "monngonmoingay.com":
            for a in soup.select("h3.post-title a"):
                href = a.get("href")
                if href: results.append({"name": a.get_text(strip=True), "recipe_url": href, "source_site": source_name})

        elif source_name == "allrecipes.com":
            for a in soup.select("a.mntl-card-list-card--extendable, a.mntl-card-list-items"):
                href = a.get("href")
                title = a.select_one(".card__title-text")
                if href and title:
                    results.append({"name": title.get_text(strip=True), "recipe_url": href, "source_site": source_name})

        elif source_name == "cookpad_vn":
            for a in soup.select("a.block-link__main, a.block-link"):
                href = a.get("href")
                if href and "/cong-thuc/" in href:
                    full_url = f"https://cookpad.com{href}" if href.startswith("/") else href
                    name = a.get_text(strip=True)
                    results.append({"name": name, "recipe_url": full_url, "source_site": source_name})

        elif source_name == "tasteofhome.com":
            for a in soup.select("a.content-search-excerpt-link, h3 a, a.post-thumbnail"):
                href = a.get("href")
                if href and "/recipes/" in href:
                    results.append({"name": a.get_text(strip=True), "recipe_url": href, "source_site": source_name})

        elif source_name == "myrecipes.com":
            for a in soup.select("a.mm-search-results-card__link, a.mntl-card-list-items"):
                href = a.get("href")
                title = a.select_one(".card__title-text")
                if href and title:
                    results.append({"name": title.get_text(strip=True), "recipe_url": href, "source_site": source_name})
        
        elif source_name == "samsungfood.com":
            for a in soup.select("a[href^='/recipes/']"):
                href = a.get("href")
                if href:
                    full_url = f"https://app.samsungfood.com{href}" if href.startswith("/") else href
                    results.append({"name": a.get_text(strip=True), "recipe_url": full_url, "source_site": source_name})
        
        return results

    def _fetch_recipe_detail(self, url: str, source: str) -> Optional[dict]:
        soup = _get_soup(url)
        if not soup:
            return None

        recipe_data = {"name": None, "description": None, "image_url": None, "ingredients": [], "time_hours": 1.0}

        # 1. Structured Data (LD+JSON)
        for script in soup.select('script[type="application/ld+json"]'):
            try:
                data = json.loads(script.string or "")
                if isinstance(data, list): 
                    data = next((item for item in data if isinstance(item, dict) and "Recipe" in str(item.get("@type", ""))), data[0])
                
                if isinstance(data, dict) and "@graph" in data: 
                    data = next((item for item in data["@graph"] if isinstance(item, dict) and item.get("@type") == "Recipe"), data)
                
                if isinstance(data, dict) and "Recipe" in str(data.get("@type", "")):
                    recipe_data["name"] = data.get("name")
                    recipe_data["description"] = data.get("description")
                    recipe_data["image_url"] = self._get_image_from_ld(data.get("image"))
                    recipe_data["ingredients"] = data.get("recipeIngredient", [])
                    recipe_data["time_hours"] = self._parse_iso_duration(data.get("totalTime"))
                    if recipe_data["ingredients"]:
                        break
            except: continue

        # 2. Meta Tag & DOM Fallback
        if not recipe_data["name"]:
            h1 = soup.select_one("h1")
            if h1: recipe_data["name"] = h1.get_text(strip=True)
        
        if not recipe_data["image_url"] and recipe_data["name"]:
            og_img = soup.find("meta", property="og:image")
            if og_img: 
                recipe_data["image_url"] = og_img.get("content")

        # 3. DOM Ingredient Fallback
        if not recipe_data["ingredients"]:
            ings = [li.get_text(strip=True) for li in soup.select("ol#ingredients li, .ingredient-list li, .ingredients-item, .recipe-ingredients li")]
            if ings: recipe_data["ingredients"] = ings

        if recipe_data["name"] and recipe_data["ingredients"]:
            return {
                "name": recipe_data["name"],
                "description": recipe_data["description"],
                "ingredients": recipe_data["ingredients"],
                "time_hours": recipe_data["time_hours"],
                "image_url": recipe_data["image_url"]
            }
        return None

    def _parse_iso_duration(self, duration: Optional[str]) -> float:
        if not duration: return 1.0
        match = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?", duration)
        if match:
            h = int(match.group(1) or 0)
            m = int(match.group(2) or 0)
            return round(h + m/60.0, 1)
        return 1.0

    def _build_search_queries(self, safe_foods: list[str], count: int) -> list[str]:
        if not safe_foods: return []
        # Use single ingredients for broader results
        if len(safe_foods) <= count:
            return safe_foods
        return random.sample(safe_foods, count)


class GenerateWorker(QThread):
    """Background worker for generating weekly meal plans."""
    progress = Signal(int, int, str)
    meal_ready = Signal(int)
    finished_ok = Signal(list)
    error = Signal(str)

    def __init__(self, db: DatabaseManager, slots_needed: int = 49, parent=None) -> None:
        super().__init__(parent)
        self.db = db
        self.slots_needed = slots_needed
        self._cancelled = False

    def run(self) -> None:
        try:
            meal_ids = self._generate_plan()
            self.finished_ok.emit(meal_ids)
        except Exception as e:
            logger.exception("Generation failed")
            self.error.emit(str(e))

    def cancel(self) -> None:
        self._cancelled = True

    def _generate_plan(self) -> list[int]:
        meal_count = self.db.get_meal_count()
        fav_ids = self.db.get_favorite_meal_ids()
        
        # Heuristic for reuse vs fresh
        reuse_ratio = min(0.8, meal_count / 100.0) if meal_count > 10 else 0.0
        reuse_count = int(self.slots_needed * reuse_ratio)
        fresh_count = self.slots_needed - reuse_count

        result_ids = []
        
        # 1. Reuse
        if reuse_count > 0:
            existing = self.db.get_all_meals()
            if existing:
                pool = []
                for m in existing:
                    weight = 3.0 if m["id"] in fav_ids else 1.0
                    pool.extend([m["id"]] * int(weight * 5))
                
                selected = random.sample(pool, min(reuse_count, len(pool)))
                result_ids.extend(selected)
                self.progress.emit(len(result_ids), self.slots_needed, f"Reusing {len(selected)} library meals")

        # 2. Fresh Scraping
        if fresh_count > 0 and not self._cancelled:
            safe_foods = list(self.db.get_safe_food_names())
            scraper = RecipeScraper(self.db, IngredientTranslator())
            
            new_ids = scraper.search_and_save(
                safe_foods=safe_foods,
                count=fresh_count,
                progress_callback=lambda c, t, s: self.progress.emit(reuse_count + c, self.slots_needed, s),
                cancel_check=lambda: self._cancelled
            )
            result_ids.extend(new_ids)

        # Pad if needed from library
        if len(result_ids) < self.slots_needed:
            all_m = self.db.get_all_meals()
            while len(result_ids) < self.slots_needed and all_m:
                result_ids.append(random.choice(all_m)["id"])
                
        return result_ids[:self.slots_needed]
