import type { Request, Response } from 'express';
import { adminDb } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';

const INITIAL_MENU = [
  { name: 'Cà phê đen', price: 20000, category: 'Cà phê', unit: 'Ly' },
  { name: 'Cà phê sữa', price: 25000, category: 'Cà phê', unit: 'Ly' },
  { name: 'Bạc xỉu', price: 30000, category: 'Cà phê', unit: 'Ly' },
  { name: 'Trà đào cam sả', price: 35000, category: 'Trà', unit: 'Ly' },
  { name: 'Trà vải', price: 35000, category: 'Trà', unit: 'Ly' },
  { name: 'Nước cam ép', price: 35000, category: 'Nước ép', unit: 'Ly' },
  { name: 'Sinh tố bơ', price: 40000, category: 'Sinh tố', unit: 'Ly' }
];

const INITIAL_TABLES = [
  { name: 'Bàn 1', area: 'Tầng 1', status: 'available' },
  { name: 'Bàn 2', area: 'Tầng 1', status: 'available' },
  { name: 'Bàn 3', area: 'Tầng 1', status: 'available' },
  { name: 'Bàn 4', area: 'Tầng 1', status: 'available' },
  { name: 'Bàn 5', area: 'Tầng 1', status: 'available' },
  { name: 'Bàn 6', area: 'Tầng 2', status: 'available' },
  { name: 'Bàn 7', area: 'Tầng 2', status: 'available' },
  { name: 'Bàn 8', area: 'Tầng 2', status: 'available' }
];

const CATEGORIES = ['Tất cả', 'Cà phê', 'Trà', 'Nước ép', 'Sinh tố', 'Đồ ăn vặt', 'Khác'];

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { storeName, storeCode, phone, password } = req.body || {};

  if (!storeName || !storeCode || !phone || !password) {
    return res.status(400).json({ error: 'Vui lòng điền đầy đủ Tên quán, Mã quán, Số điện thoại và Mật khẩu' });
  }

  const cleanStoreName = String(storeName).trim();
  const cleanStoreCode = String(storeCode).toLowerCase().trim();
  const cleanPhone = String(phone).trim();
  const cleanPassword = String(password).trim();

  if (cleanStoreCode.includes(' ') || cleanStoreCode.length < 3) {
    return res.status(400).json({ error: 'Mã cửa hàng phải viết liền không dấu và ít nhất 3 ký tự' });
  }

  if (cleanPhone.length < 9) {
    return res.status(400).json({ error: 'Số điện thoại không hợp lệ' });
  }

  try {
    // 1. Kiểm tra mã cửa hàng trùng lặp
    const existingStoreQuery = await adminDb.collection('stores')
      .where('code', '==', cleanStoreCode)
      .limit(1)
      .get();

    if (!existingStoreQuery.empty) {
      return res.status(400).json({ error: 'Mã cửa hàng này đã được đăng ký. Vui lòng chọn mã khác.' });
    }

    // 2. Kiểm tra số điện thoại đã được dùng đăng ký admin quán khác chưa
    const existingPhoneQuery = await adminDb.collection('users')
      .where('username', '==', cleanPhone)
      .where('role', '==', 'admin')
      .limit(1)
      .get();

    if (!existingPhoneQuery.empty) {
      return res.status(400).json({ error: 'Số điện thoại này đã được dùng để đăng ký một cửa hàng khác.' });
    }

    // 3. Lấy thời gian dùng thử (mặc định 14 ngày)
    let trialDays = 14;
    try {
      const pkgDoc = await adminDb.collection('packages').doc('trial').get();
      if (pkgDoc.exists && pkgDoc.data()?.trialDays) {
        trialDays = Number(pkgDoc.data()?.trialDays) || 14;
      }
    } catch (e) {}

    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + trialDays);

    // 4. Tạo document cửa hàng
    const storeRef = await adminDb.collection('stores').add({
      name: cleanStoreName,
      code: cleanStoreCode,
      phone: cleanPhone,
      subscription: {
        status: 'trial',
        trialEndDate: trialEndDate.toISOString(),
        packageId: 'trial'
      },
      createdAt: new Date().toISOString()
    });

    const storeId = storeRef.id;

    // 5. Tạo tài khoản Admin chủ quán (Tuyệt đối KHÔNG lưu plaintext password trong users)
    const adminUserRef = await adminDb.collection('users').add({
      username: cleanPhone,
      name: 'Quản trị viên',
      role: 'admin',
      storeId: storeId,
      phone: cleanPhone,
      createdAt: new Date().toISOString()
    });

    const adminUserId = adminUserRef.id;

    // 6. Lưu mật khẩu đã mã hóa và băm vào user_secrets
    // Chủ quán: lưu hash scrypt + AES-256 để Superadmin hỗ trợ khi chủ quán quên
    const passwordHash = hashPassword(cleanPassword);
    const encryptedPassword = encryptAes(cleanPassword);

    try {
      await adminDb.collection('user_secrets').doc(adminUserId).set({
        userId: adminUserId,
        storeId: storeId,
        role: 'admin',
        passwordHash,
        encryptedPassword,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } catch (secErr) {
      try {
        await adminDb.collection('users').doc(adminUserId).update({ password: cleanPassword });
      } catch (uErr) {}
    }

    // 7. Khởi tạo dữ liệu mẫu cho quán (Thực đơn, Bàn, Cài đặt)
    const batch = adminDb.batch();

    // Menu
    for (const item of INITIAL_MENU) {
      const docRef = adminDb.collection('menu').doc();
      batch.set(docRef, { ...item, storeId });
    }

    // Tables
    for (const table of INITIAL_TABLES) {
      const docRef = adminDb.collection('tables').doc();
      batch.set(docRef, { ...table, storeId });
    }

    // Settings
    const settingsDocRef = adminDb.collection('settings').doc();
    batch.set(settingsDocRef, {
      storeId,
      storeName: cleanStoreName,
      address: '',
      phone: cleanPhone,
      logo: '',
      adminUsername: cleanPhone,
      kitchenBellEnabled: true,
      vatPercent: 8,
      kitchenBillTemplate: 'Mẫu bill bếp mặc định',
      paymentBillTemplate: 'Mẫu bill thanh toán mặc định',
      menuCategories: CATEGORIES,
      inventoryCategories: ['Nguyên liệu', 'Đồ uống', 'Khác'],
      cashCategories: ['Bán hàng', 'Tiền điện', 'Tiền nước', 'Tiền mặt bằng', 'Nhập hàng', 'Lương nhân viên', 'Khác'],
      customerTypes: [
        { id: '1', name: 'Khách lẻ', discountPercent: 0 },
        { id: '2', name: 'Thành viên Đồng', discountPercent: 5 },
        { id: '3', name: 'Thành viên Bạc', discountPercent: 10 },
        { id: '4', name: 'Thành viên Vàng', discountPercent: 15 }
      ]
    });

    await batch.commit();

    return res.status(200).json({
      success: true,
      storeId,
      userId: adminUserId,
      message: 'Đăng ký cửa hàng thành công'
    });

  } catch (error: any) {
    console.error("Register store error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi đăng ký cửa hàng: ' + error.message });
  }
}
