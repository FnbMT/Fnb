import type { Request, Response } from 'express';
import { adminDb, adminAuth } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';
import { getAuthenticatedCaller, invalidateUserStatusCache } from './_token';
import { FieldValue } from 'firebase-admin/firestore';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Xác thực người gọi API bằng token
  const caller = await getAuthenticatedCaller(req);
  if (!caller) {
    return res.status(401).json({
      error: 'Yêu cầu đăng nhập: Phiên làm việc không hợp lệ hoặc đã hết hạn.'
    });
  }

  const { userId, newPassword } = req.body || {};
  if (!userId || !newPassword || String(newPassword).trim().length < 6) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có độ dài ít nhất 6 ký tự' });
  }

  const cleanUserId = String(userId).trim();
  const cleanPassword = String(newPassword).trim();

  try {
    const userDocRef = adminDb.collection('users').doc(cleanUserId);
    const userSnap = await userDocRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản người dùng cần đặt lại mật khẩu' });
    }

    const userData = userSnap.data() || {};
    const targetStoreId = userData.storeId || '';
    const targetRole = userData.role || 'order';

    // 2. Phân quyền:
    // SuperAdmin có quyền đặt lại mật khẩu cho bất kỳ ai (bao gồm chủ quán).
    // Store Admin có quyền đặt lại mật khẩu cho nhân viên thuộc quán mình (không được reset admin khác).
    const isSuperAdmin = caller.isSuperAdmin || caller.role === 'superadmin';
    const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === targetStoreId;

    if (!isSuperAdmin && !isStoreAdmin) {
      return res.status(403).json({
        error: 'Từ chối quyền truy cập: Bạn không có quyền đặt lại mật khẩu cho tài khoản này.'
      });
    }

    if (!isSuperAdmin && (targetRole === 'admin' || targetRole === 'superadmin') && caller.uid !== cleanUserId) {
      return res.status(403).json({
        error: 'Từ chối quyền truy cập: Quản trị viên cửa hàng không được đặt lại mật khẩu của Quản trị viên khác.'
      });
    }

    // 3. ĐỌC TOKEN_VERSION HIỆN TẠI VÀ TĂNG CHUẨN XÁC ĐỂ VÔ HIỆU HÓA TOKEN CŨ
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

    // 4. BĂM MẬT KHẨU SCRYPT VÀ LƯU VÀO USER_SECRETS
    const passwordHash = hashPassword(cleanPassword);
    const secretPayload: Record<string, any> = {
      userId: cleanUserId,
      storeId: targetStoreId,
      role: targetRole,
      passwordHash,
      tokenVersion: nextTokenVersion,
      resetAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (targetRole === 'admin') {
      secretPayload.encryptedPassword = encryptAes(cleanPassword);
    } else {
      secretPayload.encryptedPassword = FieldValue.delete();
    }

    try {
      await adminDb.collection('user_secrets').doc(cleanUserId).set(secretPayload, { merge: true });
    } catch (secErr) {
      return res.status(500).json({
        error: 'Lỗi hệ thống: Không thể ghi nhận mật khẩu mới vào vùng bảo mật.'
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
    } catch (_) {}

    // 6. THU HỒI TỨC THÌ TRONG CACHE VÀ FIREBASE AUTH REFRESH TOKENS
    invalidateUserStatusCache(cleanUserId);
    await adminAuth.revokeRefreshTokens(cleanUserId);

    return res.status(200).json({
      success: true,
      message: 'Đặt lại mật khẩu thành công. Các phiên đăng nhập trước đó đã được vô hiệu hóa.'
    });
  } catch (error: any) {
    console.error("Reset password error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi đặt lại mật khẩu: ' + error.message });
  }
}
