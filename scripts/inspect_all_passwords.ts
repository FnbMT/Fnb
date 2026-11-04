import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, getDoc } from 'firebase/firestore';
import crypto from 'node:crypto';

const app = initializeApp({
  apiKey: 'AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE',
  authDomain: 'app-fnb-d8940.firebaseapp.com',
  projectId: 'app-fnb-d8940'
});
const db = getFirestore(app);

const encryptionKey = 'fnb_master_secure_encryption_key_2026_default_salt!';
function decryptAes(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid format');
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = crypto.createHash('sha256').update(encryptionKey).digest();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function run() {
  const usersSnap = await getDocs(collection(db, 'users'));
  for (const u of usersSnap.docs) {
    const data = u.data();
    let recoveredPassword = data.password || null;
    let secData: any = null;
    
    // Check system/user_secret_${u.id}
    const sysDoc = await getDoc(doc(db, 'system', `user_secret_${u.id}`));
    if (sysDoc.exists()) {
      secData = sysDoc.data();
      if (!recoveredPassword && secData.encryptedPassword) {
        try {
          recoveredPassword = decryptAes(secData.encryptedPassword);
        } catch (e) {
          console.warn(`Failed decrypt sys for ${u.id}:`, e);
        }
      }
    }

    console.log(`User ${u.id} (${data.username}, store: ${data.storeId}, role: ${data.role}):`);
    console.log(`  current password in users: ${data.password ? data.password : 'NONE'}`);
    console.log(`  recovered password: ${recoveredPassword}`);
    console.log(`  clientHash in sys: ${secData?.clientHash || 'NONE'}`);
  }
}

run().catch(console.error);
