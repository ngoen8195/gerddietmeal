"""Plugin-based recipe scraper system.

Architecture: Each scraper is a plugin that implements BaseScraper.
New sources can be added by creating a new file in this directory.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any
import httpx
from bs4 import BeautifulSoup
from recipe_scrapers import scrape_html


from app.core.logger import logger

@dataclass
class ScrapedMeal:
    """Standardized result from any scraper."""
    name: str
    description: str = ""
    image_url: str = ""
    source_url: str = ""
    source_site: str = ""
    calories: float = 0
    cook_time_hours: float = 0
    servings: str = ""
    language: str = "en"
    ingredients: list[dict] = field(default_factory=list)  # [{"name": ..., "quantity": ..., "unit": ..., "comment": ...}]


class BaseScraper(ABC):
    """Base class for all recipe scrapers."""
    
    SITE_NAME: str = ""
    BASE_URL: str = ""
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    async def search(self, query: str, max_results: int = 5) -> list[ScrapedMeal]:
        """Search for recipes matching the query."""
        logger.info(f"[{self.SITE_NAME}] Starting search for: '{query}'")
        try:
            async with httpx.AsyncClient(
                headers=self.HEADERS,
                follow_redirects=True,
                timeout=20.0,
            ) as client:
                results = await self._search(client, query, max_results)
                logger.info(f"[{self.SITE_NAME}] Found {len(results)} potential recipes for '{query}'")
                return results
        except Exception as e:
            logger.error(f"[{self.SITE_NAME}] Search error for '{query}': {e}")
            return []

    @abstractmethod
    async def _search(self, client: httpx.AsyncClient, query: str, max_results: int) -> list[ScrapedMeal]:
        """Implement in subclass."""
        pass

    def _clean_servings(self, servings: Any) -> str:
        """Extract only the numeric part of the servings string (e.g. '4 servings' -> '4')."""
        if servings is None:
            return ""
        
        s = str(servings).strip()
        if not s:
            return ""
            
        import re
        # Find numeric parts: digits, dots, and hyphens for ranges (e.g. 4, 4.5, 4-6)
        match = re.search(r'(\d+[\d\.\-]*\d*)', s)
        if match:
            return match.group(1)
            
        return s

    async def _scrape_recipe_details(self, client: httpx.AsyncClient, url: str) -> dict:
        """Fetch recipe details using recipe_scrapers.scrape_me."""
        details = {"ingredients": [], "cook_time_hours": 0.0, "description": "", "name": "", "image_url": "", "servings": ""}
        try:
            from recipe_scrapers import scrape_html
            from curl_cffi.requests import AsyncSession
            
            html = ""
            try:
                async with AsyncSession() as s:
                    resp = await s.get(url, impersonate="chrome120", timeout=15)
                    logger.info(f"Detail fetch for {url} returned status {resp.status_code}")
                    if resp.status_code == 200:
                        html = resp.text
            except Exception as e:
                logger.error(f"Failed to fetch recipe details for {url}: {e}")
            
            if not html:
                return details
            
            scraper = scrape_html(html=html, org_url=url, wild_mode=True)
            
            # Extract name and image
            try:
                details["name"] = scraper.title()
            except Exception:
                pass
                
            try:
                details["image_url"] = scraper.image()
            except Exception:
                pass
            
            # Extract servings
            try:
                raw_servings = scraper.servings()
                details["servings"] = self._clean_servings(raw_servings)
            except Exception:
                try:
                    raw_yields = scraper.yields()
                    details["servings"] = self._clean_servings(raw_yields)
                except Exception:
                    pass

            # Extract ingredients
            try:
                ing_list = scraper.ingredients()
                for item in ing_list:
                    if item:
                        details["ingredients"].append(self._parse_ingredient(item))
            except Exception:
                pass
            
            # Extract time
            try:
                total_time = scraper.total_time()
                if total_time:
                    details["cook_time_hours"] = round(total_time / 60.0, 2)
            except Exception:
                pass
                
        except Exception as e:
            logger.warning(f"[{self.SITE_NAME}] Details scrape error for {url}: {e}")
            
        return details

    def _parse_time(self, time_str: str) -> float:
        """Parse various time formats to hours."""
        if not time_str:
            return 0
        time_str = time_str.strip().lower()
        hours = 0
        if "h" in time_str:
            parts = time_str.split("h")
            hours += float(parts[0].strip() or 0)
            if len(parts) > 1 and parts[1]:
                mins = ''.join(c for c in parts[1] if c.isdigit())
                if mins:
                    hours += float(mins) / 60
        elif "min" in time_str or "m" in time_str:
            mins = ''.join(c for c in time_str if c.isdigit())
            if mins:
                hours = float(mins) / 60
        elif time_str.isdigit():
            hours = float(time_str) / 60
        return round(hours, 2)

    def _normalize_vietnamese_units(self, text: str) -> str:
        """Map common Vietnamese units to standard symbols for better parsing."""
        import re
        # Mapping (case-insensitive)
        mappings = {
            r'\bgam\b': 'g',
            r'\bkilôgam\b': 'kg',
            r'\blít\b': 'l',
            r'\bmililít\b': 'ml',
            r'\bthìa cà phê\b': 'tsp',
            r'\bmuỗng cà phê\b': 'tsp',
            r'\bmcf\b': 'tsp',
            r'\bthìa canh\b': 'tbsp',
            r'\bmuỗng canh\b': 'tbsp',
            r'\bmc\b': 'tbsp',
            r'\bnhúm\b': 'pinch',
            r'\btép\b': 'clove',
            r'\bnhánh\b': 'sprig',
            r'\bcủ\b': 'bulb',
            r'\bquả\b': 'piece',
            r'\btrái\b': 'piece',
            r'\bchén\b': 'cup',
            r'\bbát\b': 'cup',
            r'\bmuỗng\b': 'tablespoon',
            r'\bổ\b': 'piece',
            r'\bbó\b': 'bunch',
            r'\bgói\b': 'packet',
            r'\blon\b': 'can',
            r'\bhộp\b': 'box',
            r'\bchai\b': 'bottle',
            r'\btúi\b': 'bag',
            r'\bnửa\b': '0.5',
            r'\bmột nửa\b': '0.5'
        }
        for pattern, replacement in mappings.items():
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
        return text

    def _humanize_quantity(self, qty: Any) -> str:
        """Convert Fraction, float, or string fraction to human-readable mixed fraction (e.g. 7/3 -> 2 1/3)."""
        from fractions import Fraction
        
        if qty is None:
            return ""
            
        try:
            # If it's already a string, try to parse it if it looks like a fraction/float
            if isinstance(qty, str):
                qty = qty.strip()
                if not qty: return ""
                if "/" in qty:
                    parts = qty.split("/")
                    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                        qty = Fraction(int(parts[0]), int(parts[1]))
                else:
                    try:
                        qty = float(qty)
                    except ValueError:
                        return qty

            if isinstance(qty, (float, int)):
                qty = Fraction(qty).limit_denominator(100)
            
            if not isinstance(qty, Fraction):
                return str(qty)

            # Limit denominator for weird floats from library processing
            qty = qty.limit_denominator(100)
            
            whole = qty.numerator // qty.denominator
            rem_num = qty.numerator % qty.denominator
            
            if rem_num == 0:
                return str(whole)
            
            # Unicode mapping for premium look
            unicode_fractions = {
                (1, 2): "½", (1, 3): "⅓", (2, 3): "⅔",
                (1, 4): "¼", (3, 4): "¾", (1, 5): "⅕",
                (2, 5): "⅖", (3, 5): "⅗", (4, 5): "⅘",
                (1, 6): "⅙", (5, 6): "⅚", (1, 8): "⅛",
                (3, 8): "⅜", (5, 8): "⅝", (7, 8): "⅞",
            }
            
            fraction_part = unicode_fractions.get((rem_num, qty.denominator), f"{rem_num}/{qty.denominator}")
            
            if whole == 0:
                return fraction_part
            return f"{whole} {fraction_part}"
        except Exception:
            return str(qty)

    def _parse_ingredient(self, item: str) -> dict:
        """Parse ingredient string into name, quantity, unit, and comment."""
        item = item.strip()
        if not item:
            return {"name": "", "quantity": "", "unit": "", "comment": ""}

        # Pre-clean: strip bullets and common prefixes
        import re
        item = re.sub(r'^[\u2022\u25e6\u2023\u2043\u2219\*\-\+]\s*', '', item)
        
        # Normalize Vietnamese units for better NLP detection
        item = self._normalize_vietnamese_units(item)

        try:
            from ingredient_parser import parse_ingredient
            p = parse_ingredient(item)
            
            # Extract name more robustly
            name = " ".join(t.text for t in p.name) if p.name else ""
            if p.preparation:
                name = f"{p.preparation.text} {name}".strip()
            
            qty = ""
            unit = ""
            if p.amount:
                # Just take the first amount for simplicity
                amt = p.amount[0]
                
                # Handle CompositeIngredientAmount (e.g., "30g + 1 tbsp")
                if hasattr(amt, 'amounts') and amt.amounts:
                    amt = amt.amounts[0]
                
                # Use getattr for safety against library variations
                qty_obj = getattr(amt, 'quantity', None)
                unit_obj = getattr(amt, 'unit', "")
                
                # Humanize the quantity (converts Fraction/float to nice strings)
                qty = self._humanize_quantity(qty_obj)
                unit = str(unit_obj) if unit_obj is not None else ""
            
            comment = p.comment.text if p.comment else ""
            
            if not qty and not unit and (not name or name == item):
                # Simple regex for: [quantity] [unit] [name]
                # Include all common Unicode fractions: ½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞
                m = re.match(r'^([\d\./\s½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]+)\s*([a-zA-Z\u00C0-\u1EF9]+)?\s*(.*)$', item)
                if m:
                    r_qty, r_unit, r_name = m.groups()
                    if r_qty and r_name:
                        return {
                            "name": r_name.strip(),
                            "quantity": self._humanize_quantity(r_qty.strip()),
                            "unit": r_unit.strip() if r_unit else "",
                            "comment": comment
                        }

            return {
                "name": name or item,
                "quantity": qty,
                "unit": unit,
                "comment": comment
            }
        except Exception as e:
            logger.warning(f"Ingredient parsing failed for '{item}': {e}. Using fallback.")
            return {"name": item, "quantity": "", "unit": "", "comment": ""}
