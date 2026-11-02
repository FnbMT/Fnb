import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocsFromServer,
  type DocumentData,
  type QueryConstraint,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { businessDateOf } from "./dataIntegrity";
import { getVietnamDayBoundariesIso } from "./firestoreDateHelper";

// A query snapshot contains the entire selected range: no display-page limit is
// ever used as a financial total. A missing index falls back to a full store query.
export function subscribeDateRange<
  T extends { date?: string; businessDate?: string }
>(
  name: string,
  storeId: string,
  firstDay: string,
  lastDay: string,
  onData: (rows: T[], confirmed: boolean) => void,
  onError: (error: Error) => void
): () => void {
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let usingFallback = false;
  const { startIso } = getVietnamDayBoundariesIso(firstDay);
  const { endExclusiveIso } = getVietnamDayBoundariesIso(lastDay);
  const attach = (fallback: boolean) => {
    const constraints: QueryConstraint[] = [where("storeId", "==", storeId)];
    if (!fallback)
      constraints.push(
        where("date", ">=", startIso),
        where("date", "<", endExclusiveIso),
        orderBy("date", "asc")
      );
    unsubscribe = onSnapshot(
      query(collection(db, name), ...constraints),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (closed) return;
        try {
          const rows = snapshot.docs
            .map((d) => ({ ...d.data(), id: d.id } as unknown as T))
            .filter((row) => {
              const date = businessDateOf(row);
              return date >= firstDay && date <= lastDay;
            });
          onData(
            rows,
            !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites
          );
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      },
      (error) => {
        if (closed) return;
        if (
          !usingFallback &&
          (error.code === "failed-precondition" ||
            error.code === "invalid-argument")
        ) {
          usingFallback = true;
          unsubscribe?.();
          attach(true);
        } else onError(error);
      }
    );
  };
  attach(false);
  return () => {
    closed = true;
    unsubscribe?.();
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
