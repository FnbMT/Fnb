import { initializeApp } from 'firebase/app';
import { getFirestore, initializeFirestore, setLogLevel } from 'firebase/firestore';
import { getAuth, initializeAuth, indexedDBLocalPersistence } from 'firebase/auth';
import { getStorage } from 'firebase/storage';

// Kích hoạt ghi log chi tiết mọi hoạt động kết nối mạng của Firestore
setLogLevel('debug');

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "app-fnb-d8940.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "app-fnb-d8940",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "app-fnb-d8940.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "638561657701",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:638561657701:web:6b62a2034fe54a2906778c"
};

const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
});

export const auth = initializeAuth(app, {
  persistence: indexedDBLocalPersistence
});

export const storage = getStorage(app);
