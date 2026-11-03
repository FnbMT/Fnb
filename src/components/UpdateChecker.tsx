import React, { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { Download, Sparkles, AlertCircle, ArrowUpRight, Apple, Smartphone } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';

// Fallback version if native runtime info is unavailable (e.g. dev/web)
export const CURRENT_LOCAL_VERSION = '1.0.3';

export interface VersionInfo {
  version: string;
  releaseNotes?: string;
  isMandatory?: boolean;
  apkUrl?: string;       // Cho Android
  appStoreUrl?: string;  // Cho iOS (Apple App Store URL)
  updatedAt?: string;
}

interface UpdateCheckerProps {
  onNotifyPush?: (notif: {
    id: string;
    title: string;
    description: string;
    type: 'warning' | 'error' | 'info';
    actionText?: string;
    action?: () => void;
  }) => void;
}

/**
 * So sánh 2 chuỗi phiên bản dạng Semantic Versioning (ví dụ: '1.0.10' vs '1.0.9').
 * Trả về true nếu remoteVer lớn hơn localVer.
 */
export function isNewerVersion(remoteVer?: string, localVer?: string): boolean {
  if (!remoteVer || !localVer) return false;
  const clean = (v: string) => v.trim().replace(/^[vV]/, '');
  const rParts = clean(remoteVer).split('.').map(p => parseInt(p, 10) || 0);
  const lParts = clean(localVer).split('.').map(p => parseInt(p, 10) || 0);
  const maxLen = Math.max(rParts.length, lParts.length);

  for (let i = 0; i < maxLen; i++) {
    const r = rParts[i] ?? 0;
    const l = lParts[i] ?? 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

export const UpdateChecker: React.FC<UpdateCheckerProps> = ({ onNotifyPush }) => {
  const [showModal, setShowModal] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<VersionInfo | null>(null);
  const [currentAppVersion, setCurrentAppVersion] = useState<string>(CURRENT_LOCAL_VERSION);
  const [platform, setPlatform] = useState<'ios' | 'android' | 'web'>('web');

  useEffect(() => {
    let isMounted = true;

    const checkUpdate = async () => {
      try {
        const plat = Capacitor.getPlatform() as 'ios' | 'android' | 'web';
        if (isMounted) setPlatform(plat);

        // Lấy số phiên bản thực tế cài đặt trên điện thoại thông qua Capacitor App API
        let localVer = CURRENT_LOCAL_VERSION;
        if (Capacitor.isNativePlatform()) {
          try {
            const appInfo = await CapacitorApp.getInfo();
            if (appInfo && appInfo.version) {
              localVer = appInfo.version;
            }
          } catch (err) {
            console.warn('[UpdateChecker] Không đọc được native app version, dùng fallback:', err);
          }
        }
        if (isMounted) setCurrentAppVersion(localVer);

        // Quyết định tài liệu Firestore cần đọc tùy theo nền tảng:
        // - iOS: đọc 'app_settings/ios_version' (Tuân thủ Apple Guideline 2.5.2 & 2.3.10)
        // - Android: đọc 'app_settings/android_version' (Cho máy POS APK / Play Store)
        let docName = 'android_version';
        if (plat === 'ios') {
          docName = 'ios_version';
        } else if (plat === 'android') {
          docName = 'android_version';
        } else {
          // Trên môi trường Web/Browser, không hiển thị modal bắt buộc cài đặt của mobile
          return;
        }

        const snap = await getDoc(doc(db, 'app_settings', docName));
        if (!snap.exists()) return;

        const data = snap.data() as VersionInfo;
        const remoteVer = data?.version;

        if (!remoteVer) return;

        // So sánh bằng SemVer chuẩn
        const hasUpdate = isNewerVersion(remoteVer, localVer);
        if (!hasUpdate) return;

        const skipKey = `fnb_skipped_update_${plat}`;
        const skippedVersion = localStorage.getItem(skipKey);

        if (isMounted) {
          setUpdateInfo(data);

          // Nếu người dùng đã bấm "Bỏ qua" phiên bản này và bản cập nhật KHÔNG bắt buộc
          if (!data.isMandatory && skippedVersion === remoteVer) {
            // Không hiện modal chặn màn hình nhưng ghim thông báo vào chuông
            if (onNotifyPush) {
              onNotifyPush({
                id: `app-update-${plat}-${remoteVer}`,
                title: plat === 'ios' ? 'Cập nhật Fnb Master trên App Store' : 'Cập nhật Fnb Master',
                description: `Đã có phiên bản mới (${remoteVer}). Vui lòng cập nhật để trải nghiệm ổn định nhất!`,
                type: 'warning',
                actionText: plat === 'ios' ? 'Mở App Store' : 'Tải xuống',
                action: () => handleRedirect(data, plat)
              });
            }
          } else {
            // Hiển thị Modal thông báo
            setShowModal(true);
          }
        }
      } catch (err) {
        console.warn('[UpdateChecker] Lỗi kiểm tra cập nhật:', err);
      }
    };

    checkUpdate();

    return () => {
      isMounted = false;
    };
  }, [onNotifyPush]);

  const handleRedirect = (info: VersionInfo, plat: 'ios' | 'android' | 'web') => {
    if (plat === 'ios') {
      const url = info.appStoreUrl?.trim();
      if (url) {
        window.open(url, '_system');
      } else {
        alert("Đường dẫn App Store chưa được thiết lập!");
      }
    } else {
      const url = info.apkUrl?.trim();
      if (url) {
        window.open(url, '_blank');
      } else {
        alert("Đường dẫn tải tệp cập nhật chưa được thiết lập!");
      }
    }
  };

  const handleSkip = () => {
    if (!updateInfo) return;

    if (updateInfo.isMandatory) {
      alert("Đây là bản cập nhật quan trọng bắt buộc. Bạn cần cập nhật để đảm bảo tính toàn vẹn dữ liệu bán hàng!");
      return;
    }

    const skipKey = `fnb_skipped_update_${platform}`;
    localStorage.setItem(skipKey, updateInfo.version);
    setShowModal(false);

    if (onNotifyPush) {
      onNotifyPush({
        id: `app-update-${platform}-${updateInfo.version}`,
        title: platform === 'ios' ? 'Cập nhật Fnb Master trên App Store' : 'Cập nhật Fnb Master',
        description: `Đã có phiên bản mới (${updateInfo.version}). Vui lòng cập nhật sớm!`,
        type: 'warning',
        actionText: platform === 'ios' ? 'Mở App Store' : 'Tải xuống',
        action: () => handleRedirect(updateInfo, platform)
      });
    }
  };

  if (!showModal || !updateInfo) return null;

  const isIos = platform === 'ios';
  const targetUrl = isIos ? updateInfo.appStoreUrl : updateInfo.apkUrl;

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div 
        role="dialog" 
        aria-modal="true" 
        aria-labelledby="update-title"
        className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white rounded-3xl p-6 md:p-7 max-w-sm w-full shadow-2xl border border-black/10 dark:border-white/10 relative animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header Icon */}
        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-inner ${
          isIos 
            ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' 
            : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        }`}>
          {isIos ? (
            <Apple className="w-8 h-8" />
          ) : (
            <Smartphone className="w-8 h-8" />
          )}
        </div>

        {/* Tiêu đề & Phiên bản */}
        <h2 id="update-title" className="text-xl font-black text-center tracking-tight mb-1">
          {isIos ? 'Đã có bản cập nhật mới' : 'Bản cập nhật mới sẵn sàng'}
        </h2>

        <div className="flex items-center justify-center gap-2 mb-3">
          <span className="text-xs px-2.5 py-1 rounded-full bg-black/5 dark:bg-white/5 font-mono text-gray-500">
            Hiện tại: v{currentAppVersion}
          </span>
          <span className="text-xs text-gray-400 font-bold">→</span>
          <span className={`text-xs px-2.5 py-1 rounded-full font-mono font-bold ${
            isIos 
              ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' 
              : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          }`}>
            Mới nhất: v{updateInfo.version}
          </span>
        </div>

        <p className="text-center text-xs md:text-sm text-gray-600 dark:text-gray-400 mb-4 leading-relaxed">
          {isIos
            ? 'Phiên bản mới đã có mặt trên Apple App Store với các cải tiến hiệu năng và tính năng mới.'
            : 'Vui lòng cài đặt phiên bản mới nhất để đảm bảo đồng bộ hóa dữ liệu và in ấn hóa đơn ổn định.'}
        </p>

        {/* Cảnh báo cập nhật bắt buộc nếu có */}
        {updateInfo.isMandatory && (
          <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2 text-amber-800 dark:text-amber-300">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
            <p className="text-xs leading-relaxed font-medium">
              Đây là bản cập nhật bắt buộc nhằm đảm bảo bảo mật và tính toàn vẹn số liệu hệ thống.
            </p>
          </div>
        )}

        {/* Nội dung cập nhật (Release Notes) */}
        {updateInfo.releaseNotes && (
          <div className="bg-black/[0.03] dark:bg-white/[0.04] p-3.5 rounded-2xl mb-5 text-xs border border-black/5 dark:border-white/5 max-h-36 overflow-y-auto">
            <h4 className="font-bold mb-1.5 flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" /> Điểm mới trong bản này:
            </h4>
            <p className="whitespace-pre-wrap text-gray-600 dark:text-gray-400 leading-relaxed font-sans">
              {updateInfo.releaseNotes}
            </p>
          </div>
        )}

        {/* Nút hành động */}
        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => handleRedirect(updateInfo, platform)}
            className={`w-full font-bold py-3.5 px-4 rounded-xl text-center text-white transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer ${
              isIos
                ? 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 shadow-blue-600/20'
                : 'bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 shadow-emerald-500/20'
            }`}
          >
            {isIos ? (
              <>
                <span>Mở App Store để cập nhật</span>
                <ArrowUpRight className="w-4 h-4" />
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>Tải xuống & Cài đặt</span>
              </>
            )}
          </button>

          {!updateInfo.isMandatory && (
            <button
              type="button"
              onClick={handleSkip}
              className="w-full bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 font-semibold py-3 rounded-xl transition-colors text-xs md:text-sm cursor-pointer"
            >
              Để sau (Bỏ qua phiên bản này)
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
