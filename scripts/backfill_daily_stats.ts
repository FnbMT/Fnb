import { adminDb } from "../api/_firebaseAdmin";
import type { Invoice, CashTransaction, DailyStats } from "../src/types";
import { aggregateDay, businessDateOf } from "../src/utils/dataIntegrity";
import { getVietnamBusinessDate } from "../src/utils/firestoreDateHelper";

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
  const baseline = await adminDb
    .collection("daily_stats")
    .where("storeId", "==", storeId)
    .get();
  const baselineById = new Map<string, any>(
    baseline.docs.map((d) => [d.id, d])
  );
  const invoiceSnapshot = await adminDb
    .collection("invoices")
    .where("storeId", "==", storeId)
    .get();
  const cashSnapshot = await adminDb
    .collection("cash_transactions")
    .where("storeId", "==", storeId)
    .get();
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
  // Validate every computed day before writing any aggregates.
  const planned = [...dates]
    .sort()
    .map((date) =>
      aggregateDay(
        storeId,
        date,
        invoiceDays.get(date) || [],
        cashDays.get(date) || [],
        true
      )
    );
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
    dryRun: options.dryRun,
  };
}
