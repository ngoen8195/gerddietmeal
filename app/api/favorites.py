"""Favorites API endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.core.database import get_session
from app.models.models import FavoriteMeal, Meal
from app.schemas.schemas import MealOut

router = APIRouter(prefix="/api/favorites", tags=["favorites"])


@router.get("/", response_model=list[MealOut])
async def list_favorites(session: AsyncSession = Depends(get_session)):
    """List all favorited meals."""
    result = await session.execute(
        select(FavoriteMeal)
        .options(selectinload(FavoriteMeal.meal).selectinload(Meal.ingredients))
        .order_by(FavoriteMeal.created_at.desc())
    )
    favs = result.scalars().all()
    fav_ids = {f.meal_id for f in favs}
    out = []
    for f in favs:
        if f.meal:
            out.append({
                "id": f.meal.id,
                "name": f.meal.name,
                "description": f.meal.description or "",
                "image_url": f.meal.image_url or "",
                "source_url": f.meal.source_url or "",
                "source_site": f.meal.source_site or "",
                "calories": f.meal.calories or 0,
                "cook_time_hours": f.meal.cook_time_hours or 0,
                "ingredient_count": len(f.meal.ingredients) if f.meal.ingredients else 0,
                "language": f.meal.language or "en",
                "has_avoid_food": f.meal.has_avoid_food or False,
                "is_favorite": True,
                "calories_incomplete": f.meal.calories_incomplete or False,
                "ingredients": [{"id": i.id, "name": i.name, "quantity": i.quantity} for i in (f.meal.ingredients or [])],
                "created_at": f.meal.created_at,
            })
    return out


@router.post("/{meal_id}", status_code=201)
async def add_favorite(meal_id: int, session: AsyncSession = Depends(get_session)):
    """Add a meal to favorites."""
    # Check meal exists
    meal_check = await session.execute(select(Meal).where(Meal.id == meal_id))
    if not meal_check.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Meal not found")

    # Check not already favorited
    existing = await session.execute(
        select(FavoriteMeal).where(FavoriteMeal.meal_id == meal_id)
    )
    if existing.scalar_one_or_none():
        return {"message": "Already favorited", "meal_id": meal_id}

    fav = FavoriteMeal(meal_id=meal_id)
    session.add(fav)
    await session.commit()
    return {"message": "Added to favorites", "meal_id": meal_id}


@router.delete("/{meal_id}", status_code=204)
async def remove_favorite(meal_id: int, session: AsyncSession = Depends(get_session)):
    """Remove a meal from favorites."""
    result = await session.execute(
        select(FavoriteMeal).where(FavoriteMeal.meal_id == meal_id)
    )
    fav = result.scalar_one_or_none()
    if not fav:
        raise HTTPException(status_code=404, detail="Not in favorites")
    await session.delete(fav)
    await session.commit()
