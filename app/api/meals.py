"""Meal Library API endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from app.core.database import get_session
from app.models.models import Meal, MealIngredient, FavoriteMeal
from app.schemas.schemas import MealOut, MealCreate, MealUpdate
import app.schemas.schemas as schemas

from app.api.utils import get_avoid_food_names, format_meal_out

router = APIRouter(prefix="/api/meals", tags=["meals"])


import re

def _clean_servings(servings: str) -> str:
    """Extract only the numeric part of the servings string."""
    if not servings:
        return ""
    s = str(servings).strip()
    match = re.search(r'(\d+[\d\.\-]*\d*)', s)
    if match:
        return match.group(1)
    return s


@router.get("/", response_model=schemas.PaginatedResponse[MealOut])
async def list_meals(
    page: int = 1,
    page_size: int = 50,
    search: str = None,
    session: AsyncSession = Depends(get_session),
):
    """List meals with pagination and optional search by name/ingredient."""
    # Base query for meals
    stmt = select(Meal).options(selectinload(Meal.ingredients))
    
    if search:
        # Search by meal name or ingredient name
        stmt = stmt.outerjoin(MealIngredient).where(
            Meal.name.ilike(f"%{search}%") | MealIngredient.name.ilike(f"%{search}%")
        ).distinct()

    # Get total count for pagination
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total_result = await session.execute(count_stmt)
    total = total_result.scalar() or 0

    # Apply pagination and sorting
    stmt = stmt.order_by(Meal.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    
    result = await session.execute(stmt)
    meals = result.unique().scalars().all()
    
    # Format for output
    fav_result = await session.execute(select(FavoriteMeal.meal_id))
    fav_ids = {row[0] for row in fav_result.fetchall()}
    avoid_names = await get_avoid_food_names(session)
    
    items = [format_meal_out(m, fav_ids, avoid_names) for m in meals]
    
    import math
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": math.ceil(total / page_size) if total > 0 else 1
    }


@router.get("/count")
async def meal_count(session: AsyncSession = Depends(get_session)):
    """Get total meal count for hard-limit check."""
    result = await session.execute(select(func.count(Meal.id)))
    return {"count": result.scalar()}


@router.get("/{meal_id}", response_model=MealOut)
async def get_meal(meal_id: int, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(Meal).options(selectinload(Meal.ingredients)).where(Meal.id == meal_id)
    )
    meal = result.scalar_one_or_none()
    if not meal:
        raise HTTPException(status_code=404, detail="Meal not found")
    
    fav_result = await session.execute(select(FavoriteMeal.meal_id).where(FavoriteMeal.meal_id == meal_id))
    fav_ids = {row[0] for row in fav_result.fetchall()}
    avoid_names = await get_avoid_food_names(session)
    
    return format_meal_out(meal, fav_ids, avoid_names)


@router.post("/", response_model=MealOut, status_code=201)
async def create_meal(meal_data: MealCreate, session: AsyncSession = Depends(get_session)):
    """Add a new meal manually."""
    db_meal = Meal(
        name=meal_data.name,
        description=meal_data.description,
        image_url=meal_data.image_url,
        source_url=meal_data.source_url,
        source_site=meal_data.source_site or "manual",
        calories=meal_data.calories,
        cook_time_hours=meal_data.cook_time_hours,
        servings=_clean_servings(meal_data.servings),
        language=meal_data.language,
    )
    session.add(db_meal)
    await session.flush()

    for ing in meal_data.ingredients:
        session.add(MealIngredient(meal_id=db_meal.id, name=ing.name, quantity=ing.quantity, unit=ing.unit, comment=ing.comment))

    await session.commit()
    
    # Calculate calories for the new meal
    from app.api.fdc import calculate_meal_calories
    await calculate_meal_calories(db_meal.id, session)
    await session.commit()

    # Re-fetch with ingredients
    result = await session.execute(
        select(Meal).options(selectinload(Meal.ingredients)).where(Meal.id == db_meal.id)
    )
    meal = result.scalar_one()
    avoid_names = await get_avoid_food_names(session)
    return format_meal_out(meal, set(), avoid_names)


@router.put("/{meal_id}", response_model=MealOut)
async def update_meal(meal_id: int, meal_data: MealUpdate, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(Meal).options(selectinload(Meal.ingredients)).where(Meal.id == meal_id)
    )
    db_meal = result.scalar_one_or_none()
    if not db_meal:
        raise HTTPException(status_code=404, detail="Meal not found")

    for key, value in meal_data.model_dump(exclude_unset=True, exclude={"ingredients"}).items():
        if key == "servings":
            value = _clean_servings(value)
        setattr(db_meal, key, value)

    # Replace ingredients if provided
    if meal_data.ingredients is not None:
        # Delete existing
        for ing in db_meal.ingredients:
            await session.delete(ing)
        await session.flush()
        # Add new
        for ing in meal_data.ingredients:
            session.add(MealIngredient(meal_id=meal_id, name=ing.name, quantity=ing.quantity, unit=ing.unit, comment=ing.comment))

    await session.commit()
    
    # Recalculate calories after saving
    from app.api.fdc import calculate_meal_calories
    await calculate_meal_calories(meal_id, session)
    await session.commit()

    result = await session.execute(
        select(Meal).options(selectinload(Meal.ingredients)).where(Meal.id == meal_id)
    )
    meal = result.scalar_one()
    
    fav_result = await session.execute(select(FavoriteMeal.meal_id).where(FavoriteMeal.meal_id == meal_id))
    fav_ids = {row[0] for row in fav_result.fetchall()}
    avoid_names = await get_avoid_food_names(session)
    
    return format_meal_out(meal, fav_ids, avoid_names)


@router.delete("/{meal_id}", status_code=204)
async def delete_meal(meal_id: int, session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Meal).where(Meal.id == meal_id))
    db_meal = result.scalar_one_or_none()
    if not db_meal:
        raise HTTPException(status_code=404, detail="Meal not found")
    await session.delete(db_meal)
    await session.commit()

