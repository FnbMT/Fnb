import React, { useState } from 'react';
import { Store as StoreIcon, User as UserIcon, ArrowLeft, Loader2, QrCode, Phone, KeyRound, CheckCircle2 } from 'lucide-react';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { collection, addDoc, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { INITIAL_MENU, INITIAL_TABLES, CATEGORIES } from '../types';

export const RegisterStoreView = ({ onBack, onSuccess }: { onBack: () => void, onSuccess: () => void }) => {
  const [storeName, setStoreName] = useState('');
  const [storeCode, setStoreCode] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Default package trial days (14 days)
  const TRIAL_DAYS = 14;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (storeCode.includes(' ') || storeCode.length < 3) {
        setError('Mã cửa hàng phải viết liền không dấu và ít nhất 3 ký tự');
        setLoading(false);
        return;
      }
      if (phone.length < 9) {
        setError('Số điện thoại không hợp lệ');
        setLoading(false);
        return;
      }

      // Check if storeCode already exists
      const storeQuery = query(collection(db, 'stores'), where('code', '==', storeCode.toLowerCase()));
      const storeSnapshot = await getDocs(storeQuery);
      
      if (!storeSnapshot.empty) {
        setError('Mã cửa hàng này đã được đăng ký. Vui lòng chọn mã khác.');
        setLoading(false);
        return;
      }

      // Check if phone number is already registered as an admin
      const phoneQuery = query(collection(db, 'users'), where('username', '==', phone), where('role', '==', 'admin'));
      const phoneSnapshot = await getDocs(phoneQuery);

      if (!phoneSnapshot.empty) {
        setError('Số điện thoại này đã được dùng để đăng ký một cửa hàng khác. Vui lòng sử dụng số điện thoại khác.');
        setLoading(false);
        return;
      }

      // Create Store with Trial Subscription
      // Fetch trial package to get trialDays
      const packageRef = doc(db, 'packages', 'trial');
      const packageSnap = await getDoc(packageRef);
      let trialDays = 14;
      if (packageSnap.exists()) {
        trialDays = packageSnap.data().trialDays || 14;
      }
      
      const trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + trialDays);

      const storeRef = await addDoc(collection(db, 'stores'), {
        name: storeName,
        code: storeCode.toLowerCase(),
        phone: phone, // Save phone to store document for superadmin to see
        subscription: {
          status: 'trial',
          trialEndDate: trialEndDate.toISOString(),
          packageId: 'trial',
        },
        createdAt: new Date().toISOString()
      });

      // Create Admin User for this store (using phone as username for simplicity)
      await addDoc(collection(db, 'users'), {
        username: phone, // using phone as the admin login username
        password: password, // user's chosen password
        name: 'Quản trị viên',
        role: 'admin',
        storeId: storeRef.id,
        createdAt: new Date().toISOString()
      });

      // Seed initial menu
      for (const item of INITIAL_MENU) {
        await addDoc(collection(db, 'menu'), { ...item, storeId: storeRef.id });
      }

      // Seed initial tables
      for (const table of INITIAL_TABLES) {
        await addDoc(collection(db, 'tables'), { ...table, storeId: storeRef.id });
      }

      // Seed initial settings
      await addDoc(collection(db, 'settings'), {
        storeId: storeRef.id,
        storeName: storeName,
        address: '',
        phone: phone,
        logo: '',
        adminUsername: phone,
        kitchenBellEnabled: true,
        vatPercent: 8,
        kitchenBillTemplate: 'Mẫu bill bếp mặc định',
        paymentBillTemplate: 'Mẫu bill thanh toán mặc định',
        menuCategories: CATEGORIES,
        inventoryCategories: ['Nguyên liệu', 'Đồ uống', 'Khác'],
        cashCategories: ['Bán hàng', 'Tiền điện', 'Tiền nước', 'Tiền mặt bằng', 'Nhập hàng', 'Lương nhân viên', 'Khác'],
        customerTypes: [
          { id: '1', name: 'Khách lẻ', discountPercent: 0 },
          { id: '2', name: 'Thành viên Đồng', discountPercent: 5 },
          { id: '3', name: 'Thành viên Bạc', discountPercent: 10 },
          { id: '4', name: 'Thành viên Vàng', discountPercent: 15 },
        ]
      });

      onSuccess();
    } catch (err: any) {
      console.error(err);
      setError('Lỗi tạo cửa hàng. Vui lòng thử lại.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-3xl p-8 shadow-2xl space-y-8"
      >
        <button 
          onClick={onBack}
          className="flex items-center gap-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors text-sm cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" /> Quay lại
        </button>

        <div className="text-center space-y-2">
          <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/20">
            <StoreIcon className="w-10 h-10 text-black" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white tracking-tighter">ĐĂNG KÝ CỬA HÀNG</h1>
          <p className="text-gray-500">
            Bắt đầu quản lý kinh doanh của bạn
          </p>
        </div>

        <form onSubmit={handleRegister} className="space-y-6">
          <div className="space-y-4">
            <div className="relative">
              <StoreIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input 
                type="text" 
                placeholder="Tên cửa hàng (VD: Cafe Trung Nguyên)"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl py-4 pl-12 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                required
              />
            </div>
            
            <div className="relative">
              <QrCode className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input 
                type="text" 
                placeholder="Mã cửa hàng (VD: cafetrungnguyen)"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl py-4 pl-12 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                value={storeCode}
                onChange={(e) => setStoreCode(e.target.value)}
                required
              />
              <p className="text-xs text-emerald-600 dark:text-emerald-500/70 mt-2 ml-1">Mã này sẽ cấp cho nhân viên để đăng nhập</p>
            </div>

            <div className="relative">
              <Phone className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input 
                type="tel" 
                placeholder="Số điện thoại Admin (Sẽ dùng làm tên đăng nhập)"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl py-4 pl-12 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
            
            <div className="relative">
              <KeyRound className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input 
                type="password" 
                placeholder="Mật khẩu Admin"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl py-4 pl-12 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          {error && (
            <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 text-rose-600 dark:text-rose-500 text-sm">
              {error}
            </div>
          )}

          <button 
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-emerald-500 text-white font-bold rounded-2xl shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'XÁC NHẬN & TẠO CỬA HÀNG'}
          </button>
        </form>
      </motion.div>
    </div>
  );
};


