import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { MapPin, CheckCircle2, QrCode } from 'lucide-react';
import { cn } from '../lib/utils';
import { User, SystemSettings, AttendanceRecord } from '../types';
import { Geolocation } from '@capacitor/geolocation';
import { format } from 'date-fns';

export const AttendanceScanner = ({
  currentUser,
  settings,
  onClose,
  onCheckIn,
  attendanceRecords
}: {
  currentUser: User;
  settings: SystemSettings | null;
  onClose: () => void;
  onCheckIn: (record: Partial<AttendanceRecord>) => Promise<void>;
  attendanceRecords: AttendanceRecord[];
}) => {
  const [scanStatus, setScanStatus] = useState<'idle' | 'locating' | 'success' | 'error'>('idle');
  const [scanMessage, setScanMessage] = useState('');
  const [gpsVerified, setGpsVerified] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const hasScannedRef = useRef(false);

  const playBeep = () => {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {
      console.error('Audio beep failed', e);
    }
  };

  useEffect(() => {
    verifyLocation();
    
    return () => {
      if (scannerRef.current && scannerRef.current.isScanning) {
        scannerRef.current.stop().then(() => {
          scannerRef.current?.clear();
          scannerRef.current = null;
        }).catch(console.error);
      }
    };
  }, []);

  const verifyLocation = async () => {
    if (!settings?.storeLocation) {
      setGpsVerified(true);
      return;
    }

    setScanStatus('locating');
    setScanMessage('Đang kiểm tra vị trí của bạn...');

    try {
      // Geolocation.getCurrentPosition in web standard will automatically prompt if not granted.
      // We use lower accuracy and some caching to speed it up significantly.
            const perm = await Geolocation.checkPermissions();
      if (perm.location !== 'granted') {
        const req = await Geolocation.requestPermissions();
        if (req.location !== 'granted') {
          throw new Error('Vui lòng cấp quyền truy cập vị trí để chấm công.');
        }
      }
      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 });
      const { latitude, longitude } = position.coords;
      const storeLat = settings.storeLocation!.lat;
      const storeLng = settings.storeLocation!.lng;
      
      const R = 6371e3;
      const p1 = latitude * Math.PI/180;
      const p2 = storeLat * Math.PI/180;
      const dp = (storeLat-latitude) * Math.PI/180;
      const dl = (storeLng-longitude) * Math.PI/180;

      const a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c;

      if (distance > 30) {
        setScanStatus('error');
        setScanMessage(`Bạn đang ở quá xa cửa hàng (${Math.round(distance)}m). Vui lòng di chuyển lại gần (khoảng cách tối đa 30m).`);
        return;
      }
      
      setScanStatus('idle');
      setScanMessage('');
      setGpsVerified(true);
    } catch (error) {
      console.error('Location error:', error);
      setScanStatus('error');
      setScanMessage('Không thể lấy vị trí của bạn. Vui lòng cấp quyền truy cập vị trí và bật GPS.');
    }
  };

  const handleScan = (text: string) => {
    if (!text || hasScannedRef.current) return;
    hasScannedRef.current = true;
    
    try {
      playBeep();
      const url = new URL(text);
      const isCheckin = url.searchParams.get('checkin') === 'true';
      const code = url.searchParams.get('code');
      const storeId = url.searchParams.get('storeId');

      if (!isCheckin || code !== settings?.attendanceQRSecret || storeId !== currentUser?.storeId) {
        setScanStatus('error');
        setScanMessage('Mã QR không hợp lệ hoặc không thuộc cửa hàng này.');
        hasScannedRef.current = false;
        return;
      }
      
      processCheckIn();
    } catch (e) {
      setScanStatus('error');
      setScanMessage('Định dạng QR không đúng.');
      hasScannedRef.current = false;
    }
  };

  const processCheckIn = async () => {
    setScanStatus('locating');
    setScanMessage('Đang ghi nhận...');

    try {
      const now = new Date();
      const todayStr = format(now, 'yyyy-MM-dd');
      
      await onCheckIn({
        userId: currentUser.id,
        staffName: currentUser.name,
        date: todayStr,
        locationValid: true
      });
      
      setScanStatus('success');
      setScanMessage(`Đã ghi nhận chấm công thành công!`);
      
      setTimeout(() => {
        onClose();
      }, 3000);
    } catch (err) {
      setScanStatus('error');
      setScanMessage('Lỗi: ' + (err instanceof Error ? err.message : String(err)));
      hasScannedRef.current = false;
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-6 border border-black/10 dark:border-white/10 shadow-2xl flex flex-col relative overflow-hidden">
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 z-10 w-8 h-8 bg-black/50 text-white rounded-full flex items-center justify-center hover:bg-black/80"
        >
          ✕
        </button>
        
        <h3 className="text-lg font-bold text-gray-900 dark:text-white text-center mb-4 flex items-center justify-center gap-2">
          <QrCode className="w-5 h-5 text-emerald-600 dark:text-emerald-500" />
          Quét mã QR Chấm Công
        </h3>

        <div className="rounded-2xl overflow-hidden bg-black aspect-square relative mb-4 flex items-center justify-center">
          {gpsVerified ? (
            <div id="reader-attendance" className="w-full h-full overflow-hidden" ref={(el) => {
              if (el && !scannerRef.current) {
                const scanner = new Html5Qrcode("reader-attendance");
                scannerRef.current = scanner;
                scanner.start(
                  { facingMode: "environment" },
                  { fps: 10, qrbox: 250, aspectRatio: 1.0 },
                  (decodedText) => {
                    handleScan(decodedText);
                  },
                  (errorMessage) => {
                    // Ignore parse errors (e.g. no QR code found in current frame)
                  }
                ).catch((err) => {
                  console.error(err);
                  setScanStatus('error');
                  setScanMessage(`Lỗi Camera: ${err?.name || err?.message || err || "Không rõ"}`);
                });
              }
            }}></div>
          ) : (
            <div className="text-white/50 text-sm flex flex-col items-center gap-2">
              {scanStatus === 'error' ? (
                <>
                  <div className="w-12 h-12 border-4 border-rose-500 rounded-full flex items-center justify-center text-xl font-bold text-rose-500 mb-2">✕</div>
                  <span className="text-rose-500 px-4 text-center">{scanMessage}</span>
                  <button onClick={verifyLocation} className="mt-4 px-4 py-2 bg-white/10 rounded-lg hover:bg-white/20">Thử lại</button>
                </>
              ) : (
                <>
                  <MapPin className="w-8 h-8 animate-bounce mb-2" />
                  <span>Đang xác nhận vị trí...</span>
                </>
              )}
            </div>
          )}
          
          {scanStatus !== 'idle' && !(!gpsVerified && scanStatus === 'locating') && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6 text-center backdrop-blur-sm z-20">
              <div className={cn(
                "p-4 rounded-xl flex flex-col items-center gap-3",
                scanStatus === 'success' ? 'text-emerald-600 dark:text-emerald-500' :
                scanStatus === 'error' ? 'text-rose-600 dark:text-rose-500' :
                'text-blue-600 dark:text-blue-500'
              )}>
                {scanStatus === 'success' ? <CheckCircle2 className="w-12 h-12" /> :
                 scanStatus === 'error' ? <div className="w-12 h-12 border-4 border-rose-500 rounded-full flex items-center justify-center text-xl font-bold mb-2">✕</div> :
                 <MapPin className="w-12 h-12 animate-bounce" />}
                <span className="font-bold text-sm bg-white dark:bg-[#1a1b1e] px-4 py-2 rounded-lg shadow-lg border border-black/10 dark:border-white/10">{scanMessage}</span>
                {scanStatus === 'error' && (
                  <button onClick={() => setScanStatus('idle')} className="mt-2 px-6 py-2 bg-rose-500 text-white rounded-lg text-sm font-bold">Thử lại</button>
                )}
              </div>
            </div>
          )}
        </div>

        <p className="text-xs text-gray-600 dark:text-gray-400 text-center">
          Hướng camera điện thoại vào mã QR được cấp tại cửa hàng để chấm công.
        </p>
      </div>
    </div>
  );
};
