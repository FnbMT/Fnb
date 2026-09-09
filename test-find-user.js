import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, where } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE",
  authDomain: "app-fnb-d8940.firebaseapp.com",
  projectId: "app-fnb-d8940"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function test() {
  try {
    const q = query(collection(db, 'users'), where('email', '==', 'nickybutch014@gmail.com'));
    const snap = await getDocs(q);
    snap.forEach(d => console.log('User:', d.id, d.data()));
    
    if (!snap.empty) {
      const userId = snap.docs[0].id;
      const q2 = query(collection(db, 'attendance_records'), where('userId', '==', userId));
      const snap2 = await getDocs(q2);
      console.log('Attendance records count:', snap2.size);
      snap2.forEach(d => console.log('Record:', d.id, d.data()));
    }
  } catch (err) {
    console.error('Test error:', err.message);
  }
}
test();
