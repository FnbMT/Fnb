import type { Request, Response } from 'express';
import { adminDb, adminAuth } from './_firebaseAdmin';
import { hashPassword, encryptAes } from './_crypto';
import { getAuthenticatedCaller, invalidateUserStatusCache } from './_token';
import { FieldValue } from 'firebase-admin/firestore';
import { STORE_STAFF_ROLES, ALL_USER_ROLES, isValidUserRole, isStoreStaffRole, UserRole } from '../src/roles';

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

  // Kiểm tra tính hợp lệ của vai trò theo schema chung, không tự ý đổi sang role khác
  if (!user.role) {
    return res.status(400).json({ error: 'Vui lòng chọn vai trò cho người dùng' });
  }

  const rawRole = String(user.role).trim();
  if (!isValidUserRole(rawRole)) {
    return res.status(400).json({
      error: `Vai trò "${user.role}" không hợp lệ. Các vai trò được hỗ trợ: ${ALL_USER_ROLES.join(', ')}`
    });
  }
  const role: UserRole = rawRole;

  const cleanStoreId = String(user.storeId || '').trim();
  const cleanUsername = String(user.username || '').toLowerCase().trim();
  const cleanName = String(user.name || '').trim();

  if (!cleanUsername || !cleanName) {
    return res.status(400).json({ error: 'Vui lòng cung cấp đầy đủ Tên đăng nhập và Họ tên' });
  }

  // 2. KIỂM SOÁT PHÂN QUYỀN VAI TRÒ NGƯỜI GỌI (Zero-Trust Authorization)
  const isSuperAdmin = Boolean(caller.isSuperAdmin || caller.role === 'superadmin');
  const isStoreAdmin = caller.role === 'admin';

  if (!isSuperAdmin && !isStoreAdmin) {
    return res.status(403).json({
      error: 'Từ chối quyền truy cập: Bạn không có quyền quản lý nhân sự.'
    });
  }

  // VULNERABILITY A: Giới hạn danh sách role được phép theo từng người gọi
  // Chỉ SuperAdmin mới có quyền tạo hoặc phân quyền Admin hoặc SuperAdmin.
  // Store Admin TUYỆT ĐỐI CHỈ được phân quyền các vai trò nhân viên trong STORE_STAFF_ROLES.
  if (!isSuperAdmin) {
    if (role === 'superadmin' || role === 'admin' || !isStoreStaffRole(role)) {
      return res.status(403).json({
        error: 'Từ chối quyền truy cập: Quản trị viên cửa hàng chỉ có quyền phân công vai trò nhân sự trong quán (order, cashier, order_cashier, kitchen, manager), không được cấp quyền Quản trị viên (Admin/SuperAdmin).'
      });
    }
  }

  try {
    // TRƯỜNG HỢP 1: TẠO MỚI NGƯỜI DÙNG (Chưa có ID)
    if (!user.id) {
      if (!user.password || String(user.password).trim().length < 1) {
        return res.status(400).json({ error: 'Mật khẩu là bắt buộc khi tạo tài khoản mới' });
      }

      // VULNERABILITY B FIX (Create): Store admin chỉ được tạo nhân sự trong cửa hàng của chính mình
      const targetStoreId = isSuperAdmin ? cleanStoreId : String(caller.storeId || '').trim();
      if (!targetStoreId) {
        return res.status(400).json({ error: 'Mã cửa hàng không hợp lệ' });
      }

      if (!isSuperAdmin && cleanStoreId && cleanStoreId !== targetStoreId) {
        return res.status(403).json({
          error: 'Từ chối quyền truy cập: Bạn không có quyền tạo tài khoản nhân viên cho cửa hàng khác.'
        });
      }

      // Kiểm tra trùng username trong cùng cửa hàng
      const existingUserQuery = await adminDb.collection('users')
        .where('storeId', '==', targetStoreId)
        .where('username', '==', cleanUsername)
        .limit(1)
        .get();

      const existingDoc = !existingUserQuery.empty ? existingUserQuery.docs[0] : null;
      const existingData = existingDoc ? existingDoc.data() : null;

      if (existingDoc && !existingData?.isDeleted && existingData?.status !== 'deleted') {
        return res.status(400).json({ error: 'Tên đăng nhập này đã tồn tại trong quán. Vui lòng chọn tên khác.' });
      }

      const cleanPassword = String(user.password).trim();
      const passwordHash = hashPassword(cleanPassword);

      // 1. Tạo document users TUYỆT ĐỐI KHÔNG chứa trường password rõ
      const userDocData: Record<string, any> = {
        storeId: targetStoreId,
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
        tokenVersion: 1,
        isDeleted: false,
        status: 'active',
        createdAt: new Date().toISOString()
      };

      let newUserId: string;
      if (existingDoc && (existingData?.isDeleted || existingData?.status === 'deleted')) {
        newUserId = existingDoc.id;
        await adminDb.collection('users').doc(newUserId).set(userDocData, { merge: true });
      } else {
        const newUserDocRef = await adminDb.collection('users').add(userDocData);
        newUserId = newUserDocRef.id;
      }

      // 2. Lưu thông tin băm vào vùng tối mật user_secrets
      const secretPayload: Record<string, any> = {
        userId: newUserId,
        storeId: targetStoreId,
        role: role,
        passwordHash,
        tokenVersion: 1,
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

    const existingData = existingDoc.data() || {};
    const existingStoreId = String(existingData.storeId || '').trim();
    const existingRole = String(existingData.role || 'order');

    // VULNERABILITY B FIX (Update): Kiểm tra đối chiếu chặt chẽ cửa hàng và quyền hạn từ DATABASE
    if (!isSuperAdmin) {
      const callerStoreId = String(caller.storeId || '').trim();
      // Bắt buộc cửa hàng của tài khoản đích lấy từ Firestore phải khớp chính xác cửa hàng của người gọi
      if (!callerStoreId || existingStoreId !== callerStoreId) {
        return res.status(403).json({
          error: 'Từ chối quyền truy cập: Bạn không có quyền chỉnh sửa tài khoản thuộc cửa hàng khác.'
        });
      }

      // Store Admin tuyệt đối không được sửa tài khoản Admin khác hoặc SuperAdmin
      if (existingRole === 'admin' || existingRole === 'superadmin') {
        return res.status(403).json({
          error: 'Từ chối quyền truy cập: Quản trị viên cửa hàng không có quyền chỉnh sửa tài khoản Quản trị viên.'
        });
      }
    }

    // Xác định storeId đích không thể bị Store Admin tùy tiện thay đổi
    const targetStoreId = isSuperAdmin ? (cleanStoreId || existingStoreId) : existingStoreId;

    // Kiểm tra trùng username nếu username thay đổi
    if (cleanUsername !== String(existingData.username || '').toLowerCase().trim()) {
      const dupQuery = await adminDb.collection('users')
        .where('storeId', '==', targetStoreId)
        .where('username', '==', cleanUsername)
        .limit(1)
        .get();

      if (!dupQuery.empty && dupQuery.docs[0].id !== userId) {
        return res.status(400).json({ error: 'Tên đăng nhập mới đã tồn tại trong quán. Vui lòng chọn tên khác.' });
      }
    }

    const updates: Record<string, any> = {
      username: cleanUsername,
      name: cleanName,
      role: role,
      storeId: targetStoreId,
      phone: user.phone ? String(user.phone).trim() : '',
      cccd: user.cccd ? String(user.cccd).trim() : '',
      address: user.address ? String(user.address).trim() : '',
      salaryType: user.salaryType || 'daily',
      salaryAmount: Number(user.salaryAmount) || 0,
      shifts: Array.isArray(user.shifts) ? user.shifts : [{ start: '08:00', end: '17:00' }],
      requiresAttendance: Boolean(user.requiresAttendance),
      updatedAt: new Date().toISOString()
    };

    // NẾU ĐỔI MẬT KHẨU HOẶC ĐỔI QUYỀN: Bắt buộc tăng tokenVersion để vô hiệu hóa toàn bộ phiên cũ
    const passwordChanged = Boolean(user.password && String(user.password).trim().length > 0);
    const roleChanged = Boolean(role !== existingRole);

    if (passwordChanged || roleChanged) {
      let currentVer = 1;
      try {
        const secretSnap = await adminDb.collection('user_secrets').doc(userId).get();
        if (secretSnap.exists) {
          currentVer = Number(secretSnap.data()?.tokenVersion || existingData.tokenVersion || 1);
        } else {
          currentVer = Number(existingData.tokenVersion || 1);
        }
      } catch (_) {}
      const nextTokenVersion = currentVer + 1;
      updates.tokenVersion = nextTokenVersion;

      const secretPayload: Record<string, any> = {
        userId,
        storeId: targetStoreId,
        role: role,
        tokenVersion: nextTokenVersion,
        updatedAt: new Date().toISOString()
      };

      if (passwordChanged) {
        const cleanPassword = String(user.password).trim();
        secretPayload.passwordHash = hashPassword(cleanPassword);
        secretPayload.passwordChangedAt = new Date().toISOString();
        if (role === 'admin') {
          secretPayload.encryptedPassword = encryptAes(cleanPassword);
        } else {
          secretPayload.encryptedPassword = FieldValue.delete();
        }
        updates.password = FieldValue.delete();
        updates.isLegacy = FieldValue.delete();
      }

      try {
        await adminDb.collection('user_secrets').doc(userId).set(secretPayload, { merge: true });
      } catch (secErr) {
        return res.status(500).json({
          error: 'Lỗi hệ thống: Không thể cập nhật thông tin xác thực an toàn vào vùng bảo mật.'
        });
      }

      invalidateUserStatusCache(userId);
      await adminAuth.revokeRefreshTokens(userId);
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
