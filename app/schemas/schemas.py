"""Pydantic schemas for request/response validation."""
from __future__ import annotations
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


# ─── Food Schemas ──────────────────────────────────────────
class FoodOut(BaseModel):
    id: int
    name: str
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

    class Config:
        from_attributes = True


class IngredientIn(BaseModel):
    name: str = Field(..., min_length=1)
    quantity: str = ""
    unit: str = ""
    comment: str = ""


class MealOut(BaseModel):
    id: int
    name: str
    description: str = ""
    image_url: str = ""
    source_url: str = ""
    source_site: str = ""
    calories: float = 0
    cook_time_hours: float = 0
    ingredient_count: int = 0
    language: str = "en"
    has_avoid_food: bool = False
    is_favorite: bool = False
    calories_incomplete: bool = False
    ingredients: list[IngredientOut] = []
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class MealCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=300)
    description: str = ""
    image_url: str = ""
    source_url: str = ""
    source_site: str = ""
    calories: float = 0
    cook_time_hours: float = 0
    language: str = "en"
    ingredients: list[IngredientIn] = []


class MealUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    source_url: Optional[str] = None
    calories: Optional[float] = None
    cook_time_hours: Optional[float] = None
    ingredients: Optional[list[IngredientIn]] = None


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
