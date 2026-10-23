import type { Request, Response } from 'express';
import { adminDb } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';
import { getAuthenticatedCaller } from './_token';
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
    // Store Admin có quyền đặt lại mật khẩu cho nhân viên thuộc quán mình.
    const isSuperAdmin = caller.isSuperAdmin || caller.role === 'superadmin';
    const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === targetStoreId;

    if (!isSuperAdmin && !isStoreAdmin) {
      return res.status(403).json({
        error: 'Từ chối quyền truy cập: Bạn không có quyền đặt lại mật khẩu cho tài khoản này.'
      });
    }

    if (targetRole === 'admin' && !isSuperAdmin && caller.uid !== cleanUserId) {
      return res.status(403).json({
        error: 'Chỉ SuperAdmin mới có quyền đặt lại mật khẩu cho tài khoản Quản trị viên (Chủ quán).'
      });
    }

    // 3. Băm mật khẩu scrypt và mã hóa AES-256 (nếu là admin)
    const passwordHash = hashPassword(cleanPassword);
    const secretPayload: Record<string, any> = {
      userId: cleanUserId,
      storeId: targetStoreId,
      role: targetRole,
      passwordHash,
      updatedAt: new Date().toISOString()
    };

    if (targetRole === 'admin') {
      secretPayload.encryptedPassword = encryptAes(cleanPassword);
    } else {
      secretPayload.encryptedPassword = FieldValue.delete();
    }

    // 4. Lưu vào user_secrets
    try {
      await adminDb.collection('user_secrets').doc(cleanUserId).set(secretPayload, { merge: true });
    } catch (secErr) {
      return res.status(500).json({
        error: 'Lỗi hệ thống: Không thể lưu mật khẩu mới vào vùng bảo mật.'
      });
    }

    // 5. Xóa triệt để mật khẩu rõ khỏi collection users
    try {
      await userDocRef.update({
        password: FieldValue.delete(),
        isLegacy: FieldValue.delete(),
        passwordResetAt: new Date().toISOString()
      });
    } catch (e) {}

    return res.status(200).json({
      success: true,
      message: 'Đặt lại mật khẩu thành công',
      userId: cleanUserId,
      username: userData.username
    });
  } catch (error: any) {
    console.error("Reset password error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi đặt lại mật khẩu: ' + error.message });
  }
}
