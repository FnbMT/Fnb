import React, { useState, useEffect, useRef } from 'react';
import { Coffee, Lock, User as UserIcon, AlertCircle, Loader2, ExternalLink, Wifi, WifiOff, QrCode, Terminal } from 'lucide-react';
import { User } from '../types';
import { motion } from 'motion/react';
import { db } from '../lib/firebase';
import { collection, query, where, getDocs, limit } from 'firebase/firestore';

export const LoginView = ({ onLogin, onRegisterClick }: { onLogin: (user: User) => void, onRegisterClick: () => void }) => {
  const [storeCode, setStoreCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [debugInfo, setDebugInfo] = useState<string>('');

  useEffect(() => {
    const checkConnection = async () => {
      try {
        // Cài đặt bộ đếm thời gian 15 giây để chống treo vô hạn
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('TIMEOUT_15S')), 15000)
        );
        const queryPromise = getDocs(query(collection(db, 'users'), limit(1)));
        
        await Promise.race([queryPromise, timeoutPromise]);
        
        setConnectionStatus('online');
      } catch (err: any) {
        console.error('Firebase connection check failed:', err);
        setConnectionStatus('offline');
        
        // Trích xuất chi tiết lỗi để hiển thị lên màn hình
        const errMsg = err?.message || err?.toString() || 'Unknown error';
        const errCode = err?.code ? ` [Code: ${err.code}]` : '';
        setDebugInfo(`${errMsg}${errCode}`);
      }
    };
    checkConnection();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (!storeCode) {
        setError('Vui lòng nhập Mã Cửa Hàng');
        setLoading(false);
        return;
      }

      // 1. Check for Super Admin bypass
      if (storeCode === 'admin' && username === 'superadmin' && password === 'superadmin') {
        onLogin({
          id: 'superadmin',
          username: 'superadmin',
          name: 'Super Admin',
          role: 'superadmin' as any,
          storeId: 'superadmin'
        });
        return;
      }

      // Query store by code
      const storeQuery = query(collection(db, 'stores'), where('code', '==', storeCode.toLowerCase()));
      const storeSnapshot = await getDocs(storeQuery);
      
      if (storeSnapshot.empty) {
        setError('Mã cửa hàng không tồn tại');
        setLoading(false);
        return;
      }

      const storeDoc = storeSnapshot.docs[0];
      const storeId = storeDoc.id;
      const storeData = storeDoc.data();

      // Check if store subscription is expired or blocked
      if (storeData.subscription) {
        if (storeData.subscription.status === 'blocked') {
          setError('Cửa hàng đã bị khóa. Vui lòng liên hệ Admin.');
          setLoading(false);
          return;
        }
      }

      // 2. Query user by storeId, username, and password
      const q = query(collection(db, 'users'), where('storeId', '==', storeId), where('username', '==', username.toLowerCase()), where('password', '==', password));
      const querySnapshot = await getDocs(q);

      if (!querySnapshot.empty) {
        const userDoc = querySnapshot.docs[0];
        const userData = userDoc.data();
        
        // Update last login
        try {
          const { updateDoc, doc } = await import('firebase/firestore');
          await updateDoc(doc(db, 'users', userDoc.id), {
            lastLogin: new Date().toISOString()
          });
        } catch (e) {
          console.error("Failed to update last login", e);
        }

        onLogin({
          id: userDoc.id,
          username: userData.username,
          name: userData.name,
          role: userData.role,
          storeId: userData.storeId,
          avatar: userData.avatar,
          store: storeData
        } as any);
      } else {
        setError('Tên đăng nhập hoặc mật khẩu không đúng');
      }
    } catch (err: any) {
      console.error(err);
      setError('Lỗi kết nối Firebase. Hãy thử mở ứng dụng trong tab mới.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a] flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-3xl p-8 shadow-2xl space-y-8"
      >
        <div className="text-center space-y-2">
          <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/20">
            <Coffee className="w-10 h-10 text-black" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white tracking-tighter">FNB MASTER</h1>
          <p className="text-gray-500">Đăng nhập để bắt đầu ca làm việc</p>
          
          <div className="flex justify-center pt-2">
            {connectionStatus === 'checking' && (
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <Loader2 className="w-3 h-3 animate-spin" /> Đang kiểm tra kết nối...
              </div>
            )}
            {connectionStatus === 'online' && (
              <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-500 bg-emerald-500/10 px-3 py-1 rounded-full">
                <Wifi className="w-3 h-3" /> Hệ thống sẵn sàng
              </div>
            )}
            {connectionStatus === 'offline' && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-500 bg-rose-500/10 px-3 py-1 rounded-full">
                  <WifiOff className="w-3 h-3" /> Lỗi kết nối
                </div>
                {debugInfo && (
                  <div className="text-[10px] text-rose-500/80 bg-rose-500/10 p-2 rounded-lg max-w-xs text-center break-words border border-rose-500/20">
                    <span className="font-bold">MÃ LỖI:</span> {debugInfo}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-4">
            <div className="relative">
              <QrCode className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input 
                type="text" 
                placeholder="Mã cửa hàng"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl py-4 pl-12 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                value={storeCode}
                onChange={(e) => setStoreCode(e.target.value)}
                required
              />
            </div>
            <div className="relative">
              <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input 
                type="text" 
                placeholder="Tên đăng nhập"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl py-4 pl-12 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input 
                type="password" 
                placeholder="Mật khẩu"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl py-4 pl-12 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 transition-all"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          {error && (
            <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 flex flex-col gap-3 text-rose-600 dark:text-rose-500 text-sm">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 shrink-0" />
                {error}
              </div>
              {connectionStatus === 'offline' && (
                <a 
                  href={window.location.href} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 py-2 bg-rose-500 text-white rounded-lg font-bold hover:bg-rose-600 transition-all"
                >
                  <ExternalLink className="w-4 h-4" /> MỞ TRONG TAB MỚI
                </a>
              )}
            </div>
          )}

          <button 
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-emerald-500 text-white font-bold rounded-2xl shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'ĐĂNG NHẬP'}
          </button>
        </form>

          <div className="pt-4 border-t border-black/5 dark:border-white/5 text-center space-y-4">
          <p className="text-gray-500 text-sm">Chưa có tài khoản cửa hàng?</p>
          <button 
            onClick={onRegisterClick}
            className="text-emerald-600 dark:text-emerald-500 font-bold hover:text-emerald-400 transition-colors cursor-pointer"
          >
            TẠO TÀI KHOẢN CỬA HÀNG MỚI
          </button>
          
          <div className="pt-2 flex flex-col gap-3">
            <a 
              href={window.location.href} 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex justify-center items-center gap-2 text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <ExternalLink className="w-3 h-3" /> Chạm để tải lại nếu bị kẹt
            </a>
          </div>

          <div className="pt-4">
            <p className="text-xs text-gray-600 uppercase tracking-widest">HỆ THỐNG QUẢN LÝ NHÀ HÀNG CHUYÊN NGHIỆP</p>
          </div>
        </div>
      </motion.div>
    </div>
  );
};
