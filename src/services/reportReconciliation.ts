import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  runTransaction,
  where,
} from 'firebase/firestore';
import { subDays, format, parseISO, eachDayOfInterval } from 'date-fns';
import { db } from '../lib/firebase';
import type { CashTransaction, DailyStats, Invoice } from '../types';
import { businessDateOf, reconcileDay } from '../utils/dataIntegrity';
import { fetchDateRangeRows } from '../utils/completeDataSource';
import { contiguousDateRanges, reconciledSource } from '../utils/reportSources';

function fingerprintDoc(value: unknown): string {
  if (!value || typeof value !== 'object') return 'null';
  return JSON.stringify(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  );
}

export interface BatchReconcileResult {
  saved: number;
  skipped: string[];
}

/**
 * Đối soát và chốt daily_stats theo lô khoảng ngày liên tiếp (Contiguous Date Ranges).
 * - Tiết kiệm tối đa lượt đọc Firestore bằng cách gộp các ngày liên tiếp thành 1 truy vấn thay vì đọc lẻ từng ngày trống.
 * - Đảm bảo tính đúng đắn 100%: Kiểm tra chéo hóa đơn - phiếu thu (receiptMismatch) và xác nhận revision trong Transaction.
 * - Ngày có sai lệch chứng từ sẽ được bỏ qua an toàn (không ghi đè ép) để giữ nguyên cảnh báo cho Quản trị viên kiểm tra.
 */
export async function reconcileStoreDaysBatch(
  storeId: string,
  daysToReconcile: string[],
  todayVn: string,
  onStatus?: (msg: string) => void
): Promise<BatchReconcileResult> {
  const pastDays = [...new Set(daysToReconcile)].filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day) && day < todayVn).sort();
  if (!storeId || pastDays.length === 0) {
    return { saved: 0, skipped: [] };
  }

  const ranges = contiguousDateRanges(pastDays);
  let saved = 0;
  const skipped: string[] = [];

  for (const range of ranges) {
    onStatus?.(`Đang tải & đối soát chứng từ từ ${range.start} đến ${range.end}...`);

    // 1. Đọc baseline của daily_stats trong khoảng ngày này
    const baselines = new Map<string, { exists: boolean; fp: string; pending: boolean }>();
    try {
      const statsSnap = await getDocsFromServer(
        query(
          collection(db, 'daily_stats'),
          where('storeId', '==', storeId),
          where('date', '>=', range.start),
          where('date', '<=', range.end)
        )
      );
      statsSnap.docs.forEach(d => {
        const dateKey = String(d.data().date || '');
        if (dateKey) {
          baselines.set(dateKey, {
            exists: true,
            fp: fingerprintDoc(d.data()),
            pending: d.metadata.hasPendingWrites,
          });
        }
      });
    } catch {
      // Fallback đọc từng doc nếu thiếu composite index
      for (const day of range.dates) {
        const snap = await getDocFromServer(doc(db, 'daily_stats', `${storeId}_${day}`));
        baselines.set(day, {
          exists: snap.exists(),
          fp: fingerprintDoc(snap.data()),
          pending: snap.metadata.hasPendingWrites,
        });
      }
    }

    // 2. Đọc gộp toàn bộ invoices và cash_transactions cho cả dải ngày liên tục (0 reads thừa ở các ngày nghỉ không phát sinh đơn)
    let rangeInvoices: Invoice[] = [];
    let rangeCash: CashTransaction[] = [];
    try {
      [rangeInvoices, rangeCash] = await Promise.all([
        fetchDateRangeRows<Invoice>('invoices', storeId, range.start, range.end),
        fetchDateRangeRows<CashTransaction>('cash_transactions', storeId, range.start, range.end),
      ]);
    } catch (rangeErr: any) {
      for (const day of range.dates) {
        skipped.push(`${day} · ${rangeErr?.message || 'Chưa tải đủ chứng từ từ máy chủ.'}`);
      }
      continue;
    }

    // 3. Phân nhóm chứng từ chính xác theo ngày kinh doanh Việt Nam
    const invoicesByDay = new Map<string, Invoice[]>();
    const cashByDay = new Map<string, CashTransaction[]>();
    let groupingError = '';

    for (const inv of rangeInvoices) {
      try {
        const d = businessDateOf(inv);
        const list = invoicesByDay.get(d);
        if (list) list.push(inv);
        else invoicesByDay.set(d, [inv]);
      } catch (e: any) {
        groupingError = e?.message || 'Hóa đơn thiếu ngày hợp lệ.';
      }
    }
    for (const tx of rangeCash) {
      try {
        const d = businessDateOf(tx);
        const list = cashByDay.get(d);
        if (list) list.push(tx);
        else cashByDay.set(d, [tx]);
      } catch (e: any) {
        groupingError = e?.message || 'Phiếu thu/chi thiếu ngày hợp lệ.';
      }
    }

    if (groupingError) {
      for (const day of range.dates) {
        skipped.push(`${day} · ${groupingError}`);
      }
      continue;
    }

    // 4. Đối soát & lưu nguyên tử từng ngày
    for (const day of range.dates) {
      const base = baselines.get(day) || { exists: false, fp: 'null', pending: false };
      if (base.pending) {
        skipped.push(`${day} · Dữ liệu ngày này đang chờ đồng bộ.`);
        continue;
      }

      try {
        const dayInvoices = invoicesByDay.get(day) || [];
        const dayCash = cashByDay.get(day) || [];
        const stat = reconcileDay(storeId, day, dayInvoices, dayCash);
        const statsRef = doc(db, 'daily_stats', `${storeId}_${day}`);

        await runTransaction(db, async txn => {
          const current = await txn.get(statsRef);
          const currentFp = current.exists() ? fingerprintDoc(current.data()) : 'null';
          if (current.exists() !== base.exists || currentFp !== base.fp) {
            throw new Error('Có giao dịch mới phát sinh trong lúc đối soát.');
          }
          const now = new Date().toISOString();
          const revision = Number(current.data()?.sourceRevision || 0);
          txn.set(
            statsRef,
            {
              ...stat,
              reconciledAt: now,
              updatedAt: now,
              sourceRevision: (Number.isFinite(revision) ? revision : 0) + 1,
            },
            { merge: true }
          );
        });
        saved++;
      } catch (dayErr: any) {
        skipped.push(`${day} · ${dayErr?.message || 'Chưa xác nhận được chứng từ.'}`);
      }
    }
  }

  return { saved, skipped };
}

const inFlightAutoReconcile = new Set<string>();

/**
 * Tự động chốt sổ ngầm các ngày quá khứ gần nhất (tối đa 14 ngày trước hôm nay) 1 lần/ngày khi Admin/Manager mở ứng dụng.
 * Giúp báo cáo Tháng/Năm luôn đọc trực tiếp từ daily_stats đã xác nhận (chỉ ~30 reads/tháng thay vì hàng chục nghìn reads).
 */
export async function autoReconcileRecentPastDays(storeId: string, todayVn: string): Promise<void> {
  if (!storeId || !/^\d{4}-\d{2}-\d{2}$/.test(todayVn)) return;
  const lockKey = `${storeId}:${todayVn}`;
  if (inFlightAutoReconcile.has(lockKey)) return;

  const storageKey = `fnb_auto_reconciled_v1_${storeId}`;
  try {
    if (localStorage.getItem(storageKey) === todayVn) return;
  } catch {
    // Ignore storage error
  }

  inFlightAutoReconcile.add(lockKey);
  try {
    const todayDate = parseISO(`${todayVn}T00:00:00`);
    const startDate = subDays(todayDate, 14);
    const yesterdayDate = subDays(todayDate, 1);
    if (startDate > yesterdayDate) return;

    const candidateDays = eachDayOfInterval({ start: startDate, end: yesterdayDate })
      .map(d => format(d, 'yyyy-MM-dd'))
      .filter(d => d < todayVn);

    if (candidateDays.length === 0) return;

    const firstDay = candidateDays[0];
    const lastDay = candidateDays[candidateDays.length - 1];

    const statsSnap = await getDocsFromServer(
      query(
        collection(db, 'daily_stats'),
        where('storeId', '==', storeId),
        where('date', '>=', firstDay),
        where('date', '<=', lastDay)
      )
    );

    const byDate = new Map<string, DailyStats>();
    statsSnap.docs.forEach(d => {
      const data = { ...d.data(), id: d.id } as DailyStats;
      if (data.date) byDate.set(data.date, data);
    });

    // Chỉ đối soát những ngày thực sự có giao dịch chưa chốt (coverageStatus !== 'reconciled')
    // hoặc ngày hôm qua (để đóng sổ ngày liền kề chuẩn xác)
    const yesterdayStr = candidateDays[candidateDays.length - 1];
    const missingDays = candidateDays.filter(day => {
      const stat = byDate.get(day);
      if (!stat) {
        // Chỉ tự động ghi zero_activity cho ngày hôm qua hoặc những ngày nằm giữa các ngày có hoạt động gần nhất
        return day === yesterdayStr;
      }
      return !reconciledSource(stat, 'invoices') || !reconciledSource(stat, 'cash');
    });

    if (missingDays.length > 0) {
      await reconcileStoreDaysBatch(storeId, missingDays, todayVn);
    }

    try {
      localStorage.setItem(storageKey, todayVn);
    } catch {
      // Ignore storage error
    }
  } catch (err) {
    console.warn('[AutoReconcile] Tạm hoãn đối soát nền:', err);
  } finally {
    inFlightAutoReconcile.delete(lockKey);
  }
}
