"""Unit conversion and density handling for food ingredients."""
import re
from pint import UnitRegistry, UndefinedUnitError

# Initialize Unit Registry
ureg = UnitRegistry()

# Common food densities (g/ml)
# Standard: 1 cup = 236.588 ml
# We map ingredient keywords to density values
DENSITY_MAP = {
    "water": 1.0,
    "milk": 1.03,
    "flour": 0.53,
    "sugar": 0.85,
    "butter": 0.91,
    "oil": 0.92,
    "honey": 1.42,
    "rice": 0.85,
    "salt": 1.2,
    "pepper": 0.5,
    "egg": 1.0,  # 1 large egg is ~50g
    "chicken": 1.0, # Approximate for protein
    "beef": 1.0,
    "pork": 1.0,
    "fish": 1.0,
    "vegetable": 0.5, # Varies wildly, 0.5 is a safe average for volume
    "fruit": 0.5,
}

def get_density(ingredient_name: str) -> float:
    """Get density of an ingredient by name lookup."""
    name = ingredient_name.lower()
    for key, val in DENSITY_MAP.items():
        if key in name:
            return val
    return 1.0 # Default to density of water

def convert_to_grams(quantity: str, unit: str, ingredient_name: str = "") -> float:
    """
    Convert a quantity and unit to metric weight (grams).
    Uses density mapping for volume-to-mass conversion.
    """
    if not quantity:
        return 0.0
    
    # Clean quantity (e.g. "1 1/2" -> 1.5)
    qty_str = quantity.replace(' ', '+')
    try:
        # Use pint's expression evaluator for fractions
        qty_val = float(ureg.parse_expression(qty_str))
    except Exception:
        # Fallback for simple digits
        nums = re.findall(r"[-+]?\d*\.\d+|\d+", quantity)
        if nums:
            qty_val = float(nums[0])
        else:
            return 0.0

    if not unit:
        # If no unit, assume grams or try to detect from name (e.g. "2 eggs")
        if "egg" in ingredient_name.lower():
            return qty_val * 50.0 # Standard egg weight
        return qty_val # Default to grams if unknown

    try:
        # Standardize unit using pint
        u = ureg(unit)
        
        # Check if it's already a mass unit
        if u.check('[mass]'):
            return float((qty_val * u).to('gram').magnitude)
        
        # If it's a volume unit, use density
        if u.check('[volume]'):
            density = get_density(ingredient_name)
            # volume (ml) * density (g/ml) = mass (g)
            ml = float((qty_val * u).to('milliliter').magnitude)
            return ml * density
        
        # Handle "piece", "can", "packet" etc.
        # These are dimensionless in pint, we need custom logic
        unit_lower = unit.lower()
        if unit_lower in ['can', 'tin']:
            return qty_val * 400.0 # Average can weight
        if unit_lower in ['piece', 'slice', 'clove']:
            if 'garlic' in ingredient_name.lower(): return qty_val * 5.0
            if 'bread' in ingredient_name.lower(): return qty_val * 30.0
            return qty_val * 100.0 # High fallback
            
        return qty_val # Fallback
        
    except UndefinedUnitError:
        # Check for common units not in pint or misspelled
        unit_lower = unit.lower()
        if 'muỗng' in unit_lower: # Vietnamese units
            if 'canh' in unit_lower: return qty_val * 15.0 # 1 tbsp
            return qty_val * 5.0 # 1 tsp
        if 'bát' in unit_lower or 'chén' in unit_lower:
            return qty_val * 200.0
        
        return qty_val # Final fallback
