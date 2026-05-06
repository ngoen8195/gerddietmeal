"""Async SQLite database manager with WAL mode for high-concurrency performance."""
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy import text

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data.db")
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

Base = declarative_base()


engine = create_async_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)

async_session_factory = sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def init_db():
    """Initialize database: create tables and set PRAGMAs."""
    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL;"))
        await conn.execute(text("PRAGMA foreign_keys=ON;"))
        from app.models.models import Food, Meal, MealIngredient, FavoriteMeal, CalorieEntry
        await conn.run_sync(Base.metadata.create_all)


async def get_session():
    """Dependency: yields an async database session."""
    async with async_session_factory() as session:
        try:
            yield session
        finally:
            await session.close()
