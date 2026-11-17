import {
  collection, query, where, getDocsFromServer,
  type DocumentData, type Query, type QuerySnapshot,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { businessDateOf } from "./dataIntegrity";
import { getVietnamDayBoundariesIso } from "./firestoreDateHelper";
import type { Invoice, CashTransaction } from "../types";
import { subscribeSharedQuery } from './sharedFirestoreQuery';

function periodBounds(firstDay: string, lastDay: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDay) || !/^\d{4}-\d{2}-\d{2}$/.test(lastDay) || firstDay > lastDay)
    throw new Error('Khoảng ngày chứng từ không hợp lệ.');
  return {
    startIso: getVietnamDayBoundariesIso(firstDay).startIso,
    endExclusiveIso: getVietnamDayBoundariesIso(lastDay).endExclusiveIso,
  };
}

// date là dấu thời gian chung của chứng từ ở cả phiên bản cũ và mới.
// Một truy vấn bao phủ cả hai schema, không đọc chồng modern + legacy.
export function dateRangeQuery(name: string, storeId: string, firstDay: string, lastDay: string): Query<DocumentData> {
  const { startIso, endExclusiveIso } = periodBounds(firstDay, lastDay);
  return query(collection(db, name), where('storeId', '==', storeId),
    where('date', '>=', startIso), where('date', '<', endExclusiveIso));
}

function periodRows<T>(snapshot: QuerySnapshot<DocumentData>, storeId: string, firstDay: string, lastDay: string): T[] {
  const { startIso, endExclusiveIso } = periodBounds(firstDay, lastDay);
  return snapshot.docs.map(d => ({ ...d.data(), id: d.id })).filter((row: any) => {
    if (row.storeId !== storeId) return false;
    const day = businessDateOf(row); // Dừng xác nhận nếu chứng từ thiếu ngày hợp lệ.
    return (day >= firstDay && day <= lastDay) || (row.date >= startIso && row.date < endExclusiveIso);
  }).sort((a: any, b: any) => String(a.date || '').localeCompare(String(b.date || ''))) as T[];
}

export function subscribeDateRange<T extends { date?: string; businessDate?: string; businessMonth?: string; businessYear?: number }>(
  name: string, storeId: string, firstDay: string, lastDay: string,
  onData: (rows: T[], confirmed: boolean) => void, onError: (error: Error) => void
): () => void {
  let closed = false;
  let stop: (() => void) | undefined;
  let fallbackStarted = false;
  const fail = (error: unknown) => {
    if (!closed) onError(error instanceof Error ? error : new Error(String((error as any)?.message || error)));
  };
  const start = (target: Query<DocumentData>) => {
    stop = subscribeSharedQuery(target, snapshot => {
      if (closed) return;
      try {
        onData(periodRows<T>(snapshot, storeId, firstDay, lastDay),
          !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites);
      } catch (error) { fail(error); }
    }, error => {
      if (closed) return;
      // Nếu index chưa triển khai, nguồn thay thế vẫn phải đọc ĐỦ và được server xác nhận.
      if (error.code === 'failed-precondition' && !fallbackStarted) {
        fallbackStarted = true;
        stop?.();
        try { start(query(collection(db, name), where('storeId', '==', storeId))); }
        catch (fallbackError) { fail(fallbackError); }
      } else fail(error);
    });
  };
  try { start(dateRangeQuery(name, storeId, firstDay, lastDay)); }
  catch (error) { fail(error); }
  return () => { closed = true; stop?.(); };
}

// Đọc toàn bộ phạm vi theo yêu cầu (xuất file/đối soát), không dùng cache hoặc giới hạn số dòng.
export async function fetchDateRangeRows<T>(name: string, storeId: string, firstDay: string, lastDay: string): Promise<T[]> {
  let snapshot: QuerySnapshot<DocumentData>;
  try { snapshot = await getDocsFromServer(dateRangeQuery(name, storeId, firstDay, lastDay)); }
  catch (error) {
    if ((error as any)?.code !== 'failed-precondition') throw error;
    snapshot = await getDocsFromServer(query(collection(db, name), where('storeId', '==', storeId)));
  }
  if (snapshot.metadata?.hasPendingWrites) throw new Error('Chứng từ đang chờ lưu. Vui lòng đợi đồng bộ trước khi xuất hoặc đối soát.');
  return periodRows<T>(snapshot, storeId, firstDay, lastDay);
}

export async function fetchFinancialPeriodSources(storeId: string, firstDay: string, lastDay: string) {
  const statsQuery = query(collection(db, 'daily_stats'), where('storeId', '==', storeId),
    where('date', '>=', firstDay), where('date', '<=', lastDay));
  const fingerprint = (snapshot: QuerySnapshot<DocumentData>) => JSON.stringify(snapshot.docs.filter(d => d.data().date >= firstDay && d.data().date <= lastDay).map(d => [d.id,
    Object.entries(d.data()).sort(([a], [b]) => a.localeCompare(b))]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  const readRevision = async () => {
    try { return await getDocsFromServer(statsQuery); }
    catch (error) {
      if ((error as any)?.code !== 'failed-precondition') throw error;
      return getDocsFromServer(query(collection(db, 'daily_stats'), where('storeId', '==', storeId)));
    }
  };
  const beforeSnapshot = await readRevision();
  if (beforeSnapshot.metadata?.hasPendingWrites) throw new Error('Dữ liệu đang chờ lưu. Vui lòng đợi đồng bộ.');
  const before = fingerprint(beforeSnapshot);
  const [invoices, cash] = await Promise.all([
    fetchDateRangeRows<Invoice>('invoices', storeId, firstDay, lastDay),
    fetchDateRangeRows<CashTransaction>('cash_transactions', storeId, firstDay, lastDay),
  ]);
  const afterSnapshot = await readRevision();
  if (afterSnapshot.metadata?.hasPendingWrites) throw new Error('Dữ liệu vừa thay đổi. Vui lòng đợi đồng bộ.');
  const after = fingerprint(afterSnapshot);
  if (before !== after) throw new Error('Chứng từ vừa thay đổi trong lúc xuất báo cáo. Vui lòng xuất lại để lấy đủ số liệu cùng phiên bản.');
  return { invoices: invoices.filter(invoice => invoice.status !== 'cancelled'), cash };
}

export async function fetchStoreRows<T = DocumentData>(
  name: string,
  storeId: string
): Promise<T[]> {
  const snapshot = await getDocsFromServer(
    query(collection(db, name), where("storeId", "==", storeId))
  );
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id } as unknown as T));
}

export async function fetchMatchingStoreRows<T = DocumentData>(
  name: string,
  storeId: string,
  field: string,
  value: string
): Promise<T[]> {
  try {
    const snapshot = await getDocsFromServer(
      query(
        collection(db, name),
        where("storeId", "==", storeId),
        where(field, "==", value)
      )
    );
    return snapshot.docs.map(
      (d) => ({ ...d.data(), id: d.id } as unknown as T)
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "failed-precondition")
      throw error;
    return (await fetchStoreRows<T>(name, storeId)).filter(
      (row) => (row as any)[field] === value
    );
  }
}
