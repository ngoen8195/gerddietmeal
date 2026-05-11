"""FDC (USDA Food Data Central) calorie database integration.

One-time fetch: downloads top 500 common food items and caches in local SQLite.
API Key: hN8pQXiqnsgUBe7ItY4pJLB4NrhT7dFoZeD6DayQ
Endpoint: https://api.nal.usda.gov/fdc/v1/foods/search
"""
import httpx
import asyncio
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload, joinedload
from sqlalchemy import select, func
from app.core.database import get_session
from app.models.models import CalorieEntry
from rapidfuzz import process, fuzz
from usda_fdc import FdcClient
import json

router = APIRouter(prefix="/api/fdc", tags=["fdc"])

FDC_API_KEY = "hN8pQXiqnsgUBe7ItY4pJLB4NrhT7dFoZeD6DayQ"
FDC_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search"
FDC_LIST_URL = "https://api.nal.usda.gov/fdc/v1/foods/list"

# Common staple food queries to seed the calorie database
SEED_QUERIES = [
    "chicken breast", "rice", "salmon", "oatmeal", "banana", "apple", "broccoli",
    "potato", "egg white", "turkey", "yogurt", "carrot", "spinach", "quinoa",
    "avocado", "sweet potato", "cucumber", "pear", "mushroom", "corn",
    "zucchini", "lettuce", "celery", "cauliflower", "asparagus", "pumpkin",
    "tofu", "shrimp", "honey", "ginger", "mango", "watermelon", "cabbage",
    "green bean", "pea", "fennel", "papaya", "melon", "fig", "coconut",
    "almond", "walnut", "pineapple", "peach", "grape", "strawberry",
    "blueberry", "raspberry", "noodle", "pasta", "bread",
]


@router.get("/status")
async def fdc_status(session: AsyncSession = Depends(get_session)):
    """Check how many calorie entries are cached."""
    result = await session.execute(select(func.count(CalorieEntry.id)))
    return {"cached_entries": result.scalar()}


@router.get("/search")
async def search_calories(query: str, session: AsyncSession = Depends(get_session)):
    """Search cached calorie data by food description."""
    result = await session.execute(
        select(CalorieEntry)
        .where(CalorieEntry.description.ilike(f"%{query}%"))
        .order_by(CalorieEntry.description)
        .limit(20)
    )
    entries = result.scalars().all()
    return [
        {
            "fdc_id": e.fdc_id,
            "description": e.description,
            "calories": e.calories,
            "data_type": e.data_type,
            "portions": json.loads(e.portions_json) if e.portions_json else []
        }
        for e in entries
    ]


@router.post("/seed-foundation")
async def seed_foundation_foods(session: AsyncSession = Depends(get_session)):
    """Fetch Foundation foods from FDC and cache them."""
    new_entries = 0
    page_size = 200
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        for page in range(1, 15):  # Fetch up to 2800 foundation foods
            try:
                resp = await client.get(
                    FDC_LIST_URL,
                    params={
                        "api_key": FDC_API_KEY,
                        "dataType": "Foundation",
                        "pageSize": page_size,
                        "pageNumber": page,
                    },
                )
                if resp.status_code != 200:
                    break
                
                foods = resp.json()
                if not foods:
                    break
                    
                for food in foods:
                    fdc_id = food.get("fdcId")
                    if not fdc_id: continue
                    
                    # Extract calories (Foundation list uses 'name' and 'amount')
                    calories = 0
                    for nutrient in food.get("foodNutrients", []):
                        # Nutrients in 'list' have 'name' and 'amount'
                        name = nutrient.get("name", "").lower()
                        if name == "energy" and nutrient.get("unitName", "").upper() == "KCAL":
                            calories = nutrient.get("amount", 0)
                            break
                    
                    # Check if already exists
                    exists = await session.execute(select(CalorieEntry).where(CalorieEntry.fdc_id == fdc_id))
                    if exists.scalar_one_or_none(): continue
                    
                    entry = CalorieEntry(
                        fdc_id=fdc_id,
                        description=food.get("description", ""),
                        calories=calories,
                        data_type="Foundation",
                        portions_json=json.dumps(food.get("foodPortions", []))
                    )
                    session.add(entry)
                    new_entries += 1
                
                await session.commit()
            except Exception as e:
                print(f"Error seeding page {page}: {e}")
                continue
                
    return {"message": f"Added {new_entries} foundation foods."}


@router.post("/seed")
async def seed_fdc(session: AsyncSession = Depends(get_session)):
    """One-time fetch: download common food calorie data from USDA FDC API.
    
    This fetches ~500 entries covering common staple foods and caches them locally.
    Safe to call multiple times (idempotent — skips already-fetched items).
    """
    count_result = await session.execute(select(func.count(CalorieEntry.id)))
    existing_count = count_result.scalar()
    if existing_count >= 400:
        return {"message": f"Already have {existing_count} entries, skipping.", "seeded": False}

    new_entries = 0
    errors = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        for query in SEED_QUERIES:
            try:
                resp = await client.get(
                    FDC_SEARCH_URL,
                    params={
                        "api_key": FDC_API_KEY,
                        "query": query,
                        "pageSize": 10,
                        "dataType": ["Foundation", "SR Legacy"],
                    },
                )
                if resp.status_code != 200:
                    errors.append(f"{query}: HTTP {resp.status_code}")
                    continue

                data = resp.json()
                for food in data.get("foods", []):
                    fdc_id = food.get("fdcId")
                    if not fdc_id:
                        continue

                    # Check if already exists
                    exists = await session.execute(
                        select(CalorieEntry).where(CalorieEntry.fdc_id == fdc_id)
                    )
                    if exists.scalar_one_or_none():
                        continue

                    # Extract calories from nutrients
                    calories = 0
                    for nutrient in food.get("foodNutrients", []):
                        if nutrient.get("nutrientName", "").lower() == "energy" and \
                           nutrient.get("unitName", "").upper() == "KCAL":
                            calories = nutrient.get("value", 0)
                            break

                    entry = CalorieEntry(
                        fdc_id=fdc_id,
                        description=food.get("description", ""),
                        calories=calories,
                        data_type=food.get("dataType", ""),
                        portions_json=json.dumps(food.get("foodPortions", []))
                    )
                    session.add(entry)
                    new_entries += 1

                await session.commit()

            except Exception as e:
                errors.append(f"{query}: {str(e)}")
                continue

# Custom scorer to prioritize FDC naming conventions
def fdc_scorer(q, choices, **kwargs):
    # We need to return a score for each choice
    # But rapidfuzz process.extract uses a scorer that takes (s1, s2)
    # So we define it as a pairwise scorer
    s1 = q.lower().strip()
    s2 = choices.lower().strip()
    
    parts = [p.strip() for p in s2.split(',')]
    
    # Base fuzzy score
    base_score = fuzz.token_set_ratio(s1, s2)
    
    bonus = 0
    # 1. Word matching priority with aliases
    query_words = set(s1.split())
    if "drink" in query_words: query_words.update(["beverage", "beverages"])
    if "yogurt" in query_words: query_words.update(["yoghurt", "yogurts"])
    
    match_count = sum(1 for w in query_words if w in s2)
    if len(query_words) > 1:
        bonus += match_count * 20
    
    # 2. Segment priority (FDC standard: Name, Form, State)
    # We check if ANY query word matches the first segment for a boost
    first_segment = parts[0] if parts else ""
    if any(w in first_segment for w in query_words):
        if s1 == first_segment: bonus += 80  # Even higher for exact match
        else: bonus += 50
    elif len(parts) > 1 and any(w in parts[1] for w in query_words):
        bonus += 25
        
    # 3. Keyword priorities
    if "raw" in s2:
        bonus += 20  # Increased from 15
    if "whole" in s2:
        bonus += 15
    if "plain" in s2:
        bonus += 15
        
    return base_score + bonus

async def get_calories_for_food(query: str, session: AsyncSession, use_api: bool = True, cached_entries=None, language: str = "en") -> tuple:
    """
    Find calories per 100g for a given food name.
    Checks local cache first (with fuzzy matching), then FDC API if use_api is True.
    """
    if not query:
        return 0.0, 0, "", [], False

    original_query = query
    # Translate to English if ingredient is Vietnamese for better FDC matching
    if language == "vi":
        from app.api.utils import translate_food_name
        translated = await translate_food_name(query, "en")
        if translated:
            print(f"DEBUG: Translated '{query}' to '{translated}' for FDC matching.")
            query = translated


    # 1. Search local cache with fuzzy matching
    if cached_entries is None:
        result = await session.execute(select(CalorieEntry))
        cached_entries = result.scalars().all()
    
    if cached_entries:
        descriptions = [e.description for e in cached_entries]
        # Use our custom scorer to prioritize FDC naming conventions
        best_match = process.extractOne(query, descriptions, scorer=fdc_scorer)
        if best_match and best_match[1] >= 85:  # Threshold remains 85
            matched_desc = best_match[0]
            print(f"DEBUG: Local match found: {matched_desc} (Score: {best_match[1]})")
            for e in cached_entries:
                if e.description == matched_desc:
                    portions = json.loads(e.portions_json) if e.portions_json else []
                    print(f"DEBUG: Found {query} in local cache: {e.description} ({e.calories} kcal)")
                    return e.calories, e.fdc_id, e.description, portions, True
        else:
            print(f"DEBUG: No local match for {query} (Best: {best_match[0] if best_match else 'None'} {best_match[1] if best_match else 0})")

    if not use_api:
        return 0.0, 0, "", [], False

    # 2. Search FDC API using usda-fdc library
    try:
        client = FdcClient(FDC_API_KEY)
        loop = asyncio.get_event_loop()
        # Search for top 10 results to find the best fuzzy match
        search_result = await loop.run_in_executor(None, lambda: client.search(query, page_size=10))
        
        if search_result and search_result.foods:
            # Use our custom scorer among the API results
            api_descriptions = [f.description for f in search_result.foods]
            best_api_match = process.extractOne(query, api_descriptions, scorer=fdc_scorer)
            
            # If we find a decent match, use it. Otherwise fallback to the first one.
            if best_api_match and best_api_match[1] >= 70:
                matched_api_desc = best_api_match[0]
                best_food = next(f for f in search_result.foods if f.description == matched_api_desc)
            else:
                best_food = search_result.foods[0]
                
            fdc_id = best_food.fdc_id
            desc = best_food.description
            
            # Fetch full details to get nutrients
            food_detail = await loop.run_in_executor(None, lambda: client.get_food(fdc_id))
            
            calories = 0
            energy_found = False
            if food_detail and food_detail.nutrients:
                # Try to find the best energy nutrient
                # Priority: 1. "Energy" (KCAL), 2. "Energy (Atwater...)" (KCAL)
                energy_nutrients = []
                for nutrient in food_detail.nutrients:
                    n_name = nutrient.name.lower()
                    if "energy" in n_name and nutrient.unit_name.upper() == "KCAL":
                        energy_nutrients.append(nutrient)
                
                if energy_nutrients:
                    # Prefer exact "energy" match
                    exact_match = next((n for n in energy_nutrients if n.name.lower() == "energy"), None)
                    if exact_match:
                        calories = exact_match.amount
                    else:
                        # Take the first one (usually Atwater General Factors)
                        calories = energy_nutrients[0].amount
                    energy_found = True
            
            portions = []
            if food_detail and hasattr(food_detail, 'food_portions'):
                # Note: usda-fdc objects might have different attribute names than raw API
                # but we'll try to get it from api_data if possible or just the object
                if hasattr(food_detail, 'api_data'):
                    portions = food_detail.api_data.get("foodPortions", [])
                else:
                    # Fallback to reconstructing from attributes if possible
                    for p in getattr(food_detail, 'food_portions', []):
                        portions.append({
                            "amount": getattr(p, 'amount', 0),
                            "modifier": getattr(p, 'modifier', ''),
                            "gramWeight": getattr(p, 'gram_weight', 0)
                        })
            
            # Cache locally
            existing = await session.execute(select(CalorieEntry).where(CalorieEntry.fdc_id == fdc_id))
            if not existing.scalar_one_or_none():
                new_entry = CalorieEntry(
                    fdc_id=fdc_id, 
                    description=desc, 
                    calories=calories, 
                    data_type=best_food.data_type,
                    portions_json=json.dumps(portions)
                )
                session.add(new_entry)
                await session.flush()
                await session.commit()
            
            return calories, fdc_id, desc, portions, energy_found
            
    except Exception as e:
        print(f"FDC API Error: {e}")
    
    return 0.0, 0, "", [], False

async def calculate_meal_calories(meal_id: int, session: AsyncSession, use_api: bool = True) -> dict:
    """Calculate total calories for a meal based on its ingredients."""
    from app.models.models import Meal, MealIngredient
    from app.core.units import convert_to_grams
    
    result = await session.execute(
        select(Meal).options(selectinload(Meal.ingredients)).where(Meal.id == meal_id)
    )
    meal = result.scalar_one_or_none()
    if not meal:
        return {"error": "Meal not found"}

    total_kcal = 0.0
    incomplete = False
    
    # Pre-fetch all cached entries once for this meal's ingredients
    result = await session.execute(select(CalorieEntry))
    cached_entries = result.scalars().all()
    
    for ing in meal.ingredients:
        # 1. Get calories and portions from FDC first
        kcal_100g, fdc_id, fdc_desc, portions, energy_found = await get_calories_for_food(
            ing.name, session, use_api=use_api, cached_entries=cached_entries, language=meal.language
        )

        
        weight = 0.0
        found_portion = False
        
        if fdc_id and portions:
            from app.core.units import ureg
            ing_unit = (ing.unit or "").lower().strip()
            
            # Parse quantity once
            try:
                qty_val = float(ureg.parse_expression(ing.quantity.replace(' ', '+')))
            except:
                import re
                nums = re.findall(r"[-+]?\d*\.\d+|\d+", ing.quantity)
                qty_val = float(nums[0]) if nums else 0.0

            if ing_unit and qty_val > 0:
                print(f"DEBUG: Checking portions for {ing.name} (Unit: {ing_unit}, Qty: {qty_val})")
                # 1. Direct String Match (e.g. "cup" in "1 cup")
                for p in portions:
                    modifier = p.get("modifier", "").lower()
                    if ing_unit in modifier:
                        portion_amount = p.get("amount", 1.0)
                        portion_grams = p.get("gramWeight", 0.0)
                        if portion_amount > 0:
                            weight = (qty_val / portion_amount) * portion_grams
                            found_portion = True
                            print(f"DEBUG: Direct portion match! Weight: {weight}")
                            break
                
                # 2. Dimensional Bridge (Volume to Volume)
                # If recipe has ml/cup and FDC has fl oz/tbsp, we can derive density
                if not found_portion:
                    try:
                        u_ing = ureg(ing_unit)
                        if u_ing.check('[volume]'):
                            # Map FDC unit strings to valid Pint units
                            vol_map = [
                                ('cup', 'cup'),
                                ('fl oz', 'fluid_ounce'),
                                ('ml', 'ml'),
                                ('tbsp', 'tbsp'),
                                ('tsp', 'tsp'),
                                ('pint', 'pint'),
                                ('quart', 'quart'),
                                ('liter', 'liter'),
                                ('gallon', 'gallon'),
                                ('tablespoon', 'tablespoon'),
                                ('teaspoon', 'teaspoon')
                            ]
                            for p in portions:
                                modifier = p.get("modifier", "").lower()
                                for vol_keyword, pint_unit in vol_map:
                                    if vol_keyword in modifier:
                                        # Match! Calculate implied density from FDC
                                        u_portion = ureg(pint_unit)
                                        portion_amount = p.get("amount", 1.0)
                                        portion_grams = p.get("gramWeight", 0.0)
                                        
                                        # ml_in_portion = portion_amount * (u_portion -> ml)
                                        ml_in_portion = (portion_amount * u_portion).to('milliliter').magnitude
                                        if ml_in_portion > 0:
                                            implied_density = portion_grams / ml_in_portion
                                            # Apply to recipe quantity
                                            ing_ml = (qty_val * u_ing).to('milliliter').magnitude
                                            weight = ing_ml * implied_density
                                            found_portion = True
                                            print(f"DEBUG: Dimensional bridge match! Density: {implied_density:.3f} g/ml, Weight: {weight}")
                                            break
                                if found_portion: break
                    except Exception as e:
                        print(f"DEBUG: Dimensional bridge failed or not a volume unit: {e}")
        
        # 2. Fallback to DENSITY_MAP if no portion match found
        if not found_portion:
            print(f"DEBUG: No portion match, falling back to convert_to_grams for {ing.name}")
            weight = convert_to_grams(ing.quantity, ing.unit, ing.name)
            print(f"DEBUG: Fallback weight: {weight}")
            
        ing.metric_weight_grams = weight
        
        # We consider it complete ONLY if:
        # 1. FDC ID was found
        # 2. Energy was successfully found in FDC (energy_found)
        # 3. Weight was successfully calculated (weight > 0)
        # Exception: if kcal_100g is exactly 0 and it was found, we still allow it (e.g. water)
        
        if fdc_id and energy_found and weight > 0:
            ing.fdc_id = fdc_id
            ing.fdc_name = fdc_desc
            ing.calories_incomplete = False
            ing_kcal = round((weight / 100.0) * kcal_100g, 1)
            ing.calories = ing_kcal
            total_kcal += ing_kcal
        else:
            if fdc_id:
                ing.fdc_id = fdc_id
                ing.fdc_name = fdc_desc
            else:
                ing.fdc_name = None
            ing.calories = 0.0
            ing.calories_incomplete = True
            incomplete = True
            
    meal.calories = round(total_kcal, 1)
    meal.calories_incomplete = incomplete
    await session.commit()
    
    return {
        "meal_id": meal_id,
        "total_calories": meal.calories,
        "incomplete": incomplete
    }

@router.post("/calculate/{meal_id}")
async def trigger_meal_calculation(meal_id: int, use_api: bool = True, session: AsyncSession = Depends(get_session)):
    """API endpoint to trigger calorie calculation for a specific meal."""
    return await calculate_meal_calories(meal_id, session, use_api=use_api)

@router.post("/calculate-all")
async def calculate_all_meals(use_api: bool = True, session: AsyncSession = Depends(get_session)):
    """Calculate calories for all meals that don't have them yet."""
    from app.models.models import Meal
    # Select meals where calories are 0, were incomplete, or are suspiciously high (>10000 kcal)
    result = await session.execute(select(Meal.id).where(
        (Meal.calories == 0) | 
        (Meal.calories_incomplete == True) |
        (Meal.calories > 10000)
    ))
    meal_ids = [r[0] for r in result.fetchall()]
    
    results = []
    for mid in meal_ids:
        res = await calculate_meal_calories(mid, session, use_api=use_api)
        results.append(res)
        
    return {"calculated": len(results), "details": results[:10]}
