import type { Request, Response } from 'express';
import { adminDb } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';
import { FieldValue } from 'firebase-admin/firestore';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, newPassword, caller } = req.body || {};

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

    // PHÂN QUYỀN API (P2 Security Guard):
    if (caller) {
      const isSelf = String(caller.id || '').trim() === cleanUserId;
      const isSuperAdmin = caller.role === 'superadmin';
      const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === storeId;

      if (!isSelf && !isSuperAdmin && !isStoreAdmin) {
        return res.status(403).json({
          error: 'Từ chối quyền truy cập: Bạn không có quyền đổi mật khẩu cho tài khoản này.'
        });
      }

      // Admin của quán không được đổi mật khẩu của Admin khác nếu không phải chính mình hoặc SuperAdmin
      if (role === 'admin' && !isSelf && !isSuperAdmin) {
        return res.status(403).json({
          error: 'Chỉ SuperAdmin hoặc chính chủ tài khoản Admin mới có thể đổi mật khẩu này.'
        });
      }
    }

    // Băm mật khẩu một chiều scrypt
    const passwordHash = hashPassword(cleanPassword);

    const secretPayload: Record<string, any> = {
      userId: cleanUserId,
      storeId,
      role,
      passwordHash,
      updatedAt: new Date().toISOString()
    };

    // Nếu là Admin (Chủ quán): Lưu bản mã hóa AES-256 để Superadmin hỗ trợ khi chủ quán quên
    // Nếu là Nhân viên: KHÔNG lưu mã hóa 2 chiều, chỉ lưu hash scrypt (Chủ quán không xem được)
    if (role === 'admin') {
      secretPayload.encryptedPassword = encryptAes(cleanPassword);
    } else {
      secretPayload.encryptedPassword = FieldValue.delete();
    }

    // Cập nhật collection bảo mật user_secrets
    try {
      await adminDb.collection('user_secrets').doc(cleanUserId).set(secretPayload, { merge: true });
      try {
        await userDocRef.update({
          password: FieldValue.delete(),
          passwordUpdatedAt: new Date().toISOString()
        });
      } catch (e) {}
    } catch (secErr) {
      // Fallback nếu không ghi được user_secrets (môi trường dev không có service account)
      try {
        await userDocRef.update({
          password: cleanPassword,
          passwordUpdatedAt: new Date().toISOString()
        });
      } catch (e) {}
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
