"""RecipeTin Eats scraper plugin."""
import asyncio
from bs4 import BeautifulSoup
from app.scrapers import BaseScraper, ScrapedMeal
from app.core.logger import logger

class RecipeTinEatsScraper(BaseScraper):
    SITE_NAME = "recipetineats.com"
    BASE_URL = "https://www.recipetineats.com"

    async def _search(self, client, query: str, max_results: int) -> list[ScrapedMeal]:
        results = []
        url = f"{self.BASE_URL}/"
        params = {"s": query}
        
        try:
            # Use curl_cffi for better compatibility with bot protection
            from curl_cffi.requests import AsyncSession
            async with AsyncSession() as s:
                resp = await s.get(url, params=params, impersonate="chrome120", timeout=15)
                
            if resp.status_code != 200:
                logger.error(f"[{self.SITE_NAME}] Search failed with status {resp.status_code}")
                return results
            html = resp.text
        except Exception as e:
            logger.error(f"[{self.SITE_NAME}] Request error: {e}")
            return results

        soup = BeautifulSoup(html, "html.parser")
        links = []
        # CSS Selector identified via browser: .entry-title-link
        for a in soup.select(".entry-title-link"):
            href = a.get("href", "")
            if href and href not in links:
                links.append(href)
        
        if not links:
            logger.warning(f"[{self.SITE_NAME}] No links found for '{query}'.")
        
        for full_url in links[:max_results]:
            try:
                details = await self._scrape_recipe_details(client, full_url)
                if not details.get("name"):
                    continue

                results.append(ScrapedMeal(
                    name=details["name"][:300],
                    image_url=details.get("image_url", ""),
                    source_url=full_url,
                    source_site=self.SITE_NAME,
                    language="en",
                    ingredients=details.get("ingredients", []),
                    cook_time_hours=details.get("cook_time_hours", 0.0)
                ))
            except Exception:
                continue

        return results
