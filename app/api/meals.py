"""Meal Library API endpoints."""
from fastapi import APIRouter, Depends, HTTPException, File, UploadFile, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from app.core.database import get_session
from app.models.models import Meal, MealIngredient, FavoriteMeal
from app.schemas.schemas import MealOut, MealCreate, MealUpdate
import app.schemas.schemas as schemas
from typing import Optional
import os
import shutil
import uuid

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


@router.post("/upload-image")
async def upload_image(
    file: UploadFile = File(...),
    meal_id: Optional[int] = Form(None),
    previous_url: Optional[str] = Form(None),
    session: AsyncSession = Depends(get_session)
):
    """Upload meal image and clean up old local files to avoid orphan files."""
    # Ensure static/uploads exists
    upload_dir = os.path.join("static", "uploads")
    os.makedirs(upload_dir, exist_ok=True)
    
    # Check if there is an old file to delete
    # 1. Check previous_url if provided
    if previous_url and previous_url.startswith("/static/uploads/"):
        old_filename = previous_url.replace("/static/uploads/", "")
        old_file_path = os.path.join(upload_dir, old_filename)
        if os.path.exists(old_file_path):
            try:
                os.remove(old_file_path)
            except Exception as e:
                print(f"Failed to delete old image {old_file_path}: {e}")
                
    # 2. Check if meal has an existing local image in database if meal_id is provided
    if meal_id:
        result = await session.execute(select(Meal).where(Meal.id == meal_id))
        meal = result.scalar_one_or_none()
        if meal and meal.image_url and meal.image_url.startswith("/static/uploads/"):
            old_filename = meal.image_url.replace("/static/uploads/", "")
            old_file_path = os.path.join(upload_dir, old_filename)
            if os.path.exists(old_file_path):
                try:
                    os.remove(old_file_path)
                except Exception as e:
                    print(f"Failed to delete old image {old_file_path}: {e}")
    
    # Save the new file
    file_ext = os.path.splitext(file.filename)[1].lower()
    # Simple whitelist validation for images
    if file_ext not in [".jpg", ".jpeg", ".png", ".gif", ".webp"]:
        raise HTTPException(status_code=400, detail="Invalid image format. Allowed formats: JPG, JPEG, PNG, GIF, WEBP.")
        
    unique_filename = f"meal_{uuid.uuid4().hex}{file_ext}"
    dest_path = os.path.join(upload_dir, unique_filename)
    
    try:
        with open(dest_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not save file: {str(e)}")
        
    new_url = f"/static/uploads/{unique_filename}"
    return {"status": "success", "url": new_url}


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
    # Duplicate URL check
    if meal_data.source_url:
        existing = await session.execute(select(Meal).where(Meal.source_url == meal_data.source_url))
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="A recipe with this URL already exists in your library.")

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
        meal_type=meal_data.meal_type,
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

    # Keep track of old image URL to delete if it changes
    old_image_url = db_meal.image_url

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
        # Flush new ingredients into the DB identity map BEFORE committing so that
        # calculate_meal_calories reads the updated rows, not the old cached collection.
        await session.flush()

    # Clean up old image if it was local and the URL changed or is set to empty
    if old_image_url and old_image_url != db_meal.image_url and old_image_url.startswith("/static/uploads/"):
        old_filename = old_image_url.replace("/static/uploads/", "")
        old_file_path = os.path.join("static", "uploads", old_filename)
        if os.path.exists(old_file_path):
            try:
                os.remove(old_file_path)
            except Exception as e:
                print(f"Failed to delete old image {old_file_path} on update: {e}")

    await session.commit()

    # Expire all cached objects so that fresh data is retrieved
    session.expire_all()

    # Recalculate calories only if ingredients were updated
    if meal_data.ingredients is not None:
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

    # Check if there is an uploaded local image to delete
    if db_meal.image_url and db_meal.image_url.startswith("/static/uploads/"):
        old_filename = db_meal.image_url.replace("/static/uploads/", "")
        old_file_path = os.path.join("static", "uploads", old_filename)
        if os.path.exists(old_file_path):
            try:
                os.remove(old_file_path)
            except Exception as e:
                print(f"Failed to delete old image {old_file_path} on delete: {e}")

    await session.delete(db_meal)
    await session.commit()

