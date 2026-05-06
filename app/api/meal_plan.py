"""Meal Plan generation API — the core intelligence of the app.

Business Rules:
- Generates a Mon→Sun plan with Breakfast (1 slot), Lunch (3 slots), Dinner (3 slots) per day.
- Only includes meals whose ingredients are NOT in the "avoid" food list.
- Favorites get 1.3x higher probability of appearing (approx).
- Saves generated plans to the database permanently.
"""
import random
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, func
from sqlalchemy.orm import selectinload
from app.core.database import get_session
from app.models.models import Meal, FavoriteMeal, Food, PlannedMeal

router = APIRouter(prefix="/api/meal-plan", tags=["meal-plan"])

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

async def _get_meal_pools(session: AsyncSession):
    # 1. Get avoid food names
    avoid_result = await session.execute(
        select(Food.name).where(Food.reflux == "avoid")
    )
    avoid_names = {row[0].lower() for row in avoid_result.fetchall()}

    # 2. Get all meals with ingredients
    meals_result = await session.execute(
        select(Meal).options(selectinload(Meal.ingredients))
    )
    all_meals = meals_result.unique().scalars().all()

    # 3. Filter safe meals and split into pools
    breakfast_keywords = ["breakfast", "smoothie", "yogurt", "scrambled egg", "gluten-free bread", "egg", "toast", "oatmeal", "pancake", "omelet", "bagel", "croissant", "granola", "fruit", "ham", "syrup", "pastry", "bữa sáng", "sữa chua", "sinh tố", "trứng", "bánh mì", "phở", "bún", "miến", "cháo", "xôi", "mì", "bơ", "bánh bao", "bánh cuốn", "bánh giầy", "bánh giò", "trứng", "ngũ cốc", "mứt", "mật ong"]
    meat_fish_keywords = ["meat", "beef", "pork", "chicken", "fish", "shrimp", "tofu", "egg", "steak", "ham", "sườn", "thịt", "cá", "tôm", "gà", "heo", "bò", "vịt", "đậu hũ", "trứng", "thịt kho", "cá kho", "thịt luộc", "thịt nướng"]
    soup_keywords = ["soup", "stew", "chowder", "bisque", "bouillon", "consommé", "minestrone", "borscht", "gazpacho", "canh", "phở", "bún", "miến", "lẩu", "súp", "canh chua", "canh cá", "canh rau", "canh cải", "canh bí", "canh mướp", "canh bầu", "canh trứng"]
    
    pools = {
        "breakfast_vi": [], "breakfast_en": [],
        "soup_vi": [], "soup_en": [],
        "veg_vi": [], "veg_en": [],
        "meat_vi": [], "meat_en": []
    }
    
    safe_meals_count = 0

    for meal in all_meals:
        ingredient_names = [ing.name.lower() for ing in meal.ingredients]
        total_ingredients = len(ingredient_names)

        # Avoid division by zero if a meal has no ingredients
        if total_ingredients == 0:
            continue

        # Count how many ingredients contain a word from avoid_names
        avoid_count = sum(
            1 for ing_name in ingredient_names
            if any(avoid in ing_name for avoid in avoid_names)
        )

        avoid_proportion = avoid_count / total_ingredients

        if avoid_proportion > 0.20:
            continue   
            
        safe_meals_count += 1
        name_lower = meal.name.lower()
        
        has_meat = any(any(kw in ing for kw in meat_fish_keywords) for ing in ingredient_names) or \
                   any(kw in name_lower for kw in meat_fish_keywords)
        
        is_breakfast = any(kw in name_lower for kw in breakfast_keywords) or \
                       any(any(kw in ing for kw in breakfast_keywords) for ing in ingredient_names)

        # Breakfast rule: No meat/fish
        if is_breakfast and not has_meat:
            if meal.language == "vi": pools["breakfast_vi"].append(meal)
            else: pools["breakfast_en"].append(meal)
        elif not is_breakfast:
            is_soup = any(kw in name_lower for kw in soup_keywords)
            
            if is_soup:
                if meal.language == "vi": pools["soup_vi"].append(meal)
                else: pools["soup_en"].append(meal)
            elif not has_meat:
                if meal.language == "vi": pools["veg_vi"].append(meal)
                else: pools["veg_en"].append(meal)
            else:
                if meal.language == "vi": pools["meat_vi"].append(meal)
                else: pools["meat_en"].append(meal)

    # 4. Get favorite meal IDs for boost
    fav_result = await session.execute(select(FavoriteMeal.meal_id))
    fav_ids = {row[0] for row in fav_result.fetchall()}

    # Boost logic: favorites get 1.3x weight (represented by adding more copies)
    def _apply_weights(pool):
        weighted = []
        for meal in pool:
            # Base weight 10, favorite gets 13
            weight = 13 if meal.id in fav_ids else 10
            weighted.extend([meal] * weight)
        return weighted

    for key in pools:
        pools[key] = _apply_weights(pools[key])
        
    return pools, fav_ids, safe_meals_count, len(all_meals)


def _pick_meal(pool: list, used_ids: set, fav_ids: set):
    """Pick a meal from the weighted pool, preferring unused meals."""
    if not pool:
        return None
    random.shuffle(pool)
    # Try to find unused meal first
    for meal in pool:
        if meal.id not in used_ids:
            used_ids.add(meal.id)
            return meal
    # All used — allow reuse
    return random.choice(pool)


def _get_pool(vi_pool, en_pool, bias=0.8):
    if random.random() < bias and vi_pool:
        return vi_pool
    return en_pool if en_pool else vi_pool


def _meal_dict(meal, fav_ids: set) -> dict:
    if not meal:
        return None
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
        "ingredient_count": len(meal.ingredients) if meal.ingredients else 0,
        "language": meal.language or "en",
        "has_avoid_food": meal.has_avoid_food or False,
        "is_favorite": meal.id in fav_ids,
        "ingredients": [{"id": i.id, "name": i.name, "quantity": i.quantity} for i in (meal.ingredients or [])],
    }


@router.post("/generate")
async def generate_meal_plan(start_date: str, session: AsyncSession = Depends(get_session)):
    """Generate a weekly meal plan from the Meal Library and persist to DB."""
    
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        
    # Generate the 7 dates
    week_dates = [(start_dt + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]

    # 1. Delete existing plan for this week
    await session.execute(
        delete(PlannedMeal).where(PlannedMeal.date.in_(week_dates))
    )

    pools, fav_ids, safe_count, total_count = await _get_meal_pools(session)
    used_ids = set()
    
    new_planned_meals = []

    for i, day in enumerate(DAYS):
        current_date = week_dates[i]
        
        # Breakfast: 1 slot (60% bias)
        breakfast = _pick_meal(_get_pool(pools["breakfast_vi"], pools["breakfast_en"], bias=0.6), used_ids, fav_ids)
        if breakfast:
            new_planned_meals.append(PlannedMeal(date=current_date, meal_type="breakfast_0", meal_id=breakfast.id))

        # Lunch: 3 slots [Soup, Veg, Meat] (80% bias)
        lunch_0 = _pick_meal(_get_pool(pools["meat_vi"], pools["meat_en"], bias=0.8), used_ids, fav_ids)
        if lunch_0: new_planned_meals.append(PlannedMeal(date=current_date, meal_type="lunch_0", meal_id=lunch_0.id))
        
        lunch_1 = _pick_meal(_get_pool(pools["veg_vi"], pools["veg_en"], bias=0.8), used_ids, fav_ids)
        if lunch_1: new_planned_meals.append(PlannedMeal(date=current_date, meal_type="lunch_1", meal_id=lunch_1.id))
        
        lunch_2 = _pick_meal(_get_pool(pools["soup_vi"], pools["soup_en"], bias=0.8), used_ids, fav_ids)
        if lunch_2: new_planned_meals.append(PlannedMeal(date=current_date, meal_type="lunch_2", meal_id=lunch_2.id))

        # Dinner: 3 slots [Soup, Veg, Meat]
        dinner_0 = _pick_meal(_get_pool(pools["meat_vi"], pools["meat_en"]), used_ids, fav_ids)
        if dinner_0: new_planned_meals.append(PlannedMeal(date=current_date, meal_type="dinner_0", meal_id=dinner_0.id))
        
        dinner_1 = _pick_meal(_get_pool(pools["veg_vi"], pools["veg_en"]), used_ids, fav_ids)
        if dinner_1: new_planned_meals.append(PlannedMeal(date=current_date, meal_type="dinner_1", meal_id=dinner_1.id))
        
        dinner_2 = _pick_meal(_get_pool(pools["soup_vi"], pools["soup_en"]), used_ids, fav_ids)
        if dinner_2: new_planned_meals.append(PlannedMeal(date=current_date, meal_type="dinner_2", meal_id=dinner_2.id))

    session.add_all(new_planned_meals)
    await session.commit()
    
    return {"status": "success", "message": "Meal plan generated and saved."}


@router.get("/week/{start_date}")
async def get_weekly_plan(start_date: str, session: AsyncSession = Depends(get_session)):
    """Retrieve the persisted meal plan for the given week."""
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        
    week_dates = [(start_dt + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
    
    # Fetch planned meals with their meal data
    result = await session.execute(
        select(PlannedMeal).where(PlannedMeal.date.in_(week_dates)).options(selectinload(PlannedMeal.meal).selectinload(Meal.ingredients))
    )
    planned_meals = result.scalars().all()
    
    fav_result = await session.execute(select(FavoriteMeal.meal_id))
    fav_ids = {row[0] for row in fav_result.fetchall()}
    
    slots = []
    
    # Reconstruct slots structure
    for i, current_date in enumerate(week_dates):
        day_name = DAYS[i]
        
        day_meals = [pm for pm in planned_meals if pm.date == current_date]
        
        for meal_type_idx in ["breakfast_0", "lunch_0", "lunch_1", "lunch_2", "dinner_0", "dinner_1", "dinner_2"]:
            parts = meal_type_idx.split("_")
            base_type = parts[0]
            slot_idx = int(parts[1])
            
            pm = next((p for p in day_meals if p.meal_type == meal_type_idx), None)
            
            slots.append({
                "day": day_name,
                "date": current_date,
                "meal_type": base_type,
                "slot_index": slot_idx,
                "meal": _meal_dict(pm.meal, fav_ids) if pm else None
            })
            
    return {"slots": slots}


@router.post("/refresh")
async def refresh_single_meal(date: str, meal_type: str, session: AsyncSession = Depends(get_session)):
    """Refresh a single specific meal slot for a date."""
    pools, fav_ids, _, _ = await _get_meal_pools(session)
    
    # Get current planned meal
    result = await session.execute(
        select(PlannedMeal).where(PlannedMeal.date == date, PlannedMeal.meal_type == meal_type)
    )
    current_pm = result.scalar_one_or_none()
    
    # Determine the pool based on meal_type
    pool_choice = []
    if meal_type == "breakfast_0":
        pool_choice = _get_pool(pools["breakfast_vi"], pools["breakfast_en"], bias=0.6)
    elif meal_type in ["lunch_0", "dinner_0"]:
        pool_choice = _get_pool(pools["meat_vi"], pools["meat_en"], bias=0.8)
    elif meal_type in ["lunch_1", "dinner_1"]:
        pool_choice = _get_pool(pools["veg_vi"], pools["veg_en"], bias=0.8)
    elif meal_type in ["lunch_2", "dinner_2"]:
        pool_choice = _get_pool(pools["soup_vi"], pools["soup_en"], bias=0.8)
        
    if not pool_choice:
        raise HTTPException(status_code=404, detail="No suitable meals found to refresh.")
        
    # Exclude current meal only if it still exists (to allow refreshing deleted placeholders)
    if current_pm:
        # Check if the meal actually exists in the database
        meal_exists_result = await session.execute(select(Meal).where(Meal.id == current_pm.meal_id))
        meal_exists = meal_exists_result.scalar_one_or_none() is not None
        
        if meal_exists:
            pool_choice = [m for m in pool_choice if m.id != current_pm.meal_id]
            
        if not pool_choice: # Fallback if only 1 meal exists in pool
            # Try a generic pool or just allow current if it's the only one
            pool_choice = pools.get("breakfast_en") or pools.get("meat_en") or []
            
    if not pool_choice:
         raise HTTPException(status_code=404, detail="No alternative meals found to refresh.")

    new_meal = random.choice(pool_choice)
    
    if current_pm:
        current_pm.meal_id = new_meal.id
    else:
        current_pm = PlannedMeal(date=date, meal_type=meal_type, meal_id=new_meal.id)
        session.add(current_pm)
        
    await session.commit()
    
    # Return updated meal
    updated_result = await session.execute(
        select(Meal).where(Meal.id == new_meal.id).options(selectinload(Meal.ingredients))
    )
    updated_meal = updated_result.scalar_one_or_none()
    
    return {"status": "success", "meal": _meal_dict(updated_meal, fav_ids)}
    

@router.post("/cleanup")
async def cleanup_old_plans(session: AsyncSession = Depends(get_session)):
    """Remove planned meals outside the ±3 week range from current date."""
    now = datetime.now()
    # Current week start (Monday)
    current_week_start = now - timedelta(days=now.weekday())
    current_week_start = current_week_start.replace(hour=0, minute=0, second=0, microsecond=0)
    
    start_range = (current_week_start - timedelta(weeks=3)).strftime("%Y-%m-%d")
    end_range = (current_week_start + timedelta(weeks=4)).strftime("%Y-%m-%d") # +3 weeks means 4 weeks of range including current
    
    # Actually, the user said "+-3 weeks", so total 7 weeks.
    # From current week's Monday - 3 weeks to current week's Monday + 3 weeks + 6 days.
    
    # Let's be precise:
    # Visible range: [W-3, W-2, W-1, W, W+1, W+2, W+3]
    # start_range = current_week_start - 3 weeks
    # end_range = current_week_start + 4 weeks (exclusive)
    
    await session.execute(
        delete(PlannedMeal).where(
            (PlannedMeal.date < start_range) | (PlannedMeal.date >= end_range)
        )
    )
    await session.commit()
    return {"status": "success", "message": "Cleaned up planned meals outside range."}

