export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const hasEncKey = Boolean(process.env.DATA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY);
  const hasJwtSec = Boolean(process.env.JWT_SECRET);
  const superPass = process.env.SUPERADMIN_PASSWORD || '';
  const hasSuperPass = Boolean(superPass && superPass.trim().length > 0);
  const superUser = process.env.SUPERADMIN_USERNAME || 'superadmin';

  let firebaseAdminInfo: any = {
    configured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT),
    initialized: false,
    error: null
  };

  try {
    const { getAdminStatus } = await import('./_firebaseAdmin');
    const status = getAdminStatus();
    firebaseAdminInfo.initialized = status.isInitialized;
    firebaseAdminInfo.hasCredential = status.hasCredential;
  } catch (adminErr: any) {
    firebaseAdminInfo.error = adminErr?.message || String(adminErr);
  }

  return res.status(200).json({
    status: 'ok',
    version: '1.0.4',
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    checks: {
      encryptionKey: hasEncKey,
      jwtSecret: hasJwtSec,
      superadminConfigured: hasSuperPass,
      superadminUsername: superUser,
      superadminPasswordLength: superPass.trim().length,
      firebaseAdmin: firebaseAdminInfo
    },
    message: hasSuperPass 
      ? 'Hệ thống máy chủ backend Vercel hoạt động bình thường.' 
      : 'Cảnh báo: SUPERADMIN_PASSWORD chưa có giá trị trên Vercel.'
  });
}
