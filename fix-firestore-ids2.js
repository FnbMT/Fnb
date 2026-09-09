import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, updateDoc, doc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE",
  authDomain: "app-fnb-d8940.firebaseapp.com",
  projectId: "app-fnb-d8940"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  try {
    const snap = await getDocs(collection(db, 'attendance_records'));
    let count = 0;
    for (const d of snap.docs) {
      const data = d.data();
      if (data.id !== d.id) {
        console.log(`Fixing doc ${d.id}: old id was ${data.id}`);
        await updateDoc(doc(db, 'attendance_records', d.id), { id: d.id });
        count++;
      }
    }
    console.log(`Fixed ${count} records.`);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
run();
