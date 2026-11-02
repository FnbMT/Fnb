import type { Request, Response } from 'express';
import { getAdminStatus } from './_firebaseAdmin';

export default function handler(req: any, res: any) {
  const hasEncKey = Boolean(process.env.DATA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY);
  const hasJwtSec = Boolean(process.env.JWT_SECRET);
  const hasSuperPass = Boolean(process.env.SUPERADMIN_PASSWORD && process.env.SUPERADMIN_PASSWORD.trim().length > 0);
  const adminStatus = getAdminStatus();

  const isReady = hasEncKey && hasJwtSec;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  return res.status(200).json({
    status: isReady ? 'ok' : 'degraded',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    checks: {
      encryptionKey: hasEncKey,
      jwtSecret: hasJwtSec,
      superadminConfigured: hasSuperPass,
      firebaseAdmin: adminStatus.hasCredential
    },
    message: hasSuperPass 
      ? 'Hệ thống bảo mật sẵn sàng.' 
      : 'Cảnh báo: SUPERADMIN_PASSWORD chưa được cấu hình trong Environment Variables.'
  });
}
