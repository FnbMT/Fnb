import { handleCors } from './_cors.js';
import type { Request, Response } from 'express';
import { adminDb, hasAdminCredential, safeDeleteSentinel } from './_firebaseAdmin.js';
import { encryptAes, hashPassword } from './_crypto.js';
import { hasStoredCredential, verifyStoredCredential } from './_legacyCredentials.js';
import { getAuthenticatedCaller } from './_token.js';

// Explicit, store-scoped migration of verified credentials to the server-only collection.
// A dry run is the default. Conflicting credentials remain available for an authorized reset.
export default async function handler(req: Request, res: Response) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Chỉ hỗ trợ POST.' });
  try {
    const caller = await getAuthenticatedCaller(req, { forceFresh: true });
    if (!caller?.isSuperAdmin || caller.uid !== 'superadmin' || caller.role !== 'superadmin') return res.status(403).json({ error: 'Yêu cầu quyền quản trị hệ thống.' });
    if (!hasAdminCredential) return res.status(503).json({ error: 'Cần xác thực máy chủ Firebase.' });
    const storeId = typeof req.body?.storeId === 'string' ? req.body.storeId.trim() : '';
    if (!storeId || storeId.includes('/')) return res.status(400).json({ error: 'Vui lòng chọn cửa hàng.' });
    const storeRef = adminDb.collection('stores').doc(storeId);
    if (!(await storeRef.get()).exists) return res.status(404).json({ error: 'Cửa hàng không tồn tại.' });
    const dryRun = req.body?.dryRun !== false;
    const snapshots = await adminDb.collection('users').where('storeId', '==', storeId).get();
    const skipped: { id: string; reason: string }[] = [];
    let eligible = 0;
    for (const snapshot of snapshots.docs) {
      if (!('password' in snapshot.data())) continue;
      try {
        const migrated = await adminDb.runTransaction(async txn => {
          const ref = adminDb.collection('users').doc(snapshot.id);
          const profile = (await txn.get(ref)).data();
          if (!profile || !('password' in profile)) return false;
          if (profile.storeId !== storeId) throw new Error('Tài khoản đã đổi cửa hàng.');
          const password = typeof profile.password === 'string' ? profile.password.trim() : '';
          const secretRef = adminDb.collection('user_secrets').doc(snapshot.id);
          const secret = (await txn.get(secretRef)).data();
          let stored = secret;
          if (!hasStoredCredential(stored)) {
            stored = (await txn.get(adminDb.collection('system').doc(`user_secret_${snapshot.id}`))).data();
          }
          if (!password || /^[a-f\d]{64}$/i.test(password)
            || (hasStoredCredential(stored) && !verifyStoredCredential(password, stored!))) {
            throw new Error('Thông tin mật khẩu cũ không khớp. Cần đặt lại mật khẩu từ chức năng quản trị.');
          }
          const version = Math.max(Number(profile.tokenVersion ?? 1), Number(secret?.tokenVersion ?? 1), Number(stored?.tokenVersion ?? 1));
          if (!Number.isSafeInteger(version) || version < 1) throw new Error('Phiên bản tài khoản không hợp lệ.');
          if (!dryRun) {
            txn.set(secretRef, {
              userId: snapshot.id, storeId, role: profile.role,
              passwordHash: hashPassword(password), tokenVersion: version,
              ...(profile.role === 'admin' ? { encryptedPassword: encryptAes(password) } : {}),
              updatedAt: new Date().toISOString(),
            }, { merge: true });
            txn.update(ref, { password: safeDeleteSentinel(), tokenVersion: version });
          }
          return true;
        });
        if (migrated) eligible++;
      } catch (error) {
        skipped.push({ id: snapshot.id, reason: error instanceof Error ? error.message : 'Chưa chuyển được thông tin xác thực.' });
      }
    }
    const settings = await adminDb.collection('settings').where('storeId', '==', storeId).get();
    const settingsWithLegacyPassword: string[] = [];
    for (const row of settings.docs) {
      const data = row.data();
      if (!('adminPassword' in data)) continue;
      const admins = snapshots.docs.filter(profile => profile.data().role === 'admin'
        && (!data.adminUsername || profile.data().username === data.adminUsername));
      if (dryRun || admins.length !== 1) { settingsWithLegacyPassword.push(row.id); continue; }
      const ref = adminDb.collection('settings').doc(row.id);
      const safe = await adminDb.runTransaction(async txn => {
        const current = (await txn.get(ref)).data();
        if (!current || !('adminPassword' in current)) return true;
        const profile = (await txn.get(adminDb.collection('users').doc(admins[0].id))).data();
        const secret = (await txn.get(adminDb.collection('user_secrets').doc(admins[0].id))).data();
        if (current.storeId !== storeId || profile?.storeId !== storeId || profile.role !== 'admin'
          || (current.adminUsername && current.adminUsername !== profile.username)
          || typeof current.adminPassword !== 'string' || !secret
          || !verifyStoredCredential(current.adminPassword.trim(), secret)) return false;
        txn.update(ref, { adminPassword: safeDeleteSentinel() });
        return true;
      });
      if (!safe) settingsWithLegacyPassword.push(row.id);
    }
    const remaining = dryRun ? snapshots : await adminDb.collection('users').where('storeId', '==', storeId).get();
    const remainingLegacyUsers = remaining.docs.filter(row => 'password' in row.data()).map(row => row.id);
    const ready = remainingLegacyUsers.length === 0 && settingsWithLegacyPassword.length === 0;
    if (!dryRun && ready) await storeRef.update({ credentialStorageVersion: 1 });
    return res.status(200).json({
      storeId, dryRun, eligible, updated: dryRun ? 0 : eligible, skipped,
      remainingLegacyUsers, settingsWithLegacyPassword, ready,
    });
  } catch (error) {
    console.error('Legacy credential migration failed:', error);
    return res.status(500).json({ error: 'Không thể kiểm tra thông tin xác thực cũ.' });
  }
}
