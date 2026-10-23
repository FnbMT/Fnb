import type { Request, Response } from 'express';
import { adminDb } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';
import { getAuthenticatedCaller } from './_token';
import { FieldValue } from 'firebase-admin/firestore';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. XÁC THỰC DANH TÍNH BẰNG TOKEN (Zero-Trust Guard)
  // Bắt buộc xác minh qua Bearer Token có chữ ký số hoặc Firebase ID Token
  const caller = await getAuthenticatedCaller(req);
  if (!caller) {
    return res.status(401).json({
      error: 'Yêu cầu đăng nhập: Phiên làm việc không hợp lệ hoặc đã hết hạn.'
    });
  }

  const { user } = req.body || {};

  if (!user) {
    return res.status(400).json({ error: 'Dữ liệu người dùng không hợp lệ' });
  }

  const cleanStoreId = String(user.storeId || '').trim();
  const cleanUsername = String(user.username || '').toLowerCase().trim();
  const cleanName = String(user.name || '').trim();
  const role = user.role || 'order';

  if (!cleanStoreId || !cleanUsername || !cleanName) {
    return res.status(400).json({ error: 'Vui lòng cung cấp đầy đủ Tên đăng nhập, Họ tên và Mã cửa hàng' });
  }

  // 2. KIỂM SOÁT PHÂN QUYỀN CHẶT CHẼ
  const isSuperAdmin = caller.isSuperAdmin || caller.role === 'superadmin';
  const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === cleanStoreId;

  if (!isSuperAdmin && !isStoreAdmin) {
    return res.status(403).json({
      error: 'Từ chối quyền truy cập: Bạn không có quyền quản lý nhân sự của cửa hàng này.'
    });
  }

  // Chỉ SuperAdmin mới có quyền tạo hoặc nâng quyền Admin
  if (role === 'admin' && !isSuperAdmin) {
    return res.status(403).json({
      error: 'Từ chối quyền truy cập: Chỉ Quản trị viên tối cao mới có quyền chỉ định tài khoản Admin.'
    });
  }

  try {
    // TRƯỜNG HỢP 1: TẠO MỚI NGƯỜI DÙNG (Chưa có ID)
    if (!user.id) {
      if (!user.password || String(user.password).trim().length < 1) {
        return res.status(400).json({ error: 'Mật khẩu là bắt buộc khi tạo tài khoản mới' });
      }

      // Kiểm tra trùng username trong cùng cửa hàng
      const existingUserQuery = await adminDb.collection('users')
        .where('storeId', '==', cleanStoreId)
        .where('username', '==', cleanUsername)
        .limit(1)
        .get();

      if (!existingUserQuery.empty) {
        return res.status(400).json({ error: 'Tên đăng nhập này đã tồn tại trong quán. Vui lòng chọn tên khác.' });
      }

      const cleanPassword = String(user.password).trim();
      const passwordHash = hashPassword(cleanPassword);

      // 1. Tạo document users TUYỆT ĐỐI KHÔNG chứa trường password rõ
      const userDocData: Record<string, any> = {
        storeId: cleanStoreId,
        username: cleanUsername,
        name: cleanName,
        role: role,
        phone: user.phone ? String(user.phone).trim() : '',
        cccd: user.cccd ? String(user.cccd).trim() : '',
        address: user.address ? String(user.address).trim() : '',
        salaryType: user.salaryType || 'daily',
        salaryAmount: Number(user.salaryAmount) || 0,
        shifts: Array.isArray(user.shifts) ? user.shifts : [{ start: '08:00', end: '17:00' }],
        requiresAttendance: Boolean(user.requiresAttendance),
        createdAt: new Date().toISOString()
      };

      const newUserDocRef = await adminDb.collection('users').add(userDocData);
      const newUserId = newUserDocRef.id;

      // 2. Lưu thông tin băm vào vùng tối mật user_secrets
      const secretPayload: Record<string, any> = {
        userId: newUserId,
        storeId: cleanStoreId,
        role: role,
        passwordHash,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      if (role === 'admin') {
        secretPayload.encryptedPassword = encryptAes(cleanPassword);
      }

      try {
        await adminDb.collection('user_secrets').doc(newUserId).set(secretPayload);
      } catch (secErr) {
        // NGUYÊN TẮC AN TOÀN: Nếu lưu mật khẩu thất bại, lập tức rollback xóa user vừa tạo
        try {
          await adminDb.collection('users').doc(newUserId).delete();
        } catch (_) {}
        return res.status(500).json({
          error: 'Lỗi hệ thống: Không thể lưu trữ thông tin xác thực an toàn. Tạo tài khoản thất bại.'
        });
      }

      return res.status(200).json({
        success: true,
        userId: newUserId,
        user: {
          id: newUserId,
          ...userDocData
        }
      });
    }

    // TRƯỜNG HỢP 2: CẬP NHẬT NGƯỜI DÙNG HIỆN CÓ
    const userId = String(user.id).trim();
    const userDocRef = adminDb.collection('users').doc(userId);
    const existingDoc = await userDocRef.get();

    if (!existingDoc.exists) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản người dùng' });
    }

    const updates: Record<string, any> = {
      username: cleanUsername,
      name: cleanName,
      role: role,
      phone: user.phone ? String(user.phone).trim() : '',
      cccd: user.cccd ? String(user.cccd).trim() : '',
      address: user.address ? String(user.address).trim() : '',
      salaryType: user.salaryType || 'daily',
      salaryAmount: Number(user.salaryAmount) || 0,
      shifts: Array.isArray(user.shifts) ? user.shifts : [{ start: '08:00', end: '17:00' }],
      requiresAttendance: Boolean(user.requiresAttendance),
      updatedAt: new Date().toISOString()
    };

    // Nếu có gửi mật khẩu mới, cập nhật vào user_secrets và xóa mật khẩu rõ
    if (user.password && String(user.password).trim().length > 0) {
      const cleanPassword = String(user.password).trim();
      const passwordHash = hashPassword(cleanPassword);

      const secretPayload: Record<string, any> = {
        userId,
        storeId: cleanStoreId,
        role: role,
        passwordHash,
        updatedAt: new Date().toISOString()
      };

      if (role === 'admin') {
        secretPayload.encryptedPassword = encryptAes(cleanPassword);
      } else {
        secretPayload.encryptedPassword = FieldValue.delete();
      }

      try {
        await adminDb.collection('user_secrets').doc(userId).set(secretPayload, { merge: true });
      } catch (secErr) {
        return res.status(500).json({
          error: 'Lỗi hệ thống: Không thể cập nhật mật khẩu vào vùng bảo mật.'
        });
      }

      // Xóa triệt để trường password rõ và cờ legacy khỏi collection users
      updates.password = FieldValue.delete();
      updates.isLegacy = FieldValue.delete();
    }

    await userDocRef.update(updates);

    return res.status(200).json({
      success: true,
      userId,
      message: 'Cập nhật tài khoản thành công'
    });
  } catch (error: any) {
    console.error("Save user error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi lưu thông tin người dùng: ' + error.message });
  }
}
