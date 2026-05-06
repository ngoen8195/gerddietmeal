"""AllRecipes scraper plugin."""
import asyncio
from curl_cffi import requests as curl_requests
from bs4 import BeautifulSoup
from app.scrapers import BaseScraper, ScrapedMeal
from app.core.logger import logger


class AllRecipesScraper(BaseScraper):
    SITE_NAME = "allrecipes.com"
    BASE_URL = "https://www.allrecipes.com"

    async def _search(self, client, query: str, max_results: int) -> list[ScrapedMeal]:
        results = []
        url = f"{self.BASE_URL}/search"
        params = {"q": query}
        
        try:
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
        
        # Collect recipe links from search results (User selector: a.mntl-card-list-card--extendable)
        links = []
        selector = 'a.mntl-card-list-card--extendable, a.mntl-card-list-items, a[href*="/recipe/"]'
        for a in soup.select(selector):
            href = a.get("href", "")
            if "/recipe/" in href and "search" not in href:
                full_url = href if href.startswith("http") else self.BASE_URL + href
                if full_url not in links:
                    links.append(full_url)
        
        if not links:
            logger.warning(f"[{self.SITE_NAME}] No links found for '{query}'. HTML length: {len(html)}. Preview: {html[:200]}")
        
        for full_url in links:
            if len(results) >= max_results:
                break
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
