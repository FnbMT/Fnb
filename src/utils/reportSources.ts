import type { CashTransaction, DailyStats, Invoice } from '../types';
import { aggregateDay, businessDateOf, isCashMethod, isSalesCategory, receiptMismatch, RECEIPT_RECONCILIATION_VERSION, validCashAmount, validInvoiceAmount } from './dataIntegrity';

export const invoiceStatFields = ['totalRevenue', 'totalCash', 'totalTransfer', 'invoiceCount', 'totalDiscount'] as const;
export const cashStatFields = ['totalIncome', 'totalExpense', 'cashIncome', 'transferIncome', 'cashExpense', 'transferExpense',
  'expenseInventory', 'expenseSalary', 'expenseRent', 'expenseOther', 'salesCashIncome', 'salesTransferIncome'] as const;

export function reconciledSource(stat: DailyStats | undefined, source: 'invoices' | 'cash'): boolean {
  if (!stat || stat.receiptReconciliationVersion !== RECEIPT_RECONCILIATION_VERSION
    || !['reconciled', 'zero_activity'].includes(stat.coverageStatus || '')) return false;
  const fields = source === 'invoices' ? invoiceStatFields : cashStatFields;
  return fields.every(field => typeof stat[field] === 'number' && Number.isFinite(stat[field]) && stat[field]! >= 0);
}

export function verifiedDayCost(stat: DailyStats | undefined): boolean {
  return Boolean(stat && stat.costStatus === 'complete' && typeof stat.totalCost === 'number'
    && Number.isFinite(stat.totalCost) && stat.totalCost >= 0);
}

export function mergeDaySources(raw: DailyStats, server: DailyStats | undefined, invoicesReady: boolean, cashReady: boolean): DailyStats {
  const result = { ...raw };
  for (const field of invoiceStatFields) (result as any)[field] = invoicesReady ? raw[field] : server?.[field] ?? 0;
  result.totalCost = invoicesReady ? raw.totalCost : server?.totalCost;
  result.costStatus = invoicesReady ? raw.costStatus : server?.costStatus;
  for (const field of cashStatFields) (result as any)[field] = cashReady ? raw[field] : server?.[field] ?? 0;
  result.cashCount = cashReady ? raw.cashCount : server?.cashCount;
  result.hasData = Boolean(result.invoiceCount || result.totalRevenue || result.cashCount || result.totalIncome || result.totalExpense);
  return result;
}

type SourceCoverage = { invoiceDays: ReadonlySet<string>; cashDays: ReadonlySet<string> };

export function aggregateReportDays(
  storeId: string, dates: string[], invoices: Invoice[], cash: CashTransaction[], coverage: SourceCoverage,
) {
  const invoiceDays = new Set(coverage.invoiceDays);
  const cashDays = new Set(coverage.cashDays);
  const issues: string[] = [];
  const receiptIssues = new Map<string, string>();

  function group<T extends Invoice | CashTransaction>(
    rows: T[], covered: ReadonlySet<string>, validDays: Set<string>, validAmount: (row: T) => boolean, label: string,
  ) {
    const byDay = new Map<string, T[]>();
    for (const row of rows) {
      let day: string;
      try { day = businessDateOf(row); }
      catch {
        if (!covered.size) continue;
        issues.push(`${label} ${row.id} thiếu ngày hợp lệ.`);
        validDays.clear();
        continue;
      }
      if (!covered.has(day)) continue;
      if (!validAmount(row)) {
        issues.push(`${label} ${row.id} ngày ${day} có số liệu không hợp lệ.`);
        validDays.delete(day);
        continue;
      }
      const dayRows = byDay.get(day);
      if (dayRows) dayRows.push(row);
      else byDay.set(day, [row]);
    }
    return byDay;
  }

  const invoicesByDay = group(invoices.filter(invoice => invoice.status !== 'cancelled'), coverage.invoiceDays, invoiceDays, validInvoiceAmount, 'Hóa đơn');
  const cashByDay = group(cash, coverage.cashDays, cashDays, validCashAmount, 'Phiếu thu/chi');
  const stats = new Map<string, DailyStats>();
  for (const day of dates) {
    if (!coverage.invoiceDays.has(day) && !coverage.cashDays.has(day)) continue;
    const dayInvoices = invoicesByDay.get(day) || [];
    const dayCash = cashByDay.get(day) || [];
    if (invoiceDays.has(day) && cashDays.has(day)) {
      const mismatch = receiptMismatch(dayInvoices, dayCash);
      if (mismatch) receiptIssues.set(day, mismatch);
    }
    stats.set(day, aggregateDay(storeId, day, dayInvoices, dayCash, false));
  }
  return { stats, invoiceDays, cashDays, issues, receiptIssues };
}

export function contiguousDateRanges(dates: string[]): { start: string; end: string; dates: string[] }[] {
  const sorted = [...new Set(dates)].sort();
  const ranges: { start: string; end: string; dates: string[] }[] = [];
  for (const day of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous && Date.parse(day + 'T00:00:00+07:00') - Date.parse(previous.end + 'T00:00:00+07:00') === 86400000) {
      previous.end = day; previous.dates.push(day);
    } else ranges.push({ start: day, end: day, dates: [day] });
  }
  return ranges;
}

// Giữ công thức cũ: thu = thu bán hàng + thu khác; số dư là phát sinh trong kỳ.
// Chỉ thay nguồn tổng kỳ, không dùng số dòng của trang đang hiển thị làm tổng kỳ.
export function cashBookTotals(rows: CashTransaction[], totals?: Partial<DailyStats>) {
  const sum = (type: 'income' | 'expense', cashMethod: boolean, sales?: boolean) => rows
    .filter(row => validCashAmount(row) && row.type === type && isCashMethod(row.paymentMethod) === cashMethod
      && (sales === undefined || isSalesCategory(row.category) === sales))
    .reduce((amount, row) => amount + row.amount, 0);
  const salesCash = totals?.salesCashIncome ?? sum('income', true, true);
  const salesBank = totals?.salesTransferIncome ?? sum('income', false, true);
  const otherCash = totals?.cashIncome ?? sum('income', true, false);
  const otherBank = totals?.transferIncome ?? sum('income', false, false);
  const totalCashExpense = totals?.cashExpense ?? sum('expense', true);
  const totalTransferExpense = totals?.transferExpense ?? sum('expense', false);
  const periodCashIncome = salesCash + otherCash, periodBankIncome = salesBank + otherBank;
  const totalIncome = periodCashIncome + periodBankIncome, totalExpense = totalCashExpense + totalTransferExpense;
  return { openingBalance: 0, totalIncome, totalExpense, closingBalance: totalIncome - totalExpense,
    cashBalance: periodCashIncome - totalCashExpense, bankBalance: periodBankIncome - totalTransferExpense,
    salesReceipts: salesCash + salesBank, nonSaleIncome: otherCash + otherBank,
    periodCashIncome, periodBankIncome, totalCashExpense, totalTransferExpense };
}
