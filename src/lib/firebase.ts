import { initializeApp } from 'firebase/app';
import { 
  initializeFirestore, 
  getFirestore,
  persistentLocalCache, 
  persistentMultipleTabManager,
  persistentSingleTabManager,
  memoryLocalCache,
  setLogLevel 
} from 'firebase/firestore';
import { getAuth, initializeAuth, indexedDBLocalPersistence } from 'firebase/auth';
import { getStorage } from 'firebase/storage';
import { Capacitor } from '@capacitor/core';

// Tắt log nội bộ của Firestore để tránh gRPC stream lifecycle warning bị ghi nhận như lỗi
try {
  setLogLevel('silent');
} catch (_) {}

if (typeof window !== 'undefined') {
  const _origError = console.error;
  console.error = (...args: any[]) => {
    const msg = args.map(a => String(a?.message || a || '')).join(' ');
    if (msg.includes('Disconnecting idle stream') || msg.includes('Timed out waiting for new targets')) {
      return;
    }
    _origError.apply(console, args);
  };
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "app-fnb-d8940.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "app-fnb-d8940",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "app-fnb-d8940.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "638561657701",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:638561657701:web:6b62a2034fe54a2906778c"
};

const app = initializeApp(firebaseConfig);

// Khởi tạo Firestore: Trên thiết bị di động Native (Capacitor WebView đơn tiến trình),
// sử dụng persistentSingleTabManager để tránh lỗi Web Locks API của multi-tab.
// Nếu thiết bị không hỗ trợ IndexedDB hoặc bộ nhớ hạn chế, tự động fallback an toàn.
const initDb = () => {
  try {
    const tabManager = Capacitor.isNativePlatform()
      ? persistentSingleTabManager({})
      : persistentMultipleTabManager();

    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager }),
      ignoreUndefinedProperties: true,
    });
  } catch (err) {
    console.warn('[Firebase] Khởi tạo persistent cache thất bại, fallback sang bộ nhớ tạm:', err);
    try {
      return initializeFirestore(app, {
        localCache: memoryLocalCache(),
        ignoreUndefinedProperties: true,
      });
    } catch {
      return getFirestore(app);
    }
  }
};

export const db = initDb();

const initAuth = () => {
  try {
    return initializeAuth(app, {
      persistence: indexedDBLocalPersistence
    });
  } catch (err) {
    console.warn('[Firebase] Khởi tạo auth persistence thất bại, fallback getAuth:', err);
    return getAuth(app);
  }
};

export const auth = initAuth();

export const storage = getStorage(app);
