"""SQLAlchemy models for the GERD Diet Meal Planner (SA 1.4 compatible)."""
from sqlalchemy import Column, Integer, String, Text, Float, Boolean, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
from app.core.database import Base


class Food(Base):
    """Food Library: Safe/Avoid items from acid_reflux_repo.json + user additions."""
    __tablename__ = "foods"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False, index=True)
    name_vi = Column(String(200), nullable=True, index=True)
    reflux = Column(String(20), nullable=False, default="ok")
    category = Column(String(100), nullable=False, default="Uncategorized")
    is_user_added = Column(Boolean, default=False)
    meal_type = Column(String(20), nullable=False, default="none")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class Meal(Base):
    """Meal Library: scraped + user-added meals."""
    __tablename__ = "meals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(300), nullable=False, index=True)
    description = Column(Text, default="")
    image_url = Column(Text, default="")
    source_url = Column(Text, default="")
    source_site = Column(String(100), default="")
    calories = Column(Float, default=0.0)
    cook_time_hours = Column(Float, default=0.0)
    servings = Column(String(50), default="")
    language = Column(String(10), default="en")
    meal_type = Column(String(200), default="none")
    has_avoid_food = Column(Boolean, default=False)
    calories_incomplete = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    ingredients = relationship("MealIngredient", back_populates="meal", cascade="all, delete-orphan")


class MealIngredient(Base):
    """Ingredients for each meal."""
    __tablename__ = "meal_ingredients"

    id = Column(Integer, primary_key=True, autoincrement=True)
    meal_id = Column(Integer, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(200), nullable=False)
    quantity = Column(String(100), default="")
    unit = Column(String(100), default="")
    comment = Column(Text, default="")
    metric_weight_grams = Column(Float, default=0.0)
    fdc_id = Column(Integer, nullable=True)
    fdc_name = Column(String(500), nullable=True)
    calories = Column(Float, default=0.0)
    calories_incomplete = Column(Boolean, default=False)

    meal = relationship("Meal", back_populates="ingredients")


class FavoriteMeal(Base):
    """User's favorite meals."""
    __tablename__ = "favorite_meals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    meal_id = Column(Integer, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False, unique=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    meal = relationship("Meal")


class CalorieEntry(Base):
    """Cached calorie data from FDC USDA API."""
    __tablename__ = "calorie_entries"

    id = Column(Integer, primary_key=True, autoincrement=True)
    fdc_id = Column(Integer, unique=True, index=True)
    description = Column(String(500), nullable=False, index=True)
    calories = Column(Float, default=0)
    data_type = Column(String(50), default="")
    portions_json = Column(Text, nullable=True)  # Store list of {amount, unit, grams}
    fetched_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class PlannedMeal(Base):
    """Persisted meal plan assignments for specific dates."""
    __tablename__ = "planned_meals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(String(10), nullable=False, index=True)  # Format: YYYY-MM-DD
    meal_type = Column(String(50), nullable=False) # 'breakfast', 'lunch_0', 'lunch_1', 'dinner_2', etc.
    meal_id = Column(Integer, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    meal = relationship("Meal")


class SystemSetting(Base):
    """General system settings and sync timestamps."""
    __tablename__ = "system_settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

