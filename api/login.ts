import type { Request, Response } from 'express';
import { adminDb, adminAuth } from './_firebaseAdmin';
import { hashPassword, verifyPassword, encryptAes, decryptAes } from './_crypto';
import { generateAuthToken } from './_token';
import { FieldValue } from 'firebase-admin/firestore';

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
    const expectedSuperUser = process.env.SUPERADMIN_USERNAME || 'superadmin';
    const expectedSuperPass = process.env.SUPERADMIN_PASSWORD || 'superadmin';

    if (cleanStoreCode === 'admin' && cleanUsername === expectedSuperUser) {
      if (cleanPassword === expectedSuperPass) {
        loginFailAttempts.delete(rateLimitKey);

        const sessionToken = generateAuthToken({
          uid: 'superadmin',
          username: expectedSuperUser,
          role: 'superadmin',
          storeId: 'superadmin',
          isSuperAdmin: true
        });

        const customToken = await adminAuth.createCustomToken('superadmin', {
          role: 'superadmin',
          isSuperAdmin: true,
          storeId: 'superadmin'
        });

        return res.status(200).json({
          success: true,
          token: sessionToken,
          customToken,
          user: {
            id: 'superadmin',
            username: expectedSuperUser,
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

    // 4. Xác thực mật khẩu theo chuẩn Zero-Trust:
    // Ưu tiên bản băm bảo mật trong user_secrets.
    // NGUYÊN TẮC: Nếu đã có bản băm trong user_secrets, TUYỆT ĐỐI KHÔNG quay về kiểm tra mật khẩu rõ nếu băm sai!
    let isPasswordValid = false;
    let secretDoc: any = null;
    try {
      const secretRef = adminDb.collection('user_secrets').doc(userId);
      secretDoc = await secretRef.get();
    } catch (e) {
      // Xử lý nếu user_secrets chưa cấp quyền
    }

    const hasStoredHash = Boolean(secretDoc && secretDoc.exists && (secretDoc.data()?.passwordHash || secretDoc.data()?.encryptedPassword));

    if (hasStoredHash) {
      const secretData = secretDoc.data() || {};
      if (secretData.passwordHash) {
        isPasswordValid = verifyPassword(cleanPassword, secretData.passwordHash);
      } else if (secretData.encryptedPassword) {
        const decrypted = decryptAes(secretData.encryptedPassword);
        isPasswordValid = decrypted === cleanPassword;
      }
      // ĐÃ CÓ BẢN BĂM: Nếu sai, dừng lại ngay lập tức (không fallback)
      if (!isPasswordValid) {
        recordFailedAttempt(rateLimitKey);
        return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
      }
    } else {
      // CHỈ TÀI KHOẢN CHUYỂN TIẾP (chưa có bản băm trong user_secrets) mới được kiểm tra đối chiếu mật khẩu cũ
      if (userData.password && String(userData.password).trim() === cleanPassword) {
        isPasswordValid = true;

        // DI CHUYỂN NGAY LẬP TỨC VÀO VÙNG BẢO MẬT & XÓA BẢN RÕ KHỎI USERS
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
          // Xóa ngay trường password thô khỏi bảng users để triệt tiêu rủi ro lộ mật khẩu
          try {
            await adminDb.collection('users').doc(userId).update({
              password: FieldValue.delete(),
              isLegacy: FieldValue.delete()
            });
          } catch (delErr) {}
        } catch (migErr) {
          console.warn("[Auth] Migration warning:", migErr);
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

    // 5. Cấp Session Token có chữ ký số bí mật HMAC-SHA256
    const sessionToken = generateAuthToken({
      uid: userId,
      username: cleanUsername,
      role: userData.role,
      storeId,
      isSuperAdmin: false
    });

    // 6. Cấp Firebase Custom Token mang Custom Claims (storeId, role)
    const customToken = await adminAuth.createCustomToken(userId, {
      storeId,
      role: userData.role,
      isSuperAdmin: false
    });

    const sanitizedUserData = { ...userData };
    delete sanitizedUserData.password;

    return res.status(200).json({
      success: true,
      token: sessionToken,
      customToken,
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
  const attempt = loginFailAttempts.get(key) || { count: 0, lockedUntil: 0 };
  attempt.count += 1;
  if (attempt.count >= 5) {
    attempt.lockedUntil = now + 10 * 60 * 1000; // Khóa 10 phút sau 5 lần sai liên tiếp
    attempt.count = 0;
  }
  loginFailAttempts.set(key, attempt);
}
