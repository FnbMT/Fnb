import {
  onSnapshot, queryEqual,
  type DocumentData, type Query, type QuerySnapshot,
} from 'firebase/firestore';

type ReadError = Error & { code?: string };
type Observer = {
  next: (snapshot: QuerySnapshot<DocumentData>) => void;
  error: (error: ReadError) => void;
};
type Entry = {
  target: Query<DocumentData>;
  scope: string;
  observers: Set<Observer>;
  snapshot?: QuerySnapshot<DocumentData>;
  stop: () => void;
  timer?: ReturnType<typeof setTimeout>;
  keepAliveMs: number;
  closed: boolean;
};
export type SharedQueryOptions = { keepAliveMs?: number };

// Chỉ tái sử dụng snapshot khi listener gốc vẫn đang sống và nhận đủ thêm/sửa/xóa.
// Khi listener dừng, xóa cả snapshot; không coi TTL/cache rời rạc là dữ liệu đã xác nhận.
const entries = new Set<Entry>();
let sessionScope = 'no-session';

function close(entry: Entry) {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.stop();
  entry.snapshot = undefined;
  entry.observers.clear();
  entries.delete(entry);
}

export function setSharedReadScope(scope: string) {
  if (scope === sessionScope) return;
  for (const entry of entries) close(entry);
  sessionScope = scope;
}

export function clearSharedReadSession() {
  for (const entry of entries) close(entry);
  sessionScope = 'no-session';
}

export function subscribeSharedQuery(
  target: Query<DocumentData>,
  onData: Observer['next'],
  onError: Observer['error'],
  options: SharedQueryOptions = {},
): () => void {
  const scope = sessionScope;
  let entry = [...entries].find(candidate => !candidate.closed
    && candidate.scope === scope && queryEqual(candidate.target, target));
  const created = !entry;
  if (!entry) {
    entry = { target, scope, observers: new Set(), stop: () => {},
      keepAliveMs: Math.max(0, options.keepAliveMs ?? 300000), closed: false };
    entries.add(entry);
  }
  const shared = entry;
  shared.keepAliveMs = Math.max(shared.keepAliveMs, options.keepAliveMs ?? 300000);
  if (shared.timer !== undefined) { clearTimeout(shared.timer); shared.timer = undefined; }
  const observer: Observer = { next: onData, error: onError };
  shared.observers.add(observer);

  const notify = (receiver: Observer, snapshot: QuerySnapshot<DocumentData>) => {
    try { receiver.next(snapshot); }
    catch (error) {
      // Một consumer lỗi không được làm mất cập nhật của consumer khác.
      try { receiver.error(error instanceof Error ? error : new Error(String(error))); }
      catch (callbackError) { console.error('Lỗi xử lý nguồn dữ liệu:', callbackError); }
    }
  };

  if (created) {
    try {
      const stop = onSnapshot(shared.target, { includeMetadataChanges: true }, snapshot => {
        if (shared.closed) return;
        shared.snapshot = snapshot;
        for (const receiver of [...shared.observers]) {
          if (shared.observers.has(receiver)) notify(receiver, snapshot);
        }
      }, error => {
        if (shared.closed) return;
        const receivers = [...shared.observers];
        close(shared);
        for (const receiver of receivers) {
          try { receiver.error(error); }
          catch (callbackError) { console.error('Lỗi xử lý nguồn dữ liệu:', callbackError); }
        }
      });
      if (shared.closed) stop(); else shared.stop = stop;
    } catch (error) {
      close(shared);
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  } else if (shared.snapshot) {
    // Giữ nguyên metadata, kể cả fromCache/hasPendingWrites; không tự nâng thành confirmed.
    notify(observer, shared.snapshot);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    shared.observers.delete(observer);
    if (shared.closed || shared.observers.size) return;
    if (!shared.keepAliveMs) { close(shared); return; }
    // Khoảng đệm ngắn giúp chuyển tab/đóng mở dropdown không tải lại toàn bộ collection.
    // Listener vẫn nhận cập nhật trong khoảng này, sau đó tự dừng nếu không còn ai dùng.
    shared.timer = setTimeout(() => close(shared), shared.keepAliveMs);
  };
}
