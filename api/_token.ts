import crypto from 'node:crypto';
import { adminAuth, hasAdminCredential, adminDb } from './_firebaseAdmin';

// Khóa bí mật dùng để ký và xác thực token JWT HMAC-SHA256 (Ưu tiên JWT_SECRET độc lập, fallback sang ENCRYPTION_KEY)
const getSecretKey = (): Buffer => {
  const secret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret || secret.trim().length === 0) {
    throw new Error('[Security Error] Thiếu cấu hình JWT_SECRET hoặc ENCRYPTION_KEY trong biến môi trường. Hệ thống từ chối sử dụng khóa mặc định cứng.');
  }
  return crypto.createHash('sha256').update(secret.trim()).digest();
};

// Khóa fallback dùng khi kiểm tra chữ ký các token cũ đã phát hành trước khi cấu hình JWT_SECRET
const getFallbackSecretKey = (): Buffer | null => {
  const encKey = process.env.ENCRYPTION_KEY;
  if (encKey && encKey.trim().length > 0 && encKey.trim() !== process.env.JWT_SECRET?.trim()) {
    return crypto.createHash('sha256').update(encKey.trim()).digest();
  }
  return null;
};

export interface AuthCaller {
  uid: string;
  username?: string;
  role: string;
  storeId: string;
  isSuperAdmin: boolean;
  tokenVersion: number;
}

export interface UserAccountStatus {
  exists: boolean;
  tokenVersion: number;
  role: string;
  storeId: string;
  cachedAt: number;
}

// Cache ngắn hạn (TTL 3 giây) để giảm reads Firestore nhưng đảm bảo thu hồi gần như tức thì khi có thay đổi
const userStatusCache = new Map<string, UserAccountStatus>();
const STATUS_CACHE_TTL_MS = 3000;

export function invalidateUserStatusCache(userId?: string) {
  if (userId) {
    userStatusCache.delete(userId);
  } else {
    userStatusCache.clear();
  }
}

export async function getUserAccountStatus(userId: string, forceFresh = false): Promise<UserAccountStatus | null> {
  if (!userId) return null;
  if (userId === 'superadmin') {
    return { exists: true, tokenVersion: 1, role: 'superadmin', storeId: 'superadmin', cachedAt: Date.now() };
  }

  if (!forceFresh) {
    const cached = userStatusCache.get(userId);
    if (cached && (Date.now() - cached.cachedAt < STATUS_CACHE_TTL_MS)) {
      return cached;
    }
  }

  try {
    const [secretDoc, userDoc] = await Promise.all([
      adminDb.collection('user_secrets').doc(userId).get().catch(() => null),
      adminDb.collection('users').doc(userId).get().catch(() => null)
    ]);

    const userExists = Boolean((userDoc && userDoc.exists) || (secretDoc && secretDoc.exists));
    if (!userExists) {
      userStatusCache.set(userId, { exists: false, tokenVersion: 0, role: '', storeId: '', cachedAt: Date.now() });
      return null;
    }

    const secretData = (secretDoc && secretDoc.exists) ? (secretDoc.data() || {}) : {};
    const userData = (userDoc && userDoc.exists) ? (userDoc.data() || {}) : {};

    const tokenVersion = Number(secretData.tokenVersion || userData.tokenVersion || 1);
    const role = String(secretData.role || userData.role || 'order');
    const storeId = String(secretData.storeId || userData.storeId || '');

    const status: UserAccountStatus = {
      exists: true,
      tokenVersion,
      role,
      storeId,
      cachedAt: Date.now()
    };
    userStatusCache.set(userId, status);
    return status;
  } catch (err) {
    console.warn("[Auth] Failed to fetch user account status for revocation check:", err);
    return null;
  }
}

/**
 * Tạo token phiên đăng nhập (Session Token) có chữ ký số bảo mật HMAC-SHA256
 * Thời hạn: 7 ngày, kèm tokenVersion để hỗ trợ thu hồi tức thì khi đổi mật khẩu
 */
export function generateAuthToken(payload: {
  uid: string;
  username: string;
  role: string;
  storeId: string;
  isSuperAdmin?: boolean;
  tokenVersion?: number;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const data = {
    ...payload,
    isSuperAdmin: Boolean(payload.isSuperAdmin || payload.role === 'superadmin'),
    tokenVersion: payload.tokenVersion ? Number(payload.tokenVersion) : 1,
    iat: nowSec,
    exp: nowSec + (7 * 24 * 60 * 60) // 7 ngày
  };
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  const key = getSecretKey();
  const signature = crypto.createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');

  return `${header}.${body}.${signature}`;
}

/**
 * Trích xuất Bearer token từ Request headers hoặc query/body
 */
export function extractBearerToken(req: any): string | null {
  let authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  if (Array.isArray(authHeader)) authHeader = authHeader[0] || '';
  
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  // Fallback từ header x-auth-token
  const xToken = req.headers?.['x-auth-token'];
  if (typeof xToken === 'string' && xToken.trim()) {
    return xToken.trim();
  }

  return null;
}

/**
 * Xác thực token của người gọi API một cách nghiêm ngặt:
 * 1. Kiểm tra chữ ký HMAC-SHA256 & thời hạn hết hạn
 * 2. Xác minh với Firebase ID Token nếu có
 * 3. So khớp tokenVersion và trạng thái tài khoản thời gian thực để THU HỒI TỨC THÌ các phiên cũ
 */
export async function verifyAuthToken(token: string, options?: { forceFresh?: boolean }): Promise<AuthCaller | null> {
  if (!token || typeof token !== 'string') return null;

  // Từ chối tuyệt đối bất kỳ chuỗi token giả lập nào (dev_token)
  if (token.startsWith('dev_token_')) {
    console.warn("[Auth Security] Rejected mock token attempt:", token);
    return null;
  }

  let unverifiedCaller: AuthCaller | null = null;

  // 1. Thử xác thực theo chuẩn HMAC-SHA256 JWT
  const parts = token.split('.');
  if (parts.length === 3) {
    const [header, body, signature] = parts;
    try {
      const key = getSecretKey();
      let isValidSig = false;
      const expectedSig = crypto.createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');

      if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        isValidSig = true;
      } else {
        // Fallback kiểm tra khóa cũ nếu JWT_SECRET vừa được tách riêng khỏi ENCRYPTION_KEY
        const fallbackKey = getFallbackSecretKey();
        if (fallbackKey) {
          const fallbackSig = crypto.createHmac('sha256', fallbackKey).update(`${header}.${body}`).digest('base64url');
          if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(fallbackSig))) {
            isValidSig = true;
          }
        }
      }

      if (isValidSig) {
        const payloadJson = Buffer.from(body, 'base64url').toString('utf8');
        const payload = JSON.parse(payloadJson);

        const nowSec = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < nowSec) {
          console.warn("[Auth] Token expired at:", payload.exp);
          return null;
        }

        if (payload.uid && payload.role) {
          unverifiedCaller = {
            uid: String(payload.uid),
            username: payload.username ? String(payload.username) : undefined,
            role: String(payload.role),
            storeId: String(payload.storeId || ''),
            isSuperAdmin: Boolean(payload.isSuperAdmin || payload.role === 'superadmin'),
            tokenVersion: payload.tokenVersion ? Number(payload.tokenVersion) : 1
          };
        }
      }
    } catch (e: any) {
      if (e.message?.includes('[Security Error]')) {
        console.error(e.message);
        throw e;
      }
    }
  }

  // 2. Thử xác thực với Firebase ID Token thật (CHỈ KHI CÓ SERVICE ACCOUNT HỢP LỆ)
  if (!unverifiedCaller && hasAdminCredential) {
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      if (decoded && decoded.uid) {
        const verifiedRole = decoded.role || (decoded.uid === 'superadmin' ? 'superadmin' : null);
        if (!verifiedRole) {
          console.warn("[Auth Security] Firebase ID token thiếu claim 'role' hợp lệ. Từ chối cấp quyền.");
          return null;
        }

        unverifiedCaller = {
          uid: decoded.uid,
          role: verifiedRole,
          storeId: decoded.storeId || '',
          isSuperAdmin: Boolean(verifiedRole === 'superadmin' || decoded.isSuperAdmin || decoded.uid === 'superadmin'),
          tokenVersion: decoded.tokenVersion ? Number(decoded.tokenVersion) : 1
        };
      }
    } catch (e) {
      return null;
    }
  }

  if (!unverifiedCaller) return null;

  // 3. XÁC MINH TRẠNG THÁI HIỆN TẠI VÀ THU HỒI TOKENVERSION THỜI GIAN THỰC (Zero-Trust Revocation Check)
  if (unverifiedCaller.uid === 'superadmin') {
    const expectedSuperPass = process.env.SUPERADMIN_PASSWORD;
    if (!expectedSuperPass || expectedSuperPass.trim().length === 0) {
      console.warn("[Auth Revocation] SuperAdmin endpoint bị vô hiệu hóa vì thiếu SUPERADMIN_PASSWORD.");
      return null;
    }
    return unverifiedCaller;
  }

  const accountStatus = await getUserAccountStatus(unverifiedCaller.uid, options?.forceFresh);
  if (!accountStatus || !accountStatus.exists) {
    console.warn(`[Auth Revocation] Tài khoản ${unverifiedCaller.uid} không tồn tại hoặc đã bị xóa.`);
    return null;
  }

  const callerVersion = Number(unverifiedCaller.tokenVersion || 1);
  if (callerVersion < accountStatus.tokenVersion) {
    console.warn(`[Auth Revocation] Phiên đăng nhập của tài khoản ${unverifiedCaller.uid} đã bị thu hồi (token v${callerVersion} < server v${accountStatus.tokenVersion}).`);
    return null;
  }

  if (accountStatus.role && unverifiedCaller.role !== accountStatus.role) {
    console.warn(`[Auth Revocation] Vai trò của tài khoản ${unverifiedCaller.uid} đã thay đổi (${unverifiedCaller.role} -> ${accountStatus.role}). Thu hồi token cũ.`);
    return null;
  }

  return {
    ...unverifiedCaller,
    role: accountStatus.role,
    storeId: accountStatus.storeId || unverifiedCaller.storeId,
    tokenVersion: accountStatus.tokenVersion
  };
}

/**
 * Lấy đối tượng caller đã được xác minh danh tính từ Request
 */
export async function getAuthenticatedCaller(req: any, options?: { forceFresh?: boolean }): Promise<AuthCaller | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  return await verifyAuthToken(token, options);
}

