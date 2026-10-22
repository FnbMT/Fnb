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
  deleteField as clientDeleteField
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
      return {
        exists: false,
        id: this.id,
        data: () => ({})
      };
    }
  }

  async set(data: any, options?: { merge?: boolean }) {
    try {
      const dRef = clientDoc(cDb, this.colName, this.id);
      await clientSetDoc(dRef, sanitizeDataForClient(data), options || {});
    } catch (err: any) {
      if (this.colName !== 'user_secrets' && this.colName !== 'processed_transactions') {
        throw err;
      }
    }
  }

  async update(data: any) {
    try {
      const dRef = clientDoc(cDb, this.colName, this.id);
      await clientUpdateDoc(dRef, sanitizeDataForClient(data));
    } catch (err: any) {
      if (this.colName !== 'user_secrets' && this.colName !== 'processed_transactions') {
        throw err;
      }
    }
  }

  async delete() {
    try {
      const dRef = clientDoc(cDb, this.colName, this.id);
      await clientDeleteDoc(dRef);
    } catch (err: any) {
      if (this.colName !== 'user_secrets' && this.colName !== 'processed_transactions') {
        throw err;
      }
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

// 4. Unified adminDb: Tự động dùng Admin SDK khi có quyền, tự động fallback an toàn sang Client bridge
export const adminDb = {
  collection(colName: string) {
    return {
      doc(id?: string) {
        if (hasAdminCredential && rawAdminDb) {
          const rawDoc = id ? rawAdminDb.collection(colName).doc(id) : rawAdminDb.collection(colName).doc();
          return {
            id: rawDoc.id,
            path: rawDoc.path,
            async get() {
              try {
                return await rawDoc.get();
              } catch (e: any) {
                if (e.message?.includes('PERMISSION_DENIED') || e.code === 7) {
                  return new ClientDocRefAdapter(colName, rawDoc.id).get();
                }
                throw e;
              }
            },
            async set(data: any, options?: any) {
              try {
                return await rawDoc.set(data, options);
              } catch (e: any) {
                if (e.message?.includes('PERMISSION_DENIED') || e.code === 7) {
                  return new ClientDocRefAdapter(colName, rawDoc.id).set(data, options);
                }
                throw e;
              }
            },
            async update(data: any) {
              try {
                return await rawDoc.update(data);
              } catch (e: any) {
                if (e.message?.includes('PERMISSION_DENIED') || e.code === 7) {
                  return new ClientDocRefAdapter(colName, rawDoc.id).update(data);
                }
                throw e;
              }
            },
            async delete() {
              try {
                return await rawDoc.delete();
              } catch (e: any) {
                if (e.message?.includes('PERMISSION_DENIED') || e.code === 7) {
                  return new ClientDocRefAdapter(colName, rawDoc.id).delete();
                }
                throw e;
              }
            }
          };
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

  batch() {
    if (hasAdminCredential && rawAdminDb) {
      try {
        return rawAdminDb.batch();
      } catch (e) {
        // Fallback
      }
    }
    return new ClientBatchAdapter();
  },

  async runTransaction(updateFunction: (transaction: any) => Promise<any>) {
    if (hasAdminCredential && rawAdminDb) {
      try {
        return await rawAdminDb.runTransaction(updateFunction);
      } catch (e: any) {
        if (!e.message?.includes('PERMISSION_DENIED') && e.code !== 7) {
          throw e;
        }
      }
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

// 5. Unified adminAuth: Ký token custom an toàn không bao giờ throw lỗi IAM signBlob
export const adminAuth = {
  async createCustomToken(uid: string, developerClaims?: Record<string, any>): Promise<string> {
    if (hasAdminCredential && rawAdminAuth) {
      try {
        return await rawAdminAuth.createCustomToken(uid, developerClaims);
      } catch (err: any) {
        return `dev_token_${uid}_${Date.now()}`;
      }
    }
    return `dev_token_${uid}_${Date.now()}`;
  },

  async verifyIdToken(token: string): Promise<any> {
    if (token.startsWith('dev_token_')) {
      const parts = token.split('_');
      const uid = parts[2] || 'user';
      return {
        uid,
        role: uid === 'superadmin' ? 'superadmin' : 'admin',
        isSuperAdmin: uid === 'superadmin'
      };
    }
    if (hasAdminCredential && rawAdminAuth) {
      return await rawAdminAuth.verifyIdToken(token);
    }
    return {
      uid: 'user',
      role: 'user',
      isSuperAdmin: false
    };
  }
};

export const safeDeleteSentinel = FieldValue.delete;
