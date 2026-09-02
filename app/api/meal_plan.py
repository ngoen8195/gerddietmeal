"""Meal Plan generation API — the core intelligence of the app.

Business Rules:
- Generates a Mon→Sun plan using user-configured slot layouts.
- Only includes meals whose ingredients are NOT in the "avoid" food list.
- Favorites get higher probability of appearing (configurable).
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
from app.api.config import get_home_config

from app.api.utils import get_avoid_food_names, get_remedy_food_names, format_meal_out, check_ingredient_avoid, check_ingredient_remedy

router = APIRouter(prefix="/api/meal-plan", tags=["meal-plan"])

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

async def _get_meal_pools(session: AsyncSession, config: dict):
    # 1. Get avoid & remedy food names
    avoid_result = await session.execute(
        select(Food.name).where(Food.reflux == "avoid")
    )
    avoid_names = {row[0].lower() for row in avoid_result.fetchall()}

    remedy_result = await session.execute(
        select(Food.name).where(Food.reflux == "remedy")
    )
    remedy_names = {row[0].lower() for row in remedy_result.fetchall()}

    # 2. Get favorite meal IDs for bypass and boost
    fav_result = await session.execute(select(FavoriteMeal.meal_id))
    fav_ids = {row[0] for row in fav_result.fetchall()}

    # 3. Get all meals with ingredients
    meals_result = await session.execute(
        select(Meal).options(selectinload(Meal.ingredients))
    )
    all_meals = meals_result.unique().scalars().all()

    # 4. Filter safe meals and split into pools based on config
    pools = {"none": []}
    cat_keywords = config.get("categories", {})
    for cat in cat_keywords.keys():
        pools[f"{cat}_vi"] = []
        pools[f"{cat}_en"] = []
    
    avoid_threshold = config.get("avoid_threshold_percent", 25) / 100.0
    
    safe_meals_count = 0
    meal_remedy_map = {}

    for meal in all_meals:
        ingredient_names = [ing.name.lower() for ing in meal.ingredients]
        total_ingredients = len(ingredient_names)

        if total_ingredients == 0:
            continue

        avoid_count = sum(
            1 for ing_name in ingredient_names
            if check_ingredient_avoid(ing_name, avoid_names)
        )

        avoid_proportion = avoid_count / total_ingredients

        # Rule: Only allow meals with <= avoid_threshold, UNLESS it is a favorite
        if avoid_proportion > avoid_threshold and meal.id not in fav_ids:
            continue   
            
        safe_meals_count += 1
        name_lower = meal.name.lower()
        
        # Check if meal contains any remedy ingredients
        has_remedy = any(
            check_ingredient_remedy(ing_name, remedy_names)
            for ing_name in ingredient_names
        )
        meal_remedy_map[meal.id] = has_remedy

        # Determine categories this meal matches
        matched_categories = []
        for cat, kws in cat_keywords.items():
            if any(any(kw in ing for kw in kws) for ing in ingredient_names) or any(kw in name_lower for kw in kws):
                matched_categories.append(cat)

        # Assign to pools
        for cat in matched_categories:
            if meal.language == "vi":
                pools[f"{cat}_vi"].append(meal)
            else:
                pools[f"{cat}_en"].append(meal)
                
        # Also always put in the "none" pool (general pool)
        pools["none"].append(meal)

    # 5. Boost logic
    favorite_boost = config.get("favorite_boost_weight", 1.3)
    remedy_boost = config.get("remedy_boost_weight", 1.3)
    
    def _apply_weights(pool):
        weighted = []
        for meal in pool:
            multiplier = 1.0
            if meal.id in fav_ids:
                multiplier *= favorite_boost
            if meal_remedy_map.get(meal.id, False):
                multiplier *= remedy_boost
            weight = max(1, int(round(10 * multiplier)))
            weighted.extend([meal] * weight)
        return weighted

    for key in pools:
        pools[key] = _apply_weights(pools[key])
        
    return pools, fav_ids, safe_meals_count, len(all_meals)

def _filter_pool_by_slot(pool, slot_id, config):
    inc_kws = config.get("slot_include_keywords", {}).get(slot_id, [])
    exc_kws = config.get("slot_exclude_keywords", {}).get(slot_id, [])
    allowed_types = config.get("slot_meal_types", {}).get(slot_id, [])
    
    filtered = []
    for meal in pool:
        # Meal type check
        m_types = [t.strip() for t in (meal.meal_type or "none").split(",")] if meal.meal_type else ["none"]
        
        if allowed_types and not any(t in allowed_types for t in m_types):
            continue
            
        name_lower = meal.name.lower()
        ing_names = [i.name.lower() for i in meal.ingredients]
        
        # Include check
        if inc_kws:
            if not any(kw in name_lower or any(kw in ing for ing in ing_names) for kw in inc_kws):
                continue
        
        # Exclude check
        if exc_kws:
            if any(kw in name_lower or any(kw in ing for ing in ing_names) for kw in exc_kws):
                continue
                
        filtered.append(meal)
    return filtered

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


@router.post("/generate")
async def generate_meal_plan(start_date: str, session: AsyncSession = Depends(get_session)):
    """Generate a weekly meal plan from the Meal Library and persist to DB."""
    import traceback
    try:
        try:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
            
        config = await get_home_config(session)
        week_dates = [(start_dt + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]

        # 1. Delete existing plan for this week
        await session.execute(
            delete(PlannedMeal).where(PlannedMeal.date.in_(week_dates))
        )

        pools, fav_ids, safe_count, total_count = await _get_meal_pools(session, config)
        used_ids = set()
        new_planned_meals = []

        # Get config variables
        slots_config = {
            "breakfast": config.get("slot_count_breakfast", 1),
            "lunch": config.get("slot_count_lunch", 3),
            "dinner": config.get("slot_count_dinner", 3)
        }
        pool_assignments = config.get("slot_pool_assignments", {})
        bias = {
            "breakfast": config.get("vi_language_bias_breakfast", 0.6),
            "lunch": config.get("vi_language_bias_lunch", 0.8),
            "dinner": config.get("vi_language_bias_dinner", 0.8)
        }

        for i, day in enumerate(DAYS):
            current_date = week_dates[i]
            
            for meal_cat in ["breakfast", "lunch", "dinner"]:
                count = slots_config[meal_cat]
                for slot_idx in range(count):
                    slot_id = f"{meal_cat}_{slot_idx}"
                    assigned_pools = pool_assignments.get(slot_id, ["none"])
                    
                    # Combine assigned pools
                    combined_vi = []
                    combined_en = []
                    if not assigned_pools or assigned_pools == ["none"]:
                        combined_vi.extend([m for m in pools["none"] if m.language == "vi"])
                        combined_en.extend([m for m in pools["none"] if m.language != "vi"])
                    else:
                        for p in assigned_pools:
                            if p == "none":
                                combined_vi.extend([m for m in pools["none"] if m.language == "vi"])
                                combined_en.extend([m for m in pools["none"] if m.language != "vi"])
                            else:
                                combined_vi.extend(pools.get(f"{p}_vi", []))
                                combined_en.extend(pools.get(f"{p}_en", []))
                    
                    filtered_vi = _filter_pool_by_slot(combined_vi, slot_id, config)
                    filtered_en = _filter_pool_by_slot(combined_en, slot_id, config)
                    
                    final_pool = _get_pool(filtered_vi, filtered_en, bias=bias[meal_cat])
                    
                    # Fallback to general pool if empty after filters
                    if not final_pool:
                        fallback_vi = _filter_pool_by_slot([m for m in pools["none"] if m.language == "vi"], slot_id, config)
                        fallback_en = _filter_pool_by_slot([m for m in pools["none"] if m.language != "vi"], slot_id, config)
                        final_pool = _get_pool(fallback_vi, fallback_en, bias=bias[meal_cat])
                        
                    picked = _pick_meal(final_pool, used_ids, fav_ids)
                    if picked:
                        new_planned_meals.append(PlannedMeal(date=current_date, meal_type=slot_id, meal_id=picked.id))

        session.add_all(new_planned_meals)
        await session.commit()
        
        return {"status": "success", "message": "Meal plan generated and saved."}
    except Exception as e:
        return {"status": "error", "message": str(e), "traceback": traceback.format_exc()}


@router.get("/week/{start_date}")
async def get_weekly_plan(start_date: str, session: AsyncSession = Depends(get_session)):
    """Retrieve the persisted meal plan for the given week."""
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
        
    config = await get_home_config(session)
    week_dates = [(start_dt + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
    
    # Fetch planned meals with their meal data
    result = await session.execute(
        select(PlannedMeal).where(PlannedMeal.date.in_(week_dates)).options(selectinload(PlannedMeal.meal).selectinload(Meal.ingredients))
    )
    planned_meals = result.scalars().all()
    
    fav_result = await session.execute(select(FavoriteMeal.meal_id))
    fav_ids = {row[0] for row in fav_result.fetchall()}
    avoid_names = await get_avoid_food_names(session)
    
    slots = []
    
    slots_config = {
        "breakfast": config.get("slot_count_breakfast", 1),
        "lunch": config.get("slot_count_lunch", 3),
        "dinner": config.get("slot_count_dinner", 3)
    }
    
    # Generate expected slots
    expected_slots = []
    for cat, count in slots_config.items():
        for i in range(count):
            expected_slots.append(f"{cat}_{i}")
    
    # Reconstruct slots structure
    for i, current_date in enumerate(week_dates):
        day_name = DAYS[i]
        
        day_meals = [pm for pm in planned_meals if pm.date == current_date]
        
        for meal_type_idx in expected_slots:
            parts = meal_type_idx.split("_")
            base_type = parts[0]
            slot_idx = int(parts[1])
            
            pm = next((p for p in day_meals if p.meal_type == meal_type_idx), None)
            
            slots.append({
                "day": day_name,
                "date": current_date,
                "meal_type": base_type,
                "slot_index": slot_idx,
                "meal": format_meal_out(pm.meal, fav_ids, avoid_names) if pm and pm.meal else None
            })
            
    return {"slots": slots}


@router.post("/refresh")
async def refresh_single_meal(date: str, meal_type: str, session: AsyncSession = Depends(get_session)):
    """Refresh a single specific meal slot for a date."""
    config = await get_home_config(session)
    pools, fav_ids, _, _ = await _get_meal_pools(session, config)
    
    # Get current planned meal
    result = await session.execute(
        select(PlannedMeal).where(PlannedMeal.date == date, PlannedMeal.meal_type == meal_type)
    )
    current_pm = result.scalar_one_or_none()
    
    # Determine the pool based on config
    base_type = meal_type.split("_")[0]
    assigned_pools = config.get("slot_pool_assignments", {}).get(meal_type, ["none"])
    bias_map = {
        "breakfast": config.get("vi_language_bias_breakfast", 0.6),
        "lunch": config.get("vi_language_bias_lunch", 0.8),
        "dinner": config.get("vi_language_bias_dinner", 0.8)
    }
    
    combined_vi = []
    combined_en = []
    if not assigned_pools or assigned_pools == ["none"]:
        combined_vi.extend([m for m in pools["none"] if m.language == "vi"])
        combined_en.extend([m for m in pools["none"] if m.language != "vi"])
    else:
        for p in assigned_pools:
            if p == "none":
                combined_vi.extend([m for m in pools["none"] if m.language == "vi"])
                combined_en.extend([m for m in pools["none"] if m.language != "vi"])
            else:
                combined_vi.extend(pools.get(f"{p}_vi", []))
                combined_en.extend(pools.get(f"{p}_en", []))
            
    filtered_vi = _filter_pool_by_slot(combined_vi, meal_type, config)
    filtered_en = _filter_pool_by_slot(combined_en, meal_type, config)
    
    pool_choice = _get_pool(filtered_vi, filtered_en, bias=bias_map.get(base_type, 0.8))
        
    if not pool_choice:
        # Fallback to none pool
        fallback_vi = _filter_pool_by_slot([m for m in pools["none"] if m.language == "vi"], meal_type, config)
        fallback_en = _filter_pool_by_slot([m for m in pools["none"] if m.language != "vi"], meal_type, config)
        pool_choice = _get_pool(fallback_vi, fallback_en, bias=bias_map.get(base_type, 0.8))
        
    # Exclude current meal only if it still exists
    if current_pm:
        meal_exists_result = await session.execute(select(Meal).where(Meal.id == current_pm.meal_id))
        meal_exists = meal_exists_result.scalar_one_or_none() is not None
        
        if meal_exists:
            pool_choice = [m for m in pool_choice if m.id != current_pm.meal_id]
            
        if not pool_choice: # Fallback if only 1 meal exists in pool
            pool_choice = pools.get("none") or []
            
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
    avoid_names = await get_avoid_food_names(session)
    return {"status": "success", "meal": format_meal_out(updated_meal, fav_ids, avoid_names)}


@router.post("/cleanup")
async def cleanup_old_plans(session: AsyncSession = Depends(get_session)):
    """Remove planned meals outside the ±3 week range from current date."""
    now = datetime.now()
    current_week_start = now - timedelta(days=now.weekday())
    current_week_start = current_week_start.replace(hour=0, minute=0, second=0, microsecond=0)
    
    start_range = (current_week_start - timedelta(weeks=3)).strftime("%Y-%m-%d")
    end_range = (current_week_start + timedelta(weeks=4)).strftime("%Y-%m-%d")
    
    await session.execute(
        delete(PlannedMeal).where(
            (PlannedMeal.date < start_range) | (PlannedMeal.date >= end_range)
        )
    )
    await session.commit()
    return {"status": "success", "message": "Cleaned up planned meals outside range."}


@router.post("/replace-specific")
async def replace_specific_meal(date: str, meal_type: str, meal_id: int, session: AsyncSession = Depends(get_session)):
    """Replace a single specific meal slot with a chosen meal ID."""
    meal_result = await session.execute(select(Meal).where(Meal.id == meal_id))
    meal = meal_result.scalar_one_or_none()
    if not meal:
        raise HTTPException(status_code=404, detail="Meal not found.")
        
    result = await session.execute(
        select(PlannedMeal).where(PlannedMeal.date == date, PlannedMeal.meal_type == meal_type)
    )
    current_pm = result.scalar_one_or_none()
    
    if current_pm:
        current_pm.meal_id = meal_id
    else:
        current_pm = PlannedMeal(date=date, meal_type=meal_type, meal_id=meal_id)
        session.add(current_pm)
        
    await session.commit()
    return {"status": "success"}
