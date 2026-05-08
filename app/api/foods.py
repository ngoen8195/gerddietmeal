"""Food Library API endpoints."""
import json, os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, update
from app.core.database import get_session
from app.models.models import Food, Meal, MealIngredient
from app.schemas.schemas import FoodOut, FoodCreate, FoodUpdate, PaginatedResponse
import app.schemas.schemas as schemas
from app.api.utils import translate_food_name

router = APIRouter(prefix="/api/foods", tags=["foods"])

RESOURCES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "resources")


@router.get("/", response_model=schemas.PaginatedResponse[FoodOut])
async def list_foods(
    page: int = 1,
    page_size: int = 50,
    category: str = None,
    reflux: str = None,
    search: str = None,
    session: AsyncSession = Depends(get_session),
):
    """List foods with pagination, optionally filtered by category, reflux status, or search term."""
    stmt = select(Food)
    if category:
        stmt = stmt.where(Food.category == category)
    if reflux:
        stmt = stmt.where(Food.reflux == reflux)
    if search:
        stmt = stmt.where(Food.name.ilike(f"%{search}%") | Food.name_vi.ilike(f"%{search}%"))

    # Get total count for pagination
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total_result = await session.execute(count_stmt)
    total = total_result.scalar() or 0

    # Apply pagination and sorting
    stmt = stmt.order_by(Food.category, Food.name)
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    
    result = await session.execute(stmt)
    items = result.scalars().all()
    
    import math
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": math.ceil(total / page_size) if total > 0 else 1
    }


@router.get("/categories")
async def list_categories(session: AsyncSession = Depends(get_session)):
    """Get all unique food categories."""
    result = await session.execute(select(Food.category).distinct().order_by(Food.category))
    return result.scalars().all()


@router.post("/", response_model=FoodOut, status_code=201)
async def create_food(food: FoodCreate, session: AsyncSession = Depends(get_session)):
    """Add a new food item."""
    # Auto-translate name to Vietnamese
    name_vi = await translate_food_name(food.name, "vi")
    
    db_food = Food(
        name=food.name, 
        name_vi=name_vi,
        reflux=food.reflux, 
        category=food.category, 
        meal_type=food.meal_type,
        is_user_added=True
    )
    session.add(db_food)
    await session.commit()
    await session.refresh(db_food)

    # If adding an "avoid" food, flag existing meals that contain it
    if food.reflux == "avoid":
        await _flag_meals_with_food(session, food.name)

    return db_food


@router.put("/{food_id}", response_model=FoodOut)
async def update_food(food_id: int, food: FoodUpdate, session: AsyncSession = Depends(get_session)):
    """Update an existing food item."""
    result = await session.execute(select(Food).where(Food.id == food_id))
    db_food = result.scalar_one_or_none()
    if not db_food:
        raise HTTPException(status_code=404, detail="Food not found")

    old_reflux = db_food.reflux
    for key, value in food.model_dump(exclude_unset=True).items():
        setattr(db_food, key, value)
    await session.commit()
    await session.refresh(db_food)

    # If changed to "avoid", flag meals
    if food.reflux == "avoid" and old_reflux != "avoid":
        await _flag_meals_with_food(session, db_food.name)

    return db_food


@router.delete("/{food_id}", status_code=204)
async def delete_food(food_id: int, session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Food).where(Food.id == food_id))
    db_food = result.scalar_one_or_none()
    if not db_food:
        raise HTTPException(status_code=404, detail="Food not found")
    await session.delete(db_food)
    await session.commit()


@router.post("/seed", status_code=200)
async def seed_foods(session: AsyncSession = Depends(get_session)):
    """Seed the Food Library from acid_reflux_repo.json (idempotent)."""
    count = await session.execute(select(func.count(Food.id)))
    if count.scalar() > 0:
        return {"message": "Foods already seeded", "seeded": False}

    json_path = os.path.join(RESOURCES_DIR, "acid_reflux_repo.json")
    with open(json_path, "r", encoding="utf-8") as f:
        foods_data = json.load(f)

    for item in foods_data:
        reflux = item.get("reflux", "ok").lower()
        if reflux == "aviod":  # fix typo in source data
            reflux = "avoid"
        db_food = Food(
            name=item["name"],
            reflux=reflux,
            category=item.get("category", "Uncategorized"),
        )
        session.add(db_food)

    await session.commit()
    return {"message": f"Seeded {len(foods_data)} foods", "seeded": True}


@router.post("/translate-missing")
async def translate_missing_names(session: AsyncSession = Depends(get_session)):
    """Find all foods without a Vietnamese name and translate them."""
    stmt = select(Food).where(Food.name_vi == None)
    result = await session.execute(stmt)
    foods_to_translate = result.scalars().all()
    
    count = 0
    for food in foods_to_translate:
        translated = await translate_food_name(food.name, "vi")
        if translated:
            food.name_vi = translated
            count += 1
            # Commit periodically to avoid long-running transactions
            if count % 20 == 0:
                await session.commit()
    
    await session.commit()
    return {"message": f"Translated {count} food names", "count": count}


async def _flag_meals_with_food(session: AsyncSession, food_name: str):
    """Flag meals that contain a newly-avoided food."""
    food_lower = food_name.lower()
    result = await session.execute(
        select(MealIngredient.meal_id).where(
            func.lower(MealIngredient.name).contains(food_lower)
        )
    )
    meal_ids = [row[0] for row in result.fetchall()]
    if meal_ids:
        await session.execute(
            update(Meal).where(Meal.id.in_(meal_ids)).values(has_avoid_food=True)
        )
        await session.commit()
