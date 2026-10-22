import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, writeBatch } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE',
  authDomain: 'app-fnb-d8940.firebaseapp.com',
  projectId: 'app-fnb-d8940',
  storageBucket: 'app-fnb-d8940.firebasestorage.app',
  messagingSenderId: '77884896237',
  appId: '1:77884896237:web:8e3eb6f0d3b6fbe71be234'
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function backfillAll() {
  console.log('Fetching all invoices...');
  const invSnap = await getDocs(collection(db, 'invoices'));
  console.log('Total invoices in DB:', invSnap.size);

  const statsMap = new Map<string, {
    storeId: string;
    date: string;
    month: string;
    year: number;
    totalRevenue: number;
    totalCash: number;
    totalTransfer: number;
    totalDiscount: number;
    invoiceCount: number;
  }>();

  invSnap.docs.forEach(docSnap => {
    const inv = docSnap.data();
    if (!inv.storeId || !inv.date) return;
    
    // Parse date in Vietnam time (UTC+7)
    const dateObj = new Date(inv.date);
    const vnDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(dateObj); // YYYY-MM-DD

    const [yStr, mStr] = vnDateStr.split('-');
    const year = parseInt(yStr, 10);
    const month = `${yStr}-${mStr}`;
    const key = `${inv.storeId}_${vnDateStr}`;

    if (!statsMap.has(key)) {
      statsMap.set(key, {
        storeId: inv.storeId,
        date: vnDateStr,
        month,
        year,
        totalRevenue: 0,
        totalCash: 0,
        totalTransfer: 0,
        totalDiscount: 0,
        invoiceCount: 0
      });
    }

    const cur = statsMap.get(key)!;
    const total = inv.total || 0;
    cur.totalRevenue += total;
    cur.totalDiscount += (inv.discount || 0);
    cur.invoiceCount += 1;

    const method = inv.paymentMethod || 'cash';
    if (method === 'cash') {
      cur.totalCash += total;
    } else {
      cur.totalTransfer += total;
    }
  });

  console.log('Unique daily stats docs to write:', statsMap.size);

  const entries = Array.from(statsMap.entries());
  for (let i = 0; i < entries.length; i += 400) {
    const batch = writeBatch(db);
    const chunk = entries.slice(i, i + 400);
    chunk.forEach(([docId, data]) => {
      batch.set(doc(db, 'daily_stats', docId), {
        ...data,
        id: docId,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    });
    await batch.commit();
    console.log(`Committed chunk ${i} to ${i + chunk.length}`);
  }

  console.log('Daily stats backfill completed successfully!');
  process.exit(0);
}
backfillAll();
