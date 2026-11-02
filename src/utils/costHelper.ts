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

export type CostSourceItem = {
  costPrice?: number;
  price?: number;
  recipe?: RecipeItem[];
  costVerified?: boolean;
  isFreeCost?: boolean;
};

/**
 * Kiểm tra xem một mức giá vốn đã thực sự được khai báo/xác minh hay chưa.
 * Không được mặc định costPrice = 0 nghĩa là đã xác minh.
 * Giá vốn 0 chỉ được coi là hoàn tất khi:
 * 1. Chủ quán đã chủ động gắn cờ xác minh (costVerified hoặc isFreeCost)
 * 2. HOẶC món ăn/dịch vụ là hoàn toàn miễn phí (sellingPrice === 0 và costPrice === 0)
 */
export function isCostExplicitlyVerified(
  costPrice: number | undefined | null,
  sellingPrice: number = 0,
  isExplicitlyVerified: boolean = false
): boolean {
  if (typeof costPrice === "number" && Number.isFinite(costPrice) && costPrice > 0) {
    return true;
  }
  if (isExplicitlyVerified) {
    return true;
  }
  if (sellingPrice === 0 && costPrice === 0) {
    return true;
  }
  return false;
}

export function calculateInvoiceCostSnapshot(
  items: OrderItem[],
  getCostSource: (itemId: string, itemName?: string) => CostSourceItem | undefined
): InvoiceCostSnapshotResult {
  let totalCost = 0;
  let isComplete = true;

  for (const item of items || []) {
    const quantity = item.quantity;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      isComplete = false;
      continue;
    }

    const source = getCostSource(item.id, item.name);
    const itemSellingPrice = typeof item.price === "number" ? item.price : (source?.price ?? 0);
    const isItemExplicitlyVerified = Boolean(
      (item as any).costVerified ||
      (item as any).isFreeCost ||
      source?.costVerified ||
      source?.isFreeCost
    );

    // 1. Kiểm tra công thức định lượng (recipe): ưu tiên recipe trên item nếu có, hoặc recipe trên source trong menu
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
        const ingVerified = Boolean((r as any).costVerified || ingSource?.costVerified);
        
        // Nguyên liệu trong công thức bắt buộc phải có giá vốn > 0 hoặc đã xác minh
        const ingDeclared = (typeof ingUnitCost === "number" && Number.isFinite(ingUnitCost) && ingUnitCost > 0) || ingVerified;
        if (!ingDeclared || !Number.isFinite(r.quantity) || r.quantity <= 0) {
          recipeComplete = false;
        } else {
          itemRecipeCost += (ingUnitCost || 0) * r.quantity;
        }
      }

      if (!recipeComplete) {
        // Nếu công thức chưa đủ dữ liệu, thử dùng giá vốn trực tiếp nếu có
        const fallbackCost = (typeof item.costPrice === "number" && item.costPrice > 0)
          ? item.costPrice
          : (typeof source?.costPrice === "number" && source.costPrice > 0)
            ? source.costPrice
            : 0;
        if (fallbackCost > 0) {
          totalCost += fallbackCost * quantity;
        }
        isComplete = false;
      } else {
        totalCost += itemRecipeCost * quantity;
      }
    } else {
      // 2. Không có công thức định lượng: dùng giá vốn trực tiếp (direct costPrice)
      // NGUYÊN TẮC: Ưu tiên giá vốn đã xác minh tại thời điểm bán (item.costPrice > 0) nếu có
      let unitCost: number | undefined = undefined;
      if (typeof item.costPrice === "number" && Number.isFinite(item.costPrice) && item.costPrice > 0) {
        unitCost = item.costPrice;
      } else if (typeof source?.costPrice === "number" && Number.isFinite(source.costPrice) && source.costPrice > 0) {
        unitCost = source.costPrice;
      } else if (item.costPrice === 0 || source?.costPrice === 0) {
        unitCost = 0;
      }

      const isVerified = isCostExplicitlyVerified(unitCost, itemSellingPrice, isItemExplicitlyVerified);
      if (!isVerified) {
        isComplete = false;
      }
      if (typeof unitCost === "number" && unitCost > 0) {
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

      const addonSellingPrice = typeof addon.price === "number" ? addon.price : 0;
      const addonExplicitlyVerified = Boolean((addon as any).costVerified || (addon as any).isFreeCost);

      if (addon.inventoryItemId) {
        const addOnSource = getCostSource(addon.inventoryItemId, addon.name);
        const addOnUnitCost = (typeof addon.costPrice === "number" && addon.costPrice > 0)
          ? addon.costPrice
          : (typeof addOnSource?.costPrice === "number" && addOnSource.costPrice > 0)
            ? addOnSource.costPrice
            : (addon.costPrice === 0 || addOnSource?.costPrice === 0)
              ? 0
              : undefined;

        const isAddonVerified = isCostExplicitlyVerified(
          addOnUnitCost,
          addonSellingPrice,
          addonExplicitlyVerified || Boolean(addOnSource?.costVerified)
        );

        if (!isAddonVerified) {
          isComplete = false;
        }
        if (typeof addOnUnitCost === "number" && addOnUnitCost > 0) {
          totalCost += addOnUnitCost * perServing * quantity;
        }
      } else {
        // Topping không gắn mã kho:
        // Thử tìm nguồn theo tên món trong hệ thống
        const addOnSource = getCostSource('', addon.name);
        let addOnUnitCost = (typeof addon.costPrice === "number" && addon.costPrice > 0)
          ? addon.costPrice
          : (typeof addOnSource?.costPrice === "number" && addOnSource.costPrice > 0)
            ? addOnSource.costPrice
            : undefined;

        if (typeof addOnUnitCost === "number" && addOnUnitCost > 0) {
          totalCost += addOnUnitCost * perServing * quantity;
        } else if (addonSellingPrice > 0 && !addonExplicitlyVerified && !addOnSource?.costVerified) {
          // Bắt buộc đánh dấu thiếu giá vốn đối với topping có thu tiền khách mà chưa có giá vốn
          isComplete = false;
        }
      }
    }
  }

  return { totalCost: Math.round(totalCost), isComplete };
}

