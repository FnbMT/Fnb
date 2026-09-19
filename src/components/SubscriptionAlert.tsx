import React, { useState, useEffect } from 'react';
import { AlertCircle, ShieldCheck, X, LogOut, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export const SubscriptionModal = ({ store, onClose, isForced, onLogout }: { store: any, onClose?: () => void, isForced?: boolean, onLogout?: () => void }) => {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-md bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-3xl p-8 shadow-2xl relative flex flex-col items-center text-center space-y-6"
      >
        {onClose && !isForced && (
          <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-900 dark:hover:text-white z-10 cursor-pointer">
            <X className="w-6 h-6" />
          </button>
        )}
        {onLogout && isForced && (
          <button onClick={onLogout} className="absolute top-4 right-4 flex items-center gap-2 text-rose-500 hover:text-rose-600 bg-rose-50 dark:bg-rose-500/10 px-3 py-1.5 rounded-lg z-10 transition-colors cursor-pointer">
             <LogOut className="w-4 h-4" />
             <span className="text-sm font-bold">Đăng xuất</span>
          </button>
        )}
        
        <div className="w-16 h-16 bg-blue-500/10 rounded-2xl flex items-center justify-center text-blue-600 dark:text-blue-500 border border-blue-500/20">
          <ShieldCheck className="w-8 h-8" />
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Thông tin tài khoản cửa hàng</h2>
          <p className="text-gray-600 dark:text-gray-400 text-sm leading-relaxed">
            {isForced 
              ? 'Thời gian sử dụng của cửa hàng đã hết hạn. Vui lòng liên hệ Quản trị viên hệ thống để được hỗ trợ.'
              : 'Ứng dụng POS kết nối đồng bộ với tài khoản cửa hàng được cấp bởi Quản trị viên.'}
          </p>
        </div>

        <div className="w-full bg-black/5 dark:bg-white/5 rounded-2xl p-4 text-left text-sm space-y-2 border border-black/5 dark:border-white/5">
          <div className="flex justify-between">
            <span className="text-gray-500">Mã cửa hàng:</span>
            <span className="font-bold text-gray-900 dark:text-white">{store?.code?.toUpperCase()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Tên cửa hàng:</span>
            <span className="font-medium text-gray-900 dark:text-white">{store?.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Trạng thái:</span>
            <span className={`font-bold ${isForced ? 'text-rose-500' : 'text-emerald-500'}`}>
              {isForced ? 'Đã hết hạn' : 'Đang hoạt động'}
            </span>
          </div>
        </div>

        <div className="w-full">
          {onClose && !isForced ? (
            <button 
              onClick={onClose}
              className="w-full py-3 bg-gray-900 text-white dark:bg-white dark:text-black rounded-xl font-bold transition-all cursor-pointer"
            >
              Đóng
            </button>
          ) : onLogout ? (
            <button 
              onClick={onLogout}
              className="w-full py-3 bg-rose-500 hover:bg-rose-600 text-white rounded-xl font-bold transition-all cursor-pointer"
            >
              Đăng xuất
            </button>
          ) : null}
        </div>
      </motion.div>
    </div>
  );
};

export const SubscriptionAlert = ({ store, onLogout }: { store: any, onLogout?: () => void }) => {
  const [showModal, setShowModal] = useState(false);
  const [daysRemaining, setDaysRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (store?.subscription) {
      const endDateStr = store.subscription.validUntil || store.subscription.trialEndDate;
      if (endDateStr) {
        const end = new Date(endDateStr).getTime();
        const now = new Date().getTime();
        const diff = end - now;
        const days = Math.ceil(diff / (1000 * 3600 * 24));
        setDaysRemaining(days);
        
        if (days <= 0) {
          setShowModal(true);
        } else {
          setShowModal(false);
        }
      }
    }
  }, [store?.subscription?.validUntil, store?.subscription?.trialEndDate]);

  if (!store?.subscription) return null;
  const isTrial = store.subscription.status === 'trial';
  
  if (daysRemaining === null) return null;
  const isExpired = daysRemaining <= 0;
  
  if (!showModal && !isExpired && (!isTrial || daysRemaining > 7)) return null;

  return (
    <>
      <div className={`p-3 text-sm flex items-center justify-between ${isExpired ? 'bg-rose-500 text-white' : 'bg-blue-600 text-white'}`}>
        <div className="flex items-center gap-2 font-bold">
          <Info className="w-5 h-5" />
          {isExpired 
            ? 'Thời gian sử dụng của cửa hàng đã hết hạn.' 
            : `Thời hạn sử dụng còn lại: ${daysRemaining} ngày.`}
        </div>
        <button 
          onClick={() => setShowModal(true)}
          className={`px-4 py-1.5 rounded-full text-xs font-bold ${isExpired ? 'bg-white text-rose-600' : 'bg-white text-blue-700'} cursor-pointer`}
        >
          Chi tiết
        </button>
      </div>

      <AnimatePresence>
        {(showModal || isExpired) && <SubscriptionModal store={store} isForced={isExpired} onClose={() => setShowModal(false)} onLogout={onLogout} />}
      </AnimatePresence>
    </>
  );
};
