import React, { useState, useEffect } from 'react';
import { AlertCircle, QrCode, X, ExternalLink, ShieldCheck, Check, LogOut, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';

export const SubscriptionModal = ({ store, onClose, isForced, onLogout }: { store: any, onClose?: () => void, isForced?: boolean, onLogout?: () => void }) => {
  const [packages, setPackages] = useState<any[]>([]);
  const [selectedPackage, setSelectedPackage] = useState<any>(null);
  const [initialValidUntil] = useState(store?.subscription?.validUntil || store?.subscription?.trialEndDate);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  useEffect(() => {
    if (packages.length > 0 && !selectedPackage) {
      const pkg = packages[0];
      const pricingOption = pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing[0] : { durationMonths: pkg.durationMonths, price: pkg.price || 0 };
      setSelectedPackage({ pkgId: pkg.id, name: pkg.name, ...pricingOption });
    }
  }, [packages, selectedPackage]);
  useEffect(() => {
    const currentValidUntil = store?.subscription?.validUntil || store?.subscription?.trialEndDate;
    if (initialValidUntil && currentValidUntil && new Date(currentValidUntil) > new Date(initialValidUntil)) {
      setPaymentSuccess(true);
    }
  }, [store?.subscription?.validUntil, store?.subscription?.trialEndDate, initialValidUntil]);

  const [systemConfig, setSystemConfig] = useState<any>(null);

  useEffect(() => {
    const fetchPackages = async () => {
      try {
        const { getDoc, doc } = await import('firebase/firestore');
        const configDoc = await getDoc(doc(db, 'system', 'config'));
        if (configDoc.exists()) {
          setSystemConfig(configDoc.data());
        }

        const snapshot = await getDocs(collection(db, 'packages'));
        const pkgs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any)).filter(p => p.id !== 'trial');
        pkgs.sort((a, b) => (a.price || 0) - (b.price || 0));
        setPackages(pkgs);
        if (pkgs.length > 0) {
          const firstPkg = pkgs[0];
          const firstPricing = firstPkg.pricing && firstPkg.pricing.length > 0 ? firstPkg.pricing[0] : { durationMonths: firstPkg.durationMonths, price: firstPkg.price || 0 };
          setSelectedPackage({ pkgId: firstPkg.id, name: firstPkg.name, ...firstPricing });
        }
      } catch (err) {
        console.error("Failed to load packages:", err);
      }
    };
    fetchPackages();
  }, []);

  const getSePayQR = (pkg: any) => {
    if (!pkg) return '';
    const bankCode = systemConfig?.bankCode || 'MB';
    const acc = systemConfig?.bankAccountNumber || '000000000';
    const amount = pkg.price;
    const isVietin = bankCode.toUpperCase() === 'ICB' || bankCode.toUpperCase() === 'CTG' || bankCode.toLowerCase().includes('vietin');
    const contentText = `${isVietin ? 'SEVQR ' : ''}${store.code} GIAHAN ${pkg.pkgId || pkg.id} ${pkg.durationMonths || 1}`.toUpperCase();
    const content = contentText.replace(/\s+/g, '%20').substring(0, 50);
    return `https://qr.sepay.vn/img?bank=${bankCode}&acc=${acc}&amount=${amount}&des=${content}`;
  };


  if (paymentSuccess) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="w-full max-w-md bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-3xl p-8 shadow-2xl relative flex flex-col items-center text-center"
        >
          <div className="w-20 h-20 bg-emerald-500/10 rounded-full flex items-center justify-center text-emerald-500 mb-6 shadow-lg shadow-emerald-500/20">
            <CheckCircle2 className="w-10 h-10" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Thanh toán thành công!</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6 leading-relaxed">
            Hệ thống đã ghi nhận đăng ký gói <strong className="text-emerald-600 dark:text-emerald-500">{selectedPackage?.name || 'mới'}</strong>, thời hạn <strong className="text-emerald-600 dark:text-emerald-500">{selectedPackage?.durationMonths || 1} tháng</strong>.<br/><br/>
            Hãy chờ vài phút để hệ thống đồng bộ.<br/>
            Liên hệ admin <strong className="text-gray-900 dark:text-white font-bold">0989929798</strong> nếu chưa được ghi nhận.
          </p>
          <button 
            onClick={() => {
              setPaymentSuccess(false);
              if (onClose) onClose();
            }}
            className="w-full py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-bold transition-colors shadow-lg shadow-emerald-500/30"
          >
            Đóng
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-4xl bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-3xl p-8 shadow-2xl relative flex flex-col md:flex-row gap-8 max-h-[90vh] overflow-y-auto"
      >
        {onClose && !isForced && (
          <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-900 dark:hover:text-white z-10">
            <X className="w-6 h-6" />
          </button>
        )}
        {onLogout && isForced && (
          <button onClick={onLogout} className="absolute top-4 right-4 flex items-center gap-2 text-rose-500 hover:text-rose-600 bg-rose-50 dark:bg-rose-500/10 px-3 py-1.5 rounded-lg z-10 transition-colors cursor-pointer">
             <LogOut className="w-4 h-4" />
             <span className="text-sm font-bold">Đăng xuất</span>
          </button>
        )}
        <div className="flex-1 space-y-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-500/10 rounded-xl flex items-center justify-center text-blue-600 dark:text-blue-500 border border-blue-500/20">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Chọn gói dịch vụ</h2>
              <p className="text-gray-600 dark:text-gray-400 text-sm">Gia hạn để không bị gián đoạn hoạt động kinh doanh.</p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 gap-4">
                  {packages.map(pkg => (
                    <div 
                      key={pkg.id} 
                      className="p-4 rounded-2xl border-2 border-black/10 dark:border-white/10"
                    >
                      <div className="flex justify-between items-center mb-2">
                        <h3 className="font-bold text-lg text-gray-900 dark:text-white flex items-center gap-2">
                          {pkg.name}
                        </h3>
                      </div>
                      <div className="flex gap-4 mb-4 text-sm text-gray-600 dark:text-gray-400 border-b border-black/5 dark:border-white/5 pb-4">
                        <div className="flex items-center gap-1"><Check className="w-4 h-4 text-emerald-500" /> Tối đa {pkg.features?.maxUsers || 'Không giới hạn'} nhân viên</div>
                        <div className="flex items-center gap-1"><Check className="w-4 h-4 text-emerald-500" /> Báo cáo: {pkg.features?.financialReports ? 'Có' : 'Không'}</div>
                      </div>
                      <div className="space-y-2">
                        {(pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing : [{ durationMonths: pkg.durationMonths, price: pkg.price || 0 }]).map((pricingOption: any, index: number) => {
                          const isSelected = selectedPackage?.pkgId === pkg.id && selectedPackage?.durationMonths === pricingOption.durationMonths;
                          return (
                            <div 
                              key={index}
                              onClick={() => setSelectedPackage({ pkgId: pkg.id, name: pkg.name, ...pricingOption })}
                              className={`flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all border ${isSelected ? 'border-blue-500 bg-blue-500/10' : 'border-black/10 dark:border-white/10 hover:border-blue-500/30'}`}
                            >
                              <span className="font-bold">{pricingOption.durationMonths} Tháng</span>
                              <div className="flex items-center gap-3">
                                <span className="font-bold text-blue-600 dark:text-blue-500">{(pricingOption.price || 0).toLocaleString()}đ</span>
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${isSelected ? 'border-blue-500' : 'border-gray-300 dark:border-gray-600'}`}>
                                  {isSelected && <div className="w-2.5 h-2.5 bg-blue-500 rounded-full" />}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

        </div>
        
        <div className="w-full md:w-80 bg-gray-50 dark:bg-black/20 rounded-2xl p-6 border border-black/10 dark:border-white/10 flex flex-col items-center justify-center text-center shrink-0">
          <h3 className="font-bold text-gray-900 dark:text-white mb-2">Thanh toán Quét Mã QR</h3>
          <p className="text-xs text-gray-500 mb-6">Hệ thống dùng SePay để duyệt tự động ngay sau 5s.</p>
          
          {selectedPackage && (
            <>
              <div className="bg-white p-4 rounded-xl shadow-sm mb-6 border border-black/5 w-full">
                <img src={getSePayQR(selectedPackage)} alt="QR Code" className="w-full h-auto aspect-square object-contain" />
              </div>
              
              <div className="w-full space-y-3 text-sm text-left">
                <div className="flex justify-between border-b border-black/5 dark:border-white/5 pb-2">
                  <span className="text-gray-500">Số tiền:</span>
                  <span className="font-bold text-gray-900 dark:text-white">{(selectedPackage.price || 0).toLocaleString()}đ</span>
                </div>
                <div className="flex flex-col gap-1 pb-2">
                  <span className="text-gray-500">Nội dung chuyển khoản:</span>
                  <span className="font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 p-2 rounded-lg text-center tracking-wider">{`${(systemConfig?.bankCode?.toUpperCase() === 'ICB' || systemConfig?.bankCode?.toUpperCase() === 'CTG' || systemConfig?.bankCode?.toLowerCase()?.includes('vietin')) ? 'SEVQR ' : ''}${store.code} GIAHAN ${selectedPackage.pkgId || selectedPackage.id} ${selectedPackage.durationMonths || 1}`.toUpperCase()}</span>
                </div>
                <p className="text-[11px] text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-500/10 p-2 rounded-lg text-center mt-2">
                  Lưu ý: Bạn phải ghi ĐÚNG nội dung chuyển khoản để hệ thống gia hạn tự động.
                </p>
              </div>
            </>
          )}
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
      <div className={`p-3 text-sm flex items-center justify-between ${isExpired ? 'bg-rose-500 text-white' : 'bg-amber-500 text-black'}`}>
        <div className="flex items-center gap-2 font-bold">
          <AlertCircle className="w-5 h-5" />
          {isExpired 
            ? 'Gói dùng thử đã hết hạn. Vui lòng thanh toán để tiếp tục sử dụng!' 
            : `Gói dùng thử sẽ hết hạn sau ${daysRemaining} ngày nữa.`}
        </div>
        <button 
          onClick={() => setShowModal(true)}
          className={`px-4 py-1.5 rounded-full text-xs font-bold ${isExpired ? 'bg-white text-rose-600 dark:text-rose-500' : 'bg-black text-amber-600 dark:text-amber-500'}`}
        >
          Gia hạn ngay
        </button>
      </div>

      <AnimatePresence>
        {(showModal || isExpired) && <SubscriptionModal store={store} isForced={isExpired} onClose={() => setShowModal(false)} onLogout={onLogout} />}
      </AnimatePresence>
    </>
  );
};
