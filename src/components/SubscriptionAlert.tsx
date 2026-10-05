import React, { useState, useEffect } from 'react';
import { AlertCircle, ShieldCheck, X, LogOut, Info, CheckCircle2, XCircle, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db } from '../lib/firebase';
import { collection, getDocs } from 'firebase/firestore';
import { StorePackage } from '../types';
import { APP_PACKAGE_TABS, isTabAllowedInPackage } from '../utils/packagePermissions';
import { cn } from '../lib/utils';

export const SubscriptionModal = ({ store, onClose, isForced, onLogout }: { store: any, onClose?: () => void, isForced?: boolean, onLogout?: () => void }) => {
  const [packages, setPackages] = useState<StorePackage[]>([]);

  useEffect(() => {
    const loadPackages = async () => {
      try {
        const snap = await getDocs(collection(db, 'packages'));
        if (!snap.empty) {
          const pkgs = snap.docs.map(d => ({ ...d.data(), id: d.id } as StorePackage));
          setPackages(pkgs);
        }
      } catch (err) {
        console.error(err);
      }
    };
    loadPackages();
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-lg bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl relative flex flex-col items-center text-center space-y-5 my-8 max-h-[90vh] overflow-y-auto"
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
        
        <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center text-emerald-600 dark:text-emerald-500 border border-emerald-500/20">
          <ShieldCheck className="w-7 h-7" />
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1.5">Nâng cấp & Quản lý gói dịch vụ</h2>
          <p className="text-gray-600 dark:text-gray-400 text-xs md:text-sm leading-relaxed">
            {isForced 
              ? 'Thời gian sử dụng của cửa hàng đã hết hạn. Vui lòng liên hệ Quản trị viên hệ thống để nâng cấp hoặc gia hạn.'
              : 'Chọn gói dịch vụ phù hợp để mở khóa toàn bộ các tính năng Nhà bếp, Kho hàng, Khách hàng, Báo cáo và Tổng kết.'}
          </p>
        </div>

        <div className="w-full bg-black/5 dark:bg-white/5 rounded-2xl p-4 text-left text-xs md:text-sm space-y-1.5 border border-black/5 dark:border-white/5">
          <div className="flex justify-between">
            <span className="text-gray-500">Mã gian hàng:</span>
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

        {/* Packages Comparison */}
        {packages.length > 0 && (
          <div className="w-full text-left space-y-3 pt-2 border-t border-black/5 dark:border-white/5">
            <div className="flex items-center gap-1.5 text-xs font-bold text-gray-900 dark:text-white">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span>Các gói dịch vụ & Tính năng Tab được hỗ trợ:</span>
            </div>

            <div className="space-y-3">
              {packages.map(pkg => (
                <div 
                  key={pkg.id} 
                  className={cn(
                    "p-3.5 rounded-2xl border transition-all",
                    store?.subscription?.packageId === pkg.id 
                      ? "bg-emerald-500/10 border-emerald-500/40" 
                      : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-gray-900 dark:text-white">{pkg.name}</span>
                      {store?.subscription?.packageId === pkg.id && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500 text-white">
                          Gói hiện tại
                        </span>
                      )}
                    </div>
                    <span className="font-bold text-xs text-emerald-600 dark:text-emerald-400">
                      {pkg.id === 'trial' ? 'Miễn phí' : `${((pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing[0].price : pkg.price) || 0).toLocaleString()}đ`}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-1 text-[11px]">
                    {APP_PACKAGE_TABS.map(tab => {
                      const isAllowed = isTabAllowedInPackage(tab.id, pkg);
                      return (
                        <div 
                          key={tab.id}
                          className={cn(
                            "flex items-center gap-1",
                            isAllowed ? "text-emerald-700 dark:text-emerald-400 font-medium" : "text-gray-400 line-through opacity-60"
                          )}
                        >
                          {isAllowed ? (
                            <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                          ) : (
                            <XCircle className="w-3 h-3 text-gray-400 shrink-0" />
                          )}
                          <span className="truncate">{tab.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="w-full text-center text-xs text-gray-500 dark:text-gray-400 bg-amber-500/10 border border-amber-500/20 p-3 rounded-xl">
          Quý khách vui lòng liên hệ trực tiếp <span className="font-bold text-gray-900 dark:text-white">Quản trị viên hệ thống</span> để được tư vấn và kích hoạt gói ngay lập tức.
        </div>

        <div className="w-full">
          {onClose && !isForced ? (
            <button 
              onClick={onClose}
              className="w-full py-3 bg-gray-900 text-white dark:bg-white dark:text-black rounded-xl font-bold transition-all cursor-pointer text-sm"
            >
              Đóng
            </button>
          ) : onLogout ? (
            <button 
              onClick={onLogout}
              className="w-full py-3 bg-rose-500 hover:bg-rose-600 text-white rounded-xl font-bold transition-all cursor-pointer text-sm"
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
