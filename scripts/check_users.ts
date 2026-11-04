import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';

const app = initializeApp({
  apiKey: 'AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE',
  authDomain: 'app-fnb-d8940.firebaseapp.com',
  projectId: 'app-fnb-d8940'
});
const db = getFirestore(app);

async function check() {
  console.log('Querying users...');
  const usersSnap = await getDocs(collection(db, 'users'));
  console.log('Total users:', usersSnap.size);
  for (const d of usersSnap.docs) {
    const data = d.data();
    console.log(`User docId=${d.id}, storeId=${data.storeId}, username=${data.username}, role=${data.role}, hasPassword=${Boolean(data.password)}, password=${data.password ? 'EXISTS' : 'NONE'}`);
    const secDoc = await getDoc(doc(db, 'system', 'user_secret_' + d.id));
    console.log(`  system/user_secret_${d.id} exists:`, secDoc.exists(), secDoc.exists() ? secDoc.data() : null);
  }

  console.log('\nQuerying stores...');
  const storesSnap = await getDocs(collection(db, 'stores'));
  console.log('Total stores:', storesSnap.size);
  for (const s of storesSnap.docs) {
    const sData = s.data();
    console.log(`Store docId=${s.id}, code=${sData.code}, name=${sData.name}`);
  }
}

check()
  .then(() => {
    console.log('Done check.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Check error:', err);
    process.exit(1);
  });
