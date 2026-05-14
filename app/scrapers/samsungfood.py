"""Samsung Food (formerly Whisk) scraper plugin."""
from bs4 import BeautifulSoup
from app.scrapers import BaseScraper, ScrapedMeal
from app.core.logger import logger


class SamsungFoodScraper(BaseScraper):
    SITE_NAME = "samsungfood.com"
    BASE_URL = "https://app.samsungfood.com"

    async def _scrape_recipe_details(self, client, url: str) -> dict:
        """Fetch recipe details with a custom fallback for Samsung Food's dynamic pages."""
        # Try the default logic first
        details = await super()._scrape_recipe_details(client, url)
        
        # If the default logic failed (name is empty), try manual extraction from the 'hydrate' JSON
        if not details.get("name"):
            logger.info(f"[{self.SITE_NAME}] Manual extraction fallback for {url}")
            from curl_cffi.requests import AsyncSession
            import json
            import re
            
            html = ""
            try:
                async with AsyncSession() as s:
                    resp = await s.get(url, impersonate="chrome120", timeout=15)
                    if resp.status_code == 200:
                        html = resp.text
            except Exception as e:
                logger.error(f"[{self.SITE_NAME}] Fallback fetch failed for {url}: {e}")

            if html:
                try:
                    # Look for var hydrate = { ... }
                    # It can end with ; or </script> or another var
                    match = re.search(r'var hydrate\s*=\s*(\{.*?\})(?:;|</script>|\s*var)', html, re.DOTALL)
                    if not match:
                        # Even more aggressive fallback
                        match = re.search(r'var hydrate\s*=\s*(\{.*)', html, re.DOTALL)
                        if match:
                            # Try to find the end by balancing braces or just taking until </script>
                            content = match.group(1)
                            end_idx = content.find('</script>')
                            if end_idx != -1:
                                content = content[:end_idx].strip()
                                if content.endswith(';'):
                                    content = content[:-1].strip()
                                data = json.loads(content)
                            else:
                                data = None
                        else:
                            data = None
                    else:
                        data = json.loads(match.group(1))
                    
                    if data:
                        # Find the recipe key (it usually starts with whisk.x.recipe.v1.RecipeAPI/GetRecipe_)
                        recipe_data = None
                        for key, value in data.items():
                            if "RecipeAPI/GetRecipe" in key and isinstance(value, dict) and "recipe" in value:
                                recipe_data = value["recipe"]
                                break
                        
                        if recipe_data:
                            details["name"] = recipe_data.get("name", "")
                            details["description"] = recipe_data.get("description", "")
                            
                            # Extract ingredients
                            raw_ingredients = recipe_data.get("ingredients", [])
                            if raw_ingredients:
                                details["ingredients"] = []
                                for ing in raw_ingredients:
                                    text = ing.get("text", "")
                                    if text:
                                        details["ingredients"].append(self._parse_ingredient(text))
                            
                            # Extract image
                            images = recipe_data.get("images", [])
                            if images and isinstance(images, list) and len(images) > 0:
                                details["image_url"] = images[0].get("original", {}).get("url", "")
                            elif "source" in recipe_data and "image" in recipe_data["source"]:
                                details["image_url"] = recipe_data["source"]["image"].get("responsive", {}).get("url", "")
                            
                            # Extract time
                            durations = recipe_data.get("durations", {})
                            total_mins = durations.get("cookTime", 0) + durations.get("prepTime", 0)
                            if total_mins > 0:
                                details["cook_time_hours"] = round(total_mins / 60.0, 2)
                            
                            # Extract servings
                            details["servings"] = self._clean_servings(recipe_data.get("servings", ""))
                            
                            logger.info(f"[{self.SITE_NAME}] Successfully extracted '{details['name']}' via manual fallback.")
                except Exception as e:
                    logger.warning(f"[{self.SITE_NAME}] Manual extraction failed for {url}: {e}")

        return details

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
