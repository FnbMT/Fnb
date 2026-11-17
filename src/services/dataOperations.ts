import {
  collection,
  doc,
  runTransaction,
  increment,
  deleteField,
  arrayUnion,
  query,
  where,
  limit,
  getDocs,
  getDoc,
  getDocFromServer,
  getDocsFromServer,
  updateDoc,
  type Transaction,
  type DocumentReference,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import type {
  CashTransaction,
  InventoryAudit,
  MenuItem,
  OrderItem,
  OrderSession,
  Table,
  User,
  Invoice,
  Shift,
  VoidLog,
  AttendanceRecord,
  PayrollRecord,
} from "../types";
import {
  operationId,
  cloneData,
  stockQuantity,
  itemKey,
  itemsSubtotal,
  orderSignature,
  expenseGroup,
  businessDateOf,
  isSalesCategory,
  matchesSalesReceipt,
  salesReceiptInvoiceId,
  attendanceTotals,
  computeAttendanceFingerprint,
} from "../utils/dataIntegrity";
import { getVietnamBusinessDate, getVietnamYesterdayDate, getVietnamEndOfDayIso } from "../utils/firestoreDateHelper";
import {
  fetchStoreRows,
  fetchMatchingStoreRows,
  fetchDateRangeRows,
} from "../utils/completeDataSource";

function owns(data: any, storeId: string) {
  if (!data || data.storeId !== storeId)
    throw new Error("Dữ liệu không thuộc cửa hàng hiện tại.");
}
function validAmount(amount: number) {
  if (!Number.isFinite(amount) || amount < 0)
    throw new Error("Số tiền không hợp lệ.");
}
async function readOpenShift(txn: Transaction, user: User, shiftId?: string) {
  if (!shiftId) return undefined;
  const ref = doc(db, "shifts", shiftId);
  const snapshot = await txn.get(ref);
  const data = snapshot.data();
  owns(data, user.storeId);
  if (data!.status !== "open")
    throw new Error(
      "Ca đã đóng ở thiết bị khác. Vui lòng mở lại ca hợp lệ trước khi ghi giao dịch."
    );
  return ref;
}
function cashStatsPayload(
  user: User,
  tx: Omit<CashTransaction, "id" | "storeId">
) {
  const day = businessDateOf(tx);
  const payload: Record<string, any> = {
    storeId: user.storeId,
    date: day,
    month: day.slice(0, 7),
    year: Number(day.slice(0, 4)),
    cashCount: increment(1),
    sourceRevision: increment(1),
    updatedAt: new Date().toISOString(),
  };
  const method =
    !tx.paymentMethod || tx.paymentMethod === "cash" ? "cash" : "transfer";
  if (tx.type === "expense") {
    payload.totalExpense = increment(tx.amount);
    payload[`${method}Expense`] = increment(tx.amount);
    payload[`expense${expenseGroup(tx.category)}`] = increment(tx.amount);
  } else if (!isSalesCategory(tx.category)) {
    payload.totalIncome = increment(tx.amount);
    payload[`${method}Income`] = increment(tx.amount);
  }
  return payload;
}
function writeCash(
  txn: Transaction,
  user: User,
  tx: Omit<CashTransaction, "id" | "storeId">,
  ref: DocumentReference,
  statsRef: DocumentReference,
  shiftRef?: DocumentReference
) {
  const day = businessDateOf(tx);
  txn.set(ref, {
    ...tx,
    storeId: user.storeId,
    businessDate: day,
    businessMonth: day.slice(0, 7),
    businessYear: Number(day.slice(0, 4)),
    shiftId: shiftRef?.id,
  });
  txn.set(statsRef, cashStatsPayload(user, tx), { merge: true });
  if (shiftRef) {
    const cash = !tx.paymentMethod || tx.paymentMethod === "cash";
    const income = tx.type === "income";
    txn.update(shiftRef, {
      totalCash: increment(cash ? (income ? tx.amount : -tx.amount) : 0),
      totalTransfer: increment(cash ? 0 : income ? tx.amount : -tx.amount),
      cashIncome: increment(cash && income ? tx.amount : 0),
      cashExpense: increment(cash && !income ? tx.amount : 0),
      transferIncome: increment(!cash && income ? tx.amount : 0),
      transferExpense: increment(!cash && !income ? tx.amount : 0),
    });
  }
}

export async function addOrderAtomic(
  user: User,
  tableId: string,
  items: OrderItem[],
  targetId: string | undefined,
  vatPercent: number,
  id: string
): Promise<string> {
  itemsSubtotal(items);
  const tableRef = doc(db, "tables", tableId),
    opRef = doc(db, "checkout_locks", `order_${user.storeId}_${id}`);
  const now = new Date().toISOString(),
    sessionId = `session-${id}`;
  return runTransaction(db, async (txn) => {
    const [op, snap] = await Promise.all([txn.get(opRef), txn.get(tableRef)]);
    owns(snap.data(), user.storeId);
    const requestSignature = JSON.stringify({
      tableId,
      targetId: targetId || "",
      items: items.map((i) => [itemKey(i), i.quantity]),
      vatPercent,
    });
    if (op.exists()) {
      if (op.data().requestSignature !== requestSignature)
        throw new Error(
          "Mã thao tác đã dùng cho một nội dung khác. Vui lòng mở lại đơn."
        );
      return op.data().sessionId as string;
    }
    const table = snap.data() as Table;
    const orders = cloneData(table.orders || []);
    let target = targetId ? orders.find((o) => o.id === targetId) : undefined;
    if (targetId && (!target || target.status === "paid"))
      throw new Error(
        "Đơn đã thanh toán hoặc vừa chuyển bàn. Vui lòng mở lại bàn."
      );
    if (!target) {
      target = {
        id: sessionId,
        items: [],
        subtotal: 0,
        discount: 0,
        vat: vatPercent,
        total: 0,
        status: "pending",
        startTime: now,
        staffId: user.id,
      };
      orders.push(target);
    }
    target.items = target.items.map((line, index) => ({
      ...line,
      lineId: line.lineId || `${target!.id}-line-${index}`,
    }));
    for (const [index, incoming] of items.entries()) {
      const existing = target.items.find(
        (i) => itemKey(i) === itemKey(incoming) && !i.isCompleted
      );
      if (existing) existing.quantity += incoming.quantity;
      else
        target.items.push({
          ...incoming,
          lineId: `${id}-line-${index}`,
          isCompleted: false,
        });
    }
    target.subtotal = itemsSubtotal(target.items);
    target.discount = Math.min(
      target.subtotal,
      Math.max(0, target.discount || 0)
    );
    target.vat = vatPercent;
    target.total =
      target.subtotal -
      target.discount +
      Math.round(((target.subtotal - target.discount) * vatPercent) / 100);
    // Newly added portions must be visible to the kitchen even on a ready session.
    target.status = "pending";
    txn.update(tableRef, {
      orders,
      status: "occupied",
      currentOrder: [],
      startTime: table.startTime || now,
    });
    txn.set(opRef, {
      storeId: user.storeId,
      type: "add_order",
      sessionId: target.id,
      requestSignature,
      completedAt: now,
      status: "completed",
    });
    return target.id;
  });
}

export async function updateOrdersAtomic(
  user: User,
  tableId: string,
  base: OrderSession[],
  desired: OrderSession[],
  kitchenOnly = false,
  voidLog?: VoidLog,
  shiftId?: string
) {
  const ref = doc(db, "tables", tableId);
  const voidRef = voidLog
    ? doc(db, "checkout_locks", `void_${user.storeId}_${operationId()}`)
    : undefined;
  await runTransaction(db, async (txn) => {
    const snap = await txn.get(ref);
    owns(snap.data(), user.storeId);
    const shift = voidLog ? await readOpenShift(txn, user, shiftId) : undefined;
    const server = (snap.data()!.orders || []) as OrderSession[];
    const before = new Map(base.map((o) => [o.id, o]));
    const after = new Map(desired.map((o) => [o.id, o]));
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (id) => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))
    );
    const result = cloneData(server);
    for (const id of changed) {
      const old = before.get(id),
        next = after.get(id),
        index = result.findIndex((o) => o.id === id);
      if (!old || index < 0 || result[index].status === "paid")
        throw new Error(
          "Đơn vừa thay đổi hoặc đã thanh toán. Vui lòng mở lại bàn."
        );
      if (orderSignature(result[index]) !== orderSignature(old))
        throw new Error(
          "Món vừa thay đổi ở thiết bị khác. Không ghi đè dữ liệu mới; vui lòng mở lại bàn."
        );
      if (kitchenOnly) {
        if (!next) throw new Error("Bếp không được xóa đơn.");
        const current = result[index];
        const identity = (line: OrderItem, i: number) =>
          line.lineId || `${itemKey(line)}#${i}`;
        const baseLines = new Map(
          old.items.map((line, i) => [identity(line, i), line])
        );
        const nextLines = new Map(
          next.items.map((line, i) => [identity(line, i), line])
        );
        const items = current.items.map((line, i) => {
          const key = identity(line, i),
            beforeLine = baseLines.get(key),
            afterLine = nextLines.get(key);
          if (!beforeLine || !afterLine)
            throw new Error(
              "Dòng món đã thay đổi. Vui lòng tải lại màn hình bếp."
            );
          // Only apply the bit changed by this action; preserve another cook's work.
          return {
            ...line,
            isCompleted:
              Boolean(beforeLine.isCompleted) !== Boolean(afterLine.isCompleted)
                ? Boolean(afterLine.isCompleted)
                : Boolean(line.isCompleted),
          };
        });
        let status = current.status;
        if (next.status !== old.status) {
          if (current.status !== old.status && current.status !== next.status)
            throw new Error(
              "Trạng thái đơn vừa đổi ở thiết bị khác. Vui lòng kiểm tra lại."
            );
          status = next.status;
        }
        if (items.every((i) => i.isCompleted) && status !== "completed")
          status = "ready";
        else if (!items.every((i) => i.isCompleted) && status === "ready")
          status = "cooking";
        result[index] = { ...current, status, items };
      } else if (!next || next.items.length === 0) result.splice(index, 1);
      else {
        const subtotal = itemsSubtotal(next.items),
          discount = Math.min(subtotal, Math.max(0, next.discount || 0));
        const current = result[index];
        const items = next.items.map((line) => {
          const previous = current.items.find(
            (oldLine) => oldLine.lineId && oldLine.lineId === line.lineId
          );
          return {
            ...line,
            isCompleted: Boolean(
              previous &&
                itemKey(previous) === itemKey(line) &&
                line.quantity <= previous.quantity &&
                previous.isCompleted
            ),
          };
        });
        result[index] = {
          ...current,
          ...next,
          items,
          status: items.some((i) => !i.isCompleted)
            ? "pending"
            : current.status,
          subtotal,
          discount,
          total:
            subtotal -
            discount +
            Math.round(((subtotal - discount) * (next.vat || 0)) / 100),
        };
      }
    }
    txn.update(ref, {
      orders: result,
      status: result.length ? "occupied" : "empty",
      ...(result.length
        ? {}
        : { startTime: deleteField(), note: deleteField() }),
    });
    if (voidRef && voidLog)
      txn.set(voidRef, {
        storeId: user.storeId,
        type: "item_void",
        tableId,
        ...voidLog,
      });
    if (shift && voidLog) txn.update(shift, { voidLogs: arrayUnion(voidLog) });
  });
}

export async function moveTablesAtomic(
  user: User,
  targetId: string,
  sourceIds: string[],
  transfer: boolean,
  id: string
) {
  if (!sourceIds.length || sourceIds.includes(targetId))
    throw new Error("Bàn nguồn/đích không hợp lệ.");
  const sources = [...new Set(sourceIds)];
  const requestSignature = JSON.stringify({
    targetId,
    sourceIds: [...sources].sort(),
    transfer,
  });
  if (sources.length > 100)
    throw new Error("Vui lòng gộp tối đa 100 bàn mỗi lần.");
  const opRef = doc(db, "checkout_locks", `move_${user.storeId}_${id}`),
    targetRef = doc(db, "tables", targetId);
  await runTransaction(db, async (txn) => {
    const op = await txn.get(opRef);
    if (op.exists()) {
      owns(op.data(), user.storeId);
      if (op.data().requestSignature !== requestSignature)
        throw new Error(
          "Mã gộp/chuyển bàn đã dùng cho lựa chọn khác. Vui lòng kiểm tra lại các bàn."
        );
      return;
    }
    const targetSnap = await txn.get(targetRef);
    owns(targetSnap.data(), user.storeId);
    const target = targetSnap.data() as Table;
    if (
      transfer &&
      (target.status !== "empty" ||
        target.orders?.length ||
        target.currentOrder?.length)
    )
      throw new Error("Bàn đích vừa có khách. Vui lòng chọn bàn khác.");
    const readSources = [];
    for (const sourceId of sources) {
      const ref = doc(db, "tables", sourceId),
        snap = await txn.get(ref);
      owns(snap.data(), user.storeId);
      const table = snap.data() as Table;
      if (!table.orders?.length || table.currentOrder?.length)
        throw new Error(
          "Bàn nguồn đã thay đổi hoặc còn món nháp. Vui lòng kiểm tra lại."
        );
      readSources.push({ ref, table });
    }
    const orders = [
      ...(target.orders || []),
      ...readSources.flatMap((s) => s.table.orders || []),
    ];
    if (new Set(orders.map((o) => o.id)).size !== orders.length)
      throw new Error(
        "Phát hiện đơn trùng giữa các bàn; cần kiểm tra trước khi gộp."
      );
    const startTimes = orders
      .map((o) => o.startTime)
      .filter(Boolean)
      .sort();
    txn.update(targetRef, {
      orders,
      currentOrder: [],
      status: "occupied",
      startTime: startTimes[0] || new Date().toISOString(),
      note: [
        target.note,
        ...readSources.map(
          (s) =>
            `${transfer ? "Chuyển" : "Gộp"} từ ${s.table.name}${
              s.table.note ? ": " + s.table.note : ""
            }`
        ),
      ]
        .filter(Boolean)
        .join("; "),
      ...(transfer
        ? {
            discount: readSources[0].table.discount || 0,
            customerId: readSources[0].table.customerId || deleteField(),
          }
        : {}),
    });
    for (const { ref } of readSources)
      txn.update(ref, {
        orders: [],
        currentOrder: [],
        status: "empty",
        startTime: deleteField(),
        note: deleteField(),
        customerId: deleteField(),
        discount: 0,
        lastCommittedTotal: deleteField(),
      });
    txn.set(opRef, {
      storeId: user.storeId,
      type: "move_tables",
      targetId,
      sourceIds: sources,
      requestSignature,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  });
}

export async function recordCashAtomic(
  user: User,
  input: Omit<CashTransaction, "id" | "storeId">,
  shiftId: string | undefined,
  id: string
) {
  validAmount(input.amount);
  if (input.amount <= 0) throw new Error("Số tiền phải lớn hơn 0.");
  if (isSalesCategory(input.category))
    throw new Error(
      "Phiếu bán hàng được tạo tự động từ hóa đơn. Vui lòng dùng hạng mục thu khác cho khoản thu thủ công."
    );
  const tx = { ...input, date: input.date || new Date().toISOString() },
    day = businessDateOf(tx);
  const requestSignature = JSON.stringify({
    type: tx.type,
    amount: tx.amount,
    paymentMethod: tx.paymentMethod,
    category: tx.category,
    note: tx.note || "",
    date: tx.date,
  });
  const ref = doc(db, "cash_transactions", `manual_${id}`),
    statsRef = doc(db, "daily_stats", `${user.storeId}_${day}`);
  await runTransaction(db, async (txn) => {
    const existing = await txn.get(ref);
    await txn.get(statsRef);
    if (existing.exists()) {
      owns(existing.data(), user.storeId);
      if (existing.data().requestSignature !== requestSignature)
        throw new Error(
          "Phiếu đã lưu với nội dung khác. Vui lòng kiểm tra sổ quỹ trước khi tạo phiếu mới."
        );
      return;
    }
    const shift = await readOpenShift(txn, user, shiftId);
    writeCash(txn, user, tx, ref, statsRef, shift);
    txn.set(ref, { requestSignature }, { merge: true });
  });
}

export async function importStockAtomic(
  user: User,
  itemId: string,
  quantity: number,
  unitPrice: number,
  shiftId: string | undefined,
  id: string,
  paymentMethod: 'cash' | 'transfer' = 'cash'
) {
  if (!Number.isFinite(quantity) || quantity <= 0)
    throw new Error("Lượng nhập phải lớn hơn 0.");
  validAmount(unitPrice);
  quantity = stockQuantity(quantity);
  if (quantity <= 0)
    throw new Error(
      "Lượng nhập nhỏ hơn độ chính xác 0,001 đơn vị kho. Vui lòng đổi đơn vị phù hợp."
    );
  const now = new Date().toISOString(),
    day = getVietnamBusinessDate(now);
  const method: 'cash' | 'transfer' = paymentMethod === 'transfer' ? 'transfer' : 'cash';
  const methodLabel = method === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt';
  const requestSignature = JSON.stringify({ itemId, quantity, unitPrice, paymentMethod: method });
  const ref = doc(db, "menu", itemId),
    logRef = doc(db, "inventory_logs", `import_${id}`),
    cashRef = doc(db, "cash_transactions", `import_${id}`),
    cardRef = doc(db, "stock_card", `import_${id}`),
    statsRef = doc(db, "daily_stats", `${user.storeId}_${day}`);
  await runTransaction(db, async (txn) => {
    const existing = await txn.get(logRef);
    const snap = await txn.get(ref);
    await txn.get(statsRef);
    owns(snap.data(), user.storeId);
    if (existing.exists()) {
      owns(existing.data(), user.storeId);
      if (existing.data().requestSignature !== requestSignature)
        throw new Error(
          "Mã nhập kho đã có nội dung khác. Vui lòng kiểm tra lịch sử trước khi tạo phiếu mới."
        );
      return;
    }
    const shift = await readOpenShift(txn, user, shiftId);
    const item = snap.data() as MenuItem,
      oldStock = item.stock || 0,
      newStock = stockQuantity(oldStock + quantity);
    // Negative inventory cannot provide a reliable historical weighted average.
    const usableOldStock = Math.max(0, oldStock),
      oldCost = item.costPrice || 0;
    const cost = Math.round(
      (usableOldStock * oldCost + quantity * unitPrice) /
        (usableOldStock + quantity)
    );
    txn.update(ref, { stock: newStock, costPrice: cost });
    txn.set(logRef, {
      storeId: user.storeId,
      itemId,
      itemName: item.name,
      quantity,
      unitPrice,
      totalPrice: Math.round(quantity * unitPrice),
      type: "import",
      paymentMethod: method,
      date: now,
      operationId: id,
      requestSignature,
    });
    txn.set(cardRef, {
      storeId: user.storeId,
      itemId,
      itemName: item.name,
      change: quantity,
      remaining: newStock,
      type: "import",
      date: now,
      referenceId: logRef.id,
      note: `Nhập kho (${methodLabel}): ${quantity} ${item.unit}`,
    });
    if (quantity * unitPrice > 0)
      writeCash(
        txn,
        user,
        {
          amount: Math.round(quantity * unitPrice),
          type: "expense",
          paymentMethod: method,
          category: "Nhập hàng",
          note: `Nhập kho (${methodLabel}): ${quantity} ${item.unit} ${item.name}`,
          date: now,
          staffId: user.id,
          staffName: user.name,
        },
        cashRef,
        statsRef,
        shift
      );
  });
}

export async function auditStockAtomic(user: User, audit: InventoryAudit) {
  if (audit.items.length > 200)
    throw new Error(
      "Vui lòng chia phiếu kiểm kho thành các phiếu tối đa 200 mặt hàng. Chưa có dữ liệu nào được ghi."
    );
  const ref = doc(db, "inventory_audits", audit.id);
  const requestSignature = JSON.stringify(
    audit.items.map((i) => [
      i.itemId,
      stockQuantity(i.systemStock),
      stockQuantity(i.actualStock),
    ])
  );
  await runTransaction(db, async (txn) => {
    const existing = await txn.get(ref);
    if (existing.exists()) {
      owns(existing.data(), user.storeId);
      if (existing.data().requestSignature !== requestSignature)
        throw new Error(
          "Mã kiểm kho đã lưu với nội dung khác. Vui lòng kiểm tra lịch sử."
        );
      return;
    }
    const reads = [];
    for (const line of audit.items) {
      const itemRef = doc(db, "menu", line.itemId),
        snap = await txn.get(itemRef);
      owns(snap.data(), user.storeId);
      if (
        stockQuantity(snap.data()!.stock || 0) !==
        stockQuantity(line.systemStock)
      )
        throw new Error(
          `${line.itemName}: tồn kho đã thay đổi trong lúc kiểm. Vui lòng kiểm tra lại trước khi xác nhận.`
        );
      if (!Number.isFinite(line.actualStock) || line.actualStock < 0)
        throw new Error("Lượng kiểm thực tế không hợp lệ.");
      reads.push({ line, itemRef });
    }
    const lines = reads.map(({ line }) => ({
      ...line,
      actualStock: stockQuantity(line.actualStock),
      discrepancy: stockQuantity(line.actualStock - line.systemStock),
    }));
    txn.set(ref, {
      ...audit,
      items: lines,
      storeId: user.storeId,
      requestSignature,
    });
    reads.forEach(({ itemRef }, index) => {
      const line = lines[index];
      txn.update(itemRef, { stock: line.actualStock });
      txn.set(doc(db, "stock_card", `audit_${audit.id}_${index}`), {
        storeId: user.storeId,
        itemId: line.itemId,
        itemName: line.itemName,
        date: audit.date,
        type: "audit",
        referenceId: audit.id,
        change: line.discrepancy,
        remaining: line.actualStock,
        note: "Điều chỉnh theo phiếu kiểm kho",
      });
    });
  });
}

export class MissingInvoiceReceiptError extends Error {
  constructor() {
    super('Hóa đơn chưa có phiếu thu đã xác nhận. Vui lòng kiểm tra chứng từ gốc trước khi hủy.');
    this.name = 'MissingInvoiceReceiptError';
  }
}

export async function legacyReceiptCandidates(user: User, invoice: Invoice): Promise<CashTransaction[]> {
  if (user.role !== 'admin') throw new Error('Chỉ quản trị viên được đối chiếu phiếu thu cũ.');
  owns(invoice, user.storeId);
  const day = businessDateOf(invoice);
  const rows = await fetchDateRangeRows<CashTransaction>('cash_transactions', user.storeId, day, day);
  return rows.filter(row => !salesReceiptInvoiceId(row) && matchesSalesReceipt(invoice, row));
}

export interface InvoiceCancellation {
  deleted: boolean;
  legacyStockUnknown?: boolean;
  receiptId?: string;
}

export async function cancelInvoiceAtomic(
  user: User,
  invoiceId: string,
  confirmedLegacyReceiptId?: string,
): Promise<InvoiceCancellation> {
  if (user.role !== 'admin') throw new Error('Chỉ quản trị viên được hủy hóa đơn.');
  const invoiceRef = doc(db, "invoices", invoiceId);
  // The cancellation transaction re-reads and validates these documents before deleting.
  const cashRows = await fetchMatchingStoreRows<any>(
    "cash_transactions",
    user.storeId,
    "invoiceId",
    invoiceId
  );
  const receiptIds = new Set<string>([...cashRows.map(row => row.id), `cash_${invoiceId}`]);
  if (confirmedLegacyReceiptId) receiptIds.add(confirmedLegacyReceiptId);
  const stockRows = (
    await fetchMatchingStoreRows<any>(
      "stock_card",
      user.storeId,
      "referenceId",
      invoiceId
    )
  ).filter((c) => c.change < 0);
  const auditRef = doc(db, "cancelled_invoices", `cancel_${invoiceId}`);
  return runTransaction(db, async (txn) => {
    const snap = await txn.get(invoiceRef);
    if (!snap.exists()) {
      const audit = await txn.get(auditRef);
      if (audit.exists()) {
        owns(audit.data(), user.storeId);
        return {
          deleted: true,
          legacyStockUnknown:
            audit.data().inventoryRestorationStatus === "needs_review",
          receiptId: audit.data().originalCashReceipt?.id,
        };
      }
      return { deleted: false };
    }
    const invoice = snap.data() as Invoice;
    owns(invoice, user.storeId);
    const day = businessDateOf(invoice),
      statsRef = doc(db, "daily_stats", `${user.storeId}_${day}`),
      statsSnap = await txn.get(statsRef);
    const invoiceWithId = { ...invoice, id: invoiceId };
    const receipts: { ref: DocumentReference; data: CashTransaction; manual: boolean }[] = [];
    for (const receiptId of receiptIds) {
      const ref = doc(db, 'cash_transactions', receiptId);
      const receiptSnap = await txn.get(ref);
      if (!receiptSnap.exists()) continue;
      const receipt = { ...receiptSnap.data(), id: ref.id } as CashTransaction;
      owns(receipt, user.storeId);
      const linkedInvoiceId = salesReceiptInvoiceId(receipt);
      const manual = receiptId === confirmedLegacyReceiptId && !linkedInvoiceId;
      if ((!manual && linkedInvoiceId !== invoiceId) || !matchesSalesReceipt(invoiceWithId, receipt)) {
        throw new Error(`Phiếu thu ${receiptId} đã thay đổi hoặc không khớp hóa đơn. Cần đối soát trước khi hủy.`);
      }
      receipts.push({ ref, data: receipt, manual });
    }
    if (!receipts.length) throw new MissingInvoiceReceiptError();
    if (receipts.length !== 1) throw new Error('Hóa đơn có nhiều phiếu thu liên quan. Cần đối soát trước khi hủy.');
    const matchedReceipt = receipts[0];
    if (confirmedLegacyReceiptId && matchedReceipt.data.id !== confirmedLegacyReceiptId) {
      throw new Error('Phiếu thu vừa thay đổi. Vui lòng mở lại hóa đơn để đối soát.');
    }
    const movements = new Map<string, number>();
    const persisted = (invoice as any).inventoryMovements as
      | { itemId: string; quantity: number }[]
      | undefined;
    if (persisted)
      for (const m of persisted)
        movements.set(
          m.itemId,
          stockQuantity((movements.get(m.itemId) || 0) + m.quantity)
        );
    else
      for (const card of stockRows) {
        const live = await txn.get(doc(db, "stock_card", card.id));
        if (live.exists() && live.data().referenceId === invoiceId)
          movements.set(
            card.itemId,
            stockQuantity(
              (movements.get(card.itemId) || 0) - live.data().change
            )
          );
      }
    const stockReads = [];
    if (movements.size > 200 || cashRows.length > 50)
      throw new Error(
        "Hóa đơn cũ có quá nhiều chứng từ liên quan. Cần đối soát riêng; chưa có thay đổi nào được ghi."
      );
    for (const [itemId, quantity] of movements) {
      const ref = doc(db, "menu", itemId),
        s = await txn.get(ref);
      if (!s.exists())
        throw new Error(
          "Mặt hàng đã xóa. Cần khôi phục mặt hàng trước khi hoàn kho hóa đơn này."
        );
      owns(s.data(), user.storeId);
      stockReads.push({ ref, data: s.data(), quantity });
    }
    const customerRef = invoice.customerId
      ? doc(db, "customers", invoice.customerId)
      : undefined;
    const customer = customerRef ? await txn.get(customerRef) : undefined;
    const shiftRef = invoice.shiftId
      ? doc(db, "shifts", invoice.shiftId)
      : undefined;
    const shift = shiftRef ? await txn.get(shiftRef) : undefined;
    const now = new Date().toISOString(),
      cash = !invoice.paymentMethod || invoice.paymentMethod === "cash";
    const points =
      (invoice as any).pointsEarned ?? Math.floor(invoice.total / 100000);
    stockReads.forEach(({ ref, data, quantity }, index) => {
      const remaining = stockQuantity((data.stock || 0) + quantity);
      txn.update(ref, { stock: remaining });
      txn.set(doc(db, "stock_card", `cancel_${invoiceId}_${index}`), {
        storeId: user.storeId,
        itemId: ref.id,
        itemName: data.name,
        date: now,
        type: "return",
        referenceId: invoiceId,
        change: quantity,
        remaining,
        note: "Hoàn đúng biến động kho của hóa đơn đã hủy",
      });
    });
    if (customerRef && customer?.exists()) {
      owns(customer.data(), user.storeId);
      txn.update(customerRef, {
        points: Math.max(0, (customer.data().points || 0) - points),
      });
    }
    const stats = statsSnap.data();
    const canSubtract =
      stats &&
      ((invoice as any).statsApplied === true ||
        invoice.costVersion! >= 2 ||
        stats.coverageStatus === "reconciled") &&
      (stats.invoiceCount || 0) >= 1 &&
      (stats.totalRevenue || 0) >= invoice.total;
    const receiptField = cash ? 'salesCashIncome' : 'salesTransferIncome';
    const oldReceiptTotal = stats?.[receiptField];
    const common = {
      ...(Number.isFinite(oldReceiptTotal) && oldReceiptTotal >= invoice.total ? { [receiptField]: increment(-invoice.total) } : {}),
      ...(Number.isFinite(stats?.cashCount) && stats!.cashCount > 0 ? { cashCount: increment(-1) } : {}),
      storeId: user.storeId,
      date: day,
      month: day.slice(0, 7),
      year: Number(day.slice(0, 4)),
      sourceRevision: increment(1),
      updatedAt: now,
      coverageStatus: "partial",
    };
    txn.set(
      statsRef,
      canSubtract
        ? {
            ...common,
            totalRevenue: increment(-invoice.total),
            totalCash: increment(cash ? -invoice.total : 0),
            totalTransfer: increment(cash ? 0 : -invoice.total),
            invoiceCount: increment(-1),
            totalDiscount: increment(-(invoice.discount || 0)),
            ...(typeof invoice.totalCost === "number"
              ? { totalCost: increment(-invoice.totalCost) }
              : { costStatus: "estimated" }),
          }
        : common,
      { merge: true }
    );
    txn.delete(matchedReceipt.ref);
    if (shiftRef && shift?.exists()) {
      const s = shift.data() as Shift;
      owns(s, user.storeId);
      const newCash = (s.totalCash || 0) - (cash ? invoice.total : 0);
      txn.update(shiftRef, {
        totalRevenue: increment(-invoice.total),
        totalCash: increment(cash ? -invoice.total : 0),
        totalTransfer: increment(cash ? 0 : -invoice.total),
        cashIncome: increment(cash ? -invoice.total : 0),
        transferIncome: increment(cash ? 0 : -invoice.total),
        ...(s.status === "closed"
          ? {
              discrepancy: (s.endCash || 0) - ((s.startCash || 0) + newCash),
              discrepancyProcessed: false,
              lastAdjustmentAt: now,
            }
          : {}),
      });
    }
    const legacyStockUnknown =
      !persisted &&
      !stockRows.length &&
      invoice.items?.some(
        (i) =>
          i.type === "goods" || i.recipe?.length || i.selectedAddOns?.length
      );
    txn.set(auditRef, {
      storeId: user.storeId,
      invoiceId,
      cancelledAt: now,
      cancelledBy: { id: user.id, name: user.name, role: user.role },
      originalInvoice: invoice,
      originalCashReceipt: matchedReceipt.data,
      receiptMatch: matchedReceipt.manual ? 'verified_by_admin' : 'invoice_link',
      total: invoice.total,
      restoredStock: stockReads.map((r) => ({
        itemId: r.ref.id,
        quantity: r.quantity,
      })),
      inventoryRestorationStatus: legacyStockUnknown
        ? "needs_review"
        : "complete",
      shiftAdjustmentStatus:
        shiftRef && !shift?.exists() ? "missing_shift" : "complete",
    });
    txn.delete(invoiceRef);
    return { deleted: true, legacyStockUnknown: Boolean(legacyStockUnknown), receiptId: matchedReceipt.data.id };
  });
}

export async function openShiftAtomic(user: User, startCash: number): Promise<void> {
  validAmount(startCash);
  const existing = await getDocsFromServer(query(
    collection(db, 'shifts'),
    where('storeId', '==', user.storeId),
    where('staffId', '==', user.id),
    where('status', '==', 'open'),
  ));
  if (existing.metadata.fromCache || existing.metadata.hasPendingWrites) {
    throw new Error('Chưa xác nhận được ca đang mở từ máy chủ. Vui lòng thử lại.');
  }

  // Tự động đóng các ca tồn đọng qua 24:00 đêm (sang ngày mới) hoặc quá 24h trước khi mở ca mới
  const nowMs = Date.now();
  const todayVn = getVietnamBusinessDate();
  for (const docSnap of existing.docs) {
    const sData = docSnap.data() as Shift;
    const shiftDate = getVietnamBusinessDate(sData.startTime);
    const isPastDay = shiftDate < todayVn;
    const shiftAge = nowMs - new Date(sData.startTime).getTime();
    const isOlderThan24h = shiftAge > 24 * 3600 * 1000;
    if (isPastDay || isOlderThan24h) {
      try {
        const endTime = isPastDay 
          ? getVietnamEndOfDayIso(shiftDate) 
          : new Date(new Date(sData.startTime).getTime() + 24 * 3600 * 1000).toISOString();
        const autoClosedReason = isPastDay 
          ? 'Tự động đóng do qua 24:00 đêm Việt Nam (chuyển sang ngày mới)' 
          : 'Tự động đóng do quá 24 giờ';

        await updateDoc(docSnap.ref, {
          status: 'closed',
          endTime,
          endCash: (sData.startCash || 0) + (sData.totalCash || 0),
          discrepancy: 0,
          discrepancyProcessed: true,
          autoClosed: true,
          autoClosedReason,
          note: autoClosedReason
        });
      } catch (err) {
        console.warn('Lỗi tự động đóng ca cũ trước khi mở ca mới:', err);
      }
    }
  }

  const guardRef = doc(db, 'checkout_locks', `shift_open_${user.storeId}_${user.id}`);
  const newShiftRef = doc(collection(db, 'shifts'));
  const now = new Date().toISOString();
  await runTransaction(db, async txn => {
    const guard = await txn.get(guardRef);
    const data = guard.data();
    if (data) {
      owns(data, user.storeId);
      if (data.staffId !== user.id) throw new Error('Khóa mở ca không thuộc nhân viên.');
    }
    const candidates = new Set<string>(existing.docs.map(snapshot => snapshot.id));
    if (typeof data?.shiftId === 'string' && data.shiftId) candidates.add(data.shiftId);
    const opened: string[] = [];
    for (const id of candidates) {
      const shift = await txn.get(doc(db, 'shifts', id));
      if (!shift.exists()) continue;
      const shiftData = shift.data();
      owns(shiftData, user.storeId);
      if (shiftData.staffId !== user.id) throw new Error('Ca không thuộc nhân viên.');
      if (shiftData.status === 'open') {
        const shiftDate = getVietnamBusinessDate(shiftData.startTime);
        const isPastDay = shiftDate < todayVn;
        const age = nowMs - new Date(shiftData.startTime).getTime();
        const isOlderThan24h = age > 24 * 3600 * 1000;
        if (isPastDay || isOlderThan24h) {
          const endTime = isPastDay 
            ? getVietnamEndOfDayIso(shiftDate) 
            : new Date(new Date(shiftData.startTime).getTime() + 24 * 3600 * 1000).toISOString();
          const autoClosedReason = isPastDay 
            ? 'Tự động đóng do qua 24:00 đêm Việt Nam (chuyển sang ngày mới)' 
            : 'Tự động đóng do quá 24 giờ';

          txn.update(doc(db, 'shifts', id), {
            status: 'closed',
            endTime,
            endCash: (shiftData.startCash || 0) + (shiftData.totalCash || 0),
            discrepancy: 0,
            discrepancyProcessed: true,
            autoClosed: true,
            autoClosedReason,
            note: autoClosedReason
          });
        } else {
          opened.push(id);
        }
      }
    }
    if (opened.length > 1) {
      for (let i = 1; i < opened.length; i++) {
        txn.update(doc(db, 'shifts', opened[i]), {
          status: 'closed',
          endTime: now,
          autoClosed: true,
          note: 'Tự động đóng ca trùng'
        });
      }
    }
    const shiftId = opened[0] || newShiftRef.id;
    if (!opened.length) {
      txn.set(newShiftRef, {
        storeId: user.storeId, staffId: user.id, staffName: user.name,
        startTime: now, startCash, status: 'open', totalRevenue: 0,
        totalCash: 0, totalTransfer: 0, cashIncome: 0, cashExpense: 0,
        transferIncome: 0, transferExpense: 0,
      });
    }
    if (data?.shiftId !== shiftId) {
      txn.set(guardRef, { storeId: user.storeId, staffId: user.id, shiftId, type: 'shift_guard', updatedAt: now });
    }
  });
}

export async function recordAttendanceAtomic(
  user: User,
  input: Partial<AttendanceRecord>
) {
  const now = new Date().toISOString(),
    day = getVietnamBusinessDate(now);
  const guardRef = doc(
      db,
      "checkout_locks",
      `attendance_${user.storeId}_${user.id}`
    ),
    freshRef = doc(collection(db, "attendance_records"));

  // 1. Kiểm tra tham chiếu lượt đang mở (Single Source of Truth) từ guard
  let candidateOpenId: string | null = null;
  const initialGuardSnap = await getDocFromServer(guardRef);
  const initialGuard = initialGuardSnap.data();

  if (initialGuardSnap.exists() && initialGuard?.openRecordId !== undefined) {
    // Đã có tham chiếu trực tiếp: Chỉ định rõ lượt đang mở (hoặc null nếu đã chấm ra)
    candidateOpenId = initialGuard.openRecordId;
  } else {
    // Trường hợp chuyển tiếp dữ liệu cũ chưa có guard hoặc guard chưa có trường openRecordId:
    // Quét toàn diện các bản ghi của nhân viên (KHÔNG dùng limit 5/10 để tránh bỏ sót lượt cũ)
    let unclosedRecords: AttendanceRecord[] = [];
    try {
      const snap = await getDocsFromServer(
        query(
          collection(db, "attendance_records"),
          where("storeId", "==", user.storeId),
          where("userId", "==", user.id)
        )
      );
      unclosedRecords = snap.docs
        .map((d) => ({ ...d.data(), id: d.id } as AttendanceRecord))
        .filter((r) => r.checkInTime && !r.checkOutTime);
    } catch (e) {
      console.warn("Lỗi quét toàn diện lượt chấm công chưa đóng:", e);
      throw new Error('Chưa xác nhận đủ lịch sử chấm công từ máy chủ. Vui lòng kết nối lại trước khi chấm công.');
    }

    if (unclosedRecords.length > 0) {
      // Tự động chốt các lượt chấm công cũ bị bỏ quên (>24 giờ). Ca qua đêm (dưới 24h) được giữ nguyên để chấm ra.
      const nowMs = Date.now();
      const staleRecords = unclosedRecords.filter(r => {
        const inMs = Date.parse(r.checkInTime || '');
        return !Number.isFinite(inMs) || (nowMs - inMs) > 24 * 3600 * 1000;
      });
      if (staleRecords.length > 0) {
        for (const stale of staleRecords) {
          try {
            const inMs = Date.parse(stale.checkInTime || '');
            const outMs = Number.isFinite(inMs) ? inMs + 8 * 3600 * 1000 : nowMs;
            await updateDoc(doc(db, "attendance_records", stale.id), {
              checkOutTime: new Date(outMs).toISOString(),
              autoClosed: true,
              note: 'Tự động chốt ra do quá 24 giờ'
            });
          } catch (err) {
            console.warn("Lỗi tự động đóng lượt chấm công cũ:", err);
          }
        }
        unclosedRecords = unclosedRecords.filter(r => !staleRecords.some(s => s.id === r.id));
      }

      // Nếu vẫn còn nhiều lượt mở (chưa quá 24h), giữ lượt mới nhất và đóng các lượt mở trước đó
      if (unclosedRecords.length > 1) {
        unclosedRecords.sort((a, b) => Date.parse(b.checkInTime || '') - Date.parse(a.checkInTime || ''));
        for (let i = 1; i < unclosedRecords.length; i++) {
          try {
            await updateDoc(doc(db, "attendance_records", unclosedRecords[i].id), {
              checkOutTime: unclosedRecords[0].checkInTime || now,
              autoClosed: true,
              note: 'Tự động chốt lượt trùng'
            });
          } catch (_) {}
        }
        unclosedRecords = [unclosedRecords[0]];
      }
    }
    candidateOpenId = unclosedRecords.length === 1 ? unclosedRecords[0].id : null;
  }

  return runTransaction(db, async (txn) => {
    const guardSnap = await txn.get(guardRef),
      guard = guardSnap.data();
    if (
      guard?.lastAction &&
      Date.parse(now) - Date.parse(guard.lastActionAt || "") < 5000
    )
      return {
        type: guard.lastAction as string,
        time: guard.lastActionAt as string,
      };

    // Xác định ID lượt đang mở trong transaction
    const candidateIds = guard?.openRecordId !== undefined
      ? [guard.openRecordId].filter(Boolean)
      : [...new Set([candidateOpenId, guard?.recordId].filter(Boolean))];
    let openRecord: { ref: DocumentReference; data: AttendanceRecord } | null = null;
    for (const targetOpenId of candidateIds) {
      const recRef = doc(db, "attendance_records", targetOpenId);
      const recSnap = await txn.get(recRef);
      if (recSnap.exists()) {
        owns(recSnap.data(), user.storeId);
        if (recSnap.data().userId !== user.id)
          throw new Error("Bản ghi không thuộc nhân viên.");
        if (!recSnap.data().checkOutTime) {
          const recData = recSnap.data() as AttendanceRecord;
          const inMs = Date.parse(recData.checkInTime || '');
          const isInvalid = !Number.isFinite(inMs);
          const recAge = isInvalid ? Infinity : Date.now() - inMs;
          // Quy tắc qua đêm thống nhất: Chỉ tự động đóng khi ca kéo dài vượt quá 24 giờ.
          // Ca qua đêm (ví dụ: vào 22:00 hôm trước, ra 09:00 hôm sau) là hoàn toàn hợp lệ.
          if (isInvalid || recAge > 24 * 3600 * 1000) {
            txn.update(recRef, {
              checkOutTime: new Date((Number.isFinite(inMs) ? inMs : Date.now()) + 8 * 3600 * 1000).toISOString(),
              autoClosed: true,
              note: 'Tự động chốt ra do quá 24 giờ'
            });
            continue;
          }
          if (openRecord) {
            txn.update(openRecord.ref, {
              checkOutTime: recData.checkInTime || now,
              autoClosed: true,
              note: 'Tự động chốt lượt trùng'
            });
          }
          openRecord = { ref: recRef, data: recSnap.data() as AttendanceRecord };
        }
      } else if (guard?.openRecordId === targetOpenId) {
        throw new Error('Không tìm thấy lượt chấm công đang mở. Vui lòng đối soát tham chiếu trước khi chấm tiếp.');
      }
    }

    const explicitIn = Boolean(input.checkInTime),
      explicitOut = Boolean(input.checkOutTime);

    if (openRecord) {
      const current = openRecord;
      if (explicitIn)
        return { type: "check_in", time: current.data.checkInTime as string };
      txn.update(current.ref, {
        checkOutTime: now,
        locationValid: input.locationValid ?? true,
      });
      txn.set(guardRef, {
        storeId: user.storeId,
        userId: user.id,
        openRecordId: null,
        recordId: current.ref.id,
        lastAction: "check_out",
        lastActionAt: now,
      });
      return { type: "check_out", time: now };
    }

    if (explicitOut) {
      if (guard?.lastAction === "check_out")
        return { type: "check_out", time: guard.lastActionAt as string };
      throw new Error("Không có lượt vào ca đang mở để chấm ra.");
    }

    let status: AttendanceRecord["status"] = "present";
    const schedules = user.shifts?.length
      ? user.shifts
      : user.shiftStart
      ? [{ start: user.shiftStart, end: user.shiftEnd || user.shiftStart }]
      : [];
    const candidates = schedules
      .flatMap((schedule) => {
        const start = Date.parse(`${day}T${schedule.start}:00+07:00`),
          end = Date.parse(`${day}T${schedule.end}:00+07:00`);
        return [0, -86400000].map((offset) => ({
          start: start + offset,
          end: end + offset + (end <= start ? 86400000 : 0),
        }));
      })
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
    const nowMs = Date.parse(now),
      active =
        candidates.find((s) => s.start <= nowMs && s.end >= nowMs) ||
        candidates
          .filter((s) => s.start <= nowMs)
          .sort((a, b) => b.start - a.start)[0];
    if (active) {
      const lateMinutes = (nowMs - active.start) / 60000;
      if (lateMinutes > 240) status = "half-day";
      else if (lateMinutes > 15) status = "late";
    }

    txn.set(freshRef, {
      storeId: user.storeId,
      userId: user.id,
      staffName: user.name,
      date: day,
      checkInTime: now,
      status,
      locationValid: input.locationValid ?? true,
    });
    txn.set(guardRef, {
      storeId: user.storeId,
      userId: user.id,
      openRecordId: freshRef.id,
      recordId: freshRef.id,
      lastAction: "check_in",
      lastActionAt: now,
    });
    return { type: "check_in", time: now };
  });
}

export async function finalizePayrollAtomic(
  currentUser: User,
  payroll: PayrollRecord,
  options?: {
    expectedAttendanceHash?: string;
  }
): Promise<{
  finalRecord: PayrollRecord;
  freshRecords: AttendanceRecord[];
  freshUser: User;
}> {
  if (!currentUser) throw new Error("Chưa đăng nhập.");
  const storeId = currentUser.storeId;
  if (!payroll.userId || !payroll.month) throw new Error("Thiếu thông tin nhân viên hoặc tháng tính lương.");
  const id = `${storeId}_${payroll.userId}_${payroll.month}`;

  // 1. Lấy dữ liệu chấm công thực tế từ máy chủ (bỏ qua cache) để xác nhận phiên bản
  const startDay = `${payroll.month}-01`;
  const endDay = `${payroll.month}-31`;
  let serverRecords: AttendanceRecord[] = [];
  try {
    const q = query(
      collection(db, "attendance_records"),
      where("storeId", "==", storeId),
      where("userId", "==", payroll.userId),
      where("date", ">=", startDay),
      where("date", "<=", endDay)
    );
    const snap = await getDocsFromServer(q);
    serverRecords = snap.docs.map(d => ({ ...d.data(), id: d.id } as AttendanceRecord));
  } catch {
    const fallbackQ = query(
      collection(db, "attendance_records"),
      where("storeId", "==", storeId),
      where("userId", "==", payroll.userId)
    );
    const snap = await getDocsFromServer(fallbackQ);
    serverRecords = snap.docs
      .map(d => ({ ...d.data(), id: d.id } as AttendanceRecord))
      .filter(r => r.date && r.date.startsWith(payroll.month));
  }

  const serverValidRecords = serverRecords.filter(r =>
    r.status === "present" || r.status === "half-day" || r.status === "late" || !r.status
  );

  const serverTotals = attendanceTotals(serverValidRecords);
  if (serverTotals.hasOpenSession) {
    throw new Error("Có lượt chấm công chưa kết thúc hoặc giờ không hợp lệ trên máy chủ. Vui lòng hoàn tất trước khi chốt lương.");
  }

  const serverAttendanceHash = computeAttendanceFingerprint(serverValidRecords);

  // 2. Xác nhận phiên bản dữ liệu chấm công: kiểm tra số ngày công, giờ làm và chữ ký phiên bản
  const daysDiffer = Math.abs(serverTotals.presentDays - payroll.presentDays) > 0.001;
  const hoursDiffer = payroll.baseSalaryType === "hourly" && Math.abs(serverTotals.totalHours - (payroll.totalHours || 0)) > 0.01;
  const targetHash = payroll.attendanceSnapshotHash || options?.expectedAttendanceHash;
  const hashDiffer = Boolean(targetHash && targetHash !== serverAttendanceHash);

  if (daysDiffer || hoursDiffer || hashDiffer) {
    const err = new Error(
      `Dữ liệu chấm công của nhân viên đã thay đổi trên máy chủ (Máy chủ ghi nhận: ${serverTotals.presentDays} ngày công / ${serverValidRecords.length} lượt; Trên máy: ${payroll.presentDays} ngày công). Dữ liệu đã được cập nhật, vui lòng tính lại và xác nhận trước khi lưu.`
    );
    (err as any).freshRecords = serverRecords;
    throw err;
  }

  // 3. Thực hiện Transaction: Kiểm tra bảng lương, cấu hình lương nhân viên, guard và khóa kiểm tra từng bản ghi
  let freshUserSnapshot: User | null = null;
  let finalRecordToSave: PayrollRecord | null = null;

  await runTransaction(db, async txn => {
    // A. Kiểm tra bảng lương đã chốt trước đó chưa
    const payrollRef = doc(db, "payroll_records", id);
    const payrollSnap = await txn.get(payrollRef);
    if (payrollSnap.exists()) {
      throw new Error("Bảng lương tháng này đã được chốt ở thiết bị khác.");
    }

    // B. Đọc và xác nhận cấu hình lương nhân viên từ máy chủ
    const userRef = doc(db, "users", payroll.userId);
    const userSnap = await txn.get(userRef);
    if (!userSnap.exists()) {
      throw new Error("Tài khoản nhân viên không tồn tại trên máy chủ.");
    }
    const serverUser = userSnap.data() as User;
    freshUserSnapshot = serverUser;
    owns(serverUser, storeId);

    if ((serverUser as any).isDeleted || (serverUser as any).status === "deleted") {
      throw new Error("Nhân viên đã bị xóa khỏi hệ thống.");
    }

    const serverSalaryType = serverUser.salaryType || "daily";
    const serverSalaryAmount = serverUser.salaryAmount || 0;

    if (serverSalaryType !== payroll.baseSalaryType || serverSalaryAmount !== payroll.baseSalaryAmount) {
      const err = new Error(
        `Cấu hình lương của nhân viên đã thay đổi trên máy chủ (${serverSalaryAmount.toLocaleString("vi-VN")}đ / ${serverSalaryType === "monthly" ? "tháng" : serverSalaryType === "hourly" ? "giờ" : "ngày"} so với ${payroll.baseSalaryAmount.toLocaleString("vi-VN")}đ / ${payroll.baseSalaryType === "monthly" ? "tháng" : payroll.baseSalaryType === "hourly" ? "giờ" : "ngày"}). Vui lòng tính lại bảng lương rồi mới lưu.`
      );
      (err as any).freshUser = serverUser;
      throw err;
    }

    // C. Đọc guard chấm công của nhân viên để ngăn chặn race condition chấm công ngay lúc chốt
    const guardRef = doc(db, "checkout_locks", `attendance_${storeId}_${payroll.userId}`);
    const guardSnap = await txn.get(guardRef);
    if (guardSnap.exists()) {
      const guardData = guardSnap.data();
      if (guardData?.openRecordId) {
        throw new Error("Nhân viên đang có lượt chấm công chưa hoàn tất trên máy chủ. Vui lòng hoàn tất trước khi chốt lương.");
      }
    }

    // D. Đọc từng bản ghi chấm công để khóa kiểm tra và đảm bảo không có lượt nào mở
    for (const rec of serverValidRecords) {
      const recRef = doc(db, "attendance_records", rec.id);
      const recSnap = await txn.get(recRef);
      if (!recSnap.exists()) {
        throw new Error("Một bản ghi chấm công đã bị thay đổi hoặc xóa trên máy chủ trong lúc chốt. Vui lòng tính lại.");
      }
      const rData = recSnap.data() as AttendanceRecord;
      if (!rData.checkOutTime) {
        throw new Error("Có lượt chấm công chưa kết thúc. Vui lòng hoàn tất trước khi chốt lương.");
      }
    }

    // E. Tính toán lại lương dựa trên thông số đã xác nhận 100% từ server
    let verifiedCalculatedSalary = 0;
    if (serverSalaryType === "monthly") {
      verifiedCalculatedSalary = Math.round(serverSalaryAmount);
    } else if (serverSalaryType === "daily") {
      verifiedCalculatedSalary = Math.round(serverSalaryAmount * serverTotals.presentDays);
    } else if (serverSalaryType === "hourly") {
      verifiedCalculatedSalary = Math.round(serverSalaryAmount * serverTotals.totalHours);
    }

    if (Math.abs(verifiedCalculatedSalary - payroll.calculatedSalary) > 1) {
      throw new Error(
        `Số tiền lương tính toán (${verifiedCalculatedSalary.toLocaleString("vi-VN")}đ) không khớp với số tiền trên phiếu (${payroll.calculatedSalary.toLocaleString("vi-VN")}đ) do dữ liệu công hoặc lương vừa thay đổi. Vui lòng tính lại bảng lương.`
      );
    }

    finalRecordToSave = {
      ...payroll,
      id,
      storeId,
      presentDays: serverTotals.presentDays,
      totalHours: serverTotals.totalHours,
      baseSalaryAmount: serverSalaryAmount,
      baseSalaryType: serverSalaryType,
      calculatedSalary: verifiedCalculatedSalary,
      totalSalary: Math.round(verifiedCalculatedSalary + (payroll.bonus || 0) - (payroll.deduction || 0)),
      attendanceSnapshotHash: serverAttendanceHash,
      attendanceRecordIds: serverValidRecords.map(r => r.id),
      finalizedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      status: "finalized",
    };

    txn.set(payrollRef, finalRecordToSave);
  });

  return {
    finalRecord: finalRecordToSave!,
    freshRecords: serverRecords,
    freshUser: freshUserSnapshot!,
  };
}

export async function unfinalizePayrollAtomic(
  currentUser: User,
  payrollId: string
): Promise<{
  success: boolean;
  unfinalizedId: string;
}> {
  if (!currentUser) throw new Error("Chưa đăng nhập.");
  const storeId = currentUser.storeId;
  if (!payrollId) throw new Error("Thiếu mã bảng lương cần mở chốt.");

  const isAdminOrManager = currentUser.role === "admin" || currentUser.role === "manager" || Boolean((currentUser as any).isSuperAdmin);
  if (!isAdminOrManager) {
    throw new Error("Chỉ Quản trị viên hoặc Quản lý cửa hàng mới có quyền mở chốt bảng lương.");
  }

  await runTransaction(db, async txn => {
    const payrollRef = doc(db, "payroll_records", payrollId);
    const payrollSnap = await txn.get(payrollRef);
    if (!payrollSnap.exists()) {
      throw new Error("Bảng lương này không tồn tại hoặc đã được mở chốt trước đó.");
    }

    const payrollData = payrollSnap.data();
    owns(payrollData, storeId);

    // Xóa bản ghi chốt lương để chuyển trạng thái về tạm tính và cho phép tính lại
    txn.delete(payrollRef);
  });

  return {
    success: true,
    unfinalizedId: payrollId,
  };
}


