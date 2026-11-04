import React, { useState, useEffect } from 'react';
import { Coffee, Lock, User as UserIcon, AlertCircle, Loader2, ExternalLink, Wifi, WifiOff, QrCode, Download, CheckCircle2, Server, Settings, X, Check, Globe, RefreshCw } from 'lucide-react';
import { User } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { db, auth } from '../lib/firebase';
import { signInWithCustomToken } from 'firebase/auth';
import { collection, query, where, getDocs, limit, doc, getDoc, updateDoc } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';

import { apiUrl, getApiBaseUrl, setCustomApiUrl, getCustomApiUrl } from '../utils/apiConfig';
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
          const snap = await getDoc(doc(db, 'app_settings', 'android_version'));
          if (snap.exists() && snap.data().apkUrl) {
            setApkUrl(snap.data().apkUrl);
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

  const [showServerModal, setShowServerModal] = useState(false);
  const [serverInputUrl, setServerInputUrl] = useState(() => getCustomApiUrl() || getApiBaseUrl());
  const [testingServer, setTestingServer] = useState(false);
  const [serverTestResult, setServerTestResult] = useState<{ success: boolean; message: string; superadmin?: boolean } | null>(null);

  const handleTestServer = async (testUrl: string) => {
    setTestingServer(true);
    setServerTestResult(null);
    try {
      const cleanUrl = testUrl.trim().replace(/\/+$/, '');
      const healthUrl = cleanUrl ? `${cleanUrl}/api/health` : '/api/health';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const isSuperAdminConfigured = Boolean(data?.checks?.superadminConfigured);
        setServerTestResult({
          success: true,
          message: isSuperAdminConfigured
            ? 'Kết nối máy chủ thành công! Biến SUPERADMIN_PASSWORD đã được kích hoạt.'
            : 'Máy chủ phản hồi OK, nhưng bạn chưa đặt biến SUPERADMIN_PASSWORD trong phần Environment Variables trên Vercel!',
          superadmin: isSuperAdminConfigured
        });
      } else {
        setServerTestResult({
          success: false,
          message: `Máy chủ phản hồi mã lỗi HTTP ${res.status}. Vui lòng kiểm tra lại cấu hình.`
        });
      }
    } catch (e: any) {
      setServerTestResult({
        success: false,
        message: 'Không thể kết nối đến địa chỉ này. Hãy đảm bảo máy chủ Vercel đã deploy và nhập đúng URL (https://...).'
      });
    } finally {
      setTestingServer(false);
    }
  };

  const handleSaveServerUrl = () => {
    setCustomApiUrl(serverInputUrl.trim());
    setError('');
    setShowServerModal(false);
  };

  const handleResetServerUrl = () => {
    setCustomApiUrl('');
    setServerInputUrl(getApiBaseUrl());
    setServerTestResult(null);
  };

  useEffect(() => {
    if (initialStoreCode) setStoreCode(initialStoreCode);
    if (initialUsername) setUsername(initialUsername);
  }, [initialStoreCode, initialUsername]);

  useEffect(() => {
    const checkConnection = async () => {
      try {
        // Cài đặt bộ đếm thời gian 15 giây để chống treo vô hạn
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('TIMEOUT_15S')), 15000)
        );
        // Kiểm tra kết nối qua tài liệu cài đặt công khai thay vì đọc bảng users
        const queryPromise = getDoc(doc(db, 'app_settings', 'android_version'));
        
        await Promise.race([queryPromise, timeoutPromise]);
        
        setConnectionStatus('online');
      } catch (err: any) {
        console.error('Firebase connection check failed:', err);
        setConnectionStatus('offline');
        
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

      // 1. GỌI API ĐĂNG NHẬP BẢO MẬT PHÍA SERVER (sử dụng apiUrl tương thích cả Web và Native APK)
      try {
        const resp = await fetch(apiUrl('/api/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storeCode: storeCode.trim(),
            username: username.trim(),
            password: password.trim()
          })
        });

        if (resp.ok) {
          const result = await resp.json();
          if (result.success && result.user) {
            // Xác thực với Firebase Auth qua Custom Token do server Vercel cấp
            if (result.customToken && !result.customToken.startsWith('dev_token_')) {
              try {
                await signInWithCustomToken(auth, result.customToken);
              } catch (authErr: any) {
                console.error("signInWithCustomToken error:", authErr?.message || authErr);
                setError('Không thể hoàn tất xác thực quyền truy cập dữ liệu với máy chủ. Vui lòng thử lại.');
                setLoading(false);
                return;
              }
            }

            onLogin(result.user);
            return;
          }
        } else {
          // Server đã phản hồi từ chối (401, 403, 404, 429, 500, 503) -> Dừng lại và hiển thị lỗi, KHÔNG fallback
          const errData = await resp.json().catch(() => ({}));
          const fallbackError = resp.status >= 500 
            ? `Máy chủ Vercel gặp sự cố nội bộ (HTTP ${resp.status}: FUNCTION_INVOCATION_FAILED). Vui lòng xem tab Logs trên Vercel.`
            : 'Tên đăng nhập hoặc mật khẩu không đúng';
          setError(errData.error || fallbackError);
          setLoading(false);
          return;
        }
      } catch (apiErr) {
        console.warn("API login network unreachable, fallback sang kiểm tra trực tiếp:", apiErr);
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

        // B. Nếu không có trường password (tài khoản đã nâng cấp bảo mật như luontv37):
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
          try {
            await updateDoc(doc(db, 'users', userDoc.id), {
              lastLogin: new Date().toISOString()
            });
          } catch (e) {}

          onLogin({
            ...userData,
            id: userDoc.id,
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
          <p className="text-gray-500">Đăng nhập để bắt đầu ca làm việc</p>
          
          <div className="flex items-center justify-center gap-2 pt-2">
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

            <button
              type="button"
              onClick={() => {
                setServerInputUrl(getCustomApiUrl() || getApiBaseUrl());
                setServerTestResult(null);
                setShowServerModal(true);
              }}
              className="p-1.5 text-gray-400 hover:text-emerald-500 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors cursor-pointer"
              title="Cấu hình máy chủ backend (Vercel / Cloud Run)"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
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
              
              {/* Nút hỗ trợ khắc phục nhanh khi máy chủ không phản hồi */}
              {(error.includes('máy chủ') || error.includes('kết nối mạng') || error.includes('không khả dụng')) && (
                <button
                  type="button"
                  onClick={() => {
                    setServerInputUrl(getCustomApiUrl() || getApiBaseUrl());
                    setServerTestResult(null);
                    setShowServerModal(true);
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2.5 px-3 bg-rose-500/20 hover:bg-rose-500/30 text-rose-700 dark:text-rose-300 rounded-xl text-xs font-semibold transition-colors cursor-pointer border border-rose-500/30 shadow-sm"
                >
                  <Server className="w-4 h-4 shrink-0" /> Cấu hình địa chỉ máy chủ backend (Vercel)
                </button>
              )}

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

            <div className="pt-2 overflow-hidden w-full flex justify-center">
              <p className="text-[10px] sm:text-xs text-gray-400 dark:text-gray-600 uppercase tracking-widest whitespace-nowrap overflow-hidden text-ellipsis text-center">HỆ THỐNG QUẢN LÝ NHÀ HÀNG CHUYÊN NGHIỆP</p>
            </div>
          </div>
      </motion.div>

      {/* MODAL CẤU HÌNH MÁY CHỦ CHO ANDROID / NATIVE */}
      <AnimatePresence>
        {showServerModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-md bg-white dark:bg-[#18191c] border border-black/10 dark:border-white/10 rounded-2xl p-6 shadow-2xl space-y-5"
            >
              <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-500">
                    <Server className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-900 dark:text-white text-base">Cấu hình máy chủ API</h3>
                    <p className="text-xs text-gray-500">Kết nối ứng dụng tới backend Vercel</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowServerModal(false)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-3">
                <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                  Địa chỉ máy chủ Backend (Server URL):
                </label>
                <div className="relative">
                  <Globe className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="url"
                    placeholder="https://fnb-xxx.vercel.app"
                    value={serverInputUrl}
                    onChange={(e) => setServerInputUrl(e.target.value)}
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2.5 pl-10 pr-3 text-xs sm:text-sm text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <p className="text-[11px] text-gray-400 leading-relaxed">
                  💡 Nhập link dự án Vercel của bạn (ví dụ <span className="font-mono text-emerald-400">https://fnb-20.vercel.app</span>). Khi lưu, ứng dụng Android sẽ gọi trực tiếp đến server này.
                </p>

                {serverTestResult && (
                  <div className={`p-3 rounded-xl text-xs border ${
                    serverTestResult.success 
                      ? (serverTestResult.superadmin 
                          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400' 
                          : 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400')
                      : 'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400'
                  }`}>
                    <p className="font-medium">{serverTestResult.message}</p>
                  </div>
                )}
              </div>

              <div className="space-y-2 pt-2">
                <button
                  type="button"
                  onClick={() => handleTestServer(serverInputUrl)}
                  disabled={testingServer || !serverInputUrl.trim()}
                  className="w-full py-2.5 px-4 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-800 dark:text-gray-200 text-xs font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  {testingServer ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  Kiểm tra kết nối máy chủ
                </button>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleResetServerUrl}
                    className="flex-1 py-2.5 px-4 border border-black/10 dark:border-white/10 text-gray-600 dark:text-gray-400 text-xs font-semibold rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                  >
                    Khôi phục gốc
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveServerUrl}
                    className="flex-1 py-2.5 px-4 bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-bold rounded-xl transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-emerald-500/20"
                  >
                    <Check className="w-4 h-4" /> Lưu & Đăng nhập
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
