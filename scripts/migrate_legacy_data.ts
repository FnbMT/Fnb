import { adminDb } from '../api/_firebaseAdmin';
import { randomUUID } from 'node:crypto';

export function getVietnamBusinessDate(dateStr?: string | Date): string {
  try {
    const d = dateStr ? (typeof dateStr === 'string' ? new Date(dateStr) : dateStr) : new Date();
    if (isNaN(d.getTime())) {
      const now = new Date();
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(now);
    }
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function classifyMenuItem(item: any, recipeIngredientIds: Set<string>): boolean {
  const nameLower = (item.name || '').toLowerCase().trim();
  const codeUpper = (item.code || '').toUpperCase().trim();
  const categoryLower = (item.category || '').toLowerCase().trim();
  const price = Number(item.price) || 0;

  // 1. Phân loại theo quy ước nguyên liệu: _nl, NL_, hoặc category 'Nguyên liệu' với giá bán 0
  if (nameLower.endsWith('_nl') || codeUpper.startsWith('NL') || categoryLower === 'nguyên liệu') {
    if (price <= 0) return true;
  }

  // 2. Nằm trong công thức định lượng (recipe) của món khác và không có giá bán lẻ
  if (recipeIngredientIds.has(item.id) && price <= 0) {
    return true;
  }

  // 3. Món ăn / đồ uống pha chế (dish) hoặc hàng hóa bán lẻ trực tiếp (price > 0)
  if (item.type === 'dish') {
    return false;
  }

  if (price > 0 && categoryLower !== 'nguyên liệu') {
    return false;
  }

  // 4. Giá trị cờ đã có nếu hợp lệ
  if (typeof item.isInventory === 'boolean') {
    return item.isInventory;
  }

  // 5. Nếu giá bán = 0 và có giá vốn > 0 -> nguyên liệu kho
  if (price <= 0 && (Number(item.costPrice) || 0) > 0) {
    return true;
  }

  return false;
}

export function calculateInvoiceCost(items: any[]): { totalCost: number; hasEstimated: boolean } {
  if (!items || !Array.isArray(items)) return { totalCost: 0, hasEstimated: false };
  // Reconstructing a legacy cost cannot certify historical ingredient/add-on prices.
  let hasEstimated = items.length > 0;

  const totalCost = items.reduce((sum, item) => {
    const costPrice = Number(item.costPrice);
    const hasValidCost = typeof item.costPrice === 'number' && costPrice > 0;
    const hasRecipe = Array.isArray(item.recipe) && item.recipe.length > 0;

    if (!hasValidCost && !hasRecipe) {
      hasEstimated = true;
    }

    const itemCost = (hasValidCost ? costPrice : 0) * (Number(item.quantity) || 1);
    const addOnsCost = (item.selectedAddOns || []).reduce((aSum: number, a: any) => {
      const unitCost = Number(a.costPrice) || 0;
      const qtyPerServing = (typeof a.quantity === 'number' && a.quantity > 0) ? a.quantity : 1;
      return aSum + (unitCost * qtyPerServing * (Number(item.quantity) || 1));
    }, 0);
    return sum + itemCost + addOnsCost;
  }, 0);

  return { totalCost, hasEstimated };
}

export interface MigrationOptions {
  dryRun?: boolean;
  forceRerun?: boolean;
}

// 1. Migrate Menu cho một cửa hàng: 1-PASS READ OPTIMIZATION & CHECKPOINT RESUME
export async function migrateStoreMenu(storeId: string, options: MigrationOptions = {}) {
  console.log(`\n=== [MENU] Bắt đầu migration Menu cho storeId: ${storeId} ===`);
  const checkpointDocRef = adminDb.doc(`migration_checkpoints/${storeId}_menu`);

  // Kiểm tra checkpoint
  if (!options.forceRerun) {
    const cpSnap = await checkpointDocRef.get();
    if (cpSnap.exists) {
      const cpData = cpSnap.data();
      if (cpData.status === 'completed') {
        console.log(`[MENU] Store ${storeId} đã hoàn tất migration Menu trước đó vào ${cpData.updatedAt}. Bỏ qua.`);
        return { totalProcessed: cpData.totalProcessed || 0, totalUpdated: cpData.totalUpdated || 0, alreadyCompleted: true };
      }
    }
  }

  // TỐI ƯU 1-PASS: Đọc toàn bộ menu của quán đúng 1 lần duy nhất (1x reads, thay vì 2x reads)
  const menuSnap = await adminDb.collection('menu').where('storeId', '==', storeId).get();
  const allItems = menuSnap.docs.map((d: any) => ({ ...d.data(), id: d.id }));
  const totalProcessed = allItems.length;

  // Thu thập recipe ingredient IDs trong bộ nhớ (0 lượt đọc Firestore phát sinh)
  const recipeIngredientIds = new Set<string>();
  allItems.forEach((item: any) => {
    if (item.recipe && Array.isArray(item.recipe)) {
      item.recipe.forEach((r: any) => {
        if (r.ingredientId) recipeIngredientIds.add(r.ingredientId);
      });
    }
  });

  const updatesToApply: Array<{ id: string; shouldBeInventory: boolean }> = [];
  allItems.forEach((item: any) => {
    const shouldBeInventory = classifyMenuItem(item, recipeIngredientIds);
    if (item.isInventory !== shouldBeInventory) {
      updatesToApply.push({ id: item.id, shouldBeInventory });
    }
  });

  const totalUpdated = updatesToApply.length;
  console.log(`[MENU] Tìm thấy ${totalProcessed} món, cần cập nhật cờ kho cho ${totalUpdated} món.`);

  if (!options.dryRun && totalUpdated > 0) {
    for (let i = 0; i < updatesToApply.length; i += 400) {
      const chunk = updatesToApply.slice(i, i + 400);
      const batch = adminDb.batch();
      chunk.forEach(u => {
        batch.update(adminDb.doc(`menu/${u.id}`), {
          isInventory: u.shouldBeInventory,
          updatedAt: new Date().toISOString()
        });
      });
      await batch.commit();
      console.log(`[MENU] Đã commit ${chunk.length} món (${i + chunk.length}/${totalUpdated}).`);
    }
  }

  if (!options.dryRun) {
    await checkpointDocRef.set({
      storeId,
      totalProcessed,
      totalUpdated,
      updatedAt: new Date().toISOString(),
      status: 'completed'
    }, { merge: true });

    try {
      await adminDb.doc(`stores/${storeId}`).update({
        'migrationStatus.menu': 'completed',
        'migrationStatus.menuMigratedAt': new Date().toISOString(),
        'migrationStatus.menuTotal': totalProcessed
      });
    } catch (storeErr) {
      console.warn('[MENU] Cập nhật migrationStatus trên store bị bỏ qua nếu store doc chưa tồn tại:', storeErr);
    }
  }

  return { totalProcessed, totalUpdated, dryRun: options.dryRun };
}

// 2. Migrate Hóa đơn: CURSOR PAGINATION, CHECKPOINT RESUME & COST SANITIZATION
export async function migrateStoreInvoices(storeId: string, options: MigrationOptions = {}) {
  console.log(`\n=== [INVOICES] Bắt đầu migration Hóa đơn cho storeId: ${storeId} ===`);
  const checkpointDocRef = adminDb.doc(`migration_checkpoints/${storeId}_invoices`);

  let lastDocId: string | null = null;
  let totalProcessed = 0;
  let totalUpdated = 0;

  // Kiểm tra checkpoint để resume thực sự
  if (!options.forceRerun) {
    const cpSnap = await checkpointDocRef.get();
    if (cpSnap.exists) {
      const cpData = cpSnap.data();
      if (cpData.status === 'completed') {
        console.log(`[INVOICES] Store ${storeId} đã hoàn tất migration Hóa đơn trước đó. Bỏ qua.`);
        return { totalProcessed: cpData.totalProcessed || 0, totalUpdated: cpData.totalUpdated || 0, alreadyCompleted: true };
      }
      if (cpData.status === 'in_progress' && cpData.lastDocId) {
        lastDocId = cpData.lastDocId;
        totalProcessed = cpData.totalProcessed || 0;
        totalUpdated = cpData.totalUpdated || 0;
        console.log(`[INVOICES] Phục hồi từ checkpoint tại document: ${lastDocId} (đã xử lý ${totalProcessed} đơn).`);
      }
    }
  }

  let hasMore = true;
  const BATCH_SIZE = 200;

  while (hasMore) {
    let q = adminDb.collection('invoices')
      .where('storeId', '==', storeId)
      .orderBy('__name__')
      .limit(BATCH_SIZE);

    if (lastDocId) {
      q = q.startAfter(lastDocId);
    }

    const snap = await q.get();
    if (snap.empty) {
      hasMore = false;
      break;
    }

    const batch = adminDb.batch();
    let batchChanges = 0;

    snap.docs.forEach((docSnap: any) => {
      totalProcessed++;
      const inv = docSnap.data();
      const updates: Record<string, any> = {};

      if(!inv.businessDate && (!inv.date || !Number.isFinite(Date.parse(inv.date)))) throw new Error(`Hóa đơn ${docSnap.id} thiếu ngày hợp lệ; không tự gán ngày hôm nay.`);
      const vnDate = inv.businessDate || getVietnamBusinessDate(inv.date);
      if (!inv.businessDate) updates.businessDate = vnDate;
      if (!inv.businessMonth) updates.businessMonth = vnDate.slice(0, 7);
      if (!inv.businessYear) updates.businessYear = parseInt(vnDate.slice(0, 4), 10);

      if (typeof inv.totalCost !== 'number') {
        const { totalCost, hasEstimated } = calculateInvoiceCost(inv.items || []);
        updates.totalCost = totalCost;
        updates.costVersion = 1;
        if (hasEstimated) {
          updates.costStatus = 'estimated';
        }
      }

      if (Object.keys(updates).length > 0) {
        if (!options.dryRun) {
          batch.update(adminDb.doc(`invoices/${docSnap.id}`), updates);
        }
        batchChanges++;
        totalUpdated++;
      }
    });

    if (!options.dryRun && batchChanges > 0) {
      await batch.commit();
      console.log(`[INVOICES] Batch commit thành công: ${batchChanges} hóa đơn cập nhật.`);
    }

    lastDocId = snap.docs[snap.docs.length - 1].id;

    if (!options.dryRun) {
      await checkpointDocRef.set({
        storeId,
        totalProcessed,
        totalUpdated,
        lastDocId,
        updatedAt: new Date().toISOString(),
        status: snap.docs.length < BATCH_SIZE ? 'completed' : 'in_progress'
      }, { merge: true });
    }

    if (snap.docs.length < BATCH_SIZE) {
      hasMore = false;
    }
  }

  if (!options.dryRun) {
    try {
      await adminDb.doc(`stores/${storeId}`).update({
        'migrationStatus.invoices': 'completed',
        'migrationStatus.invoicesMigratedAt': new Date().toISOString(),
        'migrationStatus.invoicesTotal': totalProcessed
      });
    } catch (storeErr) {
      console.warn('[INVOICES] Cập nhật migrationStatus invoices:', storeErr);
    }
  }

  console.log(`[INVOICES] Hoàn tất migration Hóa đơn: ${totalProcessed} kiểm tra, ${totalUpdated} cập nhật.`);
  return { totalProcessed, totalUpdated, dryRun: options.dryRun };
}

// 3. Migrate Sổ quỹ: CURSOR PAGINATION & CHECKPOINT RESUME
export async function migrateStoreCash(storeId: string, options: MigrationOptions = {}) {
  console.log(`\n=== [CASH] Bắt đầu migration Sổ quỹ cho storeId: ${storeId} ===`);
  const checkpointDocRef = adminDb.doc(`migration_checkpoints/${storeId}_cash`);

  let lastDocId: string | null = null;
  let totalProcessed = 0;
  let totalUpdated = 0;

  if (!options.forceRerun) {
    const cpSnap = await checkpointDocRef.get();
    if (cpSnap.exists) {
      const cpData = cpSnap.data();
      if (cpData.status === 'completed') {
        console.log(`[CASH] Store ${storeId} đã hoàn tất migration Sổ quỹ trước đó. Bỏ qua.`);
        return { totalProcessed: cpData.totalProcessed || 0, totalUpdated: cpData.totalUpdated || 0, alreadyCompleted: true };
      }
      if (cpData.status === 'in_progress' && cpData.lastDocId) {
        lastDocId = cpData.lastDocId;
        totalProcessed = cpData.totalProcessed || 0;
        totalUpdated = cpData.totalUpdated || 0;
        console.log(`[CASH] Phục hồi từ checkpoint tại document: ${lastDocId}.`);
      }
    }
  }

  let hasMore = true;
  const BATCH_SIZE = 200;

  while (hasMore) {
    let q = adminDb.collection('cash_transactions')
      .where('storeId', '==', storeId)
      .orderBy('__name__')
      .limit(BATCH_SIZE);

    if (lastDocId) {
      q = q.startAfter(lastDocId);
    }

    const snap = await q.get();
    if (snap.empty) {
      hasMore = false;
      break;
    }

    const batch = adminDb.batch();
    let batchChanges = 0;

    snap.docs.forEach((docSnap: any) => {
      totalProcessed++;
      const tx = docSnap.data();
      const updates: Record<string, any> = {};

      const vnDate = tx.businessDate || getVietnamBusinessDate(tx.date || new Date().toISOString());
      if (!tx.businessDate) updates.businessDate = vnDate;
      if (!tx.businessMonth) updates.businessMonth = vnDate.slice(0, 7);
      if (!tx.businessYear) updates.businessYear = parseInt(vnDate.slice(0, 4), 10);

      if (Object.keys(updates).length > 0) {
        if (!options.dryRun) {
          batch.update(adminDb.doc(`cash_transactions/${docSnap.id}`), updates);
        }
        batchChanges++;
        totalUpdated++;
      }
    });

    if (!options.dryRun && batchChanges > 0) {
      await batch.commit();
      console.log(`[CASH] Batch commit sổ quỹ thành công: ${batchChanges} giao dịch cập nhật.`);
    }

    lastDocId = snap.docs[snap.docs.length - 1].id;

    if (!options.dryRun) {
      await checkpointDocRef.set({
        storeId,
        totalProcessed,
        totalUpdated,
        lastDocId,
        updatedAt: new Date().toISOString(),
        status: snap.docs.length < BATCH_SIZE ? 'completed' : 'in_progress'
      }, { merge: true });
    }

    if (snap.docs.length < BATCH_SIZE) {
      hasMore = false;
    }
  }

  if (!options.dryRun) {
    try {
      await adminDb.doc(`stores/${storeId}`).update({
        'migrationStatus.cash': 'completed',
        'migrationStatus.cashMigratedAt': new Date().toISOString(),
        'migrationStatus.cashTotal': totalProcessed
      });
    } catch (storeErr) {
      console.warn('[CASH] Cập nhật migrationStatus cash:', storeErr);
    }
  }

  console.log(`[CASH] Hoàn tất migration Sổ quỹ: ${totalProcessed} kiểm tra, ${totalUpdated} cập nhật.`);
  return { totalProcessed, totalUpdated, dryRun: options.dryRun };
}

// Khóa tác vụ theo quán để đảm bảo an toàn tuyệt đối
export async function acquireStoreLock(storeId: string): Promise<string | null> {
  const ref=adminDb.doc(`migration_locks/${storeId}`),token=randomUUID();
  return adminDb.runTransaction(async txn=>{
    const snap=await txn.get(ref),data=snap.data();
    if(data&&Date.now()-Date.parse(data.lockedAt||'')<15*60*1000)return null;
    txn.set(ref,{storeId,lockedAt:new Date().toISOString(),lockedBy:'migration_job',token});
    return token;
  });
}
export async function releaseStoreLock(storeId: string, token: string) {
  const ref=adminDb.doc(`migration_locks/${storeId}`);
  await adminDb.runTransaction(async txn=>{
    const snap=await txn.get(ref);
    if(snap.exists&&snap.data()?.token===token)txn.delete(ref);
  });
}
