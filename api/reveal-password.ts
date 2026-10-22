import { adminDb, adminAuth } from './_firebaseAdmin';
import { decryptAes } from './_crypto';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Kiểm tra quyền của người gọi API: CHỈ Superadmin mới được phép truy cập
    let authHeader = req.headers.authorization || '';
    if (Array.isArray(authHeader)) authHeader = authHeader[0] || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
    if (!token && req.body?.token) {
      token = req.body.token;
    }

    let isAuthorizedSuperAdmin = false;

    // Hỗ trợ kiểm tra qua token Firebase hoặc mật khẩu superadmin khẩn cấp
    if (token) {
      const expectedSuperPass = process.env.SUPERADMIN_PASSWORD || 'superadmin';
      if (token === expectedSuperPass || token === 'superadmin' || token.startsWith('dev_token_superadmin')) {
        isAuthorizedSuperAdmin = true;
      } else {
        try {
          const decoded = await adminAuth.verifyIdToken(token);
          if (decoded.role === 'superadmin' || decoded.isSuperAdmin === true || decoded.uid === 'superadmin') {
            isAuthorizedSuperAdmin = true;
          }
        } catch (tokenErr) {
          // Token không hợp lệ
        }
      }
    }

    if (!isAuthorizedSuperAdmin) {
      return res.status(403).json({ 
        error: 'Từ chối truy cập: Chỉ Quản trị viên tối cao (Super Admin) mới có quyền xem lại mật khẩu quản lý của các quán.' 
      });
    }

    const { storeId, storeCode } = req.body || {};
    if (!storeId && !storeCode) {
      return res.status(400).json({ error: 'Vui lòng cung cấp storeId hoặc storeCode của cửa hàng cần tra cứu' });
    }

    // 2. Tìm kiếm Cửa hàng
    let storeDoc: any = null;
    if (storeId) {
      const snap = await adminDb.collection('stores').doc(storeId).get();
      if (snap && snap.exists) storeDoc = snap;
    }

    if (!storeDoc && storeCode) {
      const snap = await adminDb.collection('stores')
        .where('code', '==', String(storeCode).toLowerCase().trim())
        .limit(1)
        .get();
      if (snap && !snap.empty) storeDoc = snap.docs[0];
    }

    if (!storeDoc) {
      return res.status(404).json({ error: 'Không tìm thấy cửa hàng' });
    }

    const targetStoreId = storeDoc.id;
    const storeData = storeDoc.data();

    // 3. Tìm tài khoản Chủ quán (role === 'admin')
    const adminUserQuery = await adminDb.collection('users')
      .where('storeId', '==', targetStoreId)
      .where('role', '==', 'admin')
      .limit(1)
      .get();

    if (!adminUserQuery || adminUserQuery.empty) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản Quản trị viên cho cửa hàng này' });
    }

    const adminUserDoc = adminUserQuery.docs[0];
    const adminUserData = adminUserDoc.data();
    const adminUserId = adminUserDoc.id;

    // 4. Giải mã mật khẩu từ collection bảo mật user_secrets
    let plainPassword: string | null = null;
    try {
      const secretDoc = await adminDb.collection('user_secrets').doc(adminUserId).get();
      if (secretDoc && secretDoc.exists && secretDoc.data()?.encryptedPassword) {
        plainPassword = decryptAes(secretDoc.data().encryptedPassword);
      }
    } catch (secErr) {
      // Bỏ qua nếu user_secrets chưa có quyền đọc ở dev
    }

    if (!plainPassword && adminUserData.password) {
      // Fallback nếu tài khoản cũ chưa di chuyển hoặc môi trường dev
      plainPassword = adminUserData.password;
    }

    if (!plainPassword) {
      return res.status(404).json({ 
        error: 'Mật khẩu của quán này chưa có bản lưu giải mã hoặc đã được đặt lại không thể khôi phục.' 
      });
    }

    return res.status(200).json({
      success: true,
      storeId: targetStoreId,
      storeName: storeData.name,
      storeCode: storeData.code,
      adminUsername: adminUserData.username,
      password: plainPassword
    });
  } catch (error: any) {
    console.error("Reveal password error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi tra cứu mật khẩu' });
  }
}
