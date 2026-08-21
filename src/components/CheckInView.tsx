import React, { useState, useEffect } from 'react';
import { Camera, MapPin, CheckCircle2, XCircle, LogIn, LogOut } from 'lucide-react';
import { User, AttendanceRecord, SystemSettings } from '../types';
import { format, parseISO } from 'date-fns';

export const CheckInView = ({
  currentUser,
  settings,
  onCheckIn
}: {
  currentUser: User | null;
  settings: SystemSettings | null;
  onCheckIn: (record: Partial<AttendanceRecord>) => Promise<void>;
}) => {
  const [status, setStatus] = useState<'idle' | 'locating' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  
  const handleCheckIn = async (type: 'in' | 'out') => {
    if (!currentUser) {
      setStatus('error');
      setMessage('Vui lòng đăng nhập trước khi chấm công');
      return;
    }
    
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    if (code !== settings?.attendanceQRSecret) {
      setStatus('error');
      setMessage('Mã QR không hợp lệ hoặc đã hết hạn. Vui lòng quét lại mã QR tại quán.');
      return;
    }

    if (!settings?.storeLocation) {
      setStatus('error');
      setMessage('Cửa hàng chưa cấu hình vị trí chấm công');
      return;
    }

    setStatus('locating');
    setMessage('Đang kiểm tra vị trí...');

    if (!navigator.geolocation) {
      setStatus('error');
      setMessage('Trình duyệt không hỗ trợ vị trí');
      return;
    }

    navigator.geolocation.getCurrentPosition(async (position) => {
      const { latitude, longitude } = position.coords;
      const storeLat = settings.storeLocation!.lat;
      const storeLng = settings.storeLocation!.lng;
      
      // Calculate distance in meters (haversine approximation)
      const R = 6371e3; // metres
      const p1 = latitude * Math.PI/180; // φ, λ in radians
      const p2 = storeLat * Math.PI/180;
      const dp = (storeLat-latitude) * Math.PI/180;
      const dl = (storeLng-longitude) * Math.PI/180;

      const a = Math.sin(dp/2) * Math.sin(dp/2) +
                Math.cos(p1) * Math.cos(p2) *
                Math.sin(dl/2) * Math.sin(dl/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c; // in metres

      if (distance > 30) {
        setStatus('error');
        setMessage(`Bạn đang ở quá xa cửa hàng (${Math.round(distance)}m). Vui lòng di chuyển lại gần (khoảng cách tối đa 30m)`);
        return;
      }

      try {
        const now = new Date();
        // Here we just pass the basic data, the parent will query DB and update if needed
        await onCheckIn({
          userId: currentUser.id,
          staffName: currentUser.name,
          date: format(now, 'yyyy-MM-dd'),
          [type === 'in' ? 'checkInTime' : 'checkOutTime']: now.toISOString(),
          locationValid: true
        });
        
        setStatus('success');
        setMessage(`Đã ghi nhận chấm công ${type === 'in' ? 'VÀO CA' : 'RA CA'} thành công!`);
      } catch (err) {
        setStatus('error');
        setMessage('Có lỗi xảy ra khi lưu dữ liệu');
      }
    }, (error) => {
      setStatus('error');
      setMessage('Không thể lấy vị trí của bạn. Vui lòng cấp quyền truy cập vị trí.');
    }, { enableHighAccuracy: true });
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6 text-center">
        <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto text-emerald-600 dark:text-emerald-500">
          <MapPin className="w-10 h-10" />
        </div>
        
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white uppercase">Chấm Công</h2>
        
        {currentUser ? (
          <div className="space-y-2">
            <p className="text-gray-600 dark:text-gray-400">Xin chào, <span className="font-bold text-gray-900 dark:text-white">{currentUser.name}</span></p>
            <p className="text-sm text-gray-500">Ca làm của bạn: {currentUser.shiftStart || '--:--'} - {currentUser.shiftEnd || '--:--'}</p>
          </div>
        ) : (
          <p className="text-gray-600 dark:text-gray-400">Vui lòng đăng nhập để tiếp tục</p>
        )}

        <div className="pt-4 space-y-4">
          <button 
            onClick={() => handleCheckIn('in')}
            disabled={status === 'locating' || !currentUser}
            className="w-full py-4 bg-emerald-500 text-white rounded-xl font-bold hover:bg-emerald-400 transition-all cursor-pointer flex justify-center items-center gap-2 disabled:opacity-50"
          >
            <LogIn className="w-5 h-5" /> CHECK-IN (Vào ca)
          </button>
          
          <button 
            onClick={() => handleCheckIn('out')}
            disabled={status === 'locating' || !currentUser}
            className="w-full py-4 bg-rose-500/20 text-rose-600 dark:text-rose-500 rounded-xl font-bold hover:bg-rose-500/30 transition-all cursor-pointer flex justify-center items-center gap-2 disabled:opacity-50"
          >
            <LogOut className="w-5 h-5" /> CHECK-OUT (Ra ca)
          </button>
        </div>

        {status !== 'idle' && (
          <div className={`p-4 rounded-xl text-sm font-bold flex items-start gap-3 ${
            status === 'success' ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-500' : 
            status === 'error' ? 'bg-rose-500/20 text-rose-600 dark:text-rose-500' : 
            'bg-blue-500/20 text-blue-600 dark:text-blue-500'
          }`}>
            {status === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : 
             status === 'error' ? <XCircle className="w-5 h-5 shrink-0" /> : 
             <MapPin className="w-5 h-5 shrink-0 animate-bounce" />}
            <span className="text-left">{message}</span>
          </div>
        )}

        <button 
          onClick={() => window.location.href = '/'}
          className="w-full py-3 bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 rounded-xl hover:bg-black/10 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white transition-all text-sm font-medium mt-4"
        >
          Quay lại ứng dụng
        </button>
      </div>
    </div>
  );
};
