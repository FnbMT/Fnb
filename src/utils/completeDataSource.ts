import {
  collection,
  query,
  where,
  onSnapshot,
  getDocsFromServer,
  type DocumentData,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { businessDateOf } from "./dataIntegrity";
import { getVietnamDayBoundariesIso } from "./firestoreDateHelper";

// Lắng nghe dữ liệu theo dải ngày:
// Tối ưu hóa tuyệt đối số lượt đọc (Reads) bằng cách truy vấn theo businessDate / businessMonth / businessYear.
// Các điều kiện so sánh bằng (==) được Firestore Index-Merge tự động,
// HOÀN TOÀN KHÔNG YÊU CẦU tạo Composite Index thủ công, không bao giờ bị lỗi 'The query requires an index'.
export function subscribeDateRange<
  T extends { date?: string; businessDate?: string; businessMonth?: string; businessYear?: number }
>(
  name: string,
  storeId: string,
  firstDay: string,
  lastDay: string,
  onData: (rows: T[], confirmed: boolean) => void,
  onError: (error: Error) => void
): () => void {
  let closed = false;
  let activeUnsubscribe: (() => void) | undefined;
  const { startIso } = getVietnamDayBoundariesIso(firstDay);
  const { endExclusiveIso } = getVietnamDayBoundariesIso(lastDay);

  const emitRows = (snapshot: any) => {
    try {
      const rows = snapshot.docs
        .map((d: any) => ({ ...d.data(), id: d.id } as unknown as T))
        .filter((row: any) => {
          const date = businessDateOf(row);
          if (date >= firstDay && date <= lastDay) return true;
          const d = row.date;
          return d && d >= startIso && d < endExclusiveIso;
        })
        .sort((a: any, b: any) => ((a.date || '')).localeCompare(b.date || ''));

      onData(
        rows,
        !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites
      );
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const startFallback = () => {
    if (closed) return;
    try {
      if (activeUnsubscribe) {
        try { activeUnsubscribe(); } catch (_) {}
      }
      activeUnsubscribe = onSnapshot(
        query(collection(db, name), where("storeId", "==", storeId)),
        { includeMetadataChanges: true },
        (snapshot) => {
          if (closed) return;
          emitRows(snapshot);
        },
        (error) => {
          if (closed) return;
          console.error(`[Firestore Subscription Error] ${name}:`, error);
          onError(error);
        }
      );
    } catch (fbErr: any) {
      onError(fbErr);
    }
  };

  // 1. Phân loại truy vấn theo trường nghiệp vụ có sẵn (businessDate / businessMonth / businessYear)
  const hasBusinessFields = name === 'invoices' || name === 'cash_transactions';
  let targetQuery: any;

  if (hasBusinessFields && firstDay === lastDay) {
    // Xem theo 1 ngày duy nhất (Hôm nay, Hôm qua, hoặc ngày cụ thể):
    // Chỉ đọc chính xác các hóa đơn của ngày đó (Tiết kiệm reads tối đa, 0 index lỗi)
    targetQuery = query(
      collection(db, name),
      where("storeId", "==", storeId),
      where("businessDate", "==", firstDay)
    );
  } else if (hasBusinessFields && firstDay.slice(0, 7) === lastDay.slice(0, 7)) {
    // Xem theo 1 tháng duy nhất:
    // Chỉ đọc các hóa đơn của tháng đó (Tiết kiệm reads, 0 index lỗi)
    targetQuery = query(
      collection(db, name),
      where("storeId", "==", storeId),
      where("businessMonth", "==", firstDay.slice(0, 7))
    );
  } else if (hasBusinessFields && firstDay.slice(0, 4) === lastDay.slice(0, 4)) {
    // Xem theo 1 năm duy nhất:
    targetQuery = query(
      collection(db, name),
      where("storeId", "==", storeId),
      where("businessYear", "==", parseInt(firstDay.slice(0, 4), 10))
    );
  } else {
    // Dải ngày đa kỳ hoặc collection không có businessDate (inventory_logs):
    targetQuery = query(
      collection(db, name),
      where("storeId", "==", storeId)
    );
  }

  try {
    activeUnsubscribe = onSnapshot(
      targetQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (closed) return;
        emitRows(snapshot);
      },
      (error) => {
        if (closed) return;
        if (error.code === "failed-precondition") {
          startFallback();
        } else {
          onError(error);
        }
      }
    );
  } catch (initialErr: any) {
    if (initialErr?.code === "failed-precondition") {
      startFallback();
    } else {
      onError(initialErr);
    }
  }

  return () => {
    closed = true;
    activeUnsubscribe?.();
  };
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
