"""Mon Ngon Moi Ngay scraper plugin — Vietnamese recipe source."""
from bs4 import BeautifulSoup
from app.scrapers import BaseScraper, ScrapedMeal

class MonNgonScraper(BaseScraper):
    SITE_NAME = "monngonmoingay.com"
    BASE_URL = "https://monngonmoingay.com"

    async def _search(self, client, query: str, max_results: int) -> list[ScrapedMeal]:
        results = []
        vi_query = query  # Already translated by orchestration layer
        
        # User-specified search URL pattern
        resp = await client.get(
            f"{self.BASE_URL}/tim-kiem-mon-ngon/",
            params={"tim": 1, "keyword": vi_query},
        )
        if resp.status_code != 200:
            return results

        soup = BeautifulSoup(resp.text, "html.parser")
        
        # Target specific cards: div.flex-recipe (new) or div.col-md-4 (old)
        cards = soup.select("div.flex-recipe, div.col-md-4, .item")
        
        for card in cards:
            if len(results) >= max_results:
                break
            try:
                # Find the primary link in the card (usually inside h3)
                link_el = card.select_one("h3 a") or card.select_one("a")
                if not link_el:
                    continue
                
                full_url = link_el.get("href", "")
                if not full_url or "tim-kiem" in full_url:
                    continue

                if not full_url.startswith("http"):
                    full_url = self.BASE_URL + full_url
                
                # Check for duplicates
                if any(r.source_url == full_url for r in results):
                    continue

                # Scrape details using recipe_scrapers
                details = await self._scrape_recipe_details(client, full_url)
                
                if not details.get("name"):
                    continue

                results.append(ScrapedMeal(
                    name=details["name"][:300],
                    image_url=details.get("image_url", ""),
                    source_url=full_url,
                    source_site=self.SITE_NAME,
                    language="vi",
                    ingredients=details.get("ingredients", []),
                    cook_time_hours=details.get("cook_time_hours", 0.0)
                ))
            except Exception:
                continue

        return results
