import React, { useState, useRef } from 'react';
import { UtensilsCrossed, Plus, Edit2, Trash2, Search, Image as ImageIcon, Check, X, Layers, ListPlus, Info, Download, Upload, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ChevronDown, Filter } from 'lucide-react';
import { MenuItem, CATEGORIES, MenuItemType, RecipeItem, AddOnItem } from '../types';
import { cn } from '../lib/utils';
import { CurrencyInput } from './CurrencyInput';
import * as XLSX from 'xlsx';

export const MenuMgmtView = ({ 
  menu, 
  onAddItem, 
  onDeleteItem, 
  onUpdateItem, 
  categories,
  inventoryCategories,
  onAddCategory, 
  onDeleteCategory, 
  onUpdateCategories,
  onAddInventoryCategory,
  onDeleteInventoryCategory,
  onUpdateInventoryCategories
}: { 
  menu: MenuItem[], 
  onAddItem: (item: MenuItem) => void,
  onDeleteItem: (id: string) => void,
  onUpdateItem: (item: MenuItem) => void,
  categories: string[],
  inventoryCategories: string[],
  onAddCategory: (cat: string) => void,
  onDeleteCategory: (cat: string) => void,
  onUpdateCategories?: (cats: string[]) => void,
  onAddInventoryCategory: (cat: string) => void,
  onDeleteInventoryCategory: (cat: string) => void,
  onUpdateInventoryCategories?: (cats: string[]) => void
}) => {
  const [activeCategory, setActiveCategory] = useState('Tất cả');
  const [activeInventoryCategory, setActiveInventoryCategory] = useState('Tất cả');
  const [activeViewType, setActiveViewType] = useState<'menu' | 'inventory'>('menu');
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [activeTab, setActiveTab] = useState<'general' | 'recipe' | 'addons'>('general');
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCat, setNewCat] = useState('');
  const [isQuickUpdate, setIsQuickUpdate] = useState(false);
  const [quickPrices, setQuickPrices] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const moveCategory = (index: number, direction: 'left' | 'right') => {
    if (!onUpdateCategories) return;
    const newCats = [...categories];
    if (direction === 'left' && index > 1) { // Skip 'Tất cả' at index 0
      [newCats[index - 1], newCats[index]] = [newCats[index], newCats[index - 1]];
    } else if (direction === 'right' && index < newCats.length - 1 && index > 0) {
      [newCats[index + 1], newCats[index]] = [newCats[index], newCats[index + 1]];
    }
    onUpdateCategories(newCats);
  };

  const moveMenuItem = (index: number, direction: 'left' | 'right') => {
    const item = filtered[index];
    const otherIndex = direction === 'left' ? index - 1 : index + 1;
    const otherItem = filtered[otherIndex];
    
    if (!otherItem) return;

    // Ensure they have a display order to swap
    const currentOrder = item.displayOrder ?? index;
    const targetOrder = otherItem.displayOrder ?? otherIndex;

    // If they somehow have the same order, nudge one
    const finalItemOrder = currentOrder === targetOrder ? targetOrder + (direction === 'left' ? -1 : 1) : targetOrder;
    const finalOtherOrder = currentOrder;

    onUpdateItem({...item, displayOrder: finalItemOrder});
    onUpdateItem({...otherItem, displayOrder: finalOtherOrder});
  };

  const handleExport = () => {
    const exportData = menu.map(item => {
      // Format recipe as CODE:QUANTITY|CODE:QUANTITY
      const recipeStr = item.recipe?.map(r => {
        const ingredient = menu.find(m => m.id === r.ingredientId);
        return `${ingredient?.code || r.ingredientId}:${r.quantity}`;
      }).join('|') || '';

      // Format add-ons as NAME:PRICE|NAME:PRICE
      const addOnsStr = item.addOns?.map(a => `${a.name}:${a.price}`).join('|') || '';

      const isKho = item.isInventory || item.type === 'goods';

      return {
        'Mã món': item.code,
        'Tên món': item.name,
        'Giá bán': item.price,
        'Giá vốn': item.costPrice,
        'Nhóm': item.category,
        'Đơn vị': item.unit,
        'Loại hệ thống': isKho ? 'Kho' : 'Thực đơn',
        'Trạng thái': item.status === 'available' ? 'Đang bán' : 'Hết món',
        'Tồn kho': item.stock,
        'Thành phần (Công thức)': recipeStr,
        'Món thêm': addOnsStr
      };
    });

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Thực đơn");
    XLSX.writeFile(wb, `Thuc_don_${new Date().getTime()}.xlsx`);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const wsname = wb.SheetNames[0];
      const ws = wb.Sheets[wsname];
      const data = XLSX.utils.sheet_to_json(ws) as any[];

      const newMenuCategories = new Set(categories);
      const newInventoryCategories = new Set(inventoryCategories);
      let menuCategoriesUpdated = false;
      let inventoryCategoriesUpdated = false;

      // Temporary map for all items (existing + new from excel)
      const allItemsMap = new Map<string, MenuItem>();
      const allItemsByName = new Map<string, MenuItem>();
      
      menu.forEach(item => {
        allItemsMap.set(item.code.toLowerCase(), item);
        allItemsByName.set(item.name.toLowerCase().trim(), item);
      });

      // First pass: create items and collect categories
      const processedItems: { item: MenuItem, isNew: boolean }[] = [];
      let goodsCount = menu.filter(i => i.isInventory || i.type === 'goods').length;
      let dishCount = menu.filter(i => !i.isInventory && i.type === 'dish').length;

      data.forEach((row, index) => {
        let type: MenuItemType = 'dish';
        let isInventory = false;

        const rawTypeSys = String(row['Loại hệ thống'] || '').trim().toLowerCase();
        const rawType = String(row['Loại'] || '').trim().toLowerCase();
        const combinedType = `${rawTypeSys} ${rawType}`;

        if (
          combinedType.includes('kho') || 
          combinedType.includes('goods') || 
          combinedType.includes('hàng hóa') || 
          combinedType.includes('nguyên liệu') ||
          combinedType.includes('hang hoa') ||
          combinedType.includes('nguyen lieu')
        ) {
          type = 'goods';
          isInventory = true;
        } else {
          type = 'dish';
          isInventory = false;
        }

        const category = row['Nhóm'] || (isInventory ? 'Nguyên liệu' : 'Món mới');
        if (isInventory) {
          if (!newInventoryCategories.has(category)) {
            newInventoryCategories.add(category);
            inventoryCategoriesUpdated = true;
            onAddInventoryCategory(category);
          }
        } else {
          if (!newMenuCategories.has(category)) {
            newMenuCategories.add(category);
            menuCategoriesUpdated = true;
            onAddCategory(category);
          }
        }

        const prefix = isInventory ? 'NL' : 'MA';
        let code = row['Mã món'] || row['Mã hàng'] || row['Mã'];
        if (!code) {
           const count = isInventory ? ++goodsCount : ++dishCount;
           code = `${prefix}${count.toString().padStart(3, '0')}`;
        }
        
        let item: MenuItem;
        let isNew = false;
        const existingItem = allItemsMap.get(code.toLowerCase());

        if (existingItem) {
          item = { ...existingItem }; // copy existing
          item.name = (row['Tên món'] || row['Tên hàng'] || item.name).trim();
          if (row['Giá bán'] !== undefined) item.price = Number(row['Giá bán']) || 0;
          if (row['Giá vốn'] !== undefined) item.costPrice = Number(row['Giá vốn']) || 0;
          item.category = category;
          if (row['Đơn vị']) item.unit = row['Đơn vị'];
          if (row['Trạng thái']) item.status = row['Trạng thái'] === 'Hết món' ? 'out_of_stock' : 'available';
          if (row['Tồn kho'] !== undefined) item.stock = Number(row['Tồn kho']) || 0;
          item.type = type;
          item.isInventory = isInventory;
          item.recipe = [];
          item.addOns = [];
        } else {
          isNew = true;
          item = {
            id: Math.random().toString(36).substr(2, 9),
            code: code,
            name: (row['Tên món'] || row['Tên hàng'] || 'Món mới').trim(),
            price: Number(row['Giá bán']) || 0,
            costPrice: Number(row['Giá vốn']) || 0,
            category: category,
            unit: row['Đơn vị'] || (isInventory ? 'kg' : 'Đĩa'),
            type,
            status: row['Trạng thái'] === 'Hết món' ? 'out_of_stock' : 'available',
            stock: Number(row['Tồn kho']) || 0,
            recipe: [],
            addOns: [],
            isInventory
          };
        }

        (item as any)._rawRow = row;

        processedItems.push({ item, isNew });
        allItemsMap.set(item.code.toLowerCase(), item);
        allItemsByName.set(item.name.toLowerCase(), item);
      });

      // Update categories if needed
      if (menuCategoriesUpdated && onUpdateCategories) {
        onUpdateCategories(Array.from(newMenuCategories));
      }
      if (inventoryCategoriesUpdated && onUpdateInventoryCategories) {
        onUpdateInventoryCategories(Array.from(newInventoryCategories));
      }

      // Helper to generate missing ingredients
      const getOrCreateIngredient = (nameOrCode: string): MenuItem => {
        const query = nameOrCode.toLowerCase().trim();
        if (allItemsMap.has(query)) return allItemsMap.get(query)!;
        if (allItemsByName.has(query)) return allItemsByName.get(query)!;
        
        // Need to create new ingredient
        let newCode = nameOrCode.trim();
        const isCode = newCode.length <= 15 && !newCode.includes(' ');
        
        if (!isCode) {
           goodsCount++;
           newCode = `HH${goodsCount.toString().padStart(3, '0')}`;
        }
        
        const newIng: MenuItem = {
          id: Math.random().toString(36).substr(2, 9),
          code: newCode,
          name: nameOrCode.trim(),
          price: 0,
          costPrice: 0,
          category: 'Nguyên liệu',
          unit: 'đơn vị',
          type: 'goods',
          status: 'available',
          stock: 0,
          recipe: [],
          addOns: [],
          isInventory: true
        };
        
        if (!newInventoryCategories.has('Nguyên liệu')) {
           newInventoryCategories.add('Nguyên liệu');
           onAddInventoryCategory('Nguyên liệu');
           if (onUpdateInventoryCategories) onUpdateInventoryCategories(Array.from(newInventoryCategories));
        }

        processedItems.push({ item: newIng, isNew: true });
        allItemsMap.set(newIng.code.toLowerCase(), newIng);
        allItemsByName.set(newIng.name.toLowerCase(), newIng);
        return newIng;
      };

      // Second pass: Process recipes, addons and cost prices
      for (const processed of processedItems) {
        const item = processed.item;
        const row = (item as any)._rawRow;
        if (!row) continue;

        // Parse recipe
        let calculatedCostPrice = 0;
        const recipeStr = row['Thành phần (Công thức)'];
        if (recipeStr && typeof recipeStr === 'string') {
          // Split by |, or , or +
          const parts = recipeStr.split(/[|,+]/);
          parts.forEach(part => {
            const [ingNameOrCode, qtyStr] = part.split(':');
            if (ingNameOrCode && qtyStr) {
              const qty = Number(qtyStr.trim().replace(/[^0-9.]/g, ''));
              if (!isNaN(qty) && qty > 0) {
                 const ingredient = getOrCreateIngredient(ingNameOrCode);
                 item.recipe!.push({
                   ingredientId: ingredient.id,
                   name: ingredient.name,
                   quantity: qty,
                   unit: ingredient.unit
                 });
                 calculatedCostPrice += (ingredient.costPrice * qty);
              }
            }
          });
        }

        // Auto calculate cost price if it was 0 and we have a recipe
        if (item.costPrice === 0 && calculatedCostPrice > 0) {
          item.costPrice = calculatedCostPrice;
        }

        // Parse add-ons
        const addOnsStr = row['Món thêm'];
        if (addOnsStr && typeof addOnsStr === 'string') {
          const parts = addOnsStr.split(/[|,+]/);
          parts.forEach(part => {
            const [name, priceStr] = part.split(':');
            if (name && priceStr) {
              const price = Number(priceStr.trim().replace(/[^0-9.]/g, ''));
              if (!isNaN(price)) {
                item.addOns!.push({
                  id: Math.random().toString(36).substr(2, 5),
                  name: name.trim(),
                  price: price
                });
              }
            }
          });
        }

        delete (item as any)._rawRow;
      }

      // Add or update all items
      // Ensure inventory/ingredients are added first
      processedItems.sort((a, b) => {
        const aIsInv = a.item.isInventory || a.item.type === 'goods' ? 1 : 0;
        const bIsInv = b.item.isInventory || b.item.type === 'goods' ? 1 : 0;
        return bIsInv - aIsInv;
      });

      for (const processed of processedItems) {
        if (processed.isNew) {
           onAddItem(processed.item);
        } else {
           onUpdateItem(processed.item);
        }
      }
      
      if (fileInputRef.current) fileInputRef.current.value = '';
      alert(`Đã nhập thành công ${processedItems.length} món/nguyên liệu!`);
    };
    reader.readAsBinaryString(file);
  };

  const [newItem, setNewItem] = useState<Partial<MenuItem>>({
    name: '',
    price: 0,
    costPrice: 0,
    category: categories[1] || 'Món chính',
    unit: 'Đĩa',
    type: 'dish',
    status: 'available',
    stock: 0,
    recipe: [],
    addOns: []
  });

  const isMenuMode = activeViewType === 'menu';
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);

  const filtered = menu.filter(item => {
    const isInvItem = item.isInventory || item.type === 'goods';
    const isMatchingType = isMenuMode ? !isInvItem : isInvItem;
    const catToMatch = isMenuMode ? activeCategory : activeInventoryCategory;
    const matchesCat = catToMatch === 'Tất cả' || item.category === catToMatch;
    const matchesSearch = item.name.toLowerCase().includes(search.toLowerCase()) || item.code.toLowerCase().includes(search.toLowerCase());
    return isMatchingType && matchesCat && matchesSearch;
  }).sort((a, b) => {
    if (a.displayOrder !== undefined && b.displayOrder !== undefined) {
      return a.displayOrder - b.displayOrder;
    }
    if (a.displayOrder !== undefined) return -1;
    if (b.displayOrder !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleQuickSave = () => {
    Object.entries(quickPrices).forEach(([id, price]) => {
      const item = menu.find(i => i.id === id);
      if (item && item.price !== (price as number)) {
        onUpdateItem({ ...item, price: price as number });
      }
    });
    setIsQuickUpdate(false);
    setQuickPrices({});
  };

  const handleSave = () => {
    if (!newItem.name || !newItem.price) return;
    
    if (editingItem) {
      onUpdateItem({
        ...editingItem,
        ...newItem as MenuItem,
        isInventory: newItem.type === 'goods' || newItem.isInventory
      });
    } else {
      // Auto-generate code
      const isInv = newItem.type === 'goods' || newItem.isInventory;
      const prefix = isInv ? 'NL' : 'MA';
      const count = menu.filter(i => (i.isInventory || i.type === 'goods') === isInv).length + 1;
      const code = `${prefix}${count.toString().padStart(3, '0')}`;

      onAddItem({
        ...newItem as MenuItem,
        id: Math.random().toString(36).substr(2, 9),
        code,
        stock: newItem.stock || 0,
        type: isInv ? 'goods' : 'dish',
        isInventory: isInv
      });
    }
    setShowAdd(false);
    setEditingItem(null);
    setNewItem({ name: '', price: 0, costPrice: 0, category: categories[1], unit: 'Đĩa', type: 'dish', isInventory: false, status: 'available', stock: 0, recipe: [], addOns: [], image: '' });
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 600;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        
        // Quality 0.7 to keep it well under 1MB
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        setNewItem({ ...newItem, image: dataUrl });
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleEdit = (item: MenuItem) => {
    setEditingItem(item);
    setNewItem({ ...item });
    setShowAdd(true);
  };

  const calculateCostPrice = (recipe: RecipeItem[]) => {
    if (!recipe || recipe.length === 0) return 0;
    return recipe.reduce((total, r) => {
      const ingredient = menu.find(m => m.id === r.ingredientId);
      if (ingredient) {
        return total + (ingredient.costPrice * r.quantity);
      }
      return total;
    }, 0);
  };

  const addRecipeItem = () => {
    const recipe = newItem.recipe || [];
    setNewItem({ ...newItem, recipe: [...recipe, { ingredientId: '', name: '', quantity: 0, unit: 'kg' }] });
  };

  const addAddOn = () => {
    const addOns = newItem.addOns || [];
    setNewItem({ ...newItem, addOns: [...addOns, { id: Math.random().toString(36).substr(2, 5), name: '', price: 0, costPrice: 0 }] });
  };

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 h-full overflow-y-auto">
      <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center border-b border-black/10 dark:border-white/10 pb-4 gap-4 xl:gap-0">
        <div className="flex gap-4 md:gap-6 w-full xl:w-auto overflow-x-auto custom-scrollbar">
          <button 
             onClick={() => setActiveViewType('menu')}
             className={cn("text-lg md:text-xl font-bold flex items-center gap-2 pb-4 -mb-4 border-b-2 transition-all cursor-pointer whitespace-nowrap", isMenuMode ? "border-emerald-500 text-gray-900 dark:text-white" : "border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300")}
          >
             <UtensilsCrossed className="w-5 h-5 md:w-6 md:h-6" /> Thực đơn
          </button>
          <button 
             onClick={() => setActiveViewType('inventory')}
             className={cn("text-lg md:text-xl font-bold flex items-center gap-2 pb-4 -mb-4 border-b-2 transition-all cursor-pointer whitespace-nowrap", !isMenuMode ? "border-emerald-500 text-gray-900 dark:text-white" : "border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300")}
          >
             <Layers className="w-5 h-5 md:w-6 md:h-6" /> Kho hàng
          </button>
        </div>
        <div className="flex flex-wrap lg:flex-nowrap gap-2 md:gap-3 w-full xl:w-auto">
          <input 
            type="file" 
            ref={fileInputRef} 
            className="hidden" 
            accept=".xlsx, .xls" 
            onChange={handleImport}
          />
          <button 
            onClick={() => {
              setNewItem({ 
                name: '', 
                price: 0, 
                costPrice: 0, 
                category: isMenuMode ? (categories[1] || '') : (inventoryCategories[0] || ''), 
                unit: isMenuMode ? 'Đĩa' : 'kg', 
                type: isMenuMode ? 'dish' : 'goods', 
                isInventory: !isMenuMode, 
                status: 'available', 
                stock: 0, 
                recipe: [], 
                addOns: [], 
                image: '' 
              });
              setShowAdd(true);
            }}
            className="order-1 lg:order-none w-full lg:w-auto flex items-center justify-center gap-2 px-4 py-3 lg:py-2 bg-emerald-500 text-white rounded-xl text-base lg:text-sm font-bold hover:bg-emerald-400 transition-all cursor-pointer"
          >
            <Plus className="w-5 h-5 lg:w-4 lg:h-4" /> Thêm {isMenuMode ? 'món mới' : 'hàng hóa'}
          </button>
          
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="order-2 lg:order-none flex-1 lg:flex-none flex flex-col md:flex-row items-center justify-center gap-1 md:gap-2 px-2 md:px-4 py-2 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-[10px] md:text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/10 transition-all cursor-pointer"
          >
            <Upload className="w-4 h-4" /> <span>Import<span className="hidden md:inline"> Excel</span></span>
          </button>
          <button 
            onClick={handleExport}
            className="order-3 lg:order-none flex-1 lg:flex-none flex flex-col md:flex-row items-center justify-center gap-1 md:gap-2 px-2 md:px-4 py-2 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-[10px] md:text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/10 dark:hover:bg-white/10 transition-all cursor-pointer"
          >
            <Download className="w-4 h-4" /> <span>Export<span className="hidden md:inline"> Excel</span></span>
          </button>
          <button 
            onClick={() => {
              if (isQuickUpdate) {
                handleQuickSave();
              } else {
                setIsQuickUpdate(true);
                const prices: Record<string, number> = {};
                filtered.forEach(item => prices[item.id] = item.price);
                setQuickPrices(prices);
              }
            }}
            className={cn(
              "order-4 lg:order-none flex-1 lg:flex-none flex flex-col md:flex-row items-center justify-center gap-1 md:gap-2 px-2 md:px-4 py-2 rounded-xl text-[10px] md:text-sm font-bold transition-all cursor-pointer",
              isQuickUpdate ? "bg-emerald-500 text-white" : "bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-emerald-600 dark:text-emerald-500 hover:bg-black/10 dark:hover:bg-white/10"
            )}
          >
            {isQuickUpdate ? <Check className="w-4 h-4" /> : <Edit2 className="w-4 h-4" />}
            <span>{isQuickUpdate ? 'Lưu' : 'Sửa nhanh'}</span>
          </button>
          {isQuickUpdate && (
            <button 
              onClick={() => setIsQuickUpdate(false)}
              className="order-5 lg:order-none flex flex-col md:flex-row items-center justify-center gap-1 md:gap-2 px-3 md:px-4 py-2 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-[10px] md:text-sm text-rose-600 dark:text-rose-500 hover:bg-black/10 dark:hover:bg-white/10 cursor-pointer"
            >
              <X className="w-4 h-4" /> Hủy
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-6 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 p-6 rounded-2xl">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
          <input 
            type="text" 
            placeholder="Tìm theo mã hoặc tên..."
            className="w-full bg-gray-100 dark:bg-black/20 border border-black/10 dark:border-white/10 rounded-xl py-4 pl-12 pr-4 text-gray-900 dark:text-white text-lg focus:outline-none focus:border-emerald-500/50 transition-all"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="relative">
          <button 
            onClick={() => setShowCategoryDropdown(!showCategoryDropdown)}
            className="w-full md:w-auto px-5 py-3 bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl flex items-center justify-between gap-4 text-gray-900 dark:text-white font-bold shadow-sm hover:border-emerald-500/50 transition-all"
          >
            <div className="flex items-center gap-2">
              <Filter className="w-5 h-5 text-emerald-500" />
              <span>NHÓM MÓN: <span className="text-emerald-600 dark:text-emerald-500 font-bold ml-1">{isMenuMode ? activeCategory : activeInventoryCategory}</span></span>
            </div>
            <ChevronDown className={cn("w-4 h-4 text-gray-500 transition-transform", showCategoryDropdown ? "rotate-180" : "")} />
          </button>
          
          {showCategoryDropdown && (
            <>
              <div 
                className="fixed inset-0 z-30"
                onClick={() => setShowCategoryDropdown(false)}
              ></div>
              <div className="absolute top-full mt-2 left-0 w-full md:w-96 bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl shadow-xl z-40 p-2 flex flex-col gap-1 max-h-[60vh] overflow-y-auto custom-scrollbar">
                {(isMenuMode ? categories : inventoryCategories).map((cat, idx) => (
                  <div key={cat} className="relative group/cat flex items-center">
                    {idx > 1 && ((isMenuMode && onUpdateCategories) || (!isMenuMode && onUpdateInventoryCategories)) && (
                      <button 
                        onClick={(e) => { e.stopPropagation(); moveCategory(idx, 'left'); }}
                        className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white dark:bg-[#151619] border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-full flex items-center justify-center opacity-0 group-hover/cat:opacity-100 transition-all hover:bg-emerald-500 hover:text-white cursor-pointer shadow-md"
                        title="Di chuyển lên"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        isMenuMode ? setActiveCategory(cat) : setActiveInventoryCategory(cat);
                        setShowCategoryDropdown(false);
                      }}
                      className={cn(
                        "w-full px-4 py-3 rounded-lg text-left text-sm transition-all cursor-pointer relative",
                        (isMenuMode ? activeCategory === cat : activeInventoryCategory === cat)
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold" 
                          : "text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5"
                      )}
                    >
                      <span className="pl-6 group-hover/cat:pl-10 transition-all duration-300 inline-block">{cat}</span>
                      {(isMenuMode ? activeCategory === cat : activeInventoryCategory === cat) && (
                        <Check className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2" />
                      )}
                    </button>
                    {idx > 0 && idx < (isMenuMode ? categories.length - 1 : inventoryCategories.length - 1) && ((isMenuMode && onUpdateCategories) || (!isMenuMode && onUpdateInventoryCategories)) && (
                      <button 
                        onClick={(e) => { e.stopPropagation(); moveCategory(idx, 'right'); }}
                        className="absolute right-12 top-1/2 -translate-y-1/2 z-10 w-7 h-7 bg-white dark:bg-[#151619] border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-full flex items-center justify-center opacity-0 group-hover/cat:opacity-100 transition-all hover:bg-emerald-500 hover:text-white cursor-pointer shadow-md"
                        title="Di chuyển xuống"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                    )}
                    {cat !== 'Tất cả' && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          isMenuMode ? onDeleteCategory(cat) : onDeleteInventoryCategory(cat);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 bg-rose-500/10 text-rose-600 dark:text-rose-500 rounded-lg flex items-center justify-center opacity-0 group-hover/cat:opacity-100 transition-all hover:bg-rose-500 hover:text-white cursor-pointer z-20"
                        title="Xóa nhóm"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 md:gap-6">
        {filtered.map((item, idx) => (
          <div key={item.id} className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden flex flex-row md:flex-col group hover:border-emerald-500/30 transition-all h-28 md:h-auto relative">
            <div className="w-28 h-28 md:w-full md:aspect-video flex-shrink-0 bg-gray-100 dark:bg-gray-800 relative">
              <img 
                src={item.image || `https://picsum.photos/seed/${item.id}/400/300`} 
                alt={item.name}
                className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity"
                referrerPolicy="no-referrer"
              />
              
              {idx > 0 && (
                <button 
                  onClick={() => moveMenuItem(idx, 'left')}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-black/60 backdrop-blur-md rounded-full text-gray-900 dark:text-white hover:text-emerald-500 hover:bg-black/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-all shadow-lg hidden md:flex"
                  title="Di chuyển lên trước"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}
              {idx < filtered.length - 1 && (
                <button 
                  onClick={() => moveMenuItem(idx, 'right')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-black/60 backdrop-blur-md rounded-full text-gray-900 dark:text-white hover:text-emerald-500 hover:bg-black/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-all shadow-lg hidden md:flex"
                  title="Di chuyển ra sau"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
              
              <div className="absolute top-1 left-1 md:top-2 md:left-2">
                <span className="px-1.5 py-0.5 md:px-2 md:py-1 bg-black/60 backdrop-blur-md rounded-md text-[8px] md:text-[10px] font-mono text-gray-700 dark:text-gray-300">{item.code}</span>
              </div>
              
              <div className="absolute bottom-1 left-1 md:bottom-2 md:left-2">
                <span className={cn(
                  "px-1.5 py-0.5 md:px-2 md:py-1 rounded-md text-[8px] md:text-[10px] font-bold uppercase tracking-wider",
                  item.status === 'available' ? "bg-emerald-500/80 text-black" : "bg-rose-500/80 text-gray-900 dark:text-white"
                )}>
                  {item.status === 'available' ? 'Đang bán' : 'Hết món'}
                </span>
              </div>
            </div>

            <div className="absolute top-2 right-2 flex md:hidden gap-1 z-10">
              <button 
                onClick={() => handleEdit(item)}
                className="p-1.5 bg-black/20 backdrop-blur-md rounded-md text-gray-900 dark:text-white hover:text-emerald-500 cursor-pointer border border-black/10 dark:border-white/10"
              ><Edit2 className="w-3 h-3" /></button>
              <button 
                onClick={() => onDeleteItem(item.id)}
                className="p-1.5 bg-black/20 backdrop-blur-md rounded-md text-gray-900 dark:text-white hover:text-rose-500 cursor-pointer border border-black/10 dark:border-white/10"
              ><Trash2 className="w-3 h-3" /></button>
            </div>
            
            <div className="absolute top-2 right-2 hidden md:flex gap-2 z-10">
              <button 
                onClick={() => handleEdit(item)}
                className="p-2 bg-black/60 backdrop-blur-md rounded-lg text-gray-900 dark:text-white hover:text-emerald-500 cursor-pointer"
              ><Edit2 className="w-4 h-4" /></button>
              <button 
                onClick={() => onDeleteItem(item.id)}
                className="p-2 bg-black/60 backdrop-blur-md rounded-lg text-gray-900 dark:text-white hover:text-rose-500 cursor-pointer"
              ><Trash2 className="w-4 h-4" /></button>
            </div>

            <div className="p-3 md:p-4 flex flex-col justify-between flex-1 min-w-0">
              <div className="pr-12 md:pr-0">
                <h4 className="font-bold text-gray-900 dark:text-white truncate text-sm md:text-base leading-tight md:leading-normal mb-0.5 md:mb-0">{item.name}</h4>
                <p className="text-[10px] md:text-xs text-gray-500">{item.category} • {item.isInventory || item.type === 'goods' ? 'Kho' : 'Thực đơn'}</p>
              </div>
              <div className="flex justify-between items-end mt-1 md:mt-0">
                <div>
                  <p className="text-[9px] md:text-[10px] text-gray-500 uppercase hidden md:block">Giá bán</p>
                  {isQuickUpdate ? (
                    <CurrencyInput 
                      className="w-full max-w-[90px] md:max-w-full bg-black/10 dark:bg-white/10 border border-emerald-500/50 rounded-md md:rounded-lg py-1 px-1.5 md:px-2 text-xs md:text-sm font-mono font-bold text-emerald-600 dark:text-emerald-500 focus:outline-none"
                      value={quickPrices[item.id] || 0}
                      onChange={(val) => setQuickPrices({...quickPrices, [item.id]: Number(val)})}
                    />
                  ) : (
                    <p className="text-sm md:text-lg font-mono font-bold text-emerald-600 dark:text-emerald-500">{item.price.toLocaleString()}đ</p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-[9px] md:text-[10px] text-gray-500 uppercase hidden md:block">Tồn kho</p>
                  <p className="text-xs md:text-sm font-mono text-gray-600 dark:text-gray-400">
                    {Number(item.stock || 0).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} {item.unit}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-2xl rounded-3xl overflow-hidden border border-black/10 dark:border-white/10 shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-black/5 dark:border-white/5 flex justify-between items-center">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">{editingItem ? 'Chỉnh sửa món' : 'Thêm món mới'}</h3>
              <button 
                onClick={() => {
                  setShowAdd(false);
                  setEditingItem(null);
                }} 
                className="text-gray-500 hover:text-gray-900 dark:hover:text-white"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex border-b border-black/5 dark:border-white/5">
              {[
                { id: 'general', label: 'Thông tin chung', icon: Info },
                { id: 'recipe', label: 'Thành phần', icon: Layers },
                { id: 'addons', label: 'Món thêm', icon: ListPlus }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={cn(
                    "flex-1 py-4 flex items-center justify-center gap-2 text-sm font-bold transition-all border-b-2",
                    activeTab === tab.id ? "border-emerald-500 text-emerald-600 dark:text-emerald-500 bg-emerald-500/5" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
                  )}
                >
                  <tab.icon className="w-4 h-4" /> {tab.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar">
              {activeTab === 'general' && (
                <div className="space-y-4">
                  <div className="flex flex-col items-center gap-4 p-6 bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/10 rounded-2xl">
                    <div className="w-40 h-24 bg-gray-100 dark:bg-gray-800 rounded-xl overflow-hidden border border-black/10 dark:border-white/10">
                      {newItem.image ? (
                        <img src={newItem.image} alt="Preview" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-600">
                          <ImageIcon className="w-8 h-8" />
                        </div>
                      )}
                    </div>
                    <label className="px-4 py-2 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg text-xs font-bold hover:bg-black/10 dark:hover:bg-white/10 transition-all cursor-pointer">
                      <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                      {newItem.image ? 'Thay đổi ảnh' : 'Tải ảnh lên'}
                    </label>
                    <p className="text-[10px] text-gray-500">Dung lượng tối đa 1MB. Ảnh sẽ tự động thu nhỏ.</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="col-span-1 md:col-span-2">
                      <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Loại hệ thống</label>
                      <div className="grid grid-cols-2 gap-2">
                        <button 
                          type="button"
                          onClick={() => setNewItem({...newItem, type: 'goods', isInventory: true, category: inventoryCategories[0] || ''})}
                          className={cn("py-3 rounded-xl border text-sm font-bold transition-all", (newItem.isInventory || newItem.type === 'goods') ? "bg-emerald-500/10 border-emerald-500 text-emerald-600 dark:text-emerald-500" : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-500")}
                        >
                          Kho (Tồn kho / Nguyên liệu)
                        </button>
                        <button 
                          type="button"
                          onClick={() => setNewItem({...newItem, type: 'dish', isInventory: false, category: categories[1] || ''})}
                          className={cn("py-3 rounded-xl border text-sm font-bold transition-all", (!newItem.isInventory && newItem.type === 'dish') ? "bg-emerald-500/10 border-emerald-500 text-emerald-600 dark:text-emerald-500" : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-500")}
                        >
                          Thực đơn (Món bán)
                        </button>
                      </div>
                    </div>
                    <div className="col-span-1 md:col-span-2">
                      <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tên {newItem.isInventory || newItem.type === 'goods' ? 'hàng hóa' : 'món'}</label>
                      <input 
                        type="text" 
                        className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                        value={newItem.name}
                        onChange={(e) => setNewItem({...newItem, name: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Nhóm {(newItem.isInventory || newItem.type === 'goods') ? 'kho' : 'thực đơn'}</label>
                      <div className="flex gap-2">
                        <select 
                          className="flex-1 bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                          value={newItem.category}
                          onChange={(e) => setNewItem({...newItem, category: e.target.value})}
                        >
                          {((newItem.isInventory || newItem.type === 'goods') ? inventoryCategories : categories).filter(c => c !== 'Tất cả').map(c => (
                            <option key={c} value={c} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">{c}</option>
                          ))}
                        </select>
                        <button 
                          onClick={() => setShowAddCat(true)}
                          className="p-3 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-emerald-600 dark:text-emerald-500 hover:bg-black/10 dark:hover:bg-white/10"
                        >
                          <Plus className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Đơn vị tính</label>
                      <input 
                        type="text" 
                        className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                        value={newItem.unit}
                        onChange={(e) => setNewItem({...newItem, unit: e.target.value})}
                        placeholder="Đĩa, Ly, Lon..."
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Giá bán</label>
                      <CurrencyInput 
                        className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                        value={newItem.price}
                        onChange={(val) => setNewItem({...newItem, price: Number(val)})}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Giá vốn {newItem.recipe && newItem.recipe.length > 0 && '(Tự động tính)'}</label>
                      <CurrencyInput 
                        className={cn("w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50", newItem.recipe && newItem.recipe.length > 0 && "opacity-60")}
                        value={newItem.costPrice}
                        onChange={(val) => setNewItem({...newItem, costPrice: Number(val)})}
                        readOnly={newItem.recipe && newItem.recipe.length > 0}
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'recipe' && (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <p className="text-sm text-gray-600 dark:text-gray-400 italic">Định lượng các thành phần để tự động trừ kho khi bán.</p>
                    <button 
                      onClick={addRecipeItem}
                      className="text-xs text-emerald-600 dark:text-emerald-500 flex items-center gap-1 hover:underline"
                    >
                      <Plus className="w-3 h-3" /> Thêm thành phần
                    </button>
                  </div>
                  <div className="space-y-3">
                    {newItem.recipe?.map((r, idx) => (
                      <div key={idx} className="flex gap-3 items-end">
                        <div className="flex-1 relative">
                          <label className="text-[10px] text-gray-500 uppercase mb-1 block">Tên nguyên liệu</label>
                          <select 
                            className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg py-2 px-3 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                            value={r.ingredientId}
                            onChange={(e) => {
                              const selected = menu.find(m => m.id === e.target.value);
                              if (selected) {
                                const recipe = [...(newItem.recipe || [])];
                                recipe[idx] = {
                                  ingredientId: selected.id,
                                  name: selected.name,
                                  quantity: recipe[idx].quantity,
                                  unit: selected.unit
                                };
                                const newCostPrice = calculateCostPrice(recipe);
                                setNewItem({...newItem, recipe, costPrice: newCostPrice});
                              }
                            }}
                          >
                            <option value="" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">-- Chọn nguyên liệu --</option>
                            {menu.filter(m => m.type === 'goods' || m.category === 'Nguyên liệu').map(m => (
                              <option key={m.id} value={m.id} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">{m.code} - {m.name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="w-24">
                          <label className="text-[10px] text-gray-500 uppercase mb-1 block">Số lượng</label>
                          <input 
                            type="number" 
                            className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg py-2 px-3 text-sm text-gray-900 dark:text-white"
                            value={r.quantity}
                            onChange={(e) => {
                              const recipe = [...(newItem.recipe || [])];
                              recipe[idx].quantity = Number(e.target.value);
                              const newCostPrice = calculateCostPrice(recipe);
                              setNewItem({...newItem, recipe, costPrice: newCostPrice});
                            }}
                          />
                        </div>
                        <div className="w-20">
                          <label className="text-[10px] text-gray-500 uppercase mb-1 block">Đơn vị</label>
                          <input 
                            type="text" 
                            readOnly
                            className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg py-2 px-3 text-sm text-gray-500"
                            value={r.unit}
                          />
                        </div>
                        <button 
                          onClick={() => {
                            const recipe = (newItem.recipe || []).filter((_, i) => i !== idx);
                            const newCostPrice = calculateCostPrice(recipe);
                            setNewItem({...newItem, recipe, costPrice: recipe.length ? newCostPrice : newItem.costPrice});
                          }}
                          className="p-2 text-rose-600 dark:text-rose-500 hover:bg-rose-500/10 rounded-lg"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === 'addons' && (
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <p className="text-sm text-gray-600 dark:text-gray-400 italic">Các món ăn kèm hoặc tùy chọn thêm cho món này.</p>
                    <button 
                      onClick={addAddOn}
                      className="text-xs text-emerald-600 dark:text-emerald-500 flex items-center gap-1 hover:underline"
                    >
                      <Plus className="w-3 h-3" /> Thêm món kèm
                    </button>
                  </div>
                  <div className="space-y-3">
                    {newItem.addOns?.map((addon, idx) => (
                      <div key={idx} className="flex gap-3 items-end">
                        <div className="flex-1">
                          <label className="text-[10px] text-gray-500 uppercase mb-1 block">Tên món kèm</label>
                          <input 
                            type="text" 
                            className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg py-2 px-3 text-sm text-gray-900 dark:text-white"
                            value={addon.name}
                            onChange={(e) => {
                              const addOns = [...(newItem.addOns || [])];
                              addOns[idx].name = e.target.value;
                              setNewItem({...newItem, addOns});
                            }}
                          />
                        </div>
                        <div className="w-28">
                          <label className="text-[10px] text-gray-500 uppercase mb-1 block">Giá vốn</label>
                          <CurrencyInput 
                            className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg py-2 px-3 text-sm text-gray-900 dark:text-white"
                            value={addon.costPrice || 0}
                            onChange={(val) => {
                              const addOns = [...(newItem.addOns || [])];
                              addOns[idx].costPrice = Number(val);
                              setNewItem({...newItem, addOns});
                            }}
                          />
                        </div>
                        <div className="w-28">
                          <label className="text-[10px] text-gray-500 uppercase mb-1 block">Giá bán</label>
                          <CurrencyInput 
                            className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg py-2 px-3 text-sm text-gray-900 dark:text-white"
                            value={addon.price}
                            onChange={(val) => {
                              const addOns = [...(newItem.addOns || [])];
                              addOns[idx].price = Number(val);
                              setNewItem({...newItem, addOns});
                            }}
                          />
                        </div>
                        <button 
                          onClick={() => {
                            const addOns = (newItem.addOns || []).filter((_, i) => i !== idx);
                            setNewItem({...newItem, addOns});
                          }}
                          className="p-2 text-rose-600 dark:text-rose-500 hover:bg-rose-500/10 rounded-lg"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-black/5 dark:border-white/5 flex gap-3">
              <button 
                onClick={() => {
                  setShowAdd(false);
                  setEditingItem(null);
                }}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-600 dark:text-gray-400 font-bold hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Hủy
              </button>
              <button 
                onClick={handleSave}
                className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-400 cursor-pointer"
              >
                {editingItem ? 'Cập nhật' : 'Lưu mặt hàng'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddCat && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-sm rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white">Thêm nhóm hàng mới</h3>
            <input 
              type="text" 
              className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
              placeholder="Tên nhóm (VD: Lẩu, Nướng...)"
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
            />
            <div className="flex gap-3">
              <button 
                onClick={() => setShowAddCat(false)}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-600 dark:text-gray-400 font-bold hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Hủy
              </button>
              <button 
                onClick={() => {
                  if (newCat) {
                    if (newItem.isInventory || newItem.type === 'goods') {
                      onAddInventoryCategory(newCat);
                      setNewItem({...newItem, category: newCat});
                    } else {
                      onAddCategory(newCat);
                      setNewItem({...newItem, category: newCat});
                    }
                    setNewCat('');
                    setShowAddCat(false);
                  }
                }}
                className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-400 cursor-pointer"
              >
                Thêm nhóm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
