import { adminDb } from './_firebaseAdmin';
import { decryptAes } from './_crypto';
import { getAuthenticatedCaller } from './_token';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  try {
    // 1. Kiểm tra xác thực nghiêm ngặt bằng Token có chữ ký số (Chỉ SuperAdmin mới được xem)
    const caller = await getAuthenticatedCaller(req);
    if (!caller || !caller.isSuperAdmin) {
      return res.status(403).json({ 
        error: 'Từ chối truy cập: Chỉ Quản trị viên tối cao (Super Admin) đã xác thực mới có quyền thực hiện thao tác này.' 
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

    if (adminUserQuery.empty) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản Quản trị viên của cửa hàng này' });
    }

    const adminUserDoc = adminUserQuery.docs[0];
    const adminUserData = adminUserDoc.data();
    const adminUserId = adminUserDoc.id;

    // 4. Tìm kiếm chuỗi mã hóa trong user_secrets
    const secretSnap = await adminDb.collection('user_secrets').doc(adminUserId).get();
    let plainPassword = '';

    if (secretSnap.exists && secretSnap.data()?.encryptedPassword) {
      const decrypted = decryptAes(secretSnap.data().encryptedPassword);
      if (decrypted) {
        plainPassword = decrypted;
      }
    }

    // Nếu không giải mã được hoặc chưa có (tài khoản cũ còn lưu password)
    if (!plainPassword && adminUserData.password) {
      plainPassword = adminUserData.password;
    }

    if (!plainPassword) {
      return res.status(404).json({ 
        error: 'Mật khẩu tài khoản đã được bảo mật một chiều hoặc chưa từng được cấp khóa khôi phục. Vui lòng sử dụng tính năng Đặt lại mật khẩu (Reset Password) để hỗ trợ chủ quán.' 
      });
    }

    // 5. GHI NHẬN AUDIT LOG BẮT BUỘC CHO HÀNH ĐỘNG XEM LẠI MẬT KHẨU
    try {
      await adminDb.collection('admin_audit_logs').add({
        action: 'REVEAL_ADMIN_PASSWORD',
        targetStoreId,
        targetStoreCode: storeData.code || '',
        targetUserId: adminUserId,
        targetUsername: adminUserData.username || '',
        performedByUid: caller.uid,
        performedByUsername: caller.username || 'superadmin',
        clientIp: String(clientIp),
        timestamp: new Date().toISOString()
      });
    } catch (auditErr) {
      console.warn("[Audit] Failed to write reveal-password audit log:", auditErr);
    }

    return res.status(200).json({
      success: true,
      storeName: storeData.name,
      storeCode: storeData.code,
      adminUsername: adminUserData.username,
      adminName: adminUserData.name,
      password: plainPassword
    });
  } catch (error: any) {
    console.error("Reveal password error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi tra cứu thông tin: ' + error.message });
  }
}
