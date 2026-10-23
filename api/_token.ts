import crypto from 'node:crypto';
import { adminAuth, hasAdminCredential } from './_firebaseAdmin';

// Khóa bí mật dùng để ký và xác thực token JWT HMAC-SHA256
const getSecretKey = (): Buffer => {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'fnb_master_secure_encryption_key_2026_default_salt!';
  return crypto.createHash('sha256').update(secret).digest();
};

export interface AuthCaller {
  uid: string;
  username?: string;
  role: string;
  storeId: string;
  isSuperAdmin: boolean;
}

/**
 * Tạo token phiên đăng nhập (Session Token) có chữ ký số bảo mật HMAC-SHA256
 * Thời hạn: 7 ngày
 */
export function generateAuthToken(payload: {
  uid: string;
  username: string;
  role: string;
  storeId: string;
  isSuperAdmin?: boolean;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const data = {
    ...payload,
    isSuperAdmin: Boolean(payload.isSuperAdmin || payload.role === 'superadmin'),
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
 * Tuyệt đối KHÔNG chấp nhận các token giả mạo hoặc chuỗi cứng
 */
export async function verifyAuthToken(token: string): Promise<AuthCaller | null> {
  if (!token || typeof token !== 'string') return null;

  // 1. Thử xác thực theo chuẩn HMAC-SHA256 JWT
  const parts = token.split('.');
  if (parts.length === 3) {
    const [header, body, signature] = parts;
    try {
      const key = getSecretKey();
      const expectedSig = crypto.createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');

      if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        const payloadJson = Buffer.from(body, 'base64url').toString('utf8');
        const payload = JSON.parse(payloadJson);

        const nowSec = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < nowSec) {
          console.warn("[Auth] Token expired at:", payload.exp);
          return null;
        }

        if (payload.uid && payload.role) {
          return {
            uid: String(payload.uid),
            username: payload.username ? String(payload.username) : undefined,
            role: String(payload.role),
            storeId: String(payload.storeId || ''),
            isSuperAdmin: Boolean(payload.isSuperAdmin || payload.role === 'superadmin')
          };
        }
      }
    } catch (e) {
      // Signature error or JSON parse error
    }
  }

  // 2. Thử xác thực với Firebase ID Token thật (nếu có service account)
  if (hasAdminCredential) {
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      if (decoded && decoded.uid) {
        return {
          uid: decoded.uid,
          role: decoded.role || (decoded.uid === 'superadmin' ? 'superadmin' : 'admin'),
          storeId: decoded.storeId || '',
          isSuperAdmin: Boolean(decoded.role === 'superadmin' || decoded.isSuperAdmin || decoded.uid === 'superadmin')
        };
      }
    } catch (e) {
      // Firebase ID token invalid
    }
  }

  return null;
}

/**
 * Lấy đối tượng caller đã được xác minh danh tính từ Request
 */
export async function getAuthenticatedCaller(req: any): Promise<AuthCaller | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  return await verifyAuthToken(token);
}
