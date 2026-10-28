import type { Request, Response } from 'express';
import { adminDb, adminAuth } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';
import { getAuthenticatedCaller, invalidateUserStatusCache } from './_token';
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

    // Admin quán không được đổi mật khẩu của Admin khác hoặc SuperAdmin trừ khi là chính mình hoặc SuperAdmin
    if ((role === 'admin' || role === 'superadmin') && !isSelf && !isSuperAdmin) {
      return res.status(403).json({
        error: 'Chỉ SuperAdmin hoặc chính chủ tài khoản Quản trị mới có thể đổi mật khẩu này.'
      });
    }

    // 3. ĐỌC TOKEN_VERSION HIỆN TẠI VÀ TĂNG CHUẨN XÁC ĐỂ THU HỒI TẤT CẢ PHIÊN CŨ
    let currentVersion = 1;
    try {
      const secretSnap = await adminDb.collection('user_secrets').doc(cleanUserId).get();
      if (secretSnap.exists) {
        currentVersion = Number(secretSnap.data()?.tokenVersion || userData.tokenVersion || 1);
      } else {
        currentVersion = Number(userData.tokenVersion || 1);
      }
    } catch (_) {}
    const nextTokenVersion = currentVersion + 1;

    // 4. BĂM MẬT KHẨU MỘT CHIỀU SCRYPT VÀ LƯU VÀO VÙNG BẢO MẬT USER_SECRETS
    const passwordHash = hashPassword(cleanPassword);
    const secretPayload: Record<string, any> = {
      userId: cleanUserId,
      storeId,
      role,
      passwordHash,
      tokenVersion: nextTokenVersion,
      passwordChangedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (role === 'admin') {
      secretPayload.encryptedPassword = encryptAes(cleanPassword);
    } else {
      secretPayload.encryptedPassword = FieldValue.delete();
    }

    try {
      await adminDb.collection('user_secrets').doc(cleanUserId).set(secretPayload, { merge: true });
    } catch (secErr) {
      return res.status(500).json({
        error: 'Lỗi hệ thống: Không thể lưu mật khẩu vào vùng bảo mật. Đổi mật khẩu thất bại.'
      });
    }

    // 5. CẬP NHẬT USERS: ĐỒNG BỘ TOKEN_VERSION VÀ XÓA TRIỆT ĐỂ BẢN RÕ
    try {
      await userDocRef.update({
        tokenVersion: nextTokenVersion,
        password: FieldValue.delete(),
        isLegacy: FieldValue.delete(),
        passwordUpdatedAt: new Date().toISOString()
      });
    } catch (e) {
      console.warn("Could not clean plaintext password in users:", e);
    }

    // 6. THU HỒI TỨC THÌ TRONG CACHE VÀ FIREBASE AUTH REFRESH TOKENS
    invalidateUserStatusCache(cleanUserId);
    await adminAuth.revokeRefreshTokens(cleanUserId);

    return res.status(200).json({
      success: true,
      message: 'Đổi mật khẩu thành công. Các phiên làm việc cũ đã được thu hồi.'
    });
  } catch (error: any) {
    console.error("Change password error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi đổi mật khẩu: ' + error.message });
  }
}
