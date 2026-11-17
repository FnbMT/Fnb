import { adminDb } from "../api/_firebaseAdmin.js";
import type { Invoice, CashTransaction, DailyStats } from "../src/types";
import { reconcileDay, businessDateOf } from "../src/utils/dataIntegrity";
import { getVietnamBusinessDate, getVietnamDayBoundariesIso } from "../src/utils/firestoreDateHelper";

export interface BackfillOptions {
  startDate?: string;
  endDate?: string;
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
  skippedChangedDays: string[];
  skippedUnreconciledDays: { date: string; reason: string }[];
  dryRun?: boolean;
}

// Capture aggregate revisions BEFORE scanning sources. Every operational financial
// mutation writes the same day's aggregate in its transaction. A changed revision
// (or updateTime, including older app versions) means this scan must not overwrite it.
export async function backfillStoreDailyStats(
  storeId: string,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const today = getVietnamBusinessDate();
  // Tối ưu hóa Reads: Đưa khoảng ngày trực tiếp vào truy vấn Firestore
  let baselineQuery: any = adminDb
    .collection("daily_stats")
    .where("storeId", "==", storeId);
  if (options.startDate) {
    baselineQuery = baselineQuery.where("date", ">=", options.startDate);
  }
  if (options.endDate) {
    baselineQuery = baselineQuery.where("date", "<=", options.endDate);
  }
  let baseline;
  try {
    baseline = await baselineQuery.get();
  } catch (err: any) {
    if (err?.code === 9 || err?.message?.includes('FAILED_PRECONDITION') || err?.message?.includes('index')) {
      console.warn('[Backfill Index Warning] Cần triển khai composite index (storeId, date) cho daily_stats. Tạm fallback quét theo storeId.');
      const allDaily = await adminDb.collection("daily_stats").where("storeId", "==", storeId).get();
      const filteredDocs = allDaily.docs.filter((d: any) => {
        const dDate = d.data()?.date || '';
        if (options.startDate && dDate < options.startDate) return false;
        if (options.endDate && dDate > options.endDate) return false;
        return true;
      });
      baseline = { docs: filteredDocs };
    } else {
      throw err;
    }
  }
  const baselineById = new Map<string, any>(
    baseline.docs.map((d: any) => [d.id, d])
  );

  let invQuery: any = adminDb
    .collection("invoices")
    .where("storeId", "==", storeId);
  if (options.startDate) {
    const { startIso } = getVietnamDayBoundariesIso(options.startDate);
    invQuery = invQuery.where("date", ">=", startIso);
  }
  if (options.endDate) {
    const { endExclusiveIso } = getVietnamDayBoundariesIso(options.endDate);
    invQuery = invQuery.where("date", "<", endExclusiveIso);
  }
  const invoiceSnapshot = await invQuery.get();

  let cashQuery: any = adminDb
    .collection("cash_transactions")
    .where("storeId", "==", storeId);
  if (options.startDate) {
    const { startIso } = getVietnamDayBoundariesIso(options.startDate);
    cashQuery = cashQuery.where("date", ">=", startIso);
  }
  if (options.endDate) {
    const { endExclusiveIso } = getVietnamDayBoundariesIso(options.endDate);
    cashQuery = cashQuery.where("date", "<", endExclusiveIso);
  }
  const cashSnapshot = await cashQuery.get();
  const invoiceDays = new Map<string, Invoice[]>(),
    cashDays = new Map<string, CashTransaction[]>();
  const dates = new Set<string>();
  const inRange = (day: string) =>
    day < today &&
    (!options.startDate || day >= options.startDate) &&
    (!options.endDate || day <= options.endDate);
  for (const source of invoiceSnapshot.docs) {
    const invoice = { ...source.data(), id: source.id } as Invoice;
    const day = businessDateOf(invoice);
    if (!inRange(day) || invoice.status === "cancelled") continue;
    dates.add(day);
    invoiceDays.set(day, [...(invoiceDays.get(day) || []), invoice]);
  }
  for (const source of cashSnapshot.docs) {
    const tx = { ...source.data(), id: source.id } as CashTransaction;
    const day = businessDateOf(tx);
    if (!inRange(day)) continue;
    dates.add(day);
    cashDays.set(day, [...(cashDays.get(day) || []), tx]);
  }
  // Include existing aggregate dates so a now-empty day is reset to zero activity.
  for (const snapshot of baseline.docs) {
    const day = snapshot.data().date;
    if (typeof day === "string" && inRange(day)) dates.add(day);
  }
  if (options.startDate && options.endDate) {
    const start = new Date(`${options.startDate}T00:00:00+07:00`),
      end = new Date(`${options.endDate}T00:00:00+07:00`);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start > end
    )
      throw new Error("Khoảng ngày đối soát không hợp lệ.");
    for (let time = start.getTime(); time <= end.getTime(); time += 86400000) {
      const day = getVietnamBusinessDate(new Date(time));
      if (inRange(day)) dates.add(day);
    }
  }
  // Keep unmatched days available from their original documents for review.
  const planned: DailyStats[] = [];
  const skippedUnreconciledDays: BackfillResult['skippedUnreconciledDays'] = [];
  for (const date of [...dates].sort()) {
    try {
      planned.push(reconcileDay(storeId, date, invoiceDays.get(date) || [], cashDays.get(date) || []));
    } catch (error) {
      skippedUnreconciledDays.push({ date, reason: error instanceof Error ? error.message : 'Chứng từ không hợp lệ.' });
    }
  }
  const skippedChangedDays: string[] = [];
  let written = 0;
  if (!options.dryRun)
    for (const stat of planned) {
      const ref = adminDb.doc(`daily_stats/${stat.id}`),
        expected = baselineById.get(stat.id);
      const applied = await adminDb.runTransaction(async (txn) => {
        const current = await txn.get(ref);
        const unchanged =
          current.exists === Boolean(expected) &&
          (!current.exists ||
            Boolean(current.updateTime?.isEqual(expected!.updateTime!)));
        if (!unchanged) return false;
        const now = new Date().toISOString();
        txn.set(ref, {
          ...stat,
          reconciledAt: now,
          updatedAt: now,
          sourceVersion: 3,
          version: 3,
          sourceRevision: current.data()?.sourceRevision || 0,
        });
        return true;
      });
      if (applied) written++;
      else skippedChangedDays.push(stat.date);
    }
  return {
    storeId,
    totalDaysAggregated: planned.length,
    totalInvoicesScanned: invoiceSnapshot.size,
    totalCashTxsScanned: cashSnapshot.size,
    updatedStatsDocs: written,
    daysWithEstimatedCost: planned.filter((s) => s.costStatus === "estimated")
      .length,
    daysWithCompleteCost: planned.filter((s) => s.costStatus === "complete")
      .length,
    skippedTodayDate: today,
    skippedChangedDays,
    skippedUnreconciledDays,
    dryRun: options.dryRun,
  };
}
