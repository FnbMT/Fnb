import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, where, getDocs, updateDoc, doc, getDoc, setDoc } from "firebase/firestore";

// Initialize Firebase
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY || "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE",
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || "app-fnb-d8940.firebaseapp.com",
  projectId: process.env.VITE_FIREBASE_PROJECT_ID || "app-fnb-d8940",
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || "app-fnb-d8940.firebasestorage.app",
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "638561657701",
  appId: process.env.VITE_FIREBASE_APP_ID || "1:638561657701:web:6b62a2034fe54a2906778c"
};

// Use existing app if already initialized
let firebaseApp;
try {
  firebaseApp = initializeApp(firebaseConfig);
} catch (e) {
  // Ignore error if already initialized
}
const db = getFirestore(firebaseApp);

export default async function handler(req: any, res: any) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // BẢO MẬT: Kiểm tra API Key từ SePay
  // Vercel Environment Variable: SEPAY_API_TOKEN
  const expectedToken = process.env.SEPAY_API_TOKEN;
  if (expectedToken) {
    let authHeader = req.headers.authorization || req.headers['x-api-key'] || '';
      if (Array.isArray(authHeader)) authHeader = authHeader[0] || '';
    if (authHeader.startsWith('Apikey ')) authHeader = authHeader.substring(7);
    else if (authHeader.startsWith('Bearer ')) authHeader = authHeader.substring(7);
    if (authHeader !== expectedToken) {
      console.warn("Unauthorized webhook attempt:", req.headers);
      return res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
    }
  }

  try {
    const data = req.body;
    console.log("Received SePay Webhook:", data);

    if (data.transferType !== 'in') {
      return res.status(200).json({ success: true, message: 'Not an incoming transfer' });
    }

    const txId = data.id || data.referenceCode;
    if (!txId) {
      return res.status(400).json({ error: 'Missing transaction ID' });
    }

    const txRef = doc(db, 'processed_transactions', String(txId));
    const txSnap = await getDoc(txRef);
    if (txSnap.exists()) {
      console.log(`Transaction ${txId} already processed.`);
      return res.status(200).json({ success: true, message: 'Already processed' });
    }

    const content = (data.content || '').toUpperCase();
    
    // Check if the content includes GIAHAN
    if (content.includes('GIAHAN')) {
      const match = content.match(/([A-Z0-9_-]+)\s+GIAHAN(?:\s+([A-Z0-9_-]+)\s+([0-9]+))?/i);
      if (match && match[1]) {
        const storeCode = match[1].toLowerCase();
        console.log(`Found store code in transfer content: ${storeCode}`);

        // Search for store by code in Firestore
        const storesRef = collection(db, 'stores');
        const q = query(storesRef, where('code', '==', storeCode));
        const snapshot = await getDocs(q);

        if (!snapshot.empty) {
          const storeDoc = snapshot.docs[0];
          
          const amount = data.transferAmount || data.amount || 0;
          
          // Fetch packages to match amount
          const pkgsSnapshot = await getDocs(collection(db, 'packages'));
          let matchedPackage = null;
          let durationMonths = 1;
          
          const contentPkgId = match[2] ? match[2].toLowerCase() : null;
          const contentDuration = match[3] ? parseInt(match[3]) : null;

          if (contentPkgId && contentDuration) {
             // Exact match from content
             pkgsSnapshot.forEach(docSnap => {
               if (docSnap.id.toLowerCase() === contentPkgId) {
                 matchedPackage = { id: docSnap.id, ...docSnap.data() };
                 durationMonths = contentDuration;
               }
             });
          } else {
            // Fallback to price matching
            pkgsSnapshot.forEach(docSnap => {
              const pkg = docSnap.data();
              if (pkg.price === amount) {
                matchedPackage = { id: docSnap.id, ...pkg };
                durationMonths = pkg.durationMonths || 1;
              }
              if (pkg.pricing && Array.isArray(pkg.pricing)) {
                const opt = pkg.pricing.find(o => o.price === amount);
                if (opt) {
                  matchedPackage = { id: docSnap.id, ...pkg };
                  durationMonths = opt.durationMonths || pkg.durationMonths || 1;
                }
              }
            });
          }
          
          let newEndDate = new Date();
          const currentSub = storeDoc.data().subscription;
          if (currentSub && currentSub.validUntil) {
            const currentEnd = new Date(currentSub.validUntil);
            if (currentEnd > newEndDate) {
              newEndDate = currentEnd;
            }
          }
          newEndDate.setMonth(newEndDate.getMonth() + durationMonths);

          await updateDoc(doc(db, 'stores', storeDoc.id), {
            'subscription.status': 'active',
            'subscription.packageId': matchedPackage ? matchedPackage.id : 'pro',
            'subscription.validUntil': newEndDate.toISOString()
          });

          await setDoc(txRef, {
             storeId: storeDoc.id,
             amount: amount,
             date: new Date().toISOString(),
             raw: data
          });
          
          console.log(`Successfully extended subscription for store: ${storeCode}`);
        } else {
          console.log(`No store found with code: ${storeCode}`);
        }
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
