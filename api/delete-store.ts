import type { Request, Response } from 'express';
import { adminDb } from './_firebaseAdmin';
import { getAuthenticatedCaller, invalidateUserStatusCache } from './_token';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Xác thực danh tính caller
  const caller = await getAuthenticatedCaller(req);
  if (!caller) {
    return res.status(401).json({
      error: 'Yêu cầu đăng nhập: Phiên làm việc không hợp lệ hoặc đã hết hạn.'
    });
  }

  const { storeId } = req.body || {};
  if (!storeId) {
    return res.status(400).json({ error: 'Vui lòng cung cấp mã cửa hàng (storeId) cần xóa' });
  }

  const cleanStoreId = String(storeId).trim();

  // 2. Phân quyền: Chỉ SuperAdmin hoặc Admin chính chủ của storeId mới được xóa
  const isSuperAdmin = Boolean(caller.isSuperAdmin || caller.role === 'superadmin');
  const isStoreAdmin = caller.role === 'admin' && String(caller.storeId || '').trim() === cleanStoreId;

  if (!isSuperAdmin && !isStoreAdmin) {
    return res.status(403).json({
      error: 'Từ chối quyền truy cập: Bạn không có quyền xóa cửa hàng này.'
    });
  }

  try {
    const collectionsToClean = [
      'users',
      'menu',
      'tables',
      'table_groups',
      'invoices',
      'inventory_logs',
      'inventory_audits',
      'stock_card',
      'customers',
      'cash_transactions',
      'settings',
      'attendance_records',
      'payroll_records',
      'shifts',
      'daily_stats'
    ];

    let totalDeleted = 0;

    // Xóa tất cả tài liệu thuộc storeId trong từng collection
    for (const colName of collectionsToClean) {
      const snap = await adminDb.collection(colName).where('storeId', '==', cleanStoreId).get();
      if (!snap.empty) {
        // Dùng batch tối đa 400 docs mỗi lần
        const docs = snap.docs;
        for (let i = 0; i < docs.length; i += 400) {
          const batch = adminDb.batch();
          const chunk = docs.slice(i, i + 400);
          for (const doc of chunk) {
            batch.delete(doc.ref);
            // Nếu là collection users, xóa kèm secret trong user_secrets và xóa cache phiên
            if (colName === 'users') {
              batch.delete(adminDb.collection('user_secrets').doc(doc.id));
              invalidateUserStatusCache(doc.id);
            }
          }
          await batch.commit();
          totalDeleted += chunk.length;
        }
      }
    }

    // Xóa document cửa hàng trong stores
    const storeDocRef = adminDb.collection('stores').doc(cleanStoreId);
    await storeDocRef.delete();
    totalDeleted++;

    return res.status(200).json({
      success: true,
      message: `Đã xóa toàn bộ cửa hàng và ${totalDeleted} bản ghi liên quan thành công.`
    });
  } catch (error: any) {
    console.error("Delete store error:", error);
    return res.status(500).json({ error: 'Lỗi máy chủ khi xóa cửa hàng: ' + error.message });
  }
}
