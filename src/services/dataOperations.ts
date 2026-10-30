import {
  collection,
  doc,
  runTransaction,
  increment,
  deleteField,
  arrayUnion,
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
} from "../utils/dataIntegrity";
import { getVietnamBusinessDate } from "../utils/firestoreDateHelper";
import {
  fetchStoreRows,
  fetchMatchingStoreRows,
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
    const op = await txn.get(opRef);
    const snap = await txn.get(tableRef);
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
  id: string
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
  const requestSignature = JSON.stringify({ itemId, quantity, unitPrice });
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
      note: `Nhập kho: ${quantity} ${item.unit}`,
    });
    if (quantity * unitPrice > 0)
      writeCash(
        txn,
        user,
        {
          amount: Math.round(quantity * unitPrice),
          type: "expense",
          paymentMethod: "cash",
          category: "Nhập hàng",
          note: `Nhập kho: ${quantity} ${item.unit} ${item.name}`,
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

export async function cancelInvoiceAtomic(
  user: User,
  invoiceId: string
): Promise<{ deleted: boolean; legacyStockUnknown?: boolean }> {
  const invoiceRef = doc(db, "invoices", invoiceId);
  // The cancellation transaction re-reads and validates these documents before deleting.
  const cashRows = await fetchMatchingStoreRows<any>(
    "cash_transactions",
    user.storeId,
    "invoiceId",
    invoiceId
  );
  if (!cashRows.some((c) => c.id === `cash_${invoiceId}`))
    cashRows.push({ id: `cash_${invoiceId}` });
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
        };
      }
      return { deleted: false };
    }
    const invoice = snap.data() as Invoice;
    owns(invoice, user.storeId);
    const day = businessDateOf(invoice),
      statsRef = doc(db, "daily_stats", `${user.storeId}_${day}`),
      statsSnap = await txn.get(statsRef);
    const cashSnaps = [];
    for (const c of cashRows) {
      const ref = doc(db, "cash_transactions", c.id);
      cashSnaps.push({ ref, snap: await txn.get(ref) });
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
    const common = {
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
    for (const c of cashSnaps)
      if (c.snap.exists()) {
        owns(c.snap.data(), user.storeId);
        if (
          c.snap.data().invoiceId !== invoiceId &&
          c.ref.id !== `cash_${invoiceId}`
        )
          throw new Error("Phiếu thu không khớp hóa đơn.");
        txn.delete(c.ref);
      }
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
    return { deleted: true, legacyStockUnknown: Boolean(legacyStockUnknown) };
  });
}

export async function recordAttendanceAtomic(
  user: User,
  input: Partial<AttendanceRecord>
) {
  const history = (
    await fetchMatchingStoreRows<AttendanceRecord>(
      "attendance_records",
      user.storeId,
      "userId",
      user.id
    )
  ).filter((r) => r.checkInTime && !r.checkOutTime);
  const guardRef = doc(
      db,
      "checkout_locks",
      `attendance_${user.storeId}_${user.id}`
    ),
    freshRef = doc(collection(db, "attendance_records"));
  const now = new Date().toISOString(),
    day = getVietnamBusinessDate(now);
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
    const ids = new Set(history.map((r) => r.id));
    if (guard?.recordId) ids.add(guard.recordId);
    const open = [];
    for (const id of ids) {
      const ref = doc(db, "attendance_records", id),
        snap = await txn.get(ref);
      if (snap.exists()) {
        owns(snap.data(), user.storeId);
        if (snap.data().userId !== user.id)
          throw new Error("Bản ghi không thuộc nhân viên.");
        if (!snap.data().checkOutTime) open.push({ ref, data: snap.data() });
      }
    }
    if (open.length > 1)
      throw new Error(
        "Có nhiều lượt chấm công đang mở. Vui lòng đối soát các lượt cũ trước khi chấm tiếp."
      );
    const explicitIn = Boolean(input.checkInTime),
      explicitOut = Boolean(input.checkOutTime);
    if (open.length) {
      const current = open[0];
      if (explicitIn)
        return { type: "check_in", time: current.data.checkInTime as string };
      txn.update(current.ref, {
        checkOutTime: now,
        locationValid: input.locationValid ?? true,
      });
      txn.set(guardRef, {
        storeId: user.storeId,
        userId: user.id,
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
      recordId: freshRef.id,
      lastAction: "check_in",
      lastActionAt: now,
    });
    return { type: "check_in", time: now };
  });
}
