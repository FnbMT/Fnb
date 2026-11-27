import React, { useState, useEffect } from 'react';
import { Coffee, Lock, User as UserIcon, AlertCircle, Loader2, ExternalLink, Wifi, WifiOff, QrCode, Download, CheckCircle2 } from 'lucide-react';
import { User } from '../types';
import { motion } from 'motion/react';
import { db, auth } from '../lib/firebase';
import { signInWithCustomToken } from 'firebase/auth';
import { collection, query, where, getDocs, limit, doc, getDoc, updateDoc } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';

import { apiUrl, safeApiRequest } from '../utils/apiConfig';
import { computeSha256 } from '../utils/cryptoHelper';

export const LoginView = ({ 
  onLogin, 
  onRegisterClick,
  initialStoreCode = '',
  initialUsername = '',
  justRegistered = false
}: { 
  onLogin: (user: User) => void; 
  onRegisterClick?: () => void;
  initialStoreCode?: string;
  initialUsername?: string;
  justRegistered?: boolean;
}) => {
  const isNative = Capacitor.isNativePlatform();
  const [apkUrl, setApkUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isNative) {
      const fetchApk = async () => {
        try {
          const cacheKey = 'fnb_ver_cache_v1_android_version';
          const TWO_HOURS_MS = 2 * 3600 * 1000;
          const cachedRaw = localStorage.getItem(cacheKey);
          if (cachedRaw) {
            const parsed = JSON.parse(cachedRaw);
            if (parsed && parsed.ts && Date.now() - Number(parsed.ts) < TWO_HOURS_MS && parsed.data?.apkUrl) {
              setApkUrl(parsed.data.apkUrl);
              return;
            }
          }
          const snap = await getDoc(doc(db, 'app_settings', 'android_version'));
          if (snap.exists()) {
            const data = snap.data();
            try {
              localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
            } catch {}
            if (data.apkUrl) {
              setApkUrl(data.apkUrl);
            }
          }
        } catch (e) {}
      };
      fetchApk();
    }
  }, [isNative]);

  const [storeCode, setStoreCode] = useState(initialStoreCode);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [debugInfo, setDebugInfo] = useState<string>('');

  useEffect(() => {
    if (initialStoreCode) setStoreCode(initialStoreCode);
    if (initialUsername) setUsername(initialUsername);
  }, [initialStoreCode, initialUsername]);

  useEffect(() => {
    let isMounted = true;
    const checkConnection = async () => {
      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          if (isMounted) {
            setConnectionStatus('offline');
            setDebugInfo('Thiết bị đang không có kết nối Internet.');
          }
          return;
        }

        // Kiểm tra kết nối tới máy chủ backend Vercel (máy chủ xử lý đăng nhập)
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4000);
          const healthResp = await safeApiRequest('/api/health', { signal: controller.signal });
          clearTimeout(timer);
          if (healthResp.ok) {
            if (isMounted) {
              setConnectionStatus('online');
              setDebugInfo('');
            }
            return;
          }
        } catch (_) {
          // Backend có thể đang khởi động hoặc mạng nội bộ, thiết bị vẫn online
        }

        if (isMounted) {
          setConnectionStatus('online');
          setDebugInfo('');
        }
      } catch (err: any) {
        if (!isMounted) return;
        setConnectionStatus('online');
        setDebugInfo('');
      }
    };
    checkConnection();
    return () => { isMounted = false; };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (!storeCode.trim()) {
        setError('Vui lòng nhập Mã Cửa Hàng');
        setLoading(false);
        return;
      }
      if (!username.trim()) {
        setError('Vui lòng nhập Tên đăng nhập');
        setLoading(false);
        return;
      }

      // 1. GỌI API ĐĂNG NHẬP BẢO MẬT PHÍA SERVER (Vercel / Local / Native)
      try {
        const response = await safeApiRequest('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { 
            storeCode: storeCode.trim(), 
            username: username.trim(), 
            password: password.trim() 
          },
        });

        if (response.ok) {
          const result = await response.json().catch(() => ({}));
          if (result.success && result.user) {
            // Nếu máy chủ cấp Firebase Custom Token hợp lệ, xác thực với Firebase Auth
            if (typeof result.customToken === 'string' && result.customToken && !result.customToken.startsWith('dev_token_')) {
              try {
                await signInWithCustomToken(auth, result.customToken);
              } catch (authErr: any) {
                console.warn("[Login] signInWithCustomToken notice:", authErr?.message || authErr);
              }
            }

            onLogin(result.user);
            return;
          }
        } else if (response.status === 401 || response.status === 403 || response.status === 429) {
          // Server từ chối danh tính (Sai mật khẩu, tài khoản bị khóa, hoặc bị rate-limit)
          const errData = await response.json().catch(() => ({}));
          setError(errData.error || 'Tên đăng nhập hoặc mật khẩu không đúng');
          setLoading(false);
          return;
        } else {
          console.warn(`[Login] Máy chủ trả về HTTP ${response.status}, tiến hành fallback sang kiểm tra trực tiếp.`);
        }
      } catch (apiErr) {
        console.warn("[Login] API network unreachable, fallback sang kiểm tra trực tiếp:", apiErr);
      }

      // 2. FALLBACK NGOẠI TUYẾN / MẤT KẾT NỐI SERVER (Chỉ áp dụng khi máy chủ không phản hồi)
      const isSuperAttempt = (storeCode.toLowerCase().trim() === 'admin' || storeCode.toLowerCase().trim() === 'superadmin') && username.toLowerCase().trim() === 'superadmin';
      if (isSuperAttempt) {
        setError('Không thể kết nối đến máy chủ bảo mật. Vui lòng kiểm tra lại kết nối mạng.');
        setLoading(false);
        return;
      }

      const storeQuery = query(collection(db, 'stores'), where('code', '==', storeCode.toLowerCase().trim()));
      const storeSnapshot = await getDocs(storeQuery);
      
      if (storeSnapshot.empty) {
        setError('Mã cửa hàng không tồn tại');
        setLoading(false);
        return;
      }

      const storeDoc = storeSnapshot.docs[0];
      const storeId = storeDoc.id;
      const storeData = storeDoc.data();

      if (storeData.subscription && storeData.subscription.status === 'blocked') {
        setError('Cửa hàng đã bị khóa. Vui lòng liên hệ Admin.');
        setLoading(false);
        return;
      }

      const q = query(
        collection(db, 'users'), 
        where('storeId', '==', storeId), 
        where('username', '==', username.toLowerCase().trim())
      );
      const querySnapshot = await getDocs(q);

      if (!querySnapshot.empty) {
        const userDoc = querySnapshot.docs[0];
        const userData = userDoc.data();
        let isAuthSuccess = false;

        // A. Kiểm tra mật khẩu trực tiếp (tương thích các tài khoản legacy)
        if (userData.password && String(userData.password).trim() === password.trim()) {
          isAuthSuccess = true;
        }

        // B. Nếu không có trường password:
        // Kiểm tra đối chiếu với system/user_secret_${userDoc.id}
        if (!isAuthSuccess) {
          try {
            const secretSnap = await getDoc(doc(db, 'system', `user_secret_${userDoc.id}`));
            if (secretSnap.exists()) {
              const secData = secretSnap.data();
              if (secData.clientHash) {
                const userHash = await computeSha256(password.trim());
                if (userHash === secData.clientHash) {
                  isAuthSuccess = true;
                }
              }
            }
          } catch (secErr) {
            console.warn("Lỗi kiểm tra secret fallback:", secErr);
          }
        }

        if (isAuthSuccess) {
          const loginNowIso = new Date().toISOString();
          try {
            await updateDoc(doc(db, 'users', userDoc.id), {
              lastLogin: loginNowIso
            });
            if (storeData?.userSummary && typeof storeData.userSummary.employeeCount === 'number') {
              await updateDoc(doc(db, 'stores', storeId), userData.role === 'admin'
                ? { 'userSummary.adminLastLogin': loginNowIso }
                : { [`userSummary.staffLogins.${userDoc.id}`]: loginNowIso }
              );
            }
          } catch (e) {}

          onLogin({
            ...userData,
            id: userDoc.id,
            storeId: storeId || userData.storeId,
            tokenVersion: Number(userData.tokenVersion || 1),
            store: storeData
          } as any);
          return;
        }
      }

      setError('Tên đăng nhập hoặc mật khẩu không đúng');
    } catch (err: any) {
      console.error(err);
      setError('Lỗi kết nối. Hãy thử lại hoặc kiểm tra kết nối mạng.');
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
          
          <div className="flex items-center justify-center pt-2">
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

        {justRegistered && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 text-emerald-600 dark:text-emerald-400 text-xs sm:text-sm flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-emerald-500" />
            <div>
              <p className="font-bold">Khởi tạo cửa hàng thành công!</p>
              <p className="text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                Mã cửa hàng và số điện thoại đã được điền sẵn. Hãy nhập mật khẩu bạn vừa tạo để đăng nhập vào ca làm việc.
              </p>
            </div>
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-6">
          <div className="space-y-4">
            <div className="relative">
              <QrCode className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input 
                type="text" 
                placeholder="Mã cửa hàng"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
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
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
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
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
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
                <span>{error}</span>
              </div>

              {connectionStatus === 'offline' && !isNative && (
                <a 
                  href={window.location.href} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 py-2 bg-rose-500 text-white rounded-lg font-bold hover:bg-rose-600 transition-all text-xs"
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
            {!isNative && apkUrl && (
              <div>
                <a href={apkUrl} target="_blank" rel="noopener noreferrer" className="w-full flex items-center justify-center gap-2 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-bold py-3 px-4 rounded-xl hover:bg-emerald-200 dark:hover:bg-emerald-500/30 transition-colors text-sm">
                  <Download className="w-4 h-4" /> Tải App Android (APK)
                </a>
              </div>
            )}

            {!isNative && onRegisterClick && (
              <div className="space-y-1">
                <p className="text-gray-500 text-sm">Chưa có tài khoản cửa hàng?</p>
                <button 
                  type="button"
                  onClick={onRegisterClick}
                  className="text-emerald-600 dark:text-emerald-500 font-bold hover:text-emerald-400 transition-colors cursor-pointer text-sm"
                >
                  TẠO TÀI KHOẢN CỬA HÀNG MỚI
                </button>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <a 
                href={window.location.href} 
                target="_blank" 
                rel="noopener noreferrer"
                className="inline-flex justify-center items-center gap-2 text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                <ExternalLink className="w-3 h-3" /> Tải lại trang
              </a>
            </div>

            <div className="pt-2 w-full flex justify-center">
              <p className="text-xs text-gray-400 dark:text-gray-600 uppercase tracking-wider font-semibold text-center">
                QUẢN LÝ NHÀ HÀNG CHUYÊN NGHIỆP
              </p>
            </div>
          </div>
      </motion.div>
    </div>
  );
};
