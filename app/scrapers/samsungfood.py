"""Samsung Food (formerly Whisk) scraper plugin."""
from bs4 import BeautifulSoup
from app.scrapers import BaseScraper, ScrapedMeal


class SamsungFoodScraper(BaseScraper):
    SITE_NAME = "samsungfood.com"
    BASE_URL = "https://app.samsungfood.com"

    async def _search(self, client, query: str, max_results: int) -> list[ScrapedMeal]:
        results = []
        import requests
        import asyncio
        
        # User's step-by-step example: https://app.samsungfood.com/search/recipes?search_query=chicken&ingredients&sorting=relevance
        url = f"{self.BASE_URL}/search/recipes"
        params = {
            "search_query": query,
            "ingredients": "",
            "sorting": "relevance"
        }
        
        def _do_request():
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            }
            return requests.get(url, params=params, headers=headers, timeout=15)

        try:
            resp = await asyncio.to_thread(_do_request)
            if resp.status_code != 200:
                return results
            html = resp.text
        except Exception:
            return results

        soup = BeautifulSoup(html, "html.parser")
        
        # Collect all recipe links (user example: <a href="/recipes/...")
        links = []
        for a in soup.find_all('a'):
            href = a.get("href", "")
            # Target /recipes/ with IDs
            if "/recipes/" in href and len(href) > 20:
                full_url = href if href.startswith("http") else self.BASE_URL + href
                if full_url not in links:
                    links.append(full_url)

        for full_url in links:
            if len(results) >= max_results:
                break
            try:
                # Scrape details using recipe_scrapers
                details = await self._scrape_recipe_details(client, full_url)
                
                if not details.get("name"):
                    continue

                results.append(ScrapedMeal(
                    name=details["name"][:300],
                    description=details.get("description", ""),
                    image_url=details.get("image_url", ""),
                    source_url=full_url,
                    source_site=self.SITE_NAME,
                    language="en",
                    ingredients=details.get("ingredients", []),
                    cook_time_hours=details.get("cook_time_hours", 0.0),
                    servings=details.get("servings", "")
                ))
            except Exception:
                continue

        return results
