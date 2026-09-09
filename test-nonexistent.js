import { initializeApp } from 'firebase/app';
import { getFirestore, updateDoc, doc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE",
  authDomain: "app-fnb-d8940.firebaseapp.com",
  projectId: "app-fnb-d8940"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function test() {
  try {
    await updateDoc(doc(db, 'attendance_records', 'this_doc_does_not_exist_at_all'), { test: 1 });
  } catch (err) {
    console.log('Non-existent:', err.message);
  }
}
test();
