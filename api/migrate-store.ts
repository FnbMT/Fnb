import type { Request, Response } from 'express';
import { getAuthenticatedCaller } from './_token';
import { 
  migrateStoreMenu, 
  migrateStoreInvoices, 
  migrateStoreCash,
  acquireStoreLock,
  releaseStoreLock
} from '../scripts/migrate_legacy_data';
import { backfillStoreDailyStats } from '../scripts/backfill_daily_stats';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Xác thực quyền Admin hoặc SuperAdmin
  const caller = await getAuthenticatedCaller(req);
  if (!caller) {
    return res.status(401).json({ error: 'Phiên làm việc không hợp lệ hoặc đã hết hạn.' });
  }

  const isSuperAdmin = Boolean(caller.isSuperAdmin || caller.role === 'superadmin');
  const isStoreAdmin = caller.role === 'admin' || caller.role === 'manager';

  if (!isSuperAdmin && !isStoreAdmin) {
    return res.status(403).json({ error: 'Bạn không có quyền thực hiện migration cửa hàng.' });
  }

  const targetStoreId = isSuperAdmin ? (req.body.storeId || caller.storeId) : caller.storeId;
  if (!targetStoreId) {
    return res.status(400).json({ error: 'Thiếu storeId cần migration.' });
  }

  const {
    dryRun = false,
    forceRerun = false,
    startDate,
    endDate,
    skipMenu = false,
    skipInvoices = false,
    skipCash = false,
    skipBackfill = false
  } = req.body || {};

  // 2. Khóa tác vụ (Job Lock) để ngăn 2 migration chạy đồng thời trên cùng 1 cửa hàng
  const lockAcquired = await acquireStoreLock(targetStoreId);
  if (!lockAcquired) {
    return res.status(409).json({
      error: 'Cửa hàng đang có tiến trình migration hoặc đối soát đang chạy. Vui lòng thử lại sau.'
    });
  }

  try {
    console.log(`[API /api/migrate-store] Bắt đầu an toàn cho storeId: ${targetStoreId} (dryRun: ${dryRun}, forceRerun: ${forceRerun})`);

    let menuResult = null;
    let invoicesResult = null;
    let cashResult = null;
    let backfillResult = null;

    // Bước 1: Chuẩn hóa phân loại Menu
    if (!skipMenu) {
      menuResult = await migrateStoreMenu(targetStoreId, { dryRun, forceRerun });
    }

    // Bước 2: Chuẩn hóa Hóa đơn (businessDate & COGS snapshot)
    if (!skipInvoices) {
      invoicesResult = await migrateStoreInvoices(targetStoreId, { dryRun, forceRerun });
    }

    // Bước 3: Chuẩn hóa Sổ quỹ (businessDate & phân loại)
    if (!skipCash) {
      cashResult = await migrateStoreCash(targetStoreId, { dryRun, forceRerun });
    }

    // Bước 4: Đối soát và tổng hợp daily_stats (Cutoff bảo vệ giờ kinh doanh)
    if (!skipBackfill) {
      backfillResult = await backfillStoreDailyStats(targetStoreId, { startDate, endDate, dryRun });
    }

    return res.status(200).json({
      success: true,
      storeId: targetStoreId,
      dryRun,
      menu: menuResult,
      invoices: invoicesResult,
      cash: cashResult,
      backfill: backfillResult,
      message: dryRun 
        ? 'Chạy thử nghiệm (dry-run) thành công. Không có dữ liệu nào bị ghi đè.'
        : backfillResult?.skippedChangedDays?.length
          ? `Đã bỏ qua ${backfillResult.skippedChangedDays.length} ngày có chứng từ thay đổi trong lúc đối soát. Vui lòng chạy lại các ngày đó.`
          : 'Đã hoàn tất chuẩn hóa và đối soát các ngày được chọn. Giá vốn ước tính vẫn được giữ nhãn ước tính.'
    });
  } catch (err: any) {
    console.error('[API /api/migrate-store] Lỗi:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Lỗi server trong quá trình migration.'
    });
  } finally {
    // Luôn giải phóng khóa tác vụ
    await releaseStoreLock(targetStoreId, lockAcquired);
  }
}
