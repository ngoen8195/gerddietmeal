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
from app.core.logger import logger
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
    # Asian and global staple additions
    "egg whole", "duck egg", "seaweed", "nori", "fish sauce", "msg",
    "seasoning powder", "bouillon", "soy sauce", "sesame oil", "oyster sauce",
    "chili paste", "black pepper", "spring onion", "shallot"
]

import re

def clean_query_text(query: str) -> str:
    """Clean measurement units, quantities, and noise words from query prior to matching."""
    if not query:
        return ""
    q = query.lower().strip()
    # Strip common measurement prefixes and filler words like 'teaspoon of', 'tablespoon of', 'gr', 'of'
    q = re.sub(r'\b(teaspoon|tablespoon|tsp|tbsp|cup|piece|gram|g|gr|kg|ml|l|of|in|with|and|or)\b', ' ', q, flags=re.IGNORECASE)
    q = re.sub(r'^(muỗng|thìa|chén|bát|gói|hộp|chai|lon|túi|bó|quả|trái|tép|nhánh|củ|nửa|1/2|½|1/4|¼)\b\s*', '', q, flags=re.IGNORECASE)
    q = re.sub(r'\s+', ' ', q).strip()
    return q

def hybrid_fdc_rerank(query: str, candidate_fdc_list: list, query_vector: np.ndarray = None):
    """
    Hybrid Scoring & Heuristic Re-ranker on candidate FDC entries.
    Combines 70% Semantic (Cosine Similarity) + 30% Lexical (RapidFuzz) + USDA Structural Bonuses.
    candidate_fdc_list: List of dicts or CalorieEntry/Food objects with 'description', 'data_type', and optional 'vector'.
    """
    query_lower = clean_query_text(query)
    query_words = set(query_lower.split())
    if "drink" in query_words: query_words.update(["beverage", "beverages"])
    if "yogurt" in query_words: query_words.update(["yoghurt", "yogurts"])
    if "egg" in query_words or "eggs" in query_words: query_words.update(["egg", "eggs"])
    
    scored_results = []

    for item in candidate_fdc_list:
        desc = getattr(item, "description", None) or item.get("description", "")
        data_type = getattr(item, "data_type", None) or item.get("data_type", "")
        item_vec = getattr(item, "vector", None) or (item.get("vector") if isinstance(item, dict) else None)
        
        if item_vec is None and query_vector is not None:
            item_vec = get_text_embedding(desc)

        desc_lower = desc.lower().strip()
        segments = [s.strip() for s in desc_lower.split(',')]
        
        # 1. Semantic Similarity (Base Score scaled 0-100)
        if query_vector is not None and item_vec is not None:
            cosine_sim = float(np.dot(query_vector, item_vec))
            semantic_score = max(0.0, cosine_sim) * 100
        else:
            semantic_score = 0.0
        
        # 2. Lexical Token Match (0-100)
        lexical_score = fuzz.token_set_ratio(query_lower, desc_lower)
        
        # Combine base score: if dense vector is available use 70/30 split, else fallback to 100% lexical
        if query_vector is not None and item_vec is not None:
            base_score = (semantic_score * 0.7) + (lexical_score * 0.3)
        else:
            base_score = lexical_score
        
        bonus = 0
        match_count = sum(1 for word in query_words if word in desc_lower)
        if len(query_words) > 1:
            bonus += match_count * 20

        # 3. Structural Segment Priority (FDC standard: Name, Form, State)
        first_seg_matched = False
        if len(segments) > 0:
            first_seg = segments[0]
            if query_lower == first_seg:
                bonus += 80
                first_seg_matched = True
            elif any(w in first_seg for w in query_words):
                bonus += 50
                first_seg_matched = True
                
        if len(segments) > 1:
            second_seg = segments[1]
            if any(w in second_seg for w in query_words) and not first_seg_matched:
                bonus += 25

        # 4. Keyword Priority
        if "raw" in desc_lower: bonus += 20
        if "whole" in desc_lower: bonus += 15
        if "plain" in desc_lower: bonus += 15

        # 5. Foundation Boost (only if primary segment or significant core word match)
        if data_type == "Foundation" and (first_seg_matched or lexical_score >= 60):
            bonus += 150

        total_score = base_score + bonus
        scored_results.append((total_score, item))

    # Sort candidates by total score descending
    scored_results.sort(key=lambda x: x[0], reverse=True)
    return scored_results

# Custom scorer legacy alias
def fdc_scorer(q, choice_text, data_type=None, **kwargs):
    res = hybrid_fdc_rerank(q, [{"description": choice_text, "data_type": data_type}])
    return res[0][0] if res else 0.0

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
            logger.info(f"Translated '{query}' to '{translated}' for FDC matching.")
            query = translated

    # Clean measurement unit noise
    query = clean_query_text(query)


    # 1. Search local cache with dense vector candidate retrieval + hybrid re-ranking
    if cached_entries is None:
        result = await session.execute(select(CalorieEntry))
        cached_entries = result.scalars().all()
    
    if cached_entries:
        query_vec = get_text_embedding(query)
        
        if query_vec is not None:
            # Step A: Dense vector candidate selection (Top-50 by Cosine Similarity)
            vec_candidates = []
            for e in cached_entries:
                e_vec = get_text_embedding(e.description)
                sim = float(np.dot(query_vec, e_vec)) if e_vec is not None else 0.0
                vec_candidates.append((e, sim, e_vec))
            
            vec_candidates.sort(key=lambda x: x[1], reverse=True)
            top_50_candidates = vec_candidates[:50]
            
            # Step B: Hybrid Scoring & Heuristic Re-ranker on Top-50 candidates
            candidate_list = []
            for e, sim, e_vec in top_50_candidates:
                candidate_list.append({
                    "entry": e,
                    "description": e.description,
                    "data_type": e.data_type,
                    "vector": e_vec
                })
            
            reranked = hybrid_fdc_rerank(query, candidate_list, query_vector=query_vec)
            best_match = (reranked[0][1]["entry"], reranked[0][0]) if reranked else None
        else:
            # Fallback if SentenceTransformer is unavailable
            scored_entries = []
            for e in cached_entries:
                score = fdc_scorer(query, e.description, data_type=e.data_type)
                scored_entries.append((e, score))
            scored_entries.sort(key=lambda x: x[1], reverse=True)
            best_match = scored_entries[0] if scored_entries else None

        if best_match and best_match[1] >= 180:  # Require high confidence threshold (Base + Structural/Foundation Boost)
            entry = best_match[0]
            score = best_match[1]
            print(f"DEBUG: Local match found: {entry.description} (Score: {score:.2f}, Type: {entry.data_type})")
            portions = json.loads(entry.portions_json) if entry.portions_json else []
            return entry.calories, entry.fdc_id, entry.description, portions, True
        else:
            print(f"DEBUG: No strong local match for '{query}' (Best: {best_match[0].description if best_match else 'None'} {best_match[1] if best_match else 0:.2f})")

    if not use_api:
        return 0.0, 0, "", [], False

    # 2. Search FDC API using usda-fdc library
    try:
        client = FdcClient(FDC_API_KEY)
        loop = asyncio.get_event_loop()
        # Search for top 10 results to find the best fuzzy match
        search_result = await loop.run_in_executor(None, lambda: client.search(query, page_size=10))
        
        if search_result and search_result.foods:
            query_vec = get_text_embedding(query)
            api_candidates = []
            for f in search_result.foods:
                api_candidates.append({
                    "food": f,
                    "description": f.description,
                    "data_type": f.data_type,
                    "vector": get_text_embedding(f.description)
                })
            
            reranked_api = hybrid_fdc_rerank(query, api_candidates, query_vector=query_vec)
            best_api_match = (reranked_api[0][1]["food"], reranked_api[0][0]) if reranked_api else None
            
            if best_api_match and best_api_match[1] >= 70:
                best_food = best_api_match[0]
            else:
                best_food = search_result.foods[0]
                
            fdc_id = best_food.fdc_id
            desc = best_food.description
            
            # Fetch full details to get nutrients
            food_detail = await loop.run_in_executor(None, lambda: client.get_food(fdc_id))
            
            calories = 0
            energy_found = False
            if food_detail and food_detail.nutrients:
                energy_nutrients = []
                for nutrient in food_detail.nutrients:
                    n_name = nutrient.name.lower()
                    if "energy" in n_name and nutrient.unit_name.upper() == "KCAL":
                        energy_nutrients.append(nutrient)
                
                if energy_nutrients:
                    exact_match = next((n for n in energy_nutrients if n.name.lower() == "energy"), None)
                    if exact_match:
                        calories = exact_match.amount
                    else:
                        calories = energy_nutrients[0].amount
                    energy_found = True
            
            portions = []
            if food_detail and hasattr(food_detail, 'food_portions'):
                if hasattr(food_detail, 'api_data'):
                    portions = food_detail.api_data.get("foodPortions", [])
                else:
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
                    energy_found = False
                    for nutrient in food.get("foodNutrients", []):
                        name = nutrient.get("name", "").lower()
                        unit = nutrient.get("unitName", "").upper()
                        if "energy" in name and unit == "KCAL":
                            # Prioritize exact "energy" or "energy (atwater general...)"
                            if name == "energy":
                                calories = nutrient.get("amount", 0)
                                energy_found = True
                                break
                            elif "atwater general" in name:
                                calories = nutrient.get("amount", 0)
                                energy_found = True
                                # Keep looking for exact match just in case
                            elif not energy_found:
                                calories = nutrient.get("amount", 0)
                                energy_found = True
                    
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
                    energy_found = False
                    for nutrient in food.get("foodNutrients", []):
                        name = nutrient.get("nutrientName", "").lower()
                        unit = nutrient.get("unitName", "").upper()
                        if "energy" in name and unit == "KCAL":
                            if name == "energy":
                                calories = nutrient.get("value", 0)
                                energy_found = True
                                break
                            elif "atwater general" in name:
                                calories = nutrient.get("value", 0)
                                energy_found = True
                            elif not energy_found:
                                calories = nutrient.get("value", 0)
                                energy_found = True

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

import numpy as np

# Global cache for sentence transformer model and entry embeddings
_MODEL = None
_EMBEDDINGS_CACHE = {}  # description -> np.ndarray embedding

def get_embedding_model():
    """Lazy load SentenceTransformer model (~80MB) strictly from local cache."""
    global _MODEL
    if _MODEL is None:
        try:
            from sentence_transformers import SentenceTransformer
            # Enforce local offline model loading first without making remote HF requests
            try:
                _MODEL = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2', local_files_only=True)
            except Exception:
                # If model files are not yet in local cache, download once
                _MODEL = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2', local_files_only=False)
        except Exception as e:
            print(f"WARNING: Could not load SentenceTransformer model: {e}")
            _MODEL = False
    return _MODEL if _MODEL is not False else None

def get_text_embedding(text: str) -> np.ndarray:
    """Get or compute normalized dense vector embedding for text."""
    if text in _EMBEDDINGS_CACHE:
        return _EMBEDDINGS_CACHE[text]
    
    model = get_embedding_model()
    if model is None:
        return None
    
    vec = model.encode(text, convert_to_numpy=True, normalize_embeddings=True)
    _EMBEDDINGS_CACHE[text] = vec
    return vec

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
            from app.core.units import ureg, parse_quantity
            ing_unit = (ing.unit or "").lower().strip()
            qty_val = parse_quantity(ing.quantity)

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
