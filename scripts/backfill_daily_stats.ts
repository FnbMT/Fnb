import { adminDb } from '../api/_firebaseAdmin';
import { getVietnamBusinessDate } from './migrate_legacy_data';

export interface BackfillOptions {
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
  dryRun?: boolean;
}

export interface BackfillResult {
  storeId: string;
  totalDaysAggregated: number;
  totalInvoicesScanned: number;
  totalCashTxsScanned: number;
  updatedStatsDocs: number;
  daysWithEstimatedCost: number;
  daysWithCompleteCost: number;
  skippedTodayDate?: string;
  dryRun?: boolean;
}

interface DailyStatsRecord {
  storeId: string;
  date: string;
  month: string;
  year: number;
  totalRevenue: number;
  totalCash: number;
  totalTransfer: number;
  totalDiscount: number;
  invoiceCount: number;
  totalCost: number;
  hasData: boolean;
  costStatus: 'complete' | 'estimated' | 'partial' | 'none';
  coverageStatus: 'reconciled' | 'zero_activity';
  reconciledAt: string;
  sourceVersion: number;
  invoicesTotalCount: number;
  cashTransactionsTotalCount: number;
  totalIncome: number;
  totalExpense: number;
  cashExpense: number;
  transferExpense: number;
  cashIncome: number;
  transferIncome: number;
  expenseInventory: number;
  expenseSalary: number;
  expenseRent: number;
  expenseOther: number;
  cashCount: number;
  version: number;
  updatedAt: string;
}

// Backfill và đối soát cho một cửa hàng cụ thể (hoàn toàn an toàn trong giờ kinh doanh)
export async function backfillStoreDailyStats(
  storeId: string, 
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  console.log(`\n=== [BACKFILL] Bắt đầu đối soát và tổng hợp daily_stats cho storeId: ${storeId} ===`);
  const todayStr = getVietnamBusinessDate();

  // 1. Tải hóa đơn của cửa hàng
  let invQuery = adminDb.collection('invoices').where('storeId', '==', storeId);
  const invSnap = await invQuery.get();
  console.log(`[BACKFILL] Đã tải ${invSnap.size} hóa đơn của storeId ${storeId}.`);

  // 2. Tải giao dịch sổ quỹ của cửa hàng
  let cashQuery = adminDb.collection('cash_transactions').where('storeId', '==', storeId);
  const cashSnap = await cashQuery.get();
  console.log(`[BACKFILL] Đã tải ${cashSnap.size} giao dịch sổ quỹ của storeId ${storeId}.`);

  const statsMap = new Map<string, DailyStatsRecord>();
  const dayHasEstimatedCostMap = new Map<string, boolean>();
  const dayHasMissingCostMap = new Map<string, boolean>();

  const getOrCreateStats = (dStr: string): DailyStatsRecord => {
    const key = `${storeId}_${dStr}`;
    if (!statsMap.has(key)) {
      const [yStr, mStr] = dStr.split('-');
      statsMap.set(key, {
        storeId,
        date: dStr,
        month: `${yStr}-${mStr}`,
        year: parseInt(yStr, 10),
        totalRevenue: 0,
        totalCash: 0,
        totalTransfer: 0,
        totalDiscount: 0,
        invoiceCount: 0,
        totalCost: 0,
        hasData: false,
        costStatus: 'complete',
        coverageStatus: 'reconciled',
        reconciledAt: new Date().toISOString(),
        sourceVersion: 2,
        invoicesTotalCount: 0,
        cashTransactionsTotalCount: 0,
        totalIncome: 0,
        totalExpense: 0,
        cashExpense: 0,
        transferExpense: 0,
        cashIncome: 0,
        transferIncome: 0,
        expenseInventory: 0,
        expenseSalary: 0,
        expenseRent: 0,
        expenseOther: 0,
        cashCount: 0,
        version: 2,
        updatedAt: new Date().toISOString()
      });
    }
    return statsMap.get(key)!;
  };

  // 3. Xử lý hóa đơn
  const invoicesToUpdate: Array<{ id: string; data: Record<string, any> }> = [];

  invSnap.docs.forEach((docSnap: any) => {
    const inv = docSnap.data();
    if (!inv.date) return;

    const vnDateStr = inv.businessDate || getVietnamBusinessDate(inv.date);

    // Lọc theo khoảng ngày nếu có chỉ định
    if (options.startDate && vnDateStr < options.startDate) return;
    if (options.endDate && vnDateStr > options.endDate) return;

    // QUY TẮC AN TOÀN TUYỆT ĐỐI (CUTOFF RULE):
    // KHÔNG TỔNG HỢP / GHI ĐÈ NGÀY HÔM NAY (todayStr) bằng batch.set!
    // Ngày hôm nay đang có checkouts trực tiếp gọi FieldValue.increment().
    if (vnDateStr === todayStr) {
      return;
    }

    const cur = getOrCreateStats(vnDateStr);
    const total = Number(inv.total) || 0;
    cur.totalRevenue += total;
    cur.totalDiscount += (Number(inv.discount) || 0);
    cur.invoiceCount += 1;

    const method = inv.paymentMethod || 'cash';
    if (method === 'cash') {
      cur.totalCash += total;
    } else {
      cur.totalTransfer += total;
    }

    // Kiểm tra tính toàn vẹn của giá vốn
    const items = inv.items || [];
    let invoiceEstimated = false;
    let invoiceMissing = false;

    if (items.length > 0) {
      items.forEach((item: any) => {
        const hasCost = typeof item.costPrice === 'number' && item.costPrice > 0;
        const hasRecipe = Array.isArray(item.recipe) && item.recipe.length > 0;
        if (!hasCost && !hasRecipe) {
          invoiceEstimated = true;
        }
      });
    } else if (total > 0) {
      // Hóa đơn có tiền nhưng không có items -> Giá vốn bị thiếu
      invoiceMissing = true;
    }

    if (invoiceEstimated) {
      dayHasEstimatedCostMap.set(vnDateStr, true);
    }
    if (invoiceMissing) {
      dayHasMissingCostMap.set(vnDateStr, true);
    }

    let invCost = 0;
    if (typeof inv.totalCost === 'number') {
      invCost = inv.totalCost;
    } else {
      // Tính giá vốn snapshot
      invCost = items.reduce((sum: number, item: any) => {
        const itemCost = (Number(item.costPrice) || 0) * (Number(item.quantity) || 1);
        const addOnsCost = (item.selectedAddOns || []).reduce((aSum: number, a: any) => {
          const unitCost = Number(a.costPrice) || 0;
          const qtyPerServing = (typeof a.quantity === 'number' && a.quantity > 0) ? a.quantity : 1;
          return aSum + (unitCost * qtyPerServing * (Number(item.quantity) || 1));
        }, 0);
        return sum + itemCost + addOnsCost;
      }, 0);

      invoicesToUpdate.push({
        id: docSnap.id,
        data: {
          totalCost: invCost,
          costVersion: 1,
          costStatus: invoiceEstimated ? 'estimated' : 'complete',
          businessDate: vnDateStr,
          businessMonth: vnDateStr.slice(0, 7),
          businessYear: parseInt(vnDateStr.slice(0, 4), 10)
        }
      });
    }

    cur.totalCost += invCost;
  });

  // 4. Xử lý giao dịch sổ quỹ
  const cashToUpdate: Array<{ id: string; data: Record<string, any> }> = [];

  cashSnap.docs.forEach((docSnap: any) => {
    const tx = docSnap.data();
    if (!tx.date) return;

    const vnDateStr = tx.businessDate || getVietnamBusinessDate(tx.date);

    if (options.startDate && vnDateStr < options.startDate) return;
    if (options.endDate && vnDateStr > options.endDate) return;

    // Không ghi đè sổ quỹ ngày hôm nay
    if (vnDateStr === todayStr) {
      return;
    }

    const cur = getOrCreateStats(vnDateStr);
    cur.cashCount += 1;

    const amount = Number(tx.amount) || 0;
    const isCash = tx.paymentMethod === 'cash' || !tx.paymentMethod;
    const cat = (tx.category || '').toLowerCase().trim();

    if (tx.type === 'income' && tx.category !== 'Bán hàng') {
      cur.totalIncome += amount;
      if (isCash) cur.cashIncome += amount;
      else cur.transferIncome += amount;
    } else if (tx.type === 'expense') {
      cur.totalExpense += amount;
      if (isCash) cur.cashExpense += amount;
      else cur.transferExpense += amount;

      if (cat.includes('nhập hàng') || cat.includes('mua hàng') || cat.includes('nguyên liệu')) {
        cur.expenseInventory += amount;
      } else if (cat.includes('mặt bằng') || cat.includes('thuê nhà') || cat.includes('tiền nhà')) {
        cur.expenseRent += amount;
      } else if (cat.includes('lương') || cat.includes('nhân sự') || cat.includes('nhân viên')) {
        cur.expenseSalary += amount;
      } else {
        cur.expenseOther += amount;
      }
    }

    if (!tx.businessDate) {
      cashToUpdate.push({
        id: docSnap.id,
        data: {
          businessDate: vnDateStr,
          businessMonth: vnDateStr.slice(0, 7),
          businessYear: parseInt(vnDateStr.slice(0, 4), 10)
        }
      });
    }
  });

  // 5. Đối soát chéo và xác nhận bất biến toán học
  let daysWithEstimatedCost = 0;
  let daysWithCompleteCost = 0;

  statsMap.forEach((cur, dateKey) => {
    cur.invoicesTotalCount = cur.invoiceCount;
    cur.cashTransactionsTotalCount = cur.cashCount;
    cur.hasData = cur.invoiceCount > 0 || cur.cashCount > 0;

    // Xác định chuẩn xác costStatus
    if (cur.invoiceCount === 0) {
      cur.costStatus = 'none';
      daysWithCompleteCost++;
    } else if (dayHasEstimatedCostMap.get(cur.date)) {
      cur.costStatus = 'estimated';
      daysWithEstimatedCost++;
    } else if (dayHasMissingCostMap.get(cur.date)) {
      cur.costStatus = 'partial';
    } else {
      cur.costStatus = 'complete';
      daysWithCompleteCost++;
    }

    // Bất biến: Tổng thu = Tiền mặt + Chuyển khoản
    const nonSaleDiff = cur.totalIncome - (cur.cashIncome + cur.transferIncome);
    if (nonSaleDiff !== 0) cur.cashIncome += nonSaleDiff;

    // Bất biến: Chi phí = Chi TM + Chi CK
    const expPayDiff = cur.totalExpense - (cur.cashExpense + cur.transferExpense);
    if (expPayDiff !== 0) cur.cashExpense += expPayDiff;

    // Bất biến: Nhóm chi = Tổng chi
    const expCatDiff = cur.totalExpense - (cur.expenseInventory + cur.expenseSalary + cur.expenseRent + cur.expenseOther);
    if (expCatDiff !== 0) cur.expenseOther += expCatDiff;

    cur.coverageStatus = cur.hasData ? 'reconciled' : 'zero_activity';
    cur.reconciledAt = new Date().toISOString();
    cur.sourceVersion = 2;
    cur.version = 2;
  });

  const entries = Array.from(statsMap.entries());
  console.log(`[BACKFILL] Đã tổng hợp ${entries.length} ngày đóng sổ (đã bỏ qua hôm nay ${todayStr}).`);

  // 6. Ghi dữ liệu daily_stats theo batch nếu không phải dryRun
  if (!options.dryRun && entries.length > 0) {
    for (let i = 0; i < entries.length; i += 400) {
      const chunk = entries.slice(i, i + 400);
      const batch = adminDb.batch();
      chunk.forEach(([docId, data]) => {
        batch.set(adminDb.doc(`daily_stats/${docId}`), {
          ...data,
          id: docId
        });
      });
      await batch.commit();
      console.log(`[BACKFILL] Đã ghi daily_stats chunk ${i + 1} - ${i + chunk.length}.`);
    }

    // Cập nhật snapshot invoices
    if (invoicesToUpdate.length > 0) {
      for (let i = 0; i < invoicesToUpdate.length; i += 400) {
        const chunk = invoicesToUpdate.slice(i, i + 400);
        const batch = adminDb.batch();
        chunk.forEach(item => {
          batch.update(adminDb.doc(`invoices/${item.id}`), item.data);
        });
        await batch.commit();
      }
      console.log(`[BACKFILL] Đã cập nhật snapshot cho ${invoicesToUpdate.length} hóa đơn.`);
    }

    // Cập nhật cash_transactions
    if (cashToUpdate.length > 0) {
      for (let i = 0; i < cashToUpdate.length; i += 400) {
        const chunk = cashToUpdate.slice(i, i + 400);
        const batch = adminDb.batch();
        chunk.forEach(item => {
          batch.update(adminDb.doc(`cash_transactions/${item.id}`), item.data);
        });
        await batch.commit();
      }
      console.log(`[BACKFILL] Đã cập nhật businessDate cho ${cashToUpdate.length} giao dịch sổ quỹ.`);
    }
  }

  return {
    storeId,
    totalDaysAggregated: entries.length,
    totalInvoicesScanned: invSnap.size,
    totalCashTxsScanned: cashSnap.size,
    updatedStatsDocs: entries.length,
    daysWithEstimatedCost,
    daysWithCompleteCost,
    skippedTodayDate: todayStr,
    dryRun: options.dryRun
  };
}
