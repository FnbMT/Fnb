import type { Request, Response } from 'express';
import { adminDb, adminAuth } from './_firebaseAdmin.js';
import { getAuthenticatedCaller, invalidateUserStatusCache } from './_token.js';
import { handleCors } from './_cors.js';

export default async function handler(req: any, res: any) {
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. XÁC THỰC DANH TÍNH BẰNG TOKEN (Zero-Trust Guard)
  const caller = await getAuthenticatedCaller(req);
  if (!caller) {
    return res.status(401).json({
      error: 'Yêu cầu đăng nhập: Phiên làm việc không hợp lệ hoặc đã hết hạn.'
    });
  }

  const { userId } = req.body || {};

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

    // 2. PHÂN QUYỀN API
    const isSuperAdmin = caller.isSuperAdmin || caller.role === 'superadmin';
    const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === targetStoreId;

    if (!isSuperAdmin && !isStoreAdmin) {
      return res.status(403).json({
        error: 'Từ chối quyền truy cập: Chỉ Quản lý (Admin) của quán hoặc SuperAdmin mới có quyền xóa nhân sự.'
      });
    }

    // Admin của quán không được xóa tài khoản Quản trị viên (Admin hoặc SuperAdmin) qua API này
    if ((targetRole === 'admin' || targetRole === 'superadmin') && !isSuperAdmin) {
      return res.status(403).json({
        error: 'Không thể xóa tài khoản Quản trị viên (Admin/SuperAdmin) qua thao tác này.'
      });
    }

    // Xóa trong collection users:
    // Thử xóa vĩnh viễn document trước; nếu Firestore Rules chặn hard-delete (do allow delete: if false trong môi trường client-bridge),
    // tự động soft-delete bằng cách cập nhật isDeleted: true và status: 'deleted' (tuân thủ 100% quy tắc update của Firestore).
    try {
      await userDocRef.delete();
    } catch (delErr: any) {
      console.warn("Direct user delete failed, falling back to soft-delete:", delErr?.message || delErr);
      await userDocRef.update({
        role: targetRole,
        storeId: targetStoreId,
        username: userData.username || '',
        tokenVersion: 999999,
        isDeleted: true,
        status: 'deleted',
        deletedAt: new Date().toISOString()
      });
    }

    // Xóa trong collection user_secrets (và bản ghi legacy trong system nếu có) để vô hiệu hóa hoàn toàn mật khẩu & quyền đăng nhập
    try {
      await adminDb.collection('user_secrets').doc(cleanUserId).delete();
      await adminDb.collection('system').doc(`user_secret_${cleanUserId}`).delete().catch(() => {});
    } catch (secErr) {}

    // Tự động đóng tất cả ca làm việc đang mở của nhân viên bị xóa
    try {
      const openShiftsSnap = await adminDb.collection('shifts')
        .where('staffId', '==', cleanUserId)
        .where('status', '==', 'open')
        .get();

      const nowIso = new Date().toISOString();
      for (const shiftDoc of openShiftsSnap.docs) {
        const sData = shiftDoc.data() || {};
        await shiftDoc.ref.update({
          status: 'closed',
          endTime: nowIso,
          endCash: (Number(sData.startCash) || 0) + (Number(sData.totalCash) || 0),
          discrepancy: 0,
          discrepancyProcessed: true,
          autoClosed: true,
          note: 'Tự động đóng do tài khoản nhân viên đã bị xóa khỏi hệ thống'
        });
      }
    } catch (shiftErr) {
      console.warn("Lỗi dọn dẹp ca làm việc của nhân viên bị xóa:", shiftErr);
    }

    // Tự động chốt các lượt chấm công chưa đóng của nhân viên bị xóa
    try {
      const openAttSnap = await adminDb.collection('attendance_records')
        .where('userId', '==', cleanUserId)
        .get();

      const nowIso = new Date().toISOString();
      for (const attDoc of openAttSnap.docs) {
        const aData = attDoc.data() || {};
        if (aData.checkInTime && !aData.checkOutTime) {
          await attDoc.ref.update({
            checkOutTime: nowIso,
            autoClosed: true,
            note: 'Tự động đóng lượt chấm công do nhân viên đã bị xóa'
          });
        }
      }
    } catch (attErr) {
      console.warn("Lỗi dọn dẹp chấm công của nhân viên bị xóa:", attErr);
    }

    // Xóa các checkout_locks liên quan đến nhân viên bị xóa
    try {
      await adminDb.collection('checkout_locks').doc(`shift_open_${targetStoreId}_${cleanUserId}`).delete().catch(() => {});
      await adminDb.collection('checkout_locks').doc(`attendance_${targetStoreId}_${cleanUserId}`).delete().catch(() => {});
    } catch (_) {}

    // Thu hồi tức thì phiên đăng nhập & refresh token + đánh dấu cập nhật thống kê nhân sự quán
    invalidateUserStatusCache(cleanUserId);
    await adminAuth.revokeRefreshTokens(cleanUserId);
    if (targetStoreId) {
      await adminDb.collection('stores').doc(targetStoreId).update({ 'userSummary.needsSync': true }).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: 'Xóa tài khoản người dùng thành công'
    });
  } catch (error: any) {
    console.error("Delete user error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi xóa tài khoản: ' + error.message });
  }
}
