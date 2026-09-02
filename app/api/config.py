"""Config API for Home Page Configuration."""
import json
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import Dict, Any

from app.core.database import get_session
from app.models.models import SystemSetting

router = APIRouter(prefix="/api/config", tags=["config"])

DEFAULT_CONFIG = {
    # Layout & Display
    "slot_count_breakfast": 1,
    "slot_count_lunch": 3,
    "slot_count_dinner": 3,
    "card_height_single": 420,
    "card_height_compact": 85,
    "card_gap": 10,
    "slot_card_types": {
        "breakfast_0": "full_single",
        "lunch_0": "full_multi",
        "lunch_1": "compact",
        "lunch_2": "compact",
        "dinner_0": "full_multi",
        "dinner_1": "compact",
        "dinner_2": "compact"
    },
    # Classification Keywords
    "categories": {
        "breakfast": ["breakfast", "smoothie", "yogurt", "scrambled egg", "gluten-free bread", "egg", "toast", "oatmeal", "pancake", "omelet", "bagel", "croissant", "granola", "fruit", "ham", "syrup", "pastry", "bữa sáng", "sữa chua", "sinh tố", "trứng", "bánh mì", "phở", "bún", "miến", "cháo", "xôi", "mì", "bơ", "bánh bao", "bánh cuốn", "bánh giầy", "bánh giò", "ngũ cốc", "mứt", "mật ong"],
        "meat_fish": ["meat", "beef", "pork", "chicken", "fish", "shrimp", "tofu", "egg", "steak", "ham", "sườn", "thịt", "cá", "tôm", "gà", "heo", "bò", "vịt", "đậu hũ", "trứng", "thịt kho", "cá kho", "thịt luộc", "thịt nướng"],
        "soup": ["soup", "stew", "chowder", "bisque", "bouillon", "consommé", "minestrone", "borscht", "gazpacho", "canh", "phở", "bún", "miến", "lẩu", "súp", "canh chua", "canh cá", "canh rau", "canh cải", "canh bí", "canh mướp", "canh bầu", "canh trứng"]
    },
    # Generation Logic
    "slot_pool_assignments": {
        "breakfast_0": ["breakfast"],
        "lunch_0": ["meat_fish"],
        "lunch_1": [],
        "lunch_2": ["soup"],
        "dinner_0": ["meat_fish"],
        "dinner_1": [],
        "dinner_2": ["soup"]
    },
    "slot_include_keywords": {},
    "slot_exclude_keywords": {},
    "slot_meal_types": {
        "breakfast_0": ["breakfast"],
        "lunch_0": ["lunch", "dinner"],
        "lunch_1": ["lunch", "dinner"],
        "lunch_2": ["lunch", "dinner"],
        "dinner_0": ["lunch", "dinner"],
        "dinner_1": ["lunch", "dinner"],
        "dinner_2": ["lunch", "dinner"]
    },
    "vi_language_bias_breakfast": 0.6,
    "vi_language_bias_lunch": 0.8,
    "vi_language_bias_dinner": 0.8,
    "favorite_boost_weight": 1.3,
    "remedy_boost_weight": 1.3,
    "avoid_threshold_percent": 25
}

async def get_home_config(session: AsyncSession) -> dict:
    """Fetch user config from DB and merge with DEFAULTS."""
    result = await session.execute(select(SystemSetting).where(SystemSetting.key == "home_page_config"))
    setting = result.scalar_one_or_none()
    
    config = DEFAULT_CONFIG.copy()
    if setting and setting.value:
        try:
            user_config = json.loads(setting.value)
            for k, v in user_config.items():
                # Completely overwrite values/dicts so deletions/resizing works properly
                config[k] = v
        except json.JSONDecodeError:
            pass
            
    return config

@router.get("")
@router.get("/")
async def get_config(session: AsyncSession = Depends(get_session)):
    return await get_home_config(session)

@router.put("")
@router.put("/")
async def update_config(config_data: dict, session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(SystemSetting).where(SystemSetting.key == "home_page_config"))
    setting = result.scalar_one_or_none()
    
    config_json = json.dumps(config_data)
    if setting:
        setting.value = config_json
    else:
        setting = SystemSetting(key="home_page_config", value=config_json)
        session.add(setting)
        
    await session.commit()
    return await get_home_config(session)

@router.post("/reset")
async def reset_config(session: AsyncSession = Depends(get_session)):
    await session.execute(delete(SystemSetting).where(SystemSetting.key == "home_page_config"))
    await session.commit()
    return await get_home_config(session)
