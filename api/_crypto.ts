import crypto from 'node:crypto';

// 32-byte key derived from environment or secure fallback
const getSecretKey = (): Buffer => {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'fnb_master_secure_encryption_key_2026_default_salt!';
  return crypto.createHash('sha256').update(secret).digest();
};

/**
 * Băm mật khẩu một chiều bằng crypto.scrypt an toàn (chuẩn OWASP)
 * Định dạng lưu trữ: saltHex:hashHex
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password.trim(), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Kiểm tra mật khẩu đối chiếu với chuỗi hash saltHex:hashHex
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 2) return false;
    const [salt, originalHash] = parts;
    const computedHash = crypto.scryptSync(password.trim(), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(originalHash, 'hex'));
  } catch (e) {
    return false;
  }
}

/**
 * Mã hóa hai chiều AES-256-GCM (Chỉ dùng cho tài khoản Admin của quán để Superadmin có thể hỗ trợ xem lại)
 * Định dạng: ivHex:authTagHex:encryptedHex
 */
export function encryptAes(plainText: string): string {
  const key = getSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(plainText.trim(), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Giải mã chuỗi AES-256-GCM
 */
export function decryptAes(cipherText: string): string | null {
  try {
    const parts = cipherText.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, authTagHex, encrypted] = parts;
    
    const key = getSecretKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}
