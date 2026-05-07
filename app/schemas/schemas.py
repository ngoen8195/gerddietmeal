"""Pydantic schemas for request/response validation."""
from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


# ─── Food Schemas ──────────────────────────────────────────
class FoodOut(BaseModel):
    id: int
    name: str
    name_vi: Optional[str] = None
    reflux: str
    category: str
    is_user_added: bool = False
    meal_type: str = "none"

    class Config:
        from_attributes = True


class FoodCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    reflux: str = Field(..., pattern="^(ok|avoid|remedy)$")
    category: str = Field(default="Uncategorized", max_length=100)
    meal_type: str = Field(default="none", pattern="^(breakfast|lunch/dinner|both|none)$")


class FoodUpdate(BaseModel):
    name: Optional[str] = None
    name_vi: Optional[str] = None
    reflux: Optional[str] = None
    category: Optional[str] = None
    meal_type: Optional[str] = None


# ─── Meal Schemas ──────────────────────────────────────────
class IngredientOut(BaseModel):
    id: int
    name: str
    quantity: str = ""
    unit: str = ""
    comment: str = ""
    metric_weight_grams: float = 0.0
    fdc_id: Optional[int] = None
    is_avoid: bool = False

    class Config:
        from_attributes = True


class IngredientIn(BaseModel):
    name: str = Field(..., min_length=1)
    quantity: str = ""
    unit: str = ""
    comment: str = ""


class MealBase(BaseModel):
    name: str
    description: Optional[str] = ""
    image_url: Optional[str] = ""
    source_url: Optional[str] = ""
    source_site: Optional[str] = ""
    calories: Optional[float] = 0.0
    cook_time_hours: Optional[float] = 0.0
    servings: Optional[str] = ""
    language: Optional[str] = "en"
    meal_type: Optional[str] = "other"
    is_favorite: Optional[bool] = False

    class Config:
        from_attributes = True


class MealCreate(MealBase):
    name: str = Field(..., min_length=1, max_length=300)
    ingredients: list[IngredientIn] = []


class MealUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    source_url: Optional[str] = None
    calories: Optional[float] = None
    cook_time_hours: Optional[float] = None
    servings: Optional[str] = None
    ingredients: Optional[list[IngredientIn]] = None


class MealOut(MealBase):
    id: int
    ingredient_count: int = 0
    has_avoid_food: bool = False
    avoid_percentage: float = 0.0
    calories_incomplete: bool = False
    ingredients: list[IngredientOut] = []
    created_at: Optional[datetime] = None


# ─── Meal Plan Schema ──────────────────────────────────────
class MealPlanRequest(BaseModel):
    """Request body for generating a weekly meal plan."""
    force_regenerate: bool = False


class MealSlot(BaseModel):
    day: str
    meal_type: str  # breakfast, lunch, dinner
    slot_index: int  # 0 for main card, 1-2 for extra (lunch/dinner)
    meal: Optional[MealOut] = None


class WeeklyPlanOut(BaseModel):
    slots: list[MealSlot] = []
    stats: dict = {}
