"""Meal Library API endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from app.core.database import get_session
from app.models.models import Meal, MealIngredient, FavoriteMeal
from app.schemas.schemas import MealOut, MealCreate, MealUpdate

router = APIRouter(prefix="/api/meals", tags=["meals"])


def _meal_to_out(meal: Meal, fav_ids: set = None) -> dict:
    """Convert a Meal ORM object to a MealOut-compatible dict."""
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
        "is_favorite": meal.id in (fav_ids or set()),
        "ingredients": [
            {
                "id": i.id, 
                "name": i.name, 
                "quantity": i.quantity, 
                "unit": i.unit, 
                "comment": i.comment,
                "metric_weight_grams": i.metric_weight_grams or 0.0,
                "fdc_id": i.fdc_id
            } for i in (meal.ingredients or [])
        ],
        "created_at": meal.created_at,
    }


@router.get("/", response_model=list[MealOut])
async def list_meals(
    search: str = None,
    limit: int = 100,
    offset: int = 0,
    session: AsyncSession = Depends(get_session),
):
    """List meals with optional search by name/ingredient."""
    # Get favorite IDs
    fav_result = await session.execute(select(FavoriteMeal.meal_id))
    fav_ids = {row[0] for row in fav_result.fetchall()}

    stmt = select(Meal).options(selectinload(Meal.ingredients)).order_by(Meal.created_at.desc())
    if search:
        # Search by meal name or ingredient name
        stmt = stmt.outerjoin(MealIngredient).where(
            Meal.name.ilike(f"%{search}%") | MealIngredient.name.ilike(f"%{search}%")
        ).distinct()
    stmt = stmt.limit(limit).offset(offset)
    result = await session.execute(stmt)
    meals = result.unique().scalars().all()
    return [_meal_to_out(m, fav_ids) for m in meals]


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
    return _meal_to_out(meal, fav_ids)


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
    return _meal_to_out(result.scalar_one())


@router.put("/{meal_id}", response_model=MealOut)
async def update_meal(meal_id: int, meal_data: MealUpdate, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(Meal).options(selectinload(Meal.ingredients)).where(Meal.id == meal_id)
    )
    db_meal = result.scalar_one_or_none()
    if not db_meal:
        raise HTTPException(status_code=404, detail="Meal not found")

    for key, value in meal_data.model_dump(exclude_unset=True, exclude={"ingredients"}).items():
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
    return _meal_to_out(result.scalar_one())


@router.delete("/{meal_id}", status_code=204)
async def delete_meal(meal_id: int, session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Meal).where(Meal.id == meal_id))
    db_meal = result.scalar_one_or_none()
    if not db_meal:
        raise HTTPException(status_code=404, detail="Meal not found")
    await session.delete(db_meal)
    await session.commit()
