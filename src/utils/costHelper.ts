import { OrderItem, AddOnItem, RecipeItem } from "../types";

/**
 * Tính giá vốn (COGS) cho một topping/món ăn kèm theo định lượng một suất:
 * Công thức chuẩn: unitCost × quantityPerServing
 *
 * - a.costPrice là giá vốn 1 đơn vị kho (VND / kg, lít, hộp, cái...)
 * - a.quantity là định lượng cho 1 suất (ví dụ 0.1 kg, 0.05 lít, 1 cái...)
 *
 * Kiểm tra phòng vệ để tránh nhân định lượng 2 lần:
 * Nếu một topping cũ đã được lưu giá vốn theo suất (hoặc quantity = 0), mặc định lấy quantity = 1.
 */
export function calculateAddOnCostPerServing(addon: AddOnItem): number {
  const unitCost = addon.costPrice || 0;
  const qty =
    typeof addon.quantity === "number" && addon.quantity > 0
      ? addon.quantity
      : 1;
  return unitCost * qty;
}

/**
 * Tính tổng giá vốn cho 1 dòng món trong đơn hàng (gồm giá vốn món chính + toàn bộ món kèm theo định lượng):
 * Công thức: (item.costPrice × item.quantity) + [Tổng (unitCost × quantityPerServing × item.quantity)]
 */
export function calculateOrderItemCost(item: OrderItem): number {
  const soldQuantity = Number.isFinite(item.quantity)
    ? Math.max(0, item.quantity)
    : 0;
  const baseItemCost = (item.costPrice || 0) * soldQuantity;
  const addOnsCost = (item.selectedAddOns || []).reduce((sum, addon) => {
    return sum + calculateAddOnCostPerServing(addon) * soldQuantity;
  }, 0);
  return baseItemCost + addOnsCost;
}

/**
 * Tính tổng giá vốn (COGS) cho toàn bộ hóa đơn từ danh sách món bán
 */
export function calculateInvoiceCost(items: OrderItem[]): number {
  if (!items || !Array.isArray(items)) return 0;
  return items.reduce((total, item) => total + calculateOrderItemCost(item), 0);
}

export interface InvoiceCostSnapshotResult {
  totalCost: number;
  isComplete: boolean;
}

export function calculateInvoiceCostSnapshot(
  items: OrderItem[],
  getCostSource: (itemId: string, itemName?: string) => { costPrice?: number; recipe?: RecipeItem[] } | undefined
): InvoiceCostSnapshotResult {
  let totalCost = 0;
  let isComplete = true;
  const validCost = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;

  for (const item of items || []) {
    const quantity = item.quantity;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      isComplete = false;
      continue;
    }

    const source = getCostSource(item.id, item.name);

    // 1. Kiểm tra công thức định lượng: ưu tiên recipe trên item nếu có, hoặc recipe trên source trong menu
    const recipe = (item.recipe && item.recipe.length > 0)
      ? item.recipe
      : (source?.recipe && source.recipe.length > 0)
        ? source.recipe
        : null;

    if (recipe && recipe.length > 0) {
      let itemRecipeCost = 0;
      let recipeComplete = true;
      for (const r of recipe) {
        const ingSource = getCostSource(r.ingredientId, r.name);
        const ingUnitCost = ingSource?.costPrice;
        if (!validCost(ingUnitCost) || !Number.isFinite(r.quantity) || r.quantity < 0) {
          recipeComplete = false;
        } else {
          itemRecipeCost += ingUnitCost * r.quantity;
        }
      }
      if (!recipeComplete) {
        const fallbackCost = validCost(source?.costPrice) ? source.costPrice : item.costPrice;
        if (validCost(fallbackCost)) {
          totalCost += fallbackCost * quantity;
        }
        isComplete = false;
      } else {
        totalCost += itemRecipeCost * quantity;
      }
    } else {
      // 2. Không có công thức định lượng: dùng giá vốn trực tiếp (direct costPrice)
      const unitCost = validCost(source?.costPrice)
        ? source.costPrice
        : item.costPrice;

      if (!source) {
        // Nguồn không tồn tại trong hệ thống (thực đơn/kho)
        isComplete = false;
        if (validCost(unitCost)) {
          totalCost += unitCost * quantity;
        }
      } else if (!validCost(unitCost)) {
        isComplete = false;
      } else {
        totalCost += unitCost * quantity;
      }
    }

    // 3. Xử lý toppings / món ăn kèm (selectedAddOns)
    for (const addon of item.selectedAddOns || []) {
      const perServing = addon.quantity ?? 1;
      if (!Number.isFinite(perServing) || perServing < 0) {
        isComplete = false;
        continue;
      }

      if (addon.inventoryItemId) {
        const addOnSource = getCostSource(addon.inventoryItemId, addon.name);
        const addOnUnitCost = validCost(addOnSource?.costPrice)
          ? addOnSource.costPrice
          : addon.costPrice;
        if (!validCost(addOnUnitCost)) {
          isComplete = false;
        } else {
          totalCost += addOnUnitCost * perServing * quantity;
        }
      } else {
        // Tùy chọn / ghi chú / addon không gắn mã kho:
        // Nếu có giá vốn thì cộng vào; nếu không có (undefined/0) thì giá vốn = 0, không đánh dấu thiếu
        if (validCost(addon.costPrice) && addon.costPrice > 0) {
          totalCost += addon.costPrice * perServing * quantity;
        }
      }
    }
  }

  return { totalCost: Math.round(totalCost), isComplete };
}

