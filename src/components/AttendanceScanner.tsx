import React, { useState, useEffect } from 'react';
import { Scanner } from '@yudiel/react-qr-scanner';
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

  useEffect(() => {
    verifyLocation();
  }, []);

  const verifyLocation = async () => {
    if (!settings?.storeLocation) {
      setGpsVerified(true);
      return;
    }

    setScanStatus('locating');
    setScanMessage('Đang kiểm tra vị trí của bạn...');

    try {
      try {
        const permissions = await Geolocation.checkPermissions();
        if (permissions.location !== 'granted') {
          const request = await Geolocation.requestPermissions();
          if (request.location !== 'granted') {
            throw new Error('Permission denied');
          }
        }
      } catch (permError) {
        console.warn('Could not check permissions, proceeding to request position directly', permError);
      }

      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
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
    if (!text || scanStatus === 'locating' || scanStatus === 'success') return;
    
    try {
      const url = new URL(text);
      const isCheckin = url.searchParams.get('checkin') === 'true';
      const code = url.searchParams.get('code');
      const storeId = url.searchParams.get('storeId');

      if (!isCheckin || code !== settings?.attendanceQRSecret || storeId !== currentUser?.storeId) {
        setScanStatus('error');
        setScanMessage('Mã QR không hợp lệ hoặc không thuộc cửa hàng này.');
        return;
      }
      
      processCheckIn();
    } catch (e) {
      setScanStatus('error');
      setScanMessage('Định dạng QR không đúng.');
    }
  };

  const processCheckIn = async () => {
    setScanStatus('locating');
    setScanMessage('Đang ghi nhận...');

    try {
      const now = new Date();
      const todayStr = format(now, 'yyyy-MM-dd');
      
      const todayRecords = attendanceRecords.filter(r => r.userId === currentUser.id && r.date === todayStr);
      const latestRecord = todayRecords.sort((a, b) => new Date(b.checkInTime || 0).getTime() - new Date(a.checkInTime || 0).getTime())[0];
      const type = (latestRecord && latestRecord.checkInTime && !latestRecord.checkOutTime) ? 'out' : 'in';

      await onCheckIn({
        userId: currentUser.id,
        staffName: currentUser.name,
        date: todayStr,
        [type === 'in' ? 'checkInTime' : 'checkOutTime']: now.toISOString(),
        locationValid: true
      });
      
      setScanStatus('success');
      setScanMessage(`Đã ghi nhận chấm công ${type === 'in' ? 'VÀO CA' : 'RA CA'} thành công!`);
      
      setTimeout(() => {
        onClose();
      }, 3000);
    } catch (err) {
      setScanStatus('error');
      setScanMessage('Có lỗi xảy ra khi lưu dữ liệu');
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
            <Scanner
              onScan={(detectedCodes) => {
                if (detectedCodes && detectedCodes.length > 0) {
                  handleScan(detectedCodes[0].rawValue);
                }
              }}
              onError={(error) => {
                console.error(error?.message);
                setScanStatus('error');
                setScanMessage('Không tìm thấy Camera hoặc chưa được cấp quyền.');
              }}
              scanDelay={5000}
              retryDelay={1000}
            />
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
          
          {scanStatus !== 'idle' && scanStatus !== 'error' && !(!gpsVerified && scanStatus === 'locating') && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6 text-center backdrop-blur-sm z-20">
              <div className={cn(
                "p-4 rounded-xl flex flex-col items-center gap-3",
                scanStatus === 'success' ? 'text-emerald-600 dark:text-emerald-500' :
                'text-blue-600 dark:text-blue-500'
              )}>
                {scanStatus === 'success' ? <CheckCircle2 className="w-12 h-12" /> :
                 <MapPin className="w-12 h-12 animate-bounce" />}
                <span className="font-bold text-sm bg-white dark:bg-[#1a1b1e] px-4 py-2 rounded-lg shadow-lg border border-black/10 dark:border-white/10">{scanMessage}</span>
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
