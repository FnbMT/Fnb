import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, updateDoc, setDoc } from 'firebase/firestore';
import crypto from 'node:crypto';

const app = initializeApp({
  apiKey: 'AIzaSyCoyF_ArTx73XrHPjRTfzLXdV8yYjF24kE',
  authDomain: 'app-fnb-d8940.firebaseapp.com',
  projectId: 'app-fnb-d8940'
});
const db = getFirestore(app);

// Danh sách các mật khẩu đã xác minh
const USER_PASSWORDS: Record<string, string> = {
  'PZZaNw7A86cHKvi7mbwx': 'admin123', // luontv37 - admin
  'AW6kwGv4W355hzNtLrcl': '12345678', // luontv37 - anh
  '3rKDpckHG17pUnDDHezD': '12345678', // luontv37 - yen
  'VZocDIBTGYlL4IOio9Nl': '12345678', // luontv37 - nv1
  'WTyIIojpiahCIVTD8JbT': '12345678', // luontv - admin
  'BL07RnyA0PiXQoI9wNlv': '12345678', // luontv - huy123
  'niaklGiEJ9rCC8qhbfeu': '12345678', // luontv - nvt
  'oQGxb2iiHxVpjvTJfF2j': '12345678', // luontv - huy1
  'Ud5KwzrbN5S9tLQXpQFP': '12345678', // minhnhat - 0398382189
  '7dWv97jorrCe345caRgY': '12345678', // minhnhat - nv1
  'SQjhbsy9JQGgayzsmaQV': 'admin123', // trungnguyen37 - 0989999777
  'z59ae0wUIHNjUx5msQCu': '12345678', // luondaklak - 0946075835
  'R7Yf7uMchpanEgm40JXm': '12345678', // luondaklak - nv
  'oc8Ts2GTGopIcjLmzejw': '12345678', // luonbd - 0973515932
};

async function syncAllUsers() {
  console.log('--- ĐỒNG BỘ MẬT KHẨU TƯƠNG THÍCH CHO TẤT CẢ TÀI KHOẢN (IOS CŨ & MỚI) ---');
  const usersSnap = await getDocs(collection(db, 'users'));

  for (const u of usersSnap.docs) {
    const data = u.data();
    const userId = u.id;
    const knownPass = USER_PASSWORDS[userId] || data.password || '12345678';
    const clientHash = crypto.createHash('sha256').update(knownPass).digest('hex');

    console.log(`Đang xử lý User [${userId}] - quán: ${data.storeId}, username: ${data.username}, pass: ${knownPass}`);

    // 1. Cập nhật vào users collection (để app iOS cũ đọc trực tiếp ngay lập tức)
    await updateDoc(doc(db, 'users', userId), {
      password: knownPass
    });

    // 2. Cập nhật vào system/user_secret_${userId} (để fallback Check B cũng khớp)
    await setDoc(doc(db, 'system', `user_secret_${userId}`), {
      userId,
      storeId: data.storeId,
      role: data.role || 'order',
      clientHash: clientHash,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    console.log(` -> Đã phục hồi password và clientHash thành công cho ${data.username}!`);
  }

  console.log('\n=== TẤT CẢ TÀI KHOẢN ĐÃ ĐƯỢC PHỤC HỒI MẬT KHẨU HOÀN TOÀN ===');
}

syncAllUsers()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Lỗi sync:', err);
    process.exit(1);
  });
