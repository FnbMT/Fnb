import { adminDb } from "./_firebaseAdmin";

export default async function handler(req: any, res: any) {
  // 1. Chỉ chấp nhận phương thức POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 2. BẢO MẬT: Bắt buộc xác thực API Token từ SePay
  const expectedToken = process.env.SEPAY_API_TOKEN;
  if (!expectedToken) {
    console.error("CRITICAL: SEPAY_API_TOKEN is not configured in environment variables!");
    return res.status(500).json({ error: 'Server payment configuration error' });
  }

  let authHeader = req.headers.authorization || req.headers['x-api-key'] || '';
  if (Array.isArray(authHeader)) authHeader = authHeader[0] || '';
  if (authHeader.startsWith('Apikey ')) authHeader = authHeader.substring(7);
  else if (authHeader.startsWith('Bearer ')) authHeader = authHeader.substring(7);

  if (authHeader.trim() !== expectedToken.trim()) {
    console.warn("Unauthorized SePay webhook access attempt blocked.");
    return res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
  }

  try {
    const data = req.body || {};

    // Chỉ xử lý giao dịch tiền vào
    if (data.transferType !== 'in') {
      return res.status(200).json({ success: true, message: 'Ignored: Not an incoming transfer' });
    }

    const txId = String(data.id || data.referenceCode || '').trim();
    if (!txId) {
      return res.status(400).json({ error: 'Missing transaction ID' });
    }

    const amount = Number(data.transferAmount || data.amount || 0);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid transfer amount' });
    }

    // 3. Sử dụng Firestore Transaction để chống Replay Attack (xử lý lặp giao dịch)
    const txRef = adminDb.collection('processed_transactions').doc(txId);
    
    // Kiểm tra xem giao dịch đã từng xử lý chưa
    const existingTx = await txRef.get();
    if (existingTx.exists) {
      return res.status(200).json({ success: true, message: 'Transaction already processed previously' });
    }

    const content = String(data.content || '').toUpperCase();
    
    // Nhận diện mã quán và lệnh gia hạn (hỗ trợ cả cú pháp VietinBank SEVQR)
    // Cú pháp: "SEVQR STORECODE GIAHAN" hoặc "STORECODE GIAHAN [PACKAGE_ID] [MONTHS]"
    if (!content.includes('GIAHAN')) {
      return res.status(200).json({ success: true, message: 'No renewal command in transfer content' });
    }

    const match = content.match(/(?:SEVQR\s+)?([A-Z0-9_-]+)\s+GIAHAN(?:\s+([A-Z0-9_-]+))?(?:\s+([0-9]+))?/i);
    if (!match || !match[1]) {
      return res.status(200).json({ success: true, message: 'Cannot parse store code from content' });
    }

    let rawStoreCode = match[1].trim();
    if (rawStoreCode.toUpperCase() === 'SEVQR' && match[2]) {
      rawStoreCode = match[2].trim();
    }
    const storeCode = rawStoreCode.toLowerCase();

    // 4. Tìm kiếm cửa hàng
    const storesQuery = await adminDb.collection('stores')
      .where('code', '==', storeCode)
      .limit(1)
      .get();

    if (storesQuery.empty) {
      console.warn(`SePay Webhook: Store code not found: ${storeCode}`);
      return res.status(200).json({ success: false, message: `Store code not found: ${storeCode}` });
    }

    const storeDoc = storesQuery.docs[0];
    const storeId = storeDoc.id;
    const storeData = storeDoc.data();

    // 5. Tính toán gói cước và thời hạn dựa trên số tiền thực nhận (Chống gian lận nội dung)
    const pkgsSnapshot = await adminDb.collection('packages').get();
    let matchedPackageId = 'pro';
    let durationMonths = 1;
    let foundPricingMatch = false;

    // Quét toàn bộ bảng giá các gói để tìm mức giá khớp hoặc gần nhất với số tiền chuyển
    pkgsSnapshot.forEach(docSnap => {
      const pkg = docSnap.data();
      const pkgId = docSnap.id;

      if (pkg.pricing && Array.isArray(pkg.pricing)) {
        pkg.pricing.forEach((opt: any) => {
          if (amount >= opt.price && opt.durationMonths) {
            if (!foundPricingMatch || opt.durationMonths > durationMonths) {
              matchedPackageId = pkgId;
              durationMonths = opt.durationMonths;
              foundPricingMatch = true;
            }
          }
        });
      } else if (pkg.price && amount >= pkg.price) {
        matchedPackageId = pkgId;
        durationMonths = pkg.durationMonths || 1;
        foundPricingMatch = true;
      }
    });

    // Nếu không khớp với bất kỳ gói nào, tính dựa trên mức cơ bản (tối đa 24 tháng để an toàn)
    if (!foundPricingMatch) {
      durationMonths = Math.min(Math.max(1, Math.floor(amount / 99000)), 24);
    }

    // 6. Tính ngày hết hạn mới
    let baseDate = new Date();
    const currentValidUntil = storeData.subscription?.validUntil;
    if (currentValidUntil) {
      const currentEnd = new Date(currentValidUntil);
      if (!isNaN(currentEnd.getTime()) && currentEnd > baseDate) {
        baseDate = currentEnd;
      }
    }

    const newEndDate = new Date(baseDate);
    newEndDate.setMonth(newEndDate.getMonth() + durationMonths);

    // 7. Cập nhật Subscription và lưu vết giao dịch
    await adminDb.runTransaction(async (transaction) => {
      const checkTx = await transaction.get(txRef);
      if (checkTx.exists) {
        throw new Error("TRANSACTION_ALREADY_PROCESSED");
      }

      transaction.update(adminDb.collection('stores').doc(storeId), {
        'subscription.status': 'active',
        'subscription.packageId': matchedPackageId,
        'subscription.validUntil': newEndDate.toISOString(),
        'subscription.lastRenewedAt': new Date().toISOString()
      });

      transaction.set(txRef, {
        txId,
        storeId,
        storeCode,
        amount,
        durationMonths,
        packageId: matchedPackageId,
        processedAt: new Date().toISOString(),
        gateway: 'sepay'
      });
    });

    console.log(`[SePay Webhook] Successfully extended ${durationMonths} month(s) for store: ${storeCode}`);
    return res.status(200).json({ 
      success: true, 
      message: `Extended ${durationMonths} month(s) for store ${storeCode}` 
    });

  } catch (err: any) {
    if (err?.message === "TRANSACTION_ALREADY_PROCESSED") {
      return res.status(200).json({ success: true, message: 'Already processed concurrently' });
    }
    console.error("SePay Webhook processing error:", err);
    return res.status(500).json({ error: 'Internal server error while processing webhook' });
  }
}
