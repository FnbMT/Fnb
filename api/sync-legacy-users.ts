import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { adminDb } from './_firebaseAdmin.js';
import { decryptAes } from './_crypto.js';

// Danh sách các mật khẩu đã được đối chiếu & xác thực chính xác
const KNOWN_PASSWORDS: Record<string, string> = {
  'PZZaNw7A86cHKvi7mbwx': 'admin123', // luontv37 - admin
  'AW6kwGv4W355hzNtLrcl': '12345678', // luontv37 - anh
  '3rKDpckHG17pUnDDHezD': '12345678', // luontv37 - yen
  'VZocDIBTGYlL4IOio9Nl': '12345678', // luontv37 - nv1
  'WTyIIojpiahCIVTD8JbT': '12345678', // luontv - admin
  'BL07RnyA0PiXQoI9wNlv': '12345678', // luontv - huy123
  'niaklGiEJ9rCC8qhbfeu': '12345678', // luontv - nvt
  'oQGxb2iiHxVpjvTJfF2j': '12345678', // luontv - huy1
  'Ud5KwzrbN5S9tLQXpQFP': '12345678', // minhnhat - 0398382189
  '7dWv97jorrCe345caRgY': '12345678', // minhnhat - nv1
  'SQjhbsy9JQGgayzsmaQV': 'admin123', // trungnguyen37 - 0989999777
  'z59ae0wUIHNjUx5msQCu': '12345678', // luondaklak - 0946075835
  'R7Yf7uMchpanEgm40JXm': '12345678', // luondaklak - nv
  'oc8Ts2GTGopIcjLmzejw': '12345678', // luonbd - 0973515932
};

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const secretKey = req.query.key || req.body?.key;
  const validKey = process.env.DATA_ENCRYPTION_KEY || 'fnb_master_secure_encryption_key_2026_default_salt!';

  if (secretKey !== validKey) {
    return res.status(403).json({ error: 'Mã xác thực nội bộ không hợp lệ' });
  }

  try {
    const usersSnap = await adminDb.collection('users').get();
    const results: any[] = [];

    for (const u of usersSnap.docs) {
      const data = u.data();
      const userId = u.id;
      let finalPassword = data.password || KNOWN_PASSWORDS[userId] || null;

      // Thử giải mã nếu tài khoản chưa có password và có encryptedPassword
      if (!finalPassword) {
        try {
          const secDoc = await adminDb.collection('user_secrets').doc(userId).get();
          if (secDoc.exists && secDoc.data().encryptedPassword) {
            finalPassword = decryptAes(secDoc.data().encryptedPassword);
          }
        } catch (_) {}
      }

      if (!finalPassword) {
        try {
          const sysDoc = await adminDb.collection('system').doc(`user_secret_${userId}`).get();
          if (sysDoc.exists && sysDoc.data().encryptedPassword) {
            finalPassword = decryptAes(sysDoc.data().encryptedPassword);
          }
        } catch (_) {}
      }

      if (!finalPassword) {
        finalPassword = '12345678'; // Mật khẩu mặc định phổ biến của hệ thống
      }

      const clientHash = crypto.createHash('sha256').update(finalPassword).digest('hex');

      // 1. Phục hồi vào users doc
      await adminDb.collection('users').doc(userId).update({
        password: finalPassword
      });

      // 2. Đồng bộ vào system/user_secret_${userId}
      await adminDb.collection('system').doc(`user_secret_${userId}`).set({
        userId,
        storeId: data.storeId,
        role: data.role || 'order',
        clientHash,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      results.push({
        id: userId,
        username: data.username,
        storeId: data.storeId,
        hasPassword: true,
        clientHash
      });
    }

    return res.status(200).json({
      success: true,
      message: `Đã đồng bộ thành công ${results.length} người dùng cho thiết bị iOS & Android cũ`,
      syncedUsers: results
    });
  } catch (error: any) {
    console.error("Sync error:", error);
    return res.status(500).json({ error: error?.message || 'Lỗi server khi đồng bộ' });
  }
}
