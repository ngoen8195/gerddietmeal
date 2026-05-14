"""Favorites API endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from app.core.database import get_session
from app.models.models import FavoriteMeal, Meal
from app.schemas.schemas import MealOut
import app.schemas.schemas as schemas
import math
import traceback

from app.api.utils import get_avoid_food_names, format_meal_out
from app.core.logger import logger

router = APIRouter(prefix="/api/favorites", tags=["favorites"])


@router.get("/", response_model=schemas.PaginatedResponse[MealOut])
async def list_favorites(
    page: int = 1,
    page_size: int = 50,
    search: str = None,
    session: AsyncSession = Depends(get_session)
):
    """List favorited meals with pagination and optional search."""
    try:
        # We want to return Meals that are in the FavoriteMeal table
        from app.models.models import MealIngredient
        
        # Base query: Start with Meal, join FavoriteMeal to filter for favorites
        stmt = (
            select(Meal)
            .join(FavoriteMeal, Meal.id == FavoriteMeal.meal_id)
            .options(selectinload(Meal.ingredients))
        )
        
        if search:
            # Search by meal name or ingredient name
            stmt = stmt.outerjoin(MealIngredient).where(
                Meal.name.ilike(f"%{search}%") | MealIngredient.name.ilike(f"%{search}%")
            ).distinct()

        # Get total count
        count_stmt = select(func.count()).select_from(stmt.subquery())
        total_result = await session.execute(count_stmt)
        total = total_result.scalar() or 0
        
        # Apply sorting (by when it was favorited) and pagination
        stmt = stmt.order_by(FavoriteMeal.created_at.desc())
        stmt = stmt.offset((page - 1) * page_size).limit(page_size)
        
        result = await session.execute(stmt)
        meals = result.unique().scalars().all()
        
        # Format for output
        # In this view, we know they are all favorited
        fav_ids = {m.id for m in meals}
        avoid_names = await get_avoid_food_names(session)
        
        items = [format_meal_out(m, fav_ids, avoid_names) for m in meals]
                
        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": math.ceil(total / page_size) if total > 0 else 1
        }
    except Exception as e:
        logger.error(f"LIST_FAVORITES ERROR: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Database or formatting error: {str(e)}")


@router.post("/{meal_id}", status_code=201)
async def add_favorite(meal_id: int, session: AsyncSession = Depends(get_session)):
    """Add a meal to favorites."""
    try:
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
    except Exception as e:
        await session.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{meal_id}", status_code=204)
async def remove_favorite(meal_id: int, session: AsyncSession = Depends(get_session)):
    """Remove a meal from favorites."""
    try:
        result = await session.execute(
            select(FavoriteMeal).where(FavoriteMeal.meal_id == meal_id)
        )
        fav = result.scalar_one_or_none()
        if not fav:
            raise HTTPException(status_code=404, detail="Not in favorites")
        await session.delete(fav)
        await session.commit()
    except Exception as e:
        await session.rollback()
        raise HTTPException(status_code=500, detail=str(e))
