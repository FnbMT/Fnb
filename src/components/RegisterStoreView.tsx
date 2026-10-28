import React, { useState } from 'react';
import { Store as StoreIcon, User as UserIcon, ArrowLeft, Loader2, QrCode, Phone, KeyRound, CheckCircle2 } from 'lucide-react';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { collection, addDoc, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { INITIAL_MENU, INITIAL_TABLES, CATEGORIES } from '../types';
import { apiUrl } from '../utils/apiConfig';

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

      // Gọi API đăng ký bảo mật phía Server (/api/register-store)
      // Mã hóa mật khẩu scrypt + AES-256 an toàn trong user_secrets, không lưu mật khẩu thô trong users
      const resp = await fetch(apiUrl('/api/register-store'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeName: storeName.trim(),
          storeCode: storeCode.toLowerCase().trim(),
          phone: phone.trim(),
          password: password.trim()
        })
      });

      const result = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        setError(result.error || 'Lỗi tạo cửa hàng. Vui lòng kiểm tra lại thông tin.');
        setLoading(false);
        return;
      }

      onSuccess();
    } catch (err: any) {
      console.error(err);
      setError('Lỗi kết nối khi tạo cửa hàng. Vui lòng kiểm tra lại mạng hoặc thử lại.');
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


