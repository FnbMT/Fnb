import type { Request, Response } from 'express';
import { adminDb } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';
import { FieldValue } from 'firebase-admin/firestore';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { user, caller } = req.body || {};

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

  // PHÂN QUYỀN API (P2 Security Guard):
  // Chỉ Admin của chính cửa hàng này hoặc SuperAdmin mới có quyền tạo / sửa nhân viên
  if (caller) {
    const isSuperAdmin = caller.role === 'superadmin';
    const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === cleanStoreId;

    if (!isSuperAdmin && !isStoreAdmin) {
      return res.status(403).json({
        error: 'Từ chối quyền truy cập: Chỉ Quản trị viên (Admin) của cửa hàng hoặc SuperAdmin mới có quyền tạo hoặc chỉnh sửa nhân sự.'
      });
    }

    // Nhân viên không thể tự nâng role của mình lên Admin
    if (role === 'admin' && !isSuperAdmin && caller.role !== 'admin') {
      return res.status(403).json({
        error: 'Từ chối quyền truy cập: Không thể chỉ định vai trò Admin.'
      });
    }
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

      // Tạo document users TRƯỚC (tuyệt đối KHÔNG lưu plaintext password)
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

      // Lưu mật khẩu vào collection bảo mật user_secrets
      // NGUYÊN TẮC BẢO MẬT:
      // - role === 'admin' (Chủ quán): Lưu passwordHash + encryptedPassword (AES-256) để Super Admin có thể tra cứu khi chủ quán quên
      // - role !== 'admin' (Nhân viên): CHỈ lưu passwordHash (scrypt 1 chiều), KHÔNG mã hóa 2 chiều (Chủ quán không xem được mật khẩu nhân viên)
      const secretPayload: Record<string, any> = {
        userId: newUserId,
        storeId: cleanStoreId,
        role: role,
        passwordHash,
        updatedAt: new Date().toISOString()
      };

      if (role === 'admin') {
        secretPayload.encryptedPassword = encryptAes(cleanPassword);
      }

      try {
        await adminDb.collection('user_secrets').doc(newUserId).set(secretPayload);
      } catch (secErr) {
        try {
          await adminDb.collection('users').doc(newUserId).update({ password: cleanPassword });
        } catch (uErr) {}
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

    await userDocRef.update(updates);

    // Nếu có gửi mật khẩu mới thì tiến hành cập nhật vào user_secrets
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
        // Tự động dọn dẹp trường password thô nếu ghi user_secrets thành công
        try {
          await userDocRef.update({ password: FieldValue.delete() });
        } catch (delErr) {}
      } catch (secErr) {
        // Fallback lưu password thô nếu không ghi được user_secrets
        try {
          await userDocRef.update({ password: cleanPassword });
        } catch (uErr) {}
      }
    }

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
