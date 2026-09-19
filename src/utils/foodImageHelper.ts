// Curated collection of high-resolution food and beverage photography
// Sourced with stable IDs from Unsplash food & drink collection

const BEVERAGE_IMAGES = [
  'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=400&q=80', // Coffee latte art
  'https://images.unsplash.com/photo-1544787219-7f47ccb76574?auto=format&fit=crop&w=400&q=80', // Iced coffee
  'https://images.unsplash.com/photo-1556679343-c7306c1976bc?auto=format&fit=crop&w=400&q=80', // Iced tea lemon
  'https://images.unsplash.com/photo-1536935338788-846bb9981813?auto=format&fit=crop&w=400&q=80', // Fruit smoothie
  'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=400&q=80', // Cocktail / mocktail
  'https://images.unsplash.com/photo-1497534446932-c925b458314e?auto=format&fit=crop&w=400&q=80', // Orange juice
  'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&w=400&q=80', // Milk tea boba
  'https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=400&q=80', // Matcha latte
  'https://images.unsplash.com/photo-1560512823-829485b8bf24?auto=format&fit=crop&w=400&q=80', // Cold brew
  'https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?auto=format&fit=crop&w=400&q=80', // Glass of wine / drink
];

const MAIN_DISH_IMAGES = [
  'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43?auto=format&fit=crop&w=400&q=80', // Pho / Noodle soup
  'https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=400&q=80', // Ramen / Asian noodles
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=400&q=80', // Healthy salad bowl
  'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=400&q=80', // Steak / Grilled meat
  'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=400&q=80', // Pizza
  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=400&q=80', // Burger
  'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?auto=format&fit=crop&w=400&q=80', // BBQ skewer
  'https://images.unsplash.com/photo-1512058564366-18510be2db19?auto=format&fit=crop&w=400&q=80', // Fried rice
  'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=400&q=80', // Fresh salad dish
  'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?auto=format&fit=crop&w=400&q=80', // Seafood noodles
  'https://images.unsplash.com/photo-1541832676-9b763b0239ab?auto=format&fit=crop&w=400&q=80', // Asian hotpot / soup
  'https://images.unsplash.com/photo-1562967914-608f82629710?auto=format&fit=crop&w=400&q=80', // Fried chicken
];

const APPETIZER_DESSERT_IMAGES = [
  'https://images.unsplash.com/photo-1563729784474-d77dbb933a9e?auto=format&fit=crop&w=400&q=80', // Cupcake / dessert
  'https://images.unsplash.com/photo-1587314168485-3236d6710814?auto=format&fit=crop&w=400&q=80', // Pastry / Cake
  'https://images.unsplash.com/photo-1551024709-8f23befc6f87?auto=format&fit=crop&w=400&q=80', // Donut
  'https://images.unsplash.com/photo-1578985545062-69928b1d9587?auto=format&fit=crop&w=400&q=80', // Chocolate cake
  'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?auto=format&fit=crop&w=400&q=80', // Mexican tacos appetizer
  'https://images.unsplash.com/photo-1541544741938-0af808871cc0?auto=format&fit=crop&w=400&q=80', // French fries / snack
  'https://images.unsplash.com/photo-1509722747041-616f39b57569?auto=format&fit=crop&w=400&q=80', // Spring rolls / finger food
  'https://images.unsplash.com/photo-1505253758473-96b3015f27eb?auto=format&fit=crop&w=400&q=80', // Fresh fruits dessert
];

// Hash function to consistently pick an image from an ID or name
function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Returns a high-quality, relevant food or beverage image URL for a menu item.
 * If the item already has a custom image, that image is preserved.
 */
export function getMenuItemImage(item: { id?: string; name?: string; category?: string; image?: string }): string {
  if (item.image && item.image.trim() !== '') {
    return item.image;
  }

  const nameLower = (item.name || '').toLowerCase();
  const categoryLower = (item.category || '').toLowerCase();
  const key = `${item.id || ''}_${item.name || ''}`;
  const hash = hashCode(key || 'default_food');

  // Detect beverages / drinks
  const isBeverage = 
    categoryLower.includes('uống') ||
    categoryLower.includes('nước') ||
    categoryLower.includes('trà') ||
    categoryLower.includes('cà phê') ||
    categoryLower.includes('coffee') ||
    categoryLower.includes('drink') ||
    categoryLower.includes('beverage') ||
    categoryLower.includes('sinh tố') ||
    categoryLower.includes('bia') ||
    categoryLower.includes('rượu') ||
    nameLower.includes('trà') ||
    nameLower.includes('cà phê') ||
    nameLower.includes('cafe') ||
    nameLower.includes('sinh tố') ||
    nameLower.includes('nước ép') ||
    nameLower.includes('sữa chua') ||
    nameLower.includes('soda') ||
    nameLower.includes('latte') ||
    nameLower.includes('coca') ||
    nameLower.includes('pepsi') ||
    nameLower.includes('bia');

  if (isBeverage) {
    return BEVERAGE_IMAGES[hash % BEVERAGE_IMAGES.length];
  }

  // Detect appetizers / desserts
  const isAppetizerOrDessert = 
    categoryLower.includes('khai vị') ||
    categoryLower.includes('tráng miệng') ||
    categoryLower.includes('bánh') ||
    categoryLower.includes('ăn vặt') ||
    categoryLower.includes('dessert') ||
    categoryLower.includes('snack') ||
    nameLower.includes('bánh') ||
    nameLower.includes('khoai tây') ||
    nameLower.includes('nem rán') ||
    nameLower.includes('chả giò') ||
    nameLower.includes('gỏi cuốn') ||
    nameLower.includes('salad') ||
    nameLower.includes('kem') ||
    nameLower.includes('chè');

  if (isAppetizerOrDessert) {
    return APPETIZER_DESSERT_IMAGES[hash % APPETIZER_DESSERT_IMAGES.length];
  }

  // Default: Main dishes
  return MAIN_DISH_IMAGES[hash % MAIN_DISH_IMAGES.length];
}
