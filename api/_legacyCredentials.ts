import crypto from 'node:crypto';
import { decryptAes, verifyPassword } from './_crypto.js';

type StoredCredential = {
  passwordHash?: unknown;
  clientHash?: unknown;
  encryptedPassword?: unknown;
};

export function hasStoredCredential(data: StoredCredential | undefined): boolean {
  return [data?.passwordHash, data?.clientHash, data?.encryptedPassword]
    .some(value => typeof value === 'string' && value.length > 0);
}

export function verifyStoredCredential(password: string, data: StoredCredential): boolean {
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  if (typeof data.passwordHash === 'string' && data.passwordHash) {
    if (data.passwordHash.includes(':')) return verifyPassword(password, data.passwordHash);
    return /^[a-f\d]{64}$/i.test(data.passwordHash) ? hash === data.passwordHash.toLowerCase() : password === data.passwordHash;
  }
  if (typeof data.clientHash === 'string' && data.clientHash) return hash === data.clientHash.toLowerCase();
  if (typeof data.encryptedPassword !== 'string' || !data.encryptedPassword) return false;
  try { return decryptAes(data.encryptedPassword) === password; }
  catch { return false; }
}

export function verifyLegacyUserPassword(password: string, stored: unknown): boolean {
  if (typeof stored !== 'string' || !stored.trim()) return false;
  const value = stored.trim();
  return /^[a-f\d]{64}$/i.test(value)
    ? crypto.createHash('sha256').update(password).digest('hex') === value.toLowerCase()
    : password === value;
}
