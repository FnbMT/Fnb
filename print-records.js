import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, query, where } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE",
  authDomain: "app-fnb-d8940.firebaseapp.com",
  projectId: "app-fnb-d8940"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function run() {
  const snap = await getDocs(query(collection(db, 'attendance_records')));
  snap.docs.forEach(d => console.log(d.id, d.data().id, d.data().date, d.data().userId));
  process.exit(0);
}
run();
