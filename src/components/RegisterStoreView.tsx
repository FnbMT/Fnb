import React, { useState } from 'react';
import { 
  Store as StoreIcon, 
  User as UserIcon, 
  ArrowLeft, 
  Loader2, 
  QrCode, 
  Phone, 
  KeyRound, 
  CheckCircle2, 
  Copy, 
  Check, 
  Sparkles, 
  ArrowRight, 
  ShieldCheck 
} from 'lucide-react';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { collection, addDoc, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { INITIAL_MENU, INITIAL_TABLES, CATEGORIES } from '../types';
import { apiUrl } from '../utils/apiConfig';

export interface RegisteredStoreInfo {
  storeName: string;
  storeCode: string;
  phone: string;
}

export const RegisterStoreView = ({ 
  onBack, 
  onSuccess 
}: { 
  onBack: () => void; 
  onSuccess: (info?: RegisteredStoreInfo) => void;
}) => {
  const [storeName, setStoreName] = useState('');
  const [storeCode, setStoreCode] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isPermissionError, setIsPermissionError] = useState(false);
  const [copiedRules, setCopiedRules] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [successData, setSuccessData] = useState<RegisteredStoreInfo | null>(null);
  
  // Default package trial days (14 days)
  const TRIAL_DAYS = 14;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setIsPermissionError(false);

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
      const cleanName = storeName.trim();
      const cleanCode = storeCode.toLowerCase().trim();
      const cleanPhone = phone.trim();

      const resp = await fetch(apiUrl('/api/register-store'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeName: cleanName,
          storeCode: cleanCode,
          phone: cleanPhone,
          password: password.trim()
        })
      });

      const result = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        if (result.permissionDenied || String(result.error || '').includes('Rules')) {
          setIsPermissionError(true);
        }
        setError(result.error || 'Lỗi tạo cửa hàng. Vui lòng kiểm tra lại thông tin.');
        setLoading(false);
        return;
      }

      // Hiển thị màn hình thông báo tạo cửa hàng thành công
      setSuccessData({
        storeName: cleanName,
        storeCode: cleanCode,
        phone: cleanPhone
      });
    } catch (err: any) {
      console.error(err);
      setError('Lỗi kết nối khi tạo cửa hàng. Vui lòng kiểm tra lại mạng hoặc thử lại.');
    } finally {
      setLoading(false);
    }
  };

  // MÀN HÌNH THÔNG BÁO TẠO CỬA HÀNG THÀNH CÔNG
  if (successData) {
    const handleCopyAll = () => {
      const summary = `THÔNG TIN CỬA HÀNG FNB MASTER:\n- Tên quán: ${successData.storeName}\n- Mã cửa hàng: ${successData.storeCode}\n- Tài khoản Admin: ${successData.phone}\n- Dùng thử: 14 ngày miễn phí\n(Vui lòng lưu lại mã cửa hàng để cấp cho nhân viên đăng nhập)`;
      navigator.clipboard.writeText(summary);
      setCopiedSummary(true);
      setTimeout(() => setCopiedSummary(false), 3000);
    };

    return (
      <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a] flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md bg-white dark:bg-[#151619] border border-emerald-500/30 rounded-3xl p-8 shadow-2xl space-y-6 text-center relative overflow-hidden"
        >
          {/* Trang trí hiệu ứng nền */}
          <div className="absolute -top-24 -left-24 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-24 -right-24 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

          {/* Icon thành công */}
          <div className="relative mx-auto w-20 h-20">
            <div className="w-20 h-20 bg-emerald-500/20 border-2 border-emerald-500 rounded-3xl flex items-center justify-center shadow-xl shadow-emerald-500/20">
              <CheckCircle2 className="w-12 h-12 text-emerald-500" />
            </div>
            <div className="absolute -top-1 -right-1 bg-amber-400 text-black p-1 rounded-full shadow-md">
              <Sparkles className="w-4 h-4" />
            </div>
          </div>

          <div className="space-y-2">
            <span className="inline-block px-3 py-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs font-bold uppercase tracking-wider rounded-full">
              Khởi tạo hoàn tất
            </span>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white tracking-tight">
              TẠO CỬA HÀNG THÀNH CÔNG!
            </h1>
            <p className="text-gray-500 dark:text-gray-400 text-sm">
              Cửa hàng <strong className="text-emerald-600 dark:text-emerald-400 font-semibold">{successData.storeName}</strong> đã được khởi tạo và sẵn sàng sử dụng.
            </p>
          </div>

          {/* Bảng chi tiết thông tin đăng nhập */}
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-5 text-left space-y-4">
            <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
              <span className="text-xs text-gray-500 dark:text-gray-400">Tên cửa hàng:</span>
              <span className="text-sm font-semibold text-gray-900 dark:text-white truncate max-w-[200px]">
                {successData.storeName}
              </span>
            </div>

            <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block font-medium">Mã cửa hàng:</span>
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Cấp mã này cho nhân viên để vào ca</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-base font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/15 px-3 py-1 rounded-xl border border-emerald-500/30">
                  {successData.storeCode}
                </span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(successData.storeCode)}
                  className="p-1.5 hover:bg-black/10 dark:hover:bg-white/10 rounded-lg text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors cursor-pointer"
                  title="Sao chép mã cửa hàng"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
              <div>
                <span className="text-xs text-gray-500 dark:text-gray-400 block font-medium">Tài khoản Admin:</span>
                <span className="text-[11px] text-gray-400">Dùng số điện thoại để đăng nhập</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-sm font-semibold text-gray-900 dark:text-white">
                  {successData.phone}
                </span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(successData.phone)}
                  className="p-1.5 hover:bg-black/10 dark:hover:bg-white/10 rounded-lg text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors cursor-pointer"
                  title="Sao chép số điện thoại"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">Gói dịch vụ:</span>
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium bg-emerald-500/10 px-2.5 py-1 rounded-lg">
                <ShieldCheck className="w-3.5 h-3.5" /> Dùng thử Pro (14 ngày)
              </span>
            </div>
          </div>

          {/* Nút hành động */}
          <div className="space-y-3 pt-2">
            <button
              type="button"
              onClick={() => onSuccess(successData)}
              className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold rounded-2xl shadow-lg shadow-emerald-500/25 transition-all cursor-pointer flex items-center justify-center gap-2 text-base"
            >
              ĐĂNG NHẬP NGAY <ArrowRight className="w-5 h-5" />
            </button>

            <button
              type="button"
              onClick={handleCopyAll}
              className="w-full py-3 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 font-medium rounded-xl border border-black/10 dark:border-white/10 transition-colors cursor-pointer flex items-center justify-center gap-2 text-xs"
            >
              {copiedSummary ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
              {copiedSummary ? 'Đã sao chép toàn bộ thông tin quán!' : 'Sao chép thông tin để lưu trữ'}
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

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
            <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 text-rose-600 dark:text-rose-500 text-sm space-y-3">
              <p className="font-medium leading-relaxed">{error}</p>
              {isPermissionError && (
                <div className="bg-black/20 dark:bg-black/40 rounded-lg p-3 text-xs text-gray-300 space-y-2 border border-white/10">
                  <p className="font-semibold text-amber-400">Cách xử lý nhanh trên Firebase Console:</p>
                  <ol className="list-decimal list-inside space-y-1 text-gray-400">
                    <li>Mở Firebase Console &rarr; Firestore Database &rarr; Tab Rules</li>
                    <li>Cập nhật quyền cho phép đọc ghi collection <code>users</code></li>
                    <li>Bấm <strong>Publish (Xuất bản)</strong> rồi bấm tạo lại quán</li>
                  </ol>
                  <button
                    type="button"
                    onClick={() => {
                      const rulesText = `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if true;\n    }\n  }\n}`;
                      navigator.clipboard.writeText(rulesText);
                      setCopiedRules(true);
                      setTimeout(() => setCopiedRules(false), 3000);
                    }}
                    className="w-full mt-2 py-2 px-3 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border border-emerald-500/40 rounded-lg font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    {copiedRules ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedRules ? 'Đã sao chép Rules mẫu!' : 'Sao chép Rules mở quyền Firestore'}
                  </button>
                </div>
              )}
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


