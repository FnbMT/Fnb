import { adminDb, hasAdminCredential } from "./_firebaseAdmin.js";

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

  // 2b. Bắt buộc có Firebase Admin SDK Service Account để giao dịch thanh toán tài chính có tính nguyên tử
  if (!hasAdminCredential) {
    console.error("CRITICAL: Firebase Admin credentials not configured. Refusing non-atomic payment transaction.");
    return res.status(503).json({ error: 'Máy chủ chưa được kích hoạt Firebase Admin SDK Service Account để xử lý giao dịch thanh toán nguyên tử.' });
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
    let durationMonths = 0;
    let foundPricingMatch = false;
    let minPackagePrice = Infinity;

    // Quét toàn bộ bảng giá các gói để tìm mức giá khớp hoặc gần nhất với số tiền chuyển
    pkgsSnapshot.forEach(docSnap => {
      const pkg = docSnap.data();
      const pkgId = docSnap.id;

      if (pkg.pricing && Array.isArray(pkg.pricing)) {
        pkg.pricing.forEach((opt: any) => {
          if (typeof opt.price === 'number' && opt.price > 0 && opt.price < minPackagePrice) {
            minPackagePrice = opt.price;
          }
          if (amount >= opt.price && opt.durationMonths) {
            if (!foundPricingMatch || opt.durationMonths > durationMonths) {
              matchedPackageId = pkgId;
              durationMonths = opt.durationMonths;
              foundPricingMatch = true;
            }
          }
        });
      } else if (pkg.price) {
        if (typeof pkg.price === 'number' && pkg.price > 0 && pkg.price < minPackagePrice) {
          minPackagePrice = pkg.price;
        }
        if (amount >= pkg.price) {
          matchedPackageId = pkgId;
          durationMonths = pkg.durationMonths || 1;
          foundPricingMatch = true;
        }
      }
    });

    if (minPackagePrice === Infinity) {
      minPackagePrice = 99000;
    }

    // Nếu không khớp với bất kỳ bảng giá nào, chỉ tính duration khi amount >= minPackagePrice
    if (!foundPricingMatch) {
      const calculatedMonths = Math.floor(amount / minPackagePrice);
      if (calculatedMonths >= 1) {
        durationMonths = Math.min(calculatedMonths, 24);
        foundPricingMatch = true;
      } else {
        durationMonths = 0;
      }
    }

    // NẾU SỐ TIỀN KHÔNG ĐỦ GIA HẠN GÓI TỐI THIỂU (Ví dụ chuyển 1.000đ):
    // Ghi nhận giao dịch underpaid để đối soát thủ công, TUYỆT ĐỐI KHÔNG gia hạn thuê bao!
    if (durationMonths <= 0 || !foundPricingMatch) {
      console.warn(`[SePay Webhook] Giao dịch ${txId} của quán ${storeCode}: Số tiền ${amount}đ không đủ gia hạn gói tối thiểu (${minPackagePrice}đ).`);
      await adminDb.collection('processed_transactions').doc(txId).set({
        txId,
        storeId,
        storeCode,
        amount,
        durationMonths: 0,
        status: 'underpaid',
        minRequired: minPackagePrice,
        processedAt: new Date().toISOString(),
        gateway: 'sepay'
      });
      return res.status(200).json({
        success: true,
        message: `Giao dịch đã được ghi nhận. Số tiền ${amount}đ chưa đủ mức gia hạn tối thiểu (${minPackagePrice}đ).`
      });
    }

    // 6. Cập nhật Subscription và lưu vết giao dịch trong Transaction nguyên tử
    // Đọc storeDoc NGAY TRONG TRANSACTION để chống race condition khi có 2 giao dịch đồng thời
    const storeRef = adminDb.collection('stores').doc(storeId);
    let finalEndDateIso = '';

    await adminDb.runTransaction(async (transaction) => {
      const checkTx = await transaction.get(txRef);
      if (checkTx.exists) {
        throw new Error("TRANSACTION_ALREADY_PROCESSED");
      }

      const freshStoreSnap = await transaction.get(storeRef);
      if (!freshStoreSnap.exists) {
        throw new Error("STORE_NOT_FOUND");
      }

      const freshStoreData = freshStoreSnap.data() || {};
      let baseDate = new Date();
      const currentValidUntil = freshStoreData.subscription?.validUntil;
      if (currentValidUntil) {
        const currentEnd = new Date(currentValidUntil);
        if (!isNaN(currentEnd.getTime()) && currentEnd > baseDate) {
          baseDate = currentEnd;
        }
      }

      const newEndDate = new Date(baseDate);
      newEndDate.setMonth(newEndDate.getMonth() + durationMonths);
      finalEndDateIso = newEndDate.toISOString();

      transaction.update(storeRef, {
        'subscription.status': 'active',
        'subscription.packageId': matchedPackageId,
        'subscription.validUntil': finalEndDateIso,
        'subscription.lastRenewedAt': new Date().toISOString()
      });

      transaction.set(txRef, {
        txId,
        storeId,
        storeCode,
        amount,
        durationMonths,
        packageId: matchedPackageId,
        status: 'completed',
        processedAt: new Date().toISOString(),
        gateway: 'sepay'
      });
    });

    console.log(`[SePay Webhook] Successfully extended ${durationMonths} month(s) for store: ${storeCode} until ${finalEndDateIso}`);
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
