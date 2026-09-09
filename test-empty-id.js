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
    await updateDoc(doc(db, 'attendance_records', ''), { test: 1 });
  } catch (err) {
    console.log('Empty string:', err.message);
  }
  try {
    await updateDoc(doc(db, 'attendance_records', undefined), { test: 1 });
  } catch (err) {
    console.log('Undefined:', err.message);
  }
  try {
    // try just referencing it as projects/.../documents/.../
    // wait, what if latestRecord.id is literally a space?
    await updateDoc(doc(db, 'attendance_records', ' '), { test: 1 });
  } catch (err) {
    console.log('Space:', err.message);
  }
}
test();
