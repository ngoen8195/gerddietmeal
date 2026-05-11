"""Cookpad Vietnam scraper — most reliable source for Vietnamese recipes."""
from bs4 import BeautifulSoup
from app.scrapers import BaseScraper, ScrapedMeal

class CookpadScraper(BaseScraper):
    SITE_NAME = "cookpad.com"
    BASE_URL = "https://cookpad.com"

    async def _search(self, client, query: str, max_results: int) -> list[ScrapedMeal]:
        results = []
        vi_query = query  # Already translated by orchestration layer
        
        # Try Vietnamese Cookpad first, then global
        searches = [
            ("https://cookpad.com/vn/tim-kiem", vi_query, "vi"),
            ("https://cookpad.com/us/search", query, "en")
        ]
        for base, q, lang in searches:
            resp = await client.get(base, params={"q": q})
            if resp.status_code != 200:
                continue
            soup = BeautifulSoup(resp.text, "html.parser")
            
            # Extract links to recipes
            links = []
            for a in soup.find_all('a'):
                href = a.get('href', '')
                if ('/cong-thuc/' in href or '/recipe/' in href) and 'tao-moi' not in href:
                    if not href.startswith('http'):
                        href = self.BASE_URL + href
                    if href not in links:
                        links.append(href)
            
            for href in links:
                if len(results) >= max_results:
                    break
                try:
                    # Scrape details using recipe_scrapers
                    details = await self._scrape_recipe_details(client, href)
                    
                    if not details.get("name"):
                        continue

                    results.append(ScrapedMeal(
                        name=details["name"][:300],
                        description=details.get("description", ""),
                        image_url=details.get("image_url", ""),
                        source_url=href,
                        source_site=self.SITE_NAME,
                        language=lang,
                        ingredients=details.get("ingredients", []),
                        cook_time_hours=details.get("cook_time_hours", 0.0),
                        servings=details.get("servings", "")
                    ))
                except Exception:
                    continue

            if results:
                break

        return results
