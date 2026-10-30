import { OrderItem, AddOnItem } from "../types";

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
  getCostSource: (itemId: string) => { costPrice?: number } | undefined
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
    if (item.recipe?.length)
      for (const recipe of item.recipe) {
        const source = getCostSource(recipe.ingredientId);
        if (
          !validCost(source?.costPrice) ||
          !Number.isFinite(recipe.quantity) ||
          recipe.quantity < 0
        ) {
          isComplete = false;
          continue;
        }
        totalCost += source.costPrice * recipe.quantity * quantity;
      }
    else {
      const source = getCostSource(item.id);
      const unitCost = validCost(source?.costPrice)
        ? source.costPrice
        : item.costPrice;
      if (!validCost(source?.costPrice)) isComplete = false;
      if (!validCost(unitCost)) isComplete = false;
      else totalCost += unitCost * quantity;
    }
    for (const addon of item.selectedAddOns || []) {
      const source = addon.inventoryItemId
        ? getCostSource(addon.inventoryItemId)
        : undefined;
      const unitCost = validCost(source?.costPrice)
        ? source.costPrice
        : addon.costPrice;
      if (addon.inventoryItemId && !validCost(source?.costPrice))
        isComplete = false;
      const perServing = addon.quantity ?? 1;
      if (
        !validCost(unitCost) ||
        !Number.isFinite(perServing) ||
        perServing < 0
      ) {
        isComplete = false;
        continue;
      }
      totalCost += unitCost * perServing * quantity;
    }
  }
  return { totalCost: Math.round(totalCost), isComplete };
}
