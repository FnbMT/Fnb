import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { adminDb, adminAuth, safeDeleteSentinel } from './_firebaseAdmin.js';
import { hashPassword, verifyPassword, encryptAes, decryptAes } from './_crypto.js';
import { generateAuthToken } from './_token.js';

// Bộ nhớ đệm tạm thời cho Rate Limit đăng nhập sai (chống brute-force)
interface FailedAttempt {
  count: number;
  lockedUntil: number;
  lastAttempt: number;
}
const loginFailAttempts = new Map<string, FailedAttempt>();

// Tự động dọn dẹp các mục rate-limit đã hết hạn mỗi 5 phút để tránh rò rỉ bộ nhớ
setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of loginFailAttempts.entries()) {
    if (attempt.lockedUntil < now && now - attempt.lastAttempt > 30 * 60 * 1000) {
      loginFailAttempts.delete(key);
    }
  }
}, 5 * 60 * 1000);

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { storeCode, username, password } = req.body || {};
  const cleanUsername = String(username || '').toLowerCase().trim();
  const configuredSuperUser = (process.env.SUPERADMIN_USERNAME || 'superadmin').toLowerCase().trim();
  const isSuperAdminUser = cleanUsername === 'superadmin' || cleanUsername === configuredSuperUser;

  if (!username || !password || (!storeCode && !isSuperAdminUser)) {
    return res.status(400).json({ error: 'Vui lòng cung cấp đầy đủ Mã cửa hàng, Tên đăng nhập và Mật khẩu' });
  }

  const cleanStoreCode = String(storeCode || 'admin').toLowerCase().trim();
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
    // Hỗ trợ cả username mặc định 'superadmin' lẫn username cấu hình qua SUPERADMIN_USERNAME
    const configuredSuperUser = (process.env.SUPERADMIN_USERNAME || 'superadmin').toLowerCase().trim();
    const isSuperAdmin = 
      (cleanStoreCode === 'admin' || cleanStoreCode === 'superadmin' || cleanStoreCode === configuredSuperUser) && 
      (cleanUsername === 'superadmin' || cleanUsername === configuredSuperUser);

    if (isSuperAdmin) {
      const rawSuperPass = process.env.SUPERADMIN_PASSWORD;
      if (!rawSuperPass || rawSuperPass.trim().length === 0) {
        console.error("[Auth Security] Đăng nhập SuperAdmin bị từ chối: Biến môi trường SUPERADMIN_PASSWORD chưa được cấu hình trên máy chủ.");
        return res.status(401).json({
          error: 'Biến môi trường SUPERADMIN_PASSWORD chưa được cấu hình trên máy chủ Vercel.'
        });
      }

      const cleanSuperPass = rawSuperPass.trim().replace(/^["']|["']$/g, '');
      const isPasswordMatch = cleanPassword === cleanSuperPass || cleanPassword === rawSuperPass.trim();

      if (isPasswordMatch) {
        loginFailAttempts.delete(rateLimitKey);

        const sessionToken = generateAuthToken({
          uid: 'superadmin',
          username: cleanUsername,
          role: 'superadmin',
          storeId: 'superadmin',
          isSuperAdmin: true,
          tokenVersion: 1
        });

        let customToken: string | null = null;
        try {
          customToken = await adminAuth.createCustomToken('superadmin', {
            role: 'superadmin',
            isSuperAdmin: true,
            storeId: 'superadmin',
            tokenVersion: 1
          });
        } catch (tokenErr) {
          console.warn("[Auth Security] createCustomToken error for superadmin:", tokenErr);
        }

        return res.status(200).json({
          success: true,
          token: sessionToken,
          customToken,
          user: {
            id: 'superadmin',
            username: cleanUsername,
            name: 'Super Admin',
            role: 'superadmin',
            storeId: 'superadmin',
            token: sessionToken
          }
        });
      } else {
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({ error: 'Mật khẩu SuperAdmin không chính xác' });
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

    // 3. Tìm kiếm người dùng trong cửa hàng (Hỗ trợ chữ thường, nguyên bản, số điện thoại, và quét toàn bộ quán)
    let userDoc: any = null;
    let userData: any = null;
    let userId: string = '';

    // 3a. Thử truy vấn trực tiếp với cleanUsername (chữ thường)
    let userQuery = await adminDb.collection('users')
      .where('storeId', '==', storeId)
      .where('username', '==', cleanUsername)
      .limit(1)
      .get();

    if (!userQuery.empty) {
      userDoc = userQuery.docs[0];
    } else if (String(username || '').trim() !== cleanUsername) {
      // 3b. Thử với nguyên bản case người dùng nhập
      userQuery = await adminDb.collection('users')
        .where('storeId', '==', storeId)
        .where('username', '==', String(username || '').trim())
        .limit(1)
        .get();
      if (!userQuery.empty) userDoc = userQuery.docs[0];
    }

    // 3c. Nếu vẫn chưa thấy, tìm kiếm toàn diện trong quán (chống lệch hoa/thường, khoảng trắng thừa, tìm theo phone hoặc storeCode legacy)
    if (!userDoc) {
      const allStoreUsersSnap = await adminDb.collection('users')
        .where('storeId', 'in', [storeId, cleanStoreCode])
        .get();

      const inputClean = cleanUsername;
      const inputRaw = String(username || '').trim();
      const matched = allStoreUsersSnap.docs.find((d: any) => {
        const u = d.data();
        const dbUser = String(u.username || '').toLowerCase().trim();
        const dbPhone = String(u.phone || '').trim();
        return dbUser === inputClean || dbUser === inputRaw.toLowerCase() || (dbPhone && (dbPhone === inputRaw || dbPhone === inputClean));
      });

      if (matched) userDoc = matched;
    }

    if (!userDoc) {
      recordFailedAttempt(rateLimitKey);
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    }

    userData = userDoc.data();
    userId = userDoc.id;

    if (userId === 'superadmin' || cleanUsername === 'superadmin') {
      recordFailedAttempt(rateLimitKey);
      return res.status(403).json({ error: 'Định danh không hợp lệ đối với tài khoản cửa hàng' });
    }

    if (userData.isDeleted || userData.status === 'deleted' || userData.isActive === false) {
      recordFailedAttempt(rateLimitKey);
      return res.status(401).json({ error: 'Tài khoản người dùng này đã bị vô hiệu hóa hoặc không còn hoạt động' });
    }

    // 4. Xác thực mật khẩu đa tầng:
    let isPasswordValid = false;
    let tokenVersion = 1;
    let secretData: any = null;

    // 4a. Đọc vùng bảo mật user_secrets
    try {
      const secretRef = adminDb.collection('user_secrets').doc(userId);
      const secretDoc = await secretRef.get();
      if (secretDoc && secretDoc.exists) {
        secretData = secretDoc.data() || {};
        tokenVersion = secretData.tokenVersion ? Number(secretData.tokenVersion) : 1;
      }
    } catch (readErr: any) {
      console.warn("[Login Auth Warning] Lỗi đọc user_secrets:", userId, readErr?.message || readErr);
    }

    // 4b. Kiểm tra vùng lưu trữ legacy system/user_secret_${userId} nếu user_secrets chưa có
    if (!secretData || (!secretData.passwordHash && !secretData.clientHash && !secretData.encryptedPassword)) {
      try {
        const sysSnap = await adminDb.collection('system').doc(`user_secret_${userId}`).get();
        if (sysSnap && sysSnap.exists) {
          const sysData = sysSnap.data() || {};
          secretData = { ...sysData, ...(secretData || {}) };
          if (!secretData.passwordHash && sysData.passwordHash) secretData.passwordHash = sysData.passwordHash;
          if (!secretData.clientHash && sysData.clientHash) secretData.clientHash = sysData.clientHash;
          if (!secretData.encryptedPassword && sysData.encryptedPassword) secretData.encryptedPassword = sysData.encryptedPassword;
        }
      } catch (_) {}
    }

    // 4c. Đối chiếu với các bản băm trong secretData (scrypt, sha256, aes-256)
    if (secretData) {
      if (secretData.passwordHash) {
        if (typeof secretData.passwordHash === 'string' && secretData.passwordHash.includes(':')) {
          isPasswordValid = verifyPassword(cleanPassword, secretData.passwordHash);
        } else {
          const sha256 = crypto.createHash('sha256').update(cleanPassword).digest('hex');
          isPasswordValid = (sha256 === secretData.passwordHash || cleanPassword === secretData.passwordHash);
        }
      }

      if (!isPasswordValid && secretData.clientHash) {
        const clientSha256 = crypto.createHash('sha256').update(cleanPassword).digest('hex');
        if (clientSha256 === secretData.clientHash) {
          isPasswordValid = true;
        }
      }

      if (!isPasswordValid && secretData.encryptedPassword) {
        try {
          const decrypted = decryptAes(secretData.encryptedPassword);
          isPasswordValid = (decrypted === cleanPassword);
        } catch (_) {}
      }
    }

    // 4d. Đối chiếu với userData.password (nếu bản băm chưa có hoặc tài khoản legacy được tạo trực tiếp)
    if (!isPasswordValid && userData.password) {
      const rawUserPass = String(userData.password).trim();
      if (rawUserPass === cleanPassword) {
        isPasswordValid = true;
      } else {
        const sha256 = crypto.createHash('sha256').update(cleanPassword).digest('hex');
        if (rawUserPass === sha256) {
          isPasswordValid = true;
        }
      }
    }

    if (!isPasswordValid) {
      recordFailedAttempt(rateLimitKey);
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    }

    // Đăng nhập thành công: Xóa bộ đếm sai
    loginFailAttempts.delete(rateLimitKey);

    // 4e. TỰ ĐỘNG ĐỒNG BỘ VÀ NÂNG CẤP BẢO MẬT: Lưu hash chuẩn scrypt vào user_secrets và cập nhật lastLogin
    try {
      const passwordHash = hashPassword(cleanPassword);
      const clientHash = crypto.createHash('sha256').update(cleanPassword).digest('hex');
      const secretPayload: Record<string, any> = {
        userId,
        storeId,
        role: userData.role,
        passwordHash,
        clientHash,
        tokenVersion: tokenVersion || 1,
        updatedAt: new Date().toISOString()
      };
      if (userData.role === 'admin') {
        secretPayload.encryptedPassword = encryptAes(cleanPassword);
      }
      await adminDb.collection('user_secrets').doc(userId).set(secretPayload, { merge: true });

      // Đồng thời cập nhật system/user_secret_${userId} cho tương thích fallback hai tầng
      try {
        await adminDb.collection('system').doc(`user_secret_${userId}`).set({
          userId,
          storeId,
          role: userData.role,
          clientHash,
          updatedAt: new Date().toISOString()
        }, { merge: true });
      } catch (sysErr) {
        console.warn("[Auth Warning] Không thể cập nhật system secret:", sysErr);
      }

      // Luôn bảo lưu password trong users để đảm bảo 100% tương thích cho các thiết bị cũ (iOS TestFlight/App Store)
      const updatePayload: Record<string, any> = {
        lastLogin: new Date().toISOString(),
        password: cleanPassword
      };
      await adminDb.collection('users').doc(userId).update(updatePayload);
    } catch (migErr) {
      console.warn("[Auth Upgrade Notice]:", migErr);
    }

    // 5. Cấp Session Token có chữ ký số bí mật HMAC-SHA256 kèm tokenVersion
    const sessionToken = generateAuthToken({
      uid: userId,
      username: cleanUsername,
      role: userData.role,
      storeId,
      isSuperAdmin: false,
      tokenVersion
    });

    // 6. Cấp Firebase Custom Token mang Custom Claims (storeId, role, tokenVersion)
    const customToken = await adminAuth.createCustomToken(userId, {
      storeId,
      role: userData.role,
      isSuperAdmin: false,
      tokenVersion
    });

    // Chỉ chặn nếu môi trường yêu cầu bắt buộc Firebase Auth token (REQUIRE_ADMIN_AUTH === 'true')
    if (process.env.REQUIRE_ADMIN_AUTH === 'true' && !customToken) {
      console.error("[Login Security] Firebase Admin SDK chưa được cấu hình Service Account để tạo customToken.");
      return res.status(503).json({
        error: 'Máy chủ chưa được cấu hình Firebase Admin SDK Service Account để khởi tạo phiên đăng nhập bảo mật.'
      });
    }

    const sanitizedUserData = { ...userData };
    delete sanitizedUserData.password;
    delete sanitizedUserData.pinCode;
    delete sanitizedUserData.legacyKey;

    return res.status(200).json({
      success: true,
      token: sessionToken,
      customToken,
      hasAdminAuth: Boolean(customToken),
      user: {
        id: userId,
        token: sessionToken,
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
  const attempt = loginFailAttempts.get(key) || { count: 0, lockedUntil: 0, lastAttempt: now };
  attempt.count += 1;
  attempt.lastAttempt = now;
  if (attempt.count >= 5) {
    attempt.lockedUntil = now + 10 * 60 * 1000; // Khóa 10 phút sau 5 lần sai liên tiếp
    attempt.count = 0;
  }
  loginFailAttempts.set(key, attempt);
}
