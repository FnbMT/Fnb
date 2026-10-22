import type { Request, Response } from 'express';
import { adminDb, adminAuth } from './_firebaseAdmin';
import { hashPassword, verifyPassword, encryptAes, decryptAes } from './_crypto';

// Bộ nhớ đệm tạm thời cho Rate Limit đăng nhập sai (chống brute-force)
const loginFailAttempts = new Map<string, { count: number; lockedUntil: number }>();

export default async function handler(req: any, res: any) {
  // Hỗ trợ cả Vercel Serverless Function và Express
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { storeCode, username, password } = req.body || {};

  if (!storeCode || !username || !password) {
    return res.status(400).json({ error: 'Vui lòng cung cấp đầy đủ Mã cửa hàng, Tên đăng nhập và Mật khẩu' });
  }

  const cleanStoreCode = String(storeCode).toLowerCase().trim();
  const cleanUsername = String(username).toLowerCase().trim();
  const cleanPassword = String(password).trim();

  const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const rateLimitKey = `${clientIp}_${cleanStoreCode}_${cleanUsername}`;

  // Kiểm tra khóa tạm thời sau nhiều lần thử sai
  const currentAttempts = loginFailAttempts.get(rateLimitKey);
  const now = Date.now();
  if (currentAttempts && currentAttempts.lockedUntil > now) {
    const remainingMinutes = Math.ceil((currentAttempts.lockedUntil - now) / 60000);
    return res.status(429).json({ 
      error: `Tài khoản đã bị tạm khóa do nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau ${remainingMinutes} phút.` 
    });
  }

  try {
    // 1. Kiểm tra tài khoản Quản trị viên tối cao (Superadmin)
    // Đọc an toàn từ biến môi trường Vercel, không hardcode trong mã nguồn client
    const expectedSuperUser = process.env.SUPERADMIN_USERNAME || 'superadmin';
    const expectedSuperPass = process.env.SUPERADMIN_PASSWORD || 'superadmin';

    if (cleanStoreCode === 'admin' && cleanUsername === expectedSuperUser) {
      if (cleanPassword === expectedSuperPass) {
        // Xóa bộ đếm sai nếu đăng nhập thành công
        loginFailAttempts.delete(rateLimitKey);

        const customToken = await adminAuth.createCustomToken('superadmin', {
          role: 'superadmin',
          isSuperAdmin: true,
          storeId: 'superadmin'
        });

        return res.status(200).json({
          success: true,
          customToken,
          user: {
            id: 'superadmin',
            username: expectedSuperUser,
            name: 'Super Admin',
            role: 'superadmin',
            storeId: 'superadmin'
          }
        });
      } else {
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
      }
    }

    // 2. Tìm kiếm Cửa hàng theo mã quán
    const storeQuery = await adminDb.collection('stores')
      .where('code', '==', cleanStoreCode)
      .limit(1)
      .get();

    if (storeQuery.empty) {
      return res.status(404).json({ error: 'Mã cửa hàng không tồn tại' });
    }

    const storeDoc = storeQuery.docs[0];
    const storeId = storeDoc.id;
    const storeData = storeDoc.data();

    // Kiểm tra trạng thái khóa của cửa hàng
    if (storeData.subscription && storeData.subscription.status === 'blocked') {
      return res.status(403).json({ error: 'Cửa hàng đã bị khóa. Vui lòng liên hệ Admin để được hỗ trợ.' });
    }

    // 3. Tìm kiếm người dùng trong cửa hàng
    const userQuery = await adminDb.collection('users')
      .where('storeId', '==', storeId)
      .where('username', '==', cleanUsername)
      .limit(1)
      .get();

    if (userQuery.empty) {
      recordFailedAttempt(rateLimitKey);
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();
    const userId = userDoc.id;

    // 4. Xác thực mật khẩu và cơ chế Lazy Migration an toàn
    let isPasswordValid = false;
    let secretDoc: any = null;
    try {
      const secretRef = adminDb.collection('user_secrets').doc(userId);
      secretDoc = await secretRef.get();
    } catch (e) {
      // Bỏ qua nếu user_secrets chưa phân quyền ở dev
    }

    if (secretDoc && secretDoc.exists) {
      const secretData = secretDoc.data() || {};
      if (secretData.passwordHash) {
        isPasswordValid = verifyPassword(cleanPassword, secretData.passwordHash);
      } else if (secretData.encryptedPassword) {
        const decrypted = decryptAes(secretData.encryptedPassword);
        isPasswordValid = decrypted === cleanPassword;
      }
    }

    // Nếu user_secrets chưa có hoặc chưa khớp, thử đối chiếu với mật khẩu thô trong document users
    if (!isPasswordValid && userData.password && String(userData.password).trim() === cleanPassword) {
      isPasswordValid = true;

      // TỰ ĐỘNG CHUYỂN ĐỔI (MIGRATION) NGAY LẦN ĐĂNG NHẬP ĐẦU (nếu ghi được):
      try {
        const passwordHash = hashPassword(cleanPassword);
        const secretPayload: Record<string, any> = {
          userId,
          storeId,
          role: userData.role,
          passwordHash,
          updatedAt: new Date().toISOString()
        };

        if (userData.role === 'admin') {
          secretPayload.encryptedPassword = encryptAes(cleanPassword);
        }

        await adminDb.collection('user_secrets').doc(userId).set(secretPayload);
      } catch (migErr) {
        // Không chặn đăng nhập nếu ghi user_secrets gặp hạn chế rules
      }
    }

    if (!isPasswordValid) {
      recordFailedAttempt(rateLimitKey);
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    }

    // Đăng nhập thành công: Xóa bộ đếm sai
    loginFailAttempts.delete(rateLimitKey);

    // Cập nhật thời điểm đăng nhập gần nhất
    try {
      await adminDb.collection('users').doc(userId).update({
        lastLogin: new Date().toISOString()
      });
    } catch (e) {
      // Không chặn luồng nếu cập nhật lastLogin gặp sự cố
    }

    // 5. Cấp Firebase Custom Token mang Custom Claims (storeId, role)
    const customToken = await adminAuth.createCustomToken(userId, {
      storeId,
      role: userData.role,
      isSuperAdmin: false
    });

    const sanitizedUserData = { ...userData };
    delete sanitizedUserData.password;

    return res.status(200).json({
      success: true,
      customToken,
      user: {
        id: userId,
        ...sanitizedUserData,
        store: storeData
      }
    });
  } catch (error: any) {
    console.error("Login API error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi xử lý đăng nhập' });
  }
}

function recordFailedAttempt(key: string) {
  const now = Date.now();
  const attempt = loginFailAttempts.get(key) || { count: 0, lockedUntil: 0 };
  attempt.count += 1;
  if (attempt.count >= 5) {
    attempt.lockedUntil = now + 10 * 60 * 1000; // Khóa 10 phút sau 5 lần sai liên tiếp
    attempt.count = 0;
  }
  loginFailAttempts.set(key, attempt);
}
