import React, { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { Download, AlertCircle } from 'lucide-react';

// Hardcoded version of the web wrapper. If the DB version > this, show update.
// Actually it's better to store skipped versions in localStorage
export const CURRENT_LOCAL_VERSION = '1.0.0';

interface UpdateCheckerProps {
  onNotifyPush: (notif: any) => void;
}

export const UpdateChecker: React.FC<UpdateCheckerProps> = ({ onNotifyPush }) => {
  const [showModal, setShowModal] = useState(false);
  const [apkInfo, setApkInfo] = useState<any>(null);

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const snap = await getDoc(doc(db, 'app_settings', 'android_version'));
        if (snap.exists()) {
          const data = snap.data();
          const dbVersion = data.version;
          const skippedVersion = localStorage.getItem('skipped_update_version');
          
          if (dbVersion && dbVersion !== CURRENT_LOCAL_VERSION && dbVersion !== skippedVersion) {
            setApkInfo(data);
            setShowModal(true);
          } else if (dbVersion && dbVersion !== CURRENT_LOCAL_VERSION && dbVersion === skippedVersion) {
            // Already skipped but still out of date, push to bell
            onNotifyPush({
              id: 'app-update-pending',
              title: 'Cập nhật ứng dụng',
              description: `Đã có phiên bản mới (${dbVersion}). Vui lòng cập nhật!`,
              type: 'warning',
              actionText: 'Tải xuống',
              action: () => { window.open(data.apkUrl, '_blank'); }
            });
          }
        }
      } catch (e) {
        console.error(e);
      }
    };
    checkUpdate();
  }, [onNotifyPush]);

  if (!showModal || !apkInfo) return null;

  const handleSkip = () => {
    if (apkInfo.isMandatory) {
      alert("Đây là bản cập nhật bắt buộc, bạn không thể bỏ qua!");
      return;
    }
    localStorage.setItem('skipped_update_version', apkInfo.version);
    setShowModal(false);
    onNotifyPush({
      id: 'app-update-pending',
      title: 'Cập nhật ứng dụng',
      description: `Đã có phiên bản mới (${apkInfo.version}). Vui lòng cập nhật!`,
      type: 'warning',
      actionText: 'Tải xuống',
      action: () => { window.open(apkInfo.apkUrl, '_blank'); }
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 max-w-sm w-full shadow-2xl relative animate-in fade-in zoom-in duration-200">
        <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-4">
          <Download className="w-6 h-6" />
        </div>
        <h2 className="text-xl font-bold text-center mb-2">Bản cập nhật mới</h2>
        <p className="text-center text-gray-600 dark:text-gray-400 mb-4">
          Phiên bản {apkInfo.version} đã sẵn sàng. Vui lòng cập nhật để có trải nghiệm tốt nhất!
        </p>
        
        {apkInfo.releaseNotes && (
          <div className="bg-black/5 dark:bg-white/5 p-3 rounded-xl mb-6 text-sm">
            <h4 className="font-semibold mb-1">Nội dung cập nhật:</h4>
            <p className="whitespace-pre-wrap">{apkInfo.releaseNotes}</p>
          </div>
        )}
        
        <div className="flex flex-col gap-3">
          <a href={apkInfo.apkUrl} target="_blank" rel="noopener noreferrer" onClick={() => setShowModal(false)} className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3 rounded-xl text-center transition-colors">
            Tải xuống ngay
          </a>
          {!apkInfo.isMandatory && (
            <button onClick={handleSkip} className="w-full bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300 font-bold py-3 rounded-xl transition-colors">
              Bỏ qua
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
