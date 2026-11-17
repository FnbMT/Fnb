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
  if (invoice.costStatus === "estimated" || !invoice.costStatus) return false;
  if (invoice.status === "cancelled") return true;
  if (invoice.costStatus === "complete") {
    if (
      (invoice.costVersion || 0) < 2 ||
      !Number.isFinite(invoice.totalCost) ||
      invoice.totalCost! < 0
    ) {
      return false;
    }
    // Phòng vệ: Nếu hóa đơn có doanh thu nhưng giá vốn = 0 mà có món bán không được xác minh
    if (invoice.totalCost === 0 && (invoice.subtotal > 0 || invoice.total > 0)) {
      const hasUndeclaredItem = (invoice.items || []).some(item => {
        const p = item.price || 0;
        const c = item.costPrice || 0;
        const verified = Boolean((item as any).costVerified || (item as any).isFreeCost);
        const hasRecipe = Boolean(item.recipe && item.recipe.length > 0);
        return p > 0 && c <= 0 && !hasRecipe && !verified;
      });
      if (hasUndeclaredItem) return false;
    }
    return true;
  }
  // Old invoices have no proof that every recipe/add-on had a cost at checkout.
  return false;
}
export function allocatedItemRevenue(invoice: Invoice): number[] {
  const items = invoice.items || [];
  if (!items.length) return [];
  const weights = items.map(
    (item) =>
      ((Number.isFinite(item.price) ? item.price : 0) +
        (item.selectedAddOns || []).reduce((sum, a) => sum + (Number.isFinite(a.price) ? a.price : 0), 0)) *
      (Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1)
  );
  const gross = weights.reduce((sum, n) => sum + n, 0);
  const subtotal = Number.isFinite(invoice.subtotal) ? invoice.subtotal : (Number.isFinite(invoice.total) ? invoice.total : gross);
  const discount = Number.isFinite(invoice.discount) ? (invoice.discount || 0) : 0;
  const net = Math.max(0, Math.round(subtotal - discount));
  if (gross <= 0 || !Number.isFinite(net)) return weights.map(() => 0);
  const raw = weights.map((n) => (n / gross) * net),
    allocated = raw.map(Math.floor);
  let remaining = net - allocated.reduce((sum, n) => sum + n, 0);
  const priority = raw
    .map((n, i) => ({ i, fraction: n - allocated[i] }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let index = 0; remaining > 0 && priority.length > 0; index++, remaining--)
    allocated[priority[index % priority.length].i]++;
  return allocated;
}
export function isSalesCategory(category = ""): boolean {
  return (
    typeof category === "string" && category.normalize("NFC").trim().toLocaleLowerCase("vi-VN") === "bán hàng"
  );
}
export function expenseGroup(
  category = ""
): "Inventory" | "Rent" | "Salary" | "Other" {
  const c = typeof category === "string" ? category.toLowerCase().trim() : "";
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
export const RECEIPT_RECONCILIATION_VERSION = 1;

export function validInvoiceAmount(invoice: Invoice): boolean {
  return Number.isFinite(invoice.total) && invoice.total >= 0
    && (invoice.discount == null || (Number.isFinite(invoice.discount) && invoice.discount >= 0));
}

export function validCashAmount(receipt: CashTransaction): boolean {
  return Number.isFinite(receipt.amount) && receipt.amount >= 0
    && (receipt.type === 'income' || receipt.type === 'expense');
}

export function isCashMethod(method?: string): boolean {
  return !method || method === 'cash';
}

export function salesReceiptInvoiceId(receipt: CashTransaction): string | undefined {
  if (receipt.invoiceId) return receipt.invoiceId;
  return receipt.id.startsWith('cash_') ? receipt.id.slice(5) || undefined : undefined;
}

export function matchesSalesReceipt(invoice: Invoice, receipt: CashTransaction): boolean {
  return receipt.storeId === invoice.storeId
    && receipt.type === 'income' && isSalesCategory(receipt.category)
    && validInvoiceAmount(invoice) && validCashAmount(receipt)
    && invoice.total === receipt.amount
    && isCashMethod(invoice.paymentMethod) === isCashMethod(receipt.paymentMethod)
    && businessDateOf(invoice) === businessDateOf(receipt);
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
    salesCashIncome: 0,
    salesTransferIncome: 0,
    costStatus: sales.every(invoiceCostIsComplete) ? "complete" : "estimated",
    coverageStatus: complete
      ? sales.length || cash.length
        ? "reconciled"
        : "zero_activity"
      : "partial",
    hasData: Boolean(sales.length || cash.length),
  };
  for (const inv of sales) {
    if (!validInvoiceAmount(inv))
      throw new Error(`Hóa đơn ${inv.id} có tổng tiền hoặc giảm giá không hợp lệ.`);
    stat.totalRevenue += inv.total;
    stat[
      !inv.paymentMethod || inv.paymentMethod === "cash"
        ? "totalCash"
        : "totalTransfer"
    ] += inv.total;
    stat.totalDiscount += inv.discount || 0;
    const invCost = Number.isFinite(inv.totalCost) && inv.totalCost! >= 0
      ? inv.totalCost!
      : Math.max(0, calculateInvoiceCost(inv.items || []));
    stat.totalCost! += Math.max(0, invCost);
  }
  stat.totalCost = Math.max(0, stat.totalCost || 0);
  for (const tx of cash) {
    if (!validCashAmount(tx))
      throw new Error(`Phiếu thu/chi ${tx.id} có số tiền hoặc loại giao dịch không hợp lệ.`);
    const method =
      !tx.paymentMethod || tx.paymentMethod === "cash" ? "cash" : "transfer";
    if (tx.type === "expense") {
      stat.totalExpense! += tx.amount;
      stat[`${method}Expense`]! += tx.amount;
      stat[`expense${expenseGroup(tx.category)}`]! += tx.amount;
    } else if (isSalesCategory(tx.category)) {
      stat[method === "cash" ? "salesCashIncome" : "salesTransferIncome"]! += tx.amount;
    } else {
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
    const rows = invoiceDays.get(day);
    if (rows) rows.push(invoice);
    else invoiceDays.set(day, [invoice]);
  }
  for (const tx of cash) {
    const day = businessDateOf(tx);
    const rows = cashDays.get(day);
    if (rows) rows.push(tx);
    else cashDays.set(day, [tx]);
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
export function receiptMismatch(invoices: Invoice[], cash: CashTransaction[]): string {
  const sales = invoices.filter(invoice => invoice.status !== 'cancelled');
  const salesMap = new Map(sales.map(invoice => [invoice.id, invoice]));
  const matchedInvoiceIds = new Set<string>();
  const unmatchedReceipts: CashTransaction[] = [];

  // 1. Khớp các phiếu thu bán hàng có sẵn liên kết invoiceId
  for (const receipt of cash) {
    if (receipt.type !== 'income' || !isSalesCategory(receipt.category)) continue;
    const invoiceId = salesReceiptInvoiceId(receipt);
    if (invoiceId && salesMap.has(invoiceId)) {
      const invoice = salesMap.get(invoiceId)!;
      if (matchedInvoiceIds.has(invoiceId)) {
        return `Hóa đơn ${invoiceId} có nhiều phiếu thu bán hàng.`;
      }
      try {
        if (!matchesSalesReceipt(invoice, receipt))
          return `Phiếu thu ${receipt.id} lệch số tiền, phương thức hoặc ngày so với hóa đơn ${invoiceId}.`;
      } catch (error) {
        return `Không thể xác nhận ngày của phiếu thu ${receipt.id} và hóa đơn ${invoiceId}.`;
      }
      matchedInvoiceIds.add(invoiceId);
    } else {
      unmatchedReceipts.push(receipt);
    }
  }

  // 2. Đối soát dữ liệu cũ (legacy): Tự động khớp 1-1 theo (storeId, ngày kinh doanh, số tiền, PTTT, bàn)
  const availableInvoices = sales.filter(inv => !matchedInvoiceIds.has(inv.id));
  for (const receipt of unmatchedReceipts) {
    let receiptDay = '';
    try { receiptDay = businessDateOf(receipt); }
    catch { return `Phiếu thu ${receipt.id} thiếu ngày hợp lệ.`; }

    // Tìm hóa đơn phù hợp nhất: cùng quán, cùng ngày, cùng số tiền, cùng hình thức thanh toán
    let candidateIdx = -1;

    // Ưu tiên 1: Khớp thêm cả tên bàn ghi trong note (ví dụ "Thanh toán bàn Bàn 1")
    if (receipt.note) {
      candidateIdx = availableInvoices.findIndex(inv => {
        let invDay = '';
        try { invDay = businessDateOf(inv); } catch { return false; }
        return inv.storeId === receipt.storeId &&
          invDay === receiptDay &&
          inv.total === receipt.amount &&
          isCashMethod(inv.paymentMethod) === isCashMethod(receipt.paymentMethod) &&
          Boolean(inv.tableName && receipt.note && receipt.note.includes(inv.tableName));
      });
    }

    // Ưu tiên 2: Khớp 1-1 theo ngày, số tiền và PTTT
    if (candidateIdx < 0) {
      candidateIdx = availableInvoices.findIndex(inv => {
        let invDay = '';
        try { invDay = businessDateOf(inv); } catch { return false; }
        return inv.storeId === receipt.storeId &&
          invDay === receiptDay &&
          inv.total === receipt.amount &&
          isCashMethod(inv.paymentMethod) === isCashMethod(receipt.paymentMethod);
      });
    }

    if (candidateIdx >= 0) {
      const matched = availableInvoices.splice(candidateIdx, 1)[0];
      matchedInvoiceIds.add(matched.id);
    } else {
      const invoiceId = salesReceiptInvoiceId(receipt);
      if (invoiceId) {
        return `Phiếu thu ${receipt.id} không có hóa đơn ${invoiceId} tương ứng trong kỳ.`;
      }
      return `Phiếu thu ${receipt.id} (${receipt.amount.toLocaleString('vi-VN')}đ) chưa khớp hóa đơn tương ứng trong kỳ. Cần xác nhận chứng từ gốc.`;
    }
  }

  for (const invoice of sales) {
    if (!matchedInvoiceIds.has(invoice.id)) {
      return `Hóa đơn ${invoice.id} (${invoice.total.toLocaleString('vi-VN')}đ) thiếu phiếu thu bán hàng đã xác nhận.`;
    }
  }
  return '';
}

export function reconcileDay(storeId: string, day: string, invoices: Invoice[], cash: CashTransaction[]): DailyStats {
  for (const row of [...invoices, ...cash]) {
    if (row.storeId !== storeId || businessDateOf(row) !== day) {
      throw new Error(`Chứng từ ${row.id} có ngày hoặc cửa hàng không khớp.`);
    }
  }
  const mismatch = receiptMismatch(invoices, cash);
  if (mismatch) throw new Error(mismatch);
  return {
    ...aggregateDay(storeId, day, invoices, cash, true),
    receiptReconciliationVersion: RECEIPT_RECONCILIATION_VERSION,
  };
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

export function computeAttendanceFingerprint(records: AttendanceRecord[]): string {
  const sorted = [...records].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  return sorted
    .map(r => `${r.id}:${r.date}:${r.checkInTime || ''}:${r.checkOutTime || ''}:${r.status || ''}`)
    .join('|');
}

