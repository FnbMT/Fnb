import type {
  CashTransaction,
  DailyStats,
  Invoice,
  OrderItem,
  OrderSession,
  AttendanceRecord,
} from "../types";
import { getVietnamBusinessDate } from "./firestoreDateHelper";
import { calculateInvoiceCost } from "./costHelper";

// Orders contain plain Firestore data. Avoid structuredClone, which is absent
// from the early iOS 15 WebViews still allowed by this project's native target.
export function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneData) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) output[key] = cloneData(child);
    return output as T;
  }
  return value;
}

export function operationId(prefix = "op"): string {
  const random =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
export function stockQuantity(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Số lượng kho không hợp lệ.");
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
export function businessDateOf(value: {
  businessDate?: string;
  date?: string;
}): string {
  if (value.businessDate && /^\d{4}-\d{2}-\d{2}$/.test(value.businessDate))
    return value.businessDate;
  if (!value.date || !Number.isFinite(Date.parse(value.date)))
    throw new Error(
      "Có chứng từ thiếu ngày hợp lệ; cần đối soát trước khi chốt báo cáo."
    );
  return getVietnamBusinessDate(value.date);
}
export function itemKey(item: OrderItem): string {
  return JSON.stringify([
    item.id,
    item.type,
    item.price,
    item.note || "",
    (item.recipe || [])
      .map((r) => [r.ingredientId, r.quantity, r.unit])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    (item.selectedAddOns || [])
      .map((a) => [a.id, a.inventoryItemId || "", a.price, a.quantity ?? 1])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
}
export function orderSignature(order: OrderSession): string {
  return JSON.stringify({
    subtotal: order.subtotal,
    discount: order.discount || 0,
    items: order.items
      .map((i) => [itemKey(i), i.quantity])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}
export function itemsSubtotal(items: OrderItem[]): number {
  return Math.round(
    items.reduce((sum, item) => {
      if (
        !Number.isFinite(item.quantity) ||
        item.quantity <= 0 ||
        !Number.isFinite(item.price) ||
        item.price < 0
      )
        throw new Error("Số lượng hoặc giá món không hợp lệ.");
      const extras = (item.selectedAddOns || []).reduce((s, a) => {
        if (!Number.isFinite(a.price) || a.price < 0)
          throw new Error("Giá món kèm không hợp lệ.");
        return s + a.price;
      }, 0);
      return sum + (item.price + extras) * item.quantity;
    }, 0)
  );
}
export function invoiceCostIsComplete(invoice: Invoice): boolean {
  if (invoice.costStatus === "estimated") return false;
  if (invoice.costStatus === "complete")
    return (
      (invoice.costVersion || 0) >= 2 &&
      Number.isFinite(invoice.totalCost) &&
      invoice.totalCost! >= 0
    );
  // Old invoices have no proof that every recipe/add-on had a cost at checkout.
  return false;
}
export function allocatedItemRevenue(invoice: Invoice): number[] {
  const items = invoice.items || [];
  const weights = items.map(
    (item) =>
      (item.price +
        (item.selectedAddOns || []).reduce((sum, a) => sum + a.price, 0)) *
      item.quantity
  );
  const gross = weights.reduce((sum, n) => sum + n, 0),
    net = Math.max(0, Math.round(invoice.subtotal - (invoice.discount || 0)));
  if (gross <= 0) return weights.map(() => 0);
  const raw = weights.map((n) => (n / gross) * net),
    allocated = raw.map(Math.floor);
  let remaining = net - allocated.reduce((sum, n) => sum + n, 0);
  const priority = raw
    .map((n, i) => ({ i, fraction: n - allocated[i] }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let index = 0; remaining > 0; index++, remaining--)
    allocated[priority[index % priority.length].i]++;
  return allocated;
}
export function isSalesCategory(category = ""): boolean {
  return (
    category.normalize("NFC").trim().toLocaleLowerCase("vi-VN") === "bán hàng"
  );
}
export function expenseGroup(
  category = ""
): "Inventory" | "Rent" | "Salary" | "Other" {
  const c = category.toLowerCase().trim();
  if (
    c.includes("nhập hàng") ||
    c.includes("mua hàng") ||
    c.includes("nguyên liệu")
  )
    return "Inventory";
  if (
    c.includes("mặt bằng") ||
    c.includes("thuê nhà") ||
    c.includes("tiền nhà")
  )
    return "Rent";
  if (c.includes("lương") || c.includes("nhân sự") || c.includes("nhân viên"))
    return "Salary";
  return "Other";
}
export function aggregateDay(
  storeId: string,
  date: string,
  invoices: Invoice[],
  cash: CashTransaction[],
  complete: boolean
): DailyStats {
  const sales = invoices.filter((i) => i.status !== "cancelled");
  const stat: DailyStats = {
    id: `${storeId}_${date}`,
    storeId,
    date,
    month: date.slice(0, 7),
    year: Number(date.slice(0, 4)),
    totalRevenue: 0,
    totalCash: 0,
    totalTransfer: 0,
    invoiceCount: sales.length,
    totalDiscount: 0,
    totalCost: 0,
    totalIncome: 0,
    totalExpense: 0,
    cashIncome: 0,
    transferIncome: 0,
    cashExpense: 0,
    transferExpense: 0,
    expenseInventory: 0,
    expenseRent: 0,
    expenseSalary: 0,
    expenseOther: 0,
    cashCount: cash.length,
    costStatus: sales.every(invoiceCostIsComplete) ? "complete" : "estimated",
    coverageStatus: complete
      ? sales.length || cash.length
        ? "reconciled"
        : "zero_activity"
      : "partial",
    hasData: Boolean(sales.length || cash.length),
  };
  for (const inv of sales) {
    if (!Number.isFinite(inv.total) || inv.total < 0)
      throw new Error("Hóa đơn có tổng tiền không hợp lệ.");
    stat.totalRevenue += inv.total;
    stat[
      !inv.paymentMethod || inv.paymentMethod === "cash"
        ? "totalCash"
        : "totalTransfer"
    ] += inv.total;
    stat.totalDiscount += inv.discount || 0;
    stat.totalCost! += Number.isFinite(inv.totalCost)
      ? inv.totalCost!
      : calculateInvoiceCost(inv.items || []);
  }
  for (const tx of cash) {
    if (!Number.isFinite(tx.amount) || tx.amount < 0)
      throw new Error("Phiếu thu/chi có số tiền không hợp lệ.");
    const method =
      !tx.paymentMethod || tx.paymentMethod === "cash" ? "cash" : "transfer";
    if (tx.type === "expense") {
      stat.totalExpense! += tx.amount;
      stat[`${method}Expense`]! += tx.amount;
      stat[`expense${expenseGroup(tx.category)}`]! += tx.amount;
    } else if (tx.type === "income" && !isSalesCategory(tx.category)) {
      stat.totalIncome! += tx.amount;
      stat[`${method}Income`]! += tx.amount;
    }
  }
  stat.invoicesTotalCount = stat.invoiceCount;
  stat.cashTransactionsTotalCount = cash.length;
  return stat;
}
export function dailyStatsFromSources(
  storeId: string,
  dates: string[],
  invoices: Invoice[],
  cash: CashTransaction[],
  complete: boolean
): DailyStats[] {
  const invoiceDays = new Map<string, Invoice[]>();
  const cashDays = new Map<string, CashTransaction[]>();
  for (const invoice of invoices) {
    const day = businessDateOf(invoice);
    invoiceDays.set(day, [...(invoiceDays.get(day) || []), invoice]);
  }
  for (const tx of cash) {
    const day = businessDateOf(tx);
    cashDays.set(day, [...(cashDays.get(day) || []), tx]);
  }
  return dates.map((day) =>
    aggregateDay(
      storeId,
      day,
      invoiceDays.get(day) || [],
      cashDays.get(day) || [],
      complete
    )
  );
}
export function receiptMismatch(
  invoices: Invoice[],
  cash: CashTransaction[]
): string {
  const sales = invoices.filter((i) => i.status !== "cancelled");
  const receipts = cash.filter(
    (c) => c.type === "income" && isSalesCategory(c.category)
  );
  const invoiceIds = new Set(sales.map((i) => i.id));
  const linked = new Map<string, number>();
  for (const receipt of receipts) {
    const id = (receipt as any).invoiceId as string | undefined;
    if (id) {
      if (!invoiceIds.has(id))
        return "Có phiếu thu bán hàng không còn hóa đơn tương ứng. Cần đối soát chứng từ gốc.";
      linked.set(id, (linked.get(id) || 0) + 1);
    }
  }
  if ([...linked.values()].some((count) => count > 1))
    return "Có nhiều phiếu thu bán hàng liên kết cùng một hóa đơn. Cần kiểm tra giao dịch trùng.";
  for (const cashMethod of [true, false]) {
    const matches = (method?: string) =>
      (!method || method === "cash") === cashMethod;
    const expected = sales
      .filter((i) => matches(i.paymentMethod))
      .reduce((sum, i) => sum + i.total, 0);
    const actual = receipts
      .filter((c) => matches(c.paymentMethod))
      .reduce((sum, c) => sum + c.amount, 0);
    if (Math.abs(expected - actual) > 0.5)
      return "Tổng hóa đơn và phiếu thu bán hàng chưa khớp theo phương thức thanh toán. Số liệu chưa được chốt đối soát.";
  }
  return "";
}
export function attendanceTotals(records: AttendanceRecord[]) {
  const dayWeights = new Map<string, number>();
  const intervals = new Map<string, [number, number][]>();
  let hasOpenSession = false;
  for (const r of records) {
    if (!["present", "late", "half-day"].includes(r.status)) continue;
    dayWeights.set(
      r.date,
      Math.max(dayWeights.get(r.date) || 0, r.status === "half-day" ? 0.5 : 1)
    );
    const start = Date.parse(r.checkInTime || "");
    const end = Date.parse(r.checkOutTime || "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      hasOpenSession = true;
      continue;
    }
    intervals.set(r.date, [...(intervals.get(r.date) || []), [start, end]]);
  }
  let totalHours = 0;
  for (const day of intervals.values()) {
    const sorted = day.sort((a, b) => a[0] - b[0]);
    let start = sorted[0][0],
      end = sorted[0][1];
    for (const [s, e] of sorted.slice(1)) {
      if (s <= end) end = Math.max(end, e);
      else {
        totalHours += (end - start) / 3600000;
        start = s;
        end = e;
      }
    }
    totalHours += (end - start) / 3600000;
  }
  return {
    presentDays: [...dayWeights.values()].reduce((s, n) => s + n, 0),
    totalHours,
    hasOpenSession,
  };
}
