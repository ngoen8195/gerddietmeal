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
    session: AsyncSession = Depends(get_session)
):
    """List favorited meals with pagination."""
    try:
        # Base query to count
        count_stmt = select(func.count()).select_from(FavoriteMeal)
        total = await session.scalar(count_stmt) or 0
        
        # Query with pagination and relations
        stmt = (
            select(FavoriteMeal)
            .options(selectinload(FavoriteMeal.meal).selectinload(Meal.ingredients))
            .order_by(FavoriteMeal.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        
        result = await session.execute(stmt)
        favs = result.scalars().all()
        
        # Format
        fav_ids = {f.meal_id for f in favs}
        avoid_names = await get_avoid_food_names(session)
        
        items = []
        for f in favs:
            if f.meal:
                items.append(format_meal_out(f.meal, fav_ids, avoid_names))
            else:
                logger.warning(f"LIST_FAVORITES: FavoriteMeal {f.id} has no associated meal (meal_id: {f.meal_id})")
                
        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": math.ceil(total / page_size) if page_size > 0 else 1
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
