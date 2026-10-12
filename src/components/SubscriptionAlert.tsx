import React, { useState, useEffect } from 'react';
import { 
  ShieldCheck, 
  X, 
  LogOut, 
  Info, 
  CheckCircle2, 
  XCircle, 
  Sparkles, 
  ArrowRight, 
  QrCode, 
  Copy, 
  Check, 
  ChevronLeft, 
  CreditCard,
  Building2,
  Calendar,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { db } from '../lib/firebase';
import { collection, getDocs, doc, getDoc, onSnapshot } from 'firebase/firestore';
import { StorePackage, StorePackagePricing } from '../types';
import { APP_PACKAGE_TABS, isTabAllowedInPackage } from '../utils/packagePermissions';
import { cn } from '../lib/utils';

export const SubscriptionModal = ({ 
  store, 
  onClose, 
  isForced, 
  onLogout 
}: { 
  store: any, 
  onClose?: () => void, 
  isForced?: boolean, 
  onLogout?: () => void 
}) => {
  const [packages, setPackages] = useState<StorePackage[]>([]);
  const [selectedPackage, setSelectedPackage] = useState<StorePackage | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number>(1);
  const [isCheckoutStep, setIsCheckoutStep] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  // System bank config (managed by Super Admin in 'system/config')
  const [systemConfig, setSystemConfig] = useState<{
    bankCode?: string;
    bankAccountNumber?: string;
    bankAccountName?: string;
  }>({
    bankCode: 'MB',
    bankAccountNumber: '',
    bankAccountName: ''
  });

  // 1. Fetch system bank config & commercial packages
  useEffect(() => {
    const loadData = async () => {
      try {
        // Load bank config
        const configDoc = await getDoc(doc(db, 'system', 'config'));
        if (configDoc.exists()) {
          setSystemConfig(configDoc.data() as any);
        }

        // Load packages (filter out 'trial' as requested: chỉ hiển thị các gói kinh doanh, bỏ gói dùng thử)
        const snap = await getDocs(collection(db, 'packages'));
        if (!snap.empty) {
          const pkgs = snap.docs
            .map(d => ({ ...d.data(), id: d.id } as StorePackage))
            .filter(p => p.id !== 'trial' && !p.name.toLowerCase().includes('dùng thử'));
          setPackages(pkgs);
          if (pkgs.length > 0) {
            const currentPkgMatch = pkgs.find(p => p.id === store?.subscription?.packageId);
            const defaultPkg = currentPkgMatch || pkgs[0];
            setSelectedPackage(defaultPkg);
            const initialDuration = defaultPkg.pricing && defaultPkg.pricing.length > 0 ? defaultPkg.pricing[0].durationMonths : 1;
            setSelectedDuration(initialDuration);
          }
        }
      } catch (err) {
        console.error("Error loading subscription data:", err);
      }
    };
    loadData();
  }, [store?.subscription?.packageId]);

  // 2. Realtime listener to detect automatic activation when SePay webhook updates this store
  useEffect(() => {
    if (!store?.id) return;
    const initialStatus = store?.subscription?.status;
    const initialValidUntil = store?.subscription?.validUntil;

    const unsub = onSnapshot(doc(db, 'stores', store.id), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const updatedSub = data?.subscription;
        if (updatedSub) {
          // If status turned active or validUntil was extended
          if (
            (initialStatus !== 'active' && updatedSub.status === 'active') ||
            (initialValidUntil && updatedSub.validUntil && updatedSub.validUntil !== initialValidUntil)
          ) {
            setPaymentSuccess(true);
          }
        }
      }
    });

    return () => unsub();
  }, [store?.id]);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2500);
  };

  // Calculate price for selected duration
  const getPackagePrice = (pkg: StorePackage, durationMonths: number) => {
    if (pkg.pricing && pkg.pricing.length > 0) {
      const option = pkg.pricing.find(p => p.durationMonths === durationMonths);
      if (option) return option.price;
    }
    return (pkg.price || 0) * durationMonths;
  };

  const currentPrice = selectedPackage ? getPackagePrice(selectedPackage, selectedDuration) : 0;
  
  const storeCode = (store?.code || 'STORE').toUpperCase();
  const pkgCode = selectedPackage ? selectedPackage.id.toLowerCase() : 'pro';

  // VietinBank (CTG / VIETINBANK) requires SePay transactions to start with 'SEVQR'
  // Example: SEVQR LUONDAKLAK GIAHAN pro 12
  const isVietinBank = ['CTG', 'VIETINBANK', 'ICB'].includes((systemConfig.bankCode || '').toUpperCase().trim());
  const prefix = isVietinBank ? 'SEVQR ' : '';
  const transferContent = `${prefix}${storeCode} GIAHAN ${pkgCode} ${selectedDuration}`;

  // VietQR Quick Link
  const vietQrUrl = systemConfig.bankCode && systemConfig.bankAccountNumber
    ? `https://img.vietqr.io/image/${systemConfig.bankCode}-${systemConfig.bankAccountNumber}-compact2.png?amount=${currentPrice}&accountName=${encodeURIComponent(systemConfig.bankAccountName || '')}&addInfo=${encodeURIComponent(transferContent)}`
    : '';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-xl bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl relative flex flex-col items-center text-center space-y-5 my-8 max-h-[92vh] overflow-y-auto"
      >
        {/* Close Button */}
        {onClose && !isForced && (
          <button 
            onClick={onClose} 
            className="absolute top-4 right-4 p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition-colors z-10 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        {/* Forced Logout Button */}
        {onLogout && isForced && (
          <button 
            onClick={onLogout} 
            className="absolute top-4 right-4 flex items-center gap-1.5 text-rose-500 hover:text-rose-600 bg-rose-50 dark:bg-rose-500/10 px-3 py-1.5 rounded-xl z-10 transition-colors cursor-pointer text-xs font-bold"
          >
            <LogOut className="w-4 h-4" />
            <span>Đăng xuất</span>
          </button>
        )}

        {/* Icon & Title */}
        <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center text-emerald-600 dark:text-emerald-500 border border-emerald-500/20">
          <ShieldCheck className="w-7 h-7" />
        </div>

        <div>
          <h2 className="text-xl md:text-2xl font-bold text-gray-900 dark:text-white mb-1">
            {isCheckoutStep ? 'Thanh toán & Kích hoạt tự động' : 'Nâng cấp & Gia hạn gói dịch vụ'}
          </h2>
          <p className="text-gray-500 dark:text-gray-400 text-xs md:text-sm">
            {isCheckoutStep
              ? 'Quét mã VietQR chuyển khoản để hệ thống tự động kích hoạt tài khoản ngay sau 3 - 5 giây.'
              : isForced
                ? 'Gói dịch vụ của cửa hàng đã hết hạn. Vui lòng chọn gói bên dưới để tiếp tục sử dụng.'
                : 'Mở khóa đầy đủ các tính năng kinh doanh chuyên nghiệp cho nhà hàng & quán ăn của bạn.'}
          </p>
        </div>

        {/* Store Summary Info */}
        <div className="w-full bg-black/5 dark:bg-white/5 rounded-2xl p-4 text-left text-xs md:text-sm space-y-1.5 border border-black/5 dark:border-white/5">
          <div className="flex justify-between items-center">
            <span className="text-gray-500">Mã gian hàng:</span>
            <span className="font-mono font-bold text-gray-900 dark:text-white">{storeCode}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500">Tên cửa hàng:</span>
            <span className="font-medium text-gray-900 dark:text-white">{store?.name}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500">Trạng thái:</span>
            <span className={cn("font-bold", isForced ? "text-rose-500" : "text-emerald-500")}>
              {isForced ? 'Đã hết hạn' : 'Đang hoạt động'}
            </span>
          </div>
        </div>

        {/* Success Modal when payment detected */}
        {paymentSuccess && (
          <div className="w-full bg-emerald-500/15 border border-emerald-500/30 p-5 rounded-2xl text-emerald-800 dark:text-emerald-300 space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500 text-white flex items-center justify-center">
              <Check className="w-6 h-6 stroke-[3]" />
            </div>
            <h3 className="font-bold text-base">Thanh toán & Kích hoạt thành công!</h3>
            <p className="text-xs">
              Hệ thống đã nhận được giao dịch và tự động gia hạn gói dịch vụ cho gian hàng <b>{storeCode}</b>.
            </p>
            <button
              onClick={() => {
                if (onClose) onClose();
                else window.location.reload();
              }}
              className="w-full py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-xl text-sm transition-all"
            >
              Vào sử dụng ngay
            </button>
          </div>
        )}

        {/* STEP 1: SELECT COMMERCIAL PACKAGE */}
        {!isCheckoutStep && !paymentSuccess && (
          <div className="w-full text-left space-y-4">
            <div className="flex items-center gap-1.5 text-xs font-bold text-gray-900 dark:text-white">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span>Chọn gói kinh doanh phù hợp:</span>
            </div>

            {packages.length === 0 ? (
              <div className="text-center py-6 text-xs text-gray-400">
                Đang tải danh sách các gói dịch vụ...
              </div>
            ) : (
              <div className="space-y-3">
                {packages.map(pkg => {
                  const isCurrent = store?.subscription?.packageId === pkg.id;
                  const isSelected = selectedPackage?.id === pkg.id;

                  return (
                    <div 
                      key={pkg.id} 
                      onClick={() => {
                        setSelectedPackage(pkg);
                        const initialDuration = pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing[0].durationMonths : 1;
                        setSelectedDuration(initialDuration);
                      }}
                      className={cn(
                        "p-4 rounded-2xl border transition-all cursor-pointer relative",
                        isSelected 
                          ? "bg-emerald-500/10 border-emerald-500 shadow-sm" 
                          : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 hover:border-black/20 dark:hover:border-white/20"
                      )}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-base text-gray-900 dark:text-white">{pkg.name}</span>
                          {isCurrent && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500 text-white">
                              Đang dùng
                            </span>
                          )}
                        </div>
                        <span className="font-bold text-sm text-emerald-600 dark:text-emerald-400">
                          {((pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing[0].price : pkg.price) || 0).toLocaleString()}đ / {(pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing[0].durationMonths : 1)} tháng
                        </span>
                      </div>

                      {/* Tab Features Matrix */}
                      <div className="grid grid-cols-2 gap-1.5 text-[11px] mb-3">
                        {APP_PACKAGE_TABS.map(tab => {
                          const isAllowed = isTabAllowedInPackage(tab.id, pkg);
                          return (
                            <div 
                              key={tab.id}
                              className={cn(
                                "flex items-center gap-1.5",
                                isAllowed ? "text-emerald-700 dark:text-emerald-400 font-medium" : "text-gray-400 line-through opacity-50"
                              )}
                            >
                              {isAllowed ? (
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              ) : (
                                <XCircle className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                              )}
                              <span className="truncate">{tab.label}</span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Upgrade or Renew Action Button based on current package */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedPackage(pkg);
                          const initialDuration = pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing[0].durationMonths : 1;
                          setSelectedDuration(initialDuration);
                          setIsCheckoutStep(true);
                        }}
                        className={cn(
                          "w-full py-2.5 px-4 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm",
                          isCurrent
                            ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                            : isSelected
                              ? "bg-emerald-500 hover:bg-emerald-600 text-white"
                              : "bg-gray-900 hover:bg-black dark:bg-white dark:hover:bg-gray-100 text-white dark:text-black"
                        )}
                      >
                        <span>{isCurrent ? 'Gia hạn gói này' : 'Nâng cấp & Thanh toán gói này'}</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* STEP 2: CHECKOUT & AUTOMATIC REGISTRATION FLOW */}
        {isCheckoutStep && !paymentSuccess && selectedPackage && (
          <div className="w-full text-left space-y-4">
            {/* Back button */}
            <button
              onClick={() => setIsCheckoutStep(false)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer font-medium"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Quay lại chọn gói khác</span>
            </button>

            {/* Selected Package Info */}
            <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase font-bold text-emerald-600 dark:text-emerald-400 tracking-wider">Gói đã chọn</span>
                <h4 className="font-bold text-base text-gray-900 dark:text-white">{selectedPackage.name}</h4>
              </div>
              <div className="text-right">
                <span className="text-[10px] text-gray-500 block">Số tiền thanh toán</span>
                <span className="font-bold text-base text-emerald-600 dark:text-emerald-400">
                  {currentPrice.toLocaleString()}đ
                </span>
              </div>
            </div>

            {/* Duration Selector */}
            {selectedPackage.pricing && selectedPackage.pricing.length > 0 && (
              <div>
                <label className="text-xs font-bold text-gray-700 dark:text-gray-300 mb-1.5 block">
                  Thời hạn gia hạn:
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {selectedPackage.pricing.map((opt: StorePackagePricing) => (
                    <button
                      key={opt.durationMonths}
                      type="button"
                      onClick={() => setSelectedDuration(opt.durationMonths)}
                      className={cn(
                        "py-2.5 px-3 rounded-xl border text-xs font-bold transition-all cursor-pointer flex flex-col items-center gap-0.5",
                        selectedDuration === opt.durationMonths
                          ? "bg-emerald-500 text-white border-emerald-500 shadow-sm"
                          : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-700 dark:text-gray-300"
                      )}
                    >
                      <span>{opt.durationMonths} Tháng</span>
                      <span className="text-[10px] font-normal opacity-90">{opt.price.toLocaleString()}đ</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* VietQR Code Box */}
            <div className="bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-2xl p-4 flex flex-col items-center text-center space-y-3">
              {vietQrUrl ? (
                <>
                  <div className="bg-white p-3 rounded-2xl shadow-inner border border-black/5">
                    <img 
                      src={vietQrUrl} 
                      alt="VietQR Tự Động Kích Hoạt" 
                      className="w-56 h-auto mx-auto rounded-lg object-contain" 
                    />
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-bold">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Hệ thống đang chờ nhận tiền để tự động kích hoạt...</span>
                  </div>
                </>
              ) : (
                <div className="py-6 text-xs text-amber-500">
                  Hệ thống chưa thiết lập thông tin ngân hàng nhận thanh toán trong Super Admin.
                </div>
              )}
            </div>

            {/* Bank Transfer Details with Copy Buttons */}
            <div className="space-y-2 bg-black/5 dark:bg-white/5 p-4 rounded-2xl border border-black/5 dark:border-white/5 text-xs">
              <div className="flex justify-between items-center py-1 border-b border-black/5 dark:border-white/5">
                <span className="text-gray-500 flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5" /> Ngân hàng:
                </span>
                <span className="font-bold text-gray-900 dark:text-white uppercase">
                  {systemConfig.bankCode || 'MB'}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-black/5 dark:border-white/5">
                <span className="text-gray-500 flex items-center gap-1.5">
                  <CreditCard className="w-3.5 h-3.5" /> Số tài khoản:
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-gray-900 dark:text-white">
                    {systemConfig.bankAccountNumber || '---'}
                  </span>
                  {systemConfig.bankAccountNumber && (
                    <button
                      onClick={() => handleCopy(systemConfig.bankAccountNumber!, 'account')}
                      className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded text-gray-500 hover:text-gray-900 dark:hover:text-white cursor-pointer"
                      title="Sao chép số tài khoản"
                    >
                      {copiedField === 'account' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-black/5 dark:border-white/5">
                <span className="text-gray-500">Chủ tài khoản:</span>
                <span className="font-bold text-gray-900 dark:text-white uppercase">
                  {systemConfig.bankAccountName || '---'}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-b border-black/5 dark:border-white/5">
                <span className="text-gray-500">Số tiền:</span>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">
                    {currentPrice.toLocaleString()} VNĐ
                  </span>
                  <button
                    onClick={() => handleCopy(String(currentPrice), 'amount')}
                    className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded text-gray-500 hover:text-gray-900 dark:hover:text-white cursor-pointer"
                    title="Sao chép số tiền"
                  >
                    {copiedField === 'amount' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* CRITICAL TRANSFER CONTENT FOR SEPAY AUTO ACTIVATION */}
              <div className="py-2">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-gray-500 font-bold flex items-center gap-1 text-rose-500">
                    Nội dung chuyển khoản (bắt buộc):
                  </span>
                  <button
                    onClick={() => handleCopy(transferContent, 'content')}
                    className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-bold hover:underline cursor-pointer"
                  >
                    {copiedField === 'content' ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Đã chép</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Sao chép</span>
                      </>
                    )}
                  </button>
                </div>
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl font-mono font-bold text-amber-700 dark:text-amber-400 text-sm tracking-wide text-center select-all">
                  {transferContent}
                </div>
                {isVietinBank && (
                  <div className="mt-2 p-2 bg-blue-500/10 border border-blue-500/20 rounded-lg text-[11px] text-blue-700 dark:text-blue-300">
                    💡 <b>Quy định VietinBank:</b> SePay yêu cầu nội dung phải bắt đầu bằng chữ <b>SEVQR</b> để hệ thống nhận diện biến động số dư tức thì.
                  </div>
                )}
                <p className="text-[11px] text-gray-500 mt-1">
                  * Vui lòng giữ nguyên nội dung chuyển khoản trên để hệ thống tự động nhận diện và kích hoạt gói ngay lập tức.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Action Bottom Buttons */}
        <div className="w-full pt-2">
          {onClose && !isForced ? (
            <button 
              onClick={onClose}
              className="w-full py-3 bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/15 text-gray-700 dark:text-gray-300 rounded-xl font-bold transition-all cursor-pointer text-sm"
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
        {(showModal || isExpired) && (
          <SubscriptionModal 
            store={store} 
            isForced={isExpired} 
            onClose={() => setShowModal(false)} 
            onLogout={onLogout} 
          />
        )}
      </AnimatePresence>
    </>
  );
};
