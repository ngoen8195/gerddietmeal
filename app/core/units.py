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

VULGAR_FRACTIONS = {
    '½': ' 1/2', '⅓': ' 1/3', '⅔': ' 2/3', '¼': ' 1/4', '¾': ' 3/4',
    '⅕': ' 1/5', '⅖': ' 2/5', '⅗': ' 3/5', '⅘': ' 4/5', '⅙': ' 1/6',
    '⅚': ' 5/6', '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8'
}

def parse_quantity(quantity: str) -> float:
    """Parse quantity string including fractions (1/2, 1.5) and unicode vulgar fractions (½, ¼)."""
    if not quantity:
        return 0.0
    s = str(quantity).strip()
    for char, repl in VULGAR_FRACTIONS.items():
        s = s.replace(char, repl)
    s = s.replace(' ', '+')
    try:
        return float(ureg.parse_expression(s))
    except Exception:
        nums = re.findall(r"(\d+(?:\.\d+)?(?:\s*/\s*\d+)?)", s)
        if nums:
            total = 0.0
            for n in nums:
                if '/' in n:
                    p = n.split('/')
                    if float(p[1]) != 0:
                        total += float(p[0]) / float(p[1])
                else:
                    total += float(n)
            return total
    return 0.0

def convert_to_grams(quantity: str, unit: str, ingredient_name: str = "") -> float:
    """
    Convert a quantity and unit to metric weight (grams).
    Uses density mapping for volume-to-mass conversion.
    """
    qty_val = parse_quantity(quantity)
    if qty_val <= 0:
        return 0.0

    result = 0.0
    if not unit:
        # If no unit, assume grams or try to detect from name (e.g. "2 eggs")
        if "egg" in ingredient_name.lower():
            result = qty_val * 50.0 # Standard egg weight
        else:
            result = qty_val # Default to grams if unknown
    else:
        unit_clean = unit.lower().strip()
        unit_singular = unit_clean.rstrip('s') if len(unit_clean) > 1 and unit_clean != 'glass' else unit_clean

        try:
            # Standardize unit using pint
            u = ureg(unit_singular)
            
            # Check if it's already a mass unit
            if u.check('[mass]'):
                result = float((qty_val * u).to('gram').magnitude)
            
            # If it's a volume unit, use density
            elif u.check('[volume]'):
                density = get_density(ingredient_name)
                # volume (ml) * density (g/ml) = mass (g)
                ml = float((qty_val * u).to('milliliter').magnitude)
                result = ml * density
            
            else:
                if unit_singular in ['can', 'tin']:
                    result = qty_val * 400.0 # Average can weight
                elif unit_singular in ['piece', 'slice', 'clove']:
                    ing_lower = ingredient_name.lower()
                    if 'garlic' in ing_lower: result = qty_val * 5.0
                    elif 'bread' in ing_lower: result = qty_val * 30.0
                    elif any(k in ing_lower for k in ['thơm', 'dứa', 'pineapple', 'dưa hấu', 'watermelon', 'bí']): result = qty_val * 500.0
                    else: result = qty_val * 100.0 # High fallback
                else:
                    result = qty_val # Fallback
                
        except UndefinedUnitError:
            # Check for common units not in pint or misspelled
            if unit_singular in ['can', 'tin']:
                result = qty_val * 400.0
            elif unit_singular in ['piece', 'slice', 'clove', 'trái', 'quả', 'củ']:
                ing_lower = ingredient_name.lower()
                if 'garlic' in ing_lower: result = qty_val * 5.0
                elif 'bread' in ing_lower: result = qty_val * 30.0
                elif any(k in ing_lower for k in ['thơm', 'dứa', 'pineapple', 'dưa hấu', 'watermelon', 'bí']): result = qty_val * 500.0
                else: result = qty_val * 100.0
            elif 'muỗng' in unit_clean: # Vietnamese units
                if 'canh' in unit_clean: result = qty_val * 15.0 # 1 tbsp
                else: result = qty_val * 5.0 # 1 tsp
            elif 'bát' in unit_clean or 'chén' in unit_clean:
                result = qty_val * 200.0
            else:
                result = qty_val # Final fallback
            
    # Final Safeguard: prevent astronomical weights (e.g. > 10kg per ingredient)
    if result > 10000:
        print(f"DEBUG: astronomical weight detected: {result}g for {quantity} {unit} {ingredient_name}")
        return 0.0
        
    return result
