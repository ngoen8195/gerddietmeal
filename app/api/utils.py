"""Utility functions for calculating avoid food status and shared response formatting."""
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.models import Food, MealIngredient, Meal
from typing import Set, Dict, List, Optional
import datetime

async def translate_food_name(name: str, target_lang: str = "vi") -> str:
    """Translate a food name using deep-translator."""
    try:
        from deep_translator import GoogleTranslator
        # Detect if it's already in the target language (rough check)
        # If we are translating to VI, and it has VI characters, return original
        # For simplicity, we just try to translate
        translated = GoogleTranslator(source='auto', target=target_lang).translate(name)
        return translated
    except Exception as e:
        from app.core.logger import logger
        logger.error(f"Translation error for '{name}': {e}")
        return ""

async def get_avoid_food_names(session: AsyncSession) -> Set[str]:
    """Fetch all avoid food names (EN and VI) from the database."""
    result = await session.execute(select(Food.name, Food.name_vi).where(Food.reflux == "avoid"))
    avoid_set = set()
    for row in result.fetchall():
        if row[0]: avoid_set.add(row[0].lower())
        if row[1]: avoid_set.add(row[1].lower())
    return avoid_set

async def get_remedy_food_names(session: AsyncSession) -> Set[str]:
    """Fetch all remedy food names (EN and VI) from the database."""
    result = await session.execute(select(Food.name, Food.name_vi).where(Food.reflux == "remedy"))
    remedy_set = set()
    for row in result.fetchall():
        if row[0]: remedy_set.add(row[0].lower())
        if row[1]: remedy_set.add(row[1].lower())
    return remedy_set

CROSS_LANG_MAPPING = {
    "garlic": ["tỏi"],
    "onion": ["hành", "hành tây"],
    "chili": ["ớt", "tương ớt"],
    "pepper": ["tiêu", "ớt"],
    "lemon": ["chanh"],
    "lime": ["chanh"],
    "tomato": ["cà chua"],
    "chocolate": ["sô-cô-la"],
    "coffee": ["cà phê"],
    "mint": ["bạc hà"],
    "beer": ["bia"],
    "alcohol": ["rượu"],
    "wine": ["rượu"],
    "hot sauce": ["tương ớt", "ớt"],
    "ice": ["đá viên", "nước đá"],
    # Reverse mapping
    "tỏi": ["garlic"],
    "hành": ["onion"],
    "hành tây": ["onion"],
    "ớt": ["chili", "pepper"],
    "tiêu": ["pepper"],
    "chanh": ["lemon", "lime"],
    "cà chua": ["tomato"],
    "sô-cô-la": ["chocolate"],
    "cà phê": ["coffee"],
    "bạc hà": ["mint"],
    "bia": ["beer"],
    "rượu": ["alcohol", "wine"],
    "tương ớt": ["chili", "hot sauce"],
    "đá viên": ["ice"],
    "nước đá": ["ice"]
}

def stem(s):
    """Simple heuristic stemming for English plurals."""
    s = s.lower().strip()
    if len(s) <= 3:
        return s
    if s.endswith('ies'):
        return s[:-3] + 'y'
    if s.endswith('es'):
        if any(s.endswith(x) for x in ['shes', 'ches', 'xes', 'ses']):
            return s[:-2]
        return s[:-1]
    if s.endswith('s') and not s.endswith('ss'):
        return s[:-1]
    return s

def check_ingredient_avoid(ingredient_name: str, avoid_names: Set[str]) -> bool:
    """Check if an ingredient name matches any avoid food name, handling simple plurals and EN-VI translation."""
    if not ingredient_name:
        return False
        
    name_lower = ingredient_name.lower()
    name_tokens = name_lower.split()
    name_parts = [stem(p) for p in name_tokens]
    
    for avoid in avoid_names:
        avoid_lower = avoid.lower().strip()
        avoid_tokens = avoid_lower.split()
        avoid_stemmed_tokens = [stem(p) for p in avoid_tokens]
        
        # 1. Whole word/phrase match
        if len(avoid_stemmed_tokens) == 1:
            target = avoid_stemmed_tokens[0]
            if target in name_parts:
                return True
        else:
            # Multi-word match: check if the stemmed avoid phrase is in the stemmed name phrase
            avoid_phrase = " ".join(avoid_stemmed_tokens)
            name_phrase = " ".join(name_parts)
            if avoid_phrase in name_phrase:
                return True
            
        # 2. Cross-language mapping (hardcoded fallback)
        if avoid_lower in CROSS_LANG_MAPPING:
            for syn in CROSS_LANG_MAPPING[avoid_lower]:
                syn_lower = syn.lower()
                syn_parts = [stem(p) for p in syn_lower.split()]
                if len(syn_parts) == 1:
                    if syn_parts[0] in name_parts:
                        return True
                else:
                    syn_phrase = " ".join(syn_parts)
                    name_phrase = " ".join(name_parts)
                    if syn_phrase in name_phrase:
                        return True
        
    return False

check_ingredient_remedy = check_ingredient_avoid

def format_meal_out(meal: Meal, fav_ids: Set[int], avoid_names: Set[str], remedy_names: Optional[Set[str]] = None) -> Dict:
    """Consolidated meal formatting for API responses."""
    ingredients_out = []
    avoid_count = 0
    remedy_count = 0
    
    for i in (meal.ingredients or []):
        is_avoid = check_ingredient_avoid(i.name, avoid_names) if avoid_names else False
        is_remedy = check_ingredient_remedy(i.name, remedy_names) if remedy_names else False
        if is_avoid:
            avoid_count += 1
        if is_remedy:
            remedy_count += 1
        
        ingredients_out.append({
            "id": i.id,
            "name": i.name,
            "quantity": i.quantity or "",
            "unit": i.unit or "",
            "comment": i.comment or "",
            "metric_weight_grams": i.metric_weight_grams or 0.0,
            "fdc_id": i.fdc_id,
            "fdc_name": getattr(i, 'fdc_name', None),
            "calories": getattr(i, 'calories', 0.0),
            "calories_incomplete": getattr(i, 'calories_incomplete', False),
            "is_avoid": is_avoid,
            "is_remedy": is_remedy
        })
    
    total_ingredients = len(ingredients_out)
    avoid_percentage = (avoid_count / total_ingredients * 100) if total_ingredients > 0 else 0.0
    
    return {
        "id": meal.id,
        "name": meal.name,
        "description": meal.description or "",
        "image_url": meal.image_url or "",
        "source_url": meal.source_url or "",
        "source_site": meal.source_site or "",
        "calories": meal.calories or 0,
        "calories_incomplete": meal.calories_incomplete or False,
        "cook_time_hours": meal.cook_time_hours or 0,
        "servings": meal.servings or "",
        "ingredient_count": total_ingredients,
        "language": meal.language or "en",
        "meal_type": meal.meal_type or "none",
        "has_avoid_food": avoid_count > 0,
        "avoid_percentage": avoid_percentage,
        "is_favorite": meal.id in fav_ids,
        "ingredients": ingredients_out,
        "created_at": meal.created_at,
    }
