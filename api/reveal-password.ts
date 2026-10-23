import { adminDb } from './_firebaseAdmin';
import { decryptAes } from './_crypto';
import { getAuthenticatedCaller } from './_token';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Kiểm tra xác thực nghiêm ngặt bằng Token có chữ ký số (Loại bỏ hoàn toàn backdoor token cứng)
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
    } catch (secErr) {}

    if (!plainPassword && adminUserData.password) {
      plainPassword = adminUserData.password;
    }

    if (!plainPassword) {
      return res.status(404).json({ 
        error: 'Mật khẩu của quán này chưa có bản lưu giải mã. Vui lòng sử dụng tính năng Đặt lại mật khẩu.' 
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
