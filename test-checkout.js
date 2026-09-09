import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, updateDoc, doc, getDocs, query, where } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE",
  authDomain: "app-fnb-d8940.firebaseapp.com",
  projectId: "app-fnb-d8940",
  storageBucket: "app-fnb-d8940.firebasestorage.app",
  messagingSenderId: "638561657701",
  appId: "1:638561657701:web:6b62a2034fe54a2906778c"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function test() {
  try {
    const q = query(
        collection(db, 'attendance_records'),
        where('userId', '==', 'test_user_id'),
        where('date', '==', '2026-09-08')
      );
    const snap = await getDocs(q);
    console.log("Empty:", snap.empty);
    
    // add a doc
    const docRef = await addDoc(collection(db, 'attendance_records'), { 
        userId: 'test_user_id', 
        storeId: 'test_store',
        date: '2026-09-08',
        checkInTime: '2026-09-08T10:00:00Z',
        status: 'present',
        id: '123'
    });
    console.log('Add success:', docRef.id);
    
    // update checkout
    await updateDoc(doc(db, 'attendance_records', docRef.id), { 
        checkOutTime: '2026-09-08T18:00:00Z',
        locationValid: true
    });
    console.log('Update checkout success');
  } catch (err) {
    console.error('Test error:', err.message);
  }
}
test();
