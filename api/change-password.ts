import type { Request, Response } from 'express';
import { adminDb } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';
import { getAuthenticatedCaller } from './_token';
import { FieldValue } from 'firebase-admin/firestore';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. XÁC THỰC DANH TÍNH BẮT BUỘC BẰNG TOKEN (Zero-Trust Guard)
  const caller = await getAuthenticatedCaller(req);
  if (!caller) {
    return res.status(401).json({
      error: 'Yêu cầu đăng nhập: Phiên làm việc không hợp lệ hoặc đã hết hạn.'
    });
  }

  const { userId, newPassword } = req.body || {};

  if (!userId || !newPassword || String(newPassword).trim().length < 1) {
    return res.status(400).json({ error: 'Vui lòng cung cấp mã người dùng (userId) và mật khẩu mới' });
  }

  const cleanUserId = String(userId).trim();
  const cleanPassword = String(newPassword).trim();

  try {
    const userDocRef = adminDb.collection('users').doc(cleanUserId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Không tìm thấy thông tin tài khoản' });
    }

    const userData = userDoc.data() || {};
    const role = userData.role || 'order';
    const storeId = userData.storeId || '';

    // 2. KIỂM SOÁT PHÂN QUYỀN ĐỔI MẬT KHẨU
    const isSelf = caller.uid === cleanUserId;
    const isSuperAdmin = caller.isSuperAdmin || caller.role === 'superadmin';
    const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === storeId;

    if (!isSelf && !isSuperAdmin && !isStoreAdmin) {
      return res.status(403).json({
        error: 'Từ chối quyền truy cập: Bạn không có quyền đổi mật khẩu cho tài khoản này.'
      });
    }

    // Admin quán không được đổi mật khẩu của Admin khác trừ khi là chính mình hoặc SuperAdmin
    if (role === 'admin' && !isSelf && !isSuperAdmin) {
      return res.status(403).json({
        error: 'Chỉ SuperAdmin hoặc chính chủ tài khoản Admin mới có thể đổi mật khẩu này.'
      });
    }

    // 3. BĂM MẬT KHẨU MỘT CHIỀU SCRYPT
    const passwordHash = hashPassword(cleanPassword);

    const secretPayload: Record<string, any> = {
      userId: cleanUserId,
      storeId,
      role,
      passwordHash,
      updatedAt: new Date().toISOString()
    };

    if (role === 'admin') {
      secretPayload.encryptedPassword = encryptAes(cleanPassword);
    } else {
      secretPayload.encryptedPassword = FieldValue.delete();
    }

    // 4. LƯU VÀO VÙNG BẢO MẬT USER_SECRETS (Nếu thất bại, dừng ngay lập tức)
    try {
      await adminDb.collection('user_secrets').doc(cleanUserId).set(secretPayload, { merge: true });
    } catch (secErr) {
      return res.status(500).json({
        error: 'Lỗi hệ thống: Không thể lưu mật khẩu vào vùng bảo mật. Đổi mật khẩu thất bại.'
      });
    }

    // 5. XÓA TRIỆT ĐỂ BẢN RÕ VÀ CỜ LEGACY TRONG USERS
    try {
      await userDocRef.update({
        password: FieldValue.delete(),
        isLegacy: FieldValue.delete(),
        passwordUpdatedAt: new Date().toISOString()
      });
    } catch (e) {
      console.warn("Could not clean plaintext password in users:", e);
    }

    return res.status(200).json({
      success: true,
      message: 'Đổi mật khẩu thành công'
    });
  } catch (error: any) {
    console.error("Change password error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi đổi mật khẩu: ' + error.message });
  }
}
