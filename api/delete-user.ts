import type { Request, Response } from 'express';
import { adminDb } from './_firebaseAdmin';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, caller } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: 'Vui lòng cung cấp mã người dùng (userId) cần xóa' });
  }

  const cleanUserId = String(userId).trim();

  try {
    const userDocRef = adminDb.collection('users').doc(cleanUserId);
    const userSnap = await userDocRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Tài khoản người dùng không tồn tại' });
    }

    const userData = userSnap.data() || {};
    const targetStoreId = userData.storeId || '';
    const targetRole = userData.role || 'order';

    // PHÂN QUYỀN API (P2 Security Guard):
    if (caller) {
      const isSuperAdmin = caller.role === 'superadmin';
      const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === targetStoreId;

      if (!isSuperAdmin && !isStoreAdmin) {
        return res.status(403).json({
          error: 'Từ chối quyền truy cập: Chỉ Quản lý (Admin) của quán hoặc SuperAdmin mới có quyền xóa nhân sự.'
        });
      }

      // Admin của quán không được tự xóa tài khoản Admin qua API này
      if (targetRole === 'admin' && !isSuperAdmin) {
        return res.status(403).json({
          error: 'Không thể xóa tài khoản Quản trị viên (Admin) của quán qua thao tác này.'
        });
      }
    }

    // Xóa trong collection users
    await userDocRef.delete();

    // Xóa trong collection user_secrets
    try {
      await adminDb.collection('user_secrets').doc(cleanUserId).delete();
    } catch (secErr) {}

    return res.status(200).json({
      success: true,
      message: 'Xóa tài khoản người dùng thành công'
    });
  } catch (error: any) {
    console.error("Delete user error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi xóa tài khoản: ' + error.message });
  }
}
