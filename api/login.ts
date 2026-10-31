import type { Request, Response } from 'express';
import { adminDb, adminAuth } from './_firebaseAdmin';
import { hashPassword, verifyPassword, encryptAes, decryptAes } from './_crypto';
import { generateAuthToken } from './_token';
import { FieldValue } from 'firebase-admin/firestore';

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
    // CHỈ áp dụng khi username là 'superadmin' VÀ storeCode là 'admin' hoặc 'superadmin'
    // Tuyệt đối không can thiệp hay hiển thị thông tin SuperAdmin cho tài khoản quán thông thường (admin)
    const isSuperAdmin = (cleanStoreCode === 'admin' || cleanStoreCode === 'superadmin') && cleanUsername === 'superadmin';

    if (isSuperAdmin) {
      const expectedSuperPass = process.env.SUPERADMIN_PASSWORD;
      if (!expectedSuperPass || expectedSuperPass.trim().length === 0) {
        console.error("[Auth Security] Đăng nhập SuperAdmin bị từ chối: Biến môi trường SUPERADMIN_PASSWORD chưa được cấu hình trên máy chủ.");
        return res.status(401).json({
          error: 'Tên đăng nhập hoặc mật khẩu không đúng'
        });
      }

      if (cleanPassword === expectedSuperPass.trim()) {
        loginFailAttempts.delete(rateLimitKey);

        const sessionToken = generateAuthToken({
          uid: 'superadmin',
          username: 'superadmin',
          role: 'superadmin',
          storeId: 'superadmin',
          isSuperAdmin: true,
          tokenVersion: 1
        });

        const customToken = await adminAuth.createCustomToken('superadmin', {
          role: 'superadmin',
          isSuperAdmin: true,
          storeId: 'superadmin',
          tokenVersion: 1
        });

        return res.status(200).json({
          success: true,
          token: sessionToken,
          customToken,
          user: {
            id: 'superadmin',
            username: 'superadmin',
            name: 'Super Admin',
            role: 'superadmin',
            storeId: 'superadmin',
            token: sessionToken
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

    if (userData.isDeleted || userData.status === 'deleted') {
      recordFailedAttempt(rateLimitKey);
      return res.status(401).json({ error: 'Tài khoản người dùng này đã bị xóa hoặc không còn hoạt động' });
    }

    // 4. Xác thực mật khẩu:
    // Đọc vùng bảo mật user_secrets
    let secretDoc: any = null;
    let fallbackToLegacy = false;
    try {
      const secretRef = adminDb.collection('user_secrets').doc(userId);
      secretDoc = await secretRef.get();
    } catch (readErr: any) {
      console.warn("[Login Auth Warning] Không thể đọc user_secrets của userId:", userId, readErr?.message || readErr);
      // Khi không thể đọc user_secrets (ví dụ do Firestore Rules chặn hoặc chạy môi trường client-bridge),
      // nếu tài khoản có mật khẩu trong users, cho phép kiểm tra để không chặn người dùng hợp lệ
      if (userData.password && String(userData.password).trim() === cleanPassword) {
        fallbackToLegacy = true;
      } else {
        return res.status(503).json({
          error: 'Dịch vụ xác thực tạm thời không khả dụng. Vui lòng thử lại sau giây lát.'
        });
      }
    }

    const hasStoredSecret = Boolean(secretDoc && secretDoc.exists);
    const secretData = hasStoredSecret ? (secretDoc.data() || {}) : null;
    const hasStoredHash = Boolean(secretData && (secretData.passwordHash || secretData.encryptedPassword));

    let isPasswordValid = fallbackToLegacy;
    let tokenVersion = secretData?.tokenVersion ? Number(secretData.tokenVersion) : 1;

    if (!fallbackToLegacy && hasStoredHash) {
      // TRƯỜNG HỢP A: ĐÃ CÓ BẢN BĂM TRONG USER_SECRETS
      if (secretData.passwordHash) {
        isPasswordValid = verifyPassword(cleanPassword, secretData.passwordHash);
      } else if (secretData.encryptedPassword) {
        const decrypted = decryptAes(secretData.encryptedPassword);
        isPasswordValid = decrypted === cleanPassword;
      }

      // ĐÃ CÓ BẢN BĂM: Nếu sai mật khẩu, dừng lại ngay lập tức (KHÔNG FALLBACK)
      if (!isPasswordValid) {
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
      }

      // Nếu tài khoản cũ vẫn còn trường password thô trong users, dọn dẹp an toàn khi đã xác thực đúng
      if (userData.password) {
        try {
          await adminDb.collection('users').doc(userId).update({
            password: FieldValue.delete(),
            isLegacy: FieldValue.delete()
          });
        } catch (_) {}
      }
    } else {
      // TRƯỜNG HỢP B: TÀI KHOẢN CHUYỂN TIẾP (Chưa từng có bản băm trong user_secrets)
      if (userData.password && String(userData.password).trim() === cleanPassword) {
        isPasswordValid = true;

        // DI CHUYỂN AN TOÀN VÀO USER_SECRETS
        try {
          const passwordHash = hashPassword(cleanPassword);
          const secretPayload: Record<string, any> = {
            userId,
            storeId,
            role: userData.role,
            passwordHash,
            tokenVersion: 1,
            migratedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          if (userData.role === 'admin') {
            secretPayload.encryptedPassword = encryptAes(cleanPassword);
          }

          await adminDb.collection('user_secrets').doc(userId).set(secretPayload);
        } catch (migErr) {
          console.warn("[Auth] Migration hash notice:", migErr);
        }
      } else {
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
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
    } catch (e) {}

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
