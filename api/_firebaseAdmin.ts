import { initializeApp as initAdminApp, getApps as getAdminApps, cert } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { initializeApp as initClientApp, getApps as getClientApps } from 'firebase/app';
import {
  getFirestore as getClientFirestore,
  collection as clientCollection,
  doc as clientDoc,
  getDoc as clientGetDoc,
  getDocs as clientGetDocs,
  setDoc as clientSetDoc,
  updateDoc as clientUpdateDoc,
  deleteDoc as clientDeleteDoc,
  addDoc as clientAddDoc,
  query as clientQuery,
  where as clientWhere,
  limit as clientLimit,
  orderBy as clientOrderBy,
  writeBatch as clientWriteBatch,
  deleteField as clientDeleteField,
  startAfter as clientStartAfter,
  documentId as clientDocumentId
} from 'firebase/firestore';

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'app-fnb-d8940';
const apiKey = process.env.VITE_FIREBASE_API_KEY || "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE";
const authDomain = process.env.VITE_FIREBASE_AUTH_DOMAIN || "app-fnb-d8940.firebaseapp.com";

// Kiểm tra xem có cấu hình Service Account thực tế từ Vercel hay không
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY;

export const hasAdminCredential = Boolean(
  (serviceAccountRaw && serviceAccountRaw.trim().length > 10) ||
  (clientEmail && privateKey && clientEmail.includes('@'))
);

export const getAdminStatus = () => ({
  hasCredential: hasAdminCredential,
  isInitialized: Boolean(rawAdminApp && rawAdminDb),
  projectId
});

// 1. Khởi tạo Firebase Admin SDK (Chỉ khi có Service Account thật)
let rawAdminApp: any = null;
let rawAdminDb: any = null;
let rawAdminAuth: any = null;

if (hasAdminCredential) {
  try {
    const existing = getAdminApps();
    if (existing.length > 0) {
      rawAdminApp = existing[0];
    } else if (serviceAccountRaw) {
      const parsed = JSON.parse(serviceAccountRaw);
      rawAdminApp = initAdminApp({
        credential: cert(parsed),
        projectId: parsed.project_id || projectId
      });
    } else if (clientEmail && privateKey) {
      rawAdminApp = initAdminApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
        projectId
      });
    }
    if (rawAdminApp) {
      rawAdminDb = getAdminFirestore(rawAdminApp);
      rawAdminAuth = getAdminAuth(rawAdminApp);
    }
  } catch (err) {
    console.warn("[FirebaseAdmin] Failed to initialize Firebase Admin with service account:", err);
  }
}

// 2. Khởi tạo Firebase Client SDK trên server (làm cầu nối fallback siêu tốc và an toàn cho dev/preview)
const getClientDbInstance = () => {
  const apps = getClientApps();
  const cApp = apps.find(a => a.name === 'server-client-bridge') || initClientApp({
    apiKey,
    authDomain,
    projectId,
  }, 'server-client-bridge');
  return getClientFirestore(cApp);
};

const cDb = getClientDbInstance();

// Hàm chuẩn hóa dữ liệu khi gửi qua Client SDK (thay thế FieldValue.delete)
const sanitizeDataForClient = (data: any): any => {
  if (!data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeDataForClient);

  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && ('isEqual' in value || value.constructor?.name === 'FieldValue')) {
      clean[key] = clientDeleteField();
    } else if (value && typeof value === 'object' && !(value instanceof Date)) {
      clean[key] = sanitizeDataForClient(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
};

// 3. Adapter Collection & Query tương thích chuẩn Admin SDK
class ClientQueryAdapter {
  private colName: string;
  private filters: Array<{ field: string; op: any; val: any }> = [];
  private orders: Array<{ field: string; dir: 'asc' | 'desc' }> = [];
  private limitNum: number | null = null;

  constructor(colName: string) {
    this.colName = colName;
  }

  where(field: string, op: any, val: any) {
    this.filters.push({ field, op, val });
    return this;
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    this.orders.push({ field, dir });
    return this;
  }

  private startAfterDocOrId: any = null;

  startAfter(cursor: any) {
    this.startAfterDocOrId = cursor;
    return this;
  }

  limit(num: number) {
    this.limitNum = num;
    return this;
  }

  async get() {
    let q: any = clientCollection(cDb, this.colName);
    const constraints: any[] = [];
    for (const f of this.filters) {
      constraints.push(clientWhere(f.field, f.op, f.val));
    }
    for (const o of this.orders) {
      constraints.push(clientOrderBy(o.field, o.dir));
    }
    if (this.startAfterDocOrId) {
      if (typeof this.startAfterDocOrId === 'string') {
        constraints.push(clientWhere(clientDocumentId(), '>', this.startAfterDocOrId));
      } else {
        constraints.push(clientStartAfter(this.startAfterDocOrId));
      }
    }
    if (this.limitNum) {
      constraints.push(clientLimit(this.limitNum));
    }
    if (constraints.length > 0) {
      q = clientQuery(q, ...constraints);
    }
    const snapshot = await clientGetDocs(q);
    const docs = snapshot.docs.map(d => ({
      id: d.id,
      exists: true,
      data: () => d.data(),
      ref: { id: d.id, path: `${this.colName}/${d.id}` }
    }));
    return {
      empty: snapshot.empty,
      size: snapshot.size,
      docs,
      forEach(cb: (doc: any) => void) {
        docs.forEach(cb);
      }
    };
  }
}

class AdminQueryAdapter {
  private colName: string;
  private rawQuery: any;
  private filters: Array<{ field: string; op: any; val: any }> = [];
  private orders: Array<{ field: string; dir: 'asc' | 'desc' }> = [];
  private limitNum: number | null = null;
  private startAfterCursor: any = null;

  constructor(colName: string, rawQuery: any, initialFilter?: { field: string; op: any; val: any }) {
    this.colName = colName;
    this.rawQuery = rawQuery;
    if (initialFilter) {
      this.filters.push(initialFilter);
    }
  }

  where(field: string, op: any, val: any) {
    if (this.rawQuery) {
      try {
        this.rawQuery = this.rawQuery.where(field, op, val);
      } catch (e) {
        this.rawQuery = null;
      }
    }
    this.filters.push({ field, op, val });
    return this;
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    if (this.rawQuery) {
      try {
        this.rawQuery = this.rawQuery.orderBy(field, dir);
      } catch (e) {
        this.rawQuery = null;
      }
    }
    this.orders.push({ field, dir });
    return this;
  }

  startAfter(cursor: any) {
    if (this.rawQuery) {
      try {
        this.rawQuery = this.rawQuery.startAfter(cursor);
      } catch (e) {
        this.rawQuery = null;
      }
    }
    this.startAfterCursor = cursor;
    return this;
  }

  limit(num: number) {
    if (this.rawQuery) {
      try {
        this.rawQuery = this.rawQuery.limit(num);
      } catch (e) {
        this.rawQuery = null;
      }
    }
    this.limitNum = num;
    return this;
  }

  async get() {
    if (this.rawQuery) {
      try {
        const snap = await this.rawQuery.get();
        if (snap && typeof snap.forEach === 'function') {
          return snap;
        }
        return {
          empty: snap.empty,
          size: snap.size,
          docs: snap.docs,
          forEach(cb: (doc: any) => void) {
            snap.docs.forEach(cb);
          }
        };
      } catch (err: any) {
        if (!err.message?.includes('PERMISSION_DENIED') && err.code !== 7) {
          throw err;
        }
      }
    }
    // Fallback sang Client Query
    let clientQ = new ClientQueryAdapter(this.colName);
    for (const f of this.filters) {
      clientQ.where(f.field, f.op, f.val);
    }
    for (const o of this.orders) {
      clientQ.orderBy(o.field, o.dir);
    }
    if (this.startAfterCursor) {
      clientQ.startAfter(this.startAfterCursor);
    }
    if (this.limitNum) {
      clientQ.limit(this.limitNum);
    }
    return clientQ.get();
  }
}

class ClientDocRefAdapter {
  id: string;
  path: string;
  private colName: string;

  constructor(colName: string, id?: string) {
    this.colName = colName;
    if (id) {
      this.id = id;
    } else {
      this.id = clientDoc(clientCollection(cDb, colName)).id;
    }
    this.path = `${colName}/${this.id}`;
  }

  async get() {
    try {
      const dRef = clientDoc(cDb, this.colName, this.id);
      const snap = await clientGetDoc(dRef);
      return {
        exists: snap.exists(),
        id: snap.id,
        data: () => snap.data() || {}
      };
    } catch (err: any) {
      console.error(`[FirebaseBridge] Error reading document ${this.path}:`, err?.message || err);
      throw err;
    }
  }

  async set(data: any, options?: { merge?: boolean }) {
    try {
      const dRef = clientDoc(cDb, this.colName, this.id);
      await clientSetDoc(dRef, sanitizeDataForClient(data), options || {});
    } catch (err: any) {
      console.error(`[FirebaseBridge] Error writing document ${this.path}:`, err?.message || err);
      throw err;
    }
  }

  async update(data: any) {
    try {
      const dRef = clientDoc(cDb, this.colName, this.id);
      await clientUpdateDoc(dRef, sanitizeDataForClient(data));
    } catch (err: any) {
      console.error(`[FirebaseBridge] Error updating document ${this.path}:`, err?.message || err);
      throw err;
    }
  }

  async delete() {
    try {
      const dRef = clientDoc(cDb, this.colName, this.id);
      await clientDeleteDoc(dRef);
    } catch (err: any) {
      console.error(`[FirebaseBridge] Error deleting document ${this.path}:`, err?.message || err);
      throw err;
    }
  }
}

class ClientBatchAdapter {
  private batch = clientWriteBatch(cDb);

  set(docRef: any, data: any, options?: any) {
    const dRef = clientDoc(cDb, docRef.path);
    this.batch.set(dRef, sanitizeDataForClient(data), options || {});
    return this;
  }

  update(docRef: any, data: any) {
    const dRef = clientDoc(cDb, docRef.path);
    this.batch.update(dRef, sanitizeDataForClient(data));
    return this;
  }

  delete(docRef: any) {
    const dRef = clientDoc(cDb, docRef.path);
    this.batch.delete(dRef);
    return this;
  }

  async commit() {
    await this.batch.commit();
  }
}

export function unwrapDocumentReference(ref: any): any {
  if (!ref) return ref;
  if (ref._rawRef) return ref._rawRef;
  if (typeof ref === 'object' && (ref.constructor?.name === 'DocumentReference' || typeof ref.get === 'function')) {
    if (ref.path && hasAdminCredential && rawAdminDb && !(ref instanceof (rawAdminDb.collection('dummy').doc().constructor as any))) {
      return rawAdminDb.doc(ref.path);
    }
    return ref;
  }
  if (ref.path && hasAdminCredential && rawAdminDb) {
    return rawAdminDb.doc(ref.path);
  }
  return ref;
}

// 4. Unified adminDb: Tự động dùng Admin SDK khi có quyền, tự động fallback an toàn sang Client bridge
export const adminDb = {
  collection(colName: string) {
    return {
      doc(id?: string) {
        if (hasAdminCredential && rawAdminDb) {
          const rawDoc = id ? rawAdminDb.collection(colName).doc(id) : rawAdminDb.collection(colName).doc();
          return rawDoc;
        }
        return new ClientDocRefAdapter(colName, id);
      },

      where(field: string, op: any, val: any) {
        const rawQ = hasAdminCredential && rawAdminDb ? rawAdminDb.collection(colName).where(field, op, val) : null;
        return new AdminQueryAdapter(colName, rawQ, { field, op, val });
      },

      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        const rawQ = hasAdminCredential && rawAdminDb ? rawAdminDb.collection(colName).orderBy(field, dir) : null;
        const adapter = new AdminQueryAdapter(colName, rawQ);
        return adapter.orderBy(field, dir);
      },

      limit(num: number) {
        const rawQ = hasAdminCredential && rawAdminDb ? rawAdminDb.collection(colName).limit(num) : null;
        const adapter = new AdminQueryAdapter(colName, rawQ);
        return adapter.limit(num);
      },

      startAfter(cursor: any) {
        const rawQ = hasAdminCredential && rawAdminDb ? rawAdminDb.collection(colName) : null;
        const adapter = new AdminQueryAdapter(colName, rawQ);
        return adapter.startAfter(cursor);
      },

      async get() {
        const rawQ = hasAdminCredential && rawAdminDb ? rawAdminDb.collection(colName) : null;
        const adapter = new AdminQueryAdapter(colName, rawQ);
        return adapter.get();
      },

      async add(data: any) {
        if (hasAdminCredential && rawAdminDb) {
          try {
            return await rawAdminDb.collection(colName).add(data);
          } catch (e: any) {
            if (!e.message?.includes('PERMISSION_DENIED') && e.code !== 7) {
              throw e;
            }
          }
        }
        const docRef = await clientAddDoc(clientCollection(cDb, colName), sanitizeDataForClient(data));
        return { id: docRef.id, path: docRef.path };
      }
    };
  },

  doc(docPath: string) {
    if (hasAdminCredential && rawAdminDb) {
      return rawAdminDb.doc(docPath);
    }
    const [colName, ...idParts] = docPath.split('/');
    return new ClientDocRefAdapter(colName, idParts.join('/'));
  },

  batch() {
    if (hasAdminCredential && rawAdminDb) {
      const rawBatch = rawAdminDb.batch();
      return {
        set(docRef: any, data: any, options?: any) {
          return rawBatch.set(unwrapDocumentReference(docRef), data, options || {});
        },
        update(docRef: any, data: any, ...more: any[]) {
          return rawBatch.update(unwrapDocumentReference(docRef), data, ...more);
        },
        delete(docRef: any) {
          return rawBatch.delete(unwrapDocumentReference(docRef));
        },
        commit() {
          return rawBatch.commit();
        }
      };
    }
    return new ClientBatchAdapter();
  },

  async runTransaction(updateFunction: (transaction: any) => Promise<any>) {
    if (hasAdminCredential && rawAdminDb) {
      return await rawAdminDb.runTransaction(async (rawTxn: any) => {
        const txnWrapper = {
          get(docRef: any) {
            return rawTxn.get(unwrapDocumentReference(docRef));
          },
          set(docRef: any, data: any, options?: any) {
            return rawTxn.set(unwrapDocumentReference(docRef), data, options || {});
          },
          update(docRef: any, data: any, ...more: any[]) {
            return rawTxn.update(unwrapDocumentReference(docRef), data, ...more);
          },
          delete(docRef: any) {
            return rawTxn.delete(unwrapDocumentReference(docRef));
          }
        };
        return await updateFunction(txnWrapper);
      });
    }

    // Fallback transaction adapter
    const txAdapter = {
      async get(docRef: any) {
        return await docRef.get();
      },
      update(docRef: any, data: any) {
        return docRef.update(data);
      },
      set(docRef: any, data: any, options?: any) {
        return docRef.set(data, options);
      },
      delete(docRef: any) {
        return docRef.delete();
      }
    };
    return await updateFunction(txAdapter);
  }
};

// 5. Unified adminAuth: Xác thực và ký token qua Firebase Admin SDK chính thức
export const adminAuth = {
  async createCustomToken(uid: string, developerClaims?: Record<string, any>): Promise<string | null> {
    if (hasAdminCredential && rawAdminAuth) {
      try {
        return await rawAdminAuth.createCustomToken(uid, developerClaims);
      } catch (err: any) {
        console.warn("[AdminAuth] createCustomToken error:", err.message);
        return null;
      }
    }
    return null;
  },

  async verifyIdToken(token: string): Promise<any> {
    if (!token || typeof token !== 'string') {
      throw new Error('[Security Error] Token không hợp lệ.');
    }
    if (token.startsWith('dev_token_')) {
      throw new Error('[Security Error] Từ chối token giả lập (dev_token) - cơ chế bị loại bỏ hoàn toàn.');
    }
    if (hasAdminCredential && rawAdminAuth) {
      return await rawAdminAuth.verifyIdToken(token);
    }
    throw new Error('[Security Error] Firebase Admin SDK chưa được cấu hình Service Account hợp lệ để xác minh chữ ký token.');
  },

  async revokeRefreshTokens(uid: string): Promise<void> {
    if (hasAdminCredential && rawAdminAuth) {
      try {
        await rawAdminAuth.revokeRefreshTokens(uid);
      } catch (err: any) {
        console.warn("[AdminAuth] revokeRefreshTokens error for uid:", uid, err?.message || err);
      }
    }
  }
};

export const safeDeleteSentinel = FieldValue.delete;
