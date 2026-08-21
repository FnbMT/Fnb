import React, { useState, useMemo } from 'react';
import { User, AttendanceRecord, SystemSettings, PayrollRecord } from '../types';
import { Calendar, DollarSign, Clock, MapPin, CheckCircle2, QrCode } from 'lucide-react';
import { format, parseISO, startOfMonth, endOfMonth, isWithinInterval } from 'date-fns';
import { Scanner } from '@yudiel/react-qr-scanner';
import { cn } from '../lib/utils';

export const MyPayrollView = ({ 
  currentUser, 
  attendanceRecords,
  payrollRecords,
  settings,
  onCheckIn
}: { 
  currentUser: User | null;
  attendanceRecords: AttendanceRecord[];
  payrollRecords: PayrollRecord[];
  settings: SystemSettings | null;
  onCheckIn: (record: Partial<AttendanceRecord>) => Promise<void>;
}) => {
  const [payrollMonth, setPayrollMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [showScanner, setShowScanner] = useState(false);
  const [scanStatus, setScanStatus] = useState<'idle' | 'locating' | 'success' | 'error'>('idle');
  const [scanMessage, setScanMessage] = useState('');

  const payrollData = useMemo(() => {
    if (!currentUser) return null;
    
    // Check if there is a finalized payroll record for this month
    const finalized = payrollRecords.find(p => p.userId === currentUser.id && p.month === payrollMonth && p.status === 'finalized');

    const start = startOfMonth(parseISO(`${payrollMonth}-01`));
    const end = endOfMonth(start);
    
    const records = attendanceRecords.filter(r => 
      r.userId === currentUser.id && 
      isWithinInterval(parseISO(r.date), { start, end }) &&
      (r.status === 'present' || r.status === 'half-day' || r.status === 'late')
    );
    
    let presentDays = 0;
    records.forEach(r => {
      if (r.status === 'present' || r.status === 'late') presentDays += 1;
      if (r.status === 'half-day') presentDays += 0.5;
    });

    let calculatedSalary = 0;
    if (currentUser.salaryType === 'monthly') {
      calculatedSalary = currentUser.salaryAmount || 0;
    } else if (currentUser.salaryType === 'daily') {
      calculatedSalary = (currentUser.salaryAmount || 0) * presentDays;
    } else if (currentUser.salaryType === 'hourly') {
      calculatedSalary = (currentUser.salaryAmount || 0) * presentDays * 8; // Approx
    }

    if (finalized) {
      return {
        presentDays: finalized.presentDays,
        calculatedSalary: finalized.calculatedSalary,
        bonus: finalized.bonus,
        totalSalary: finalized.totalSalary,
        records: records.sort((a, b) => b.date.localeCompare(a.date)),
        finalized: true
      };
    }

    return {
      presentDays,
      calculatedSalary,
      bonus: 0,
      totalSalary: calculatedSalary,
      records: records.sort((a, b) => b.date.localeCompare(a.date)),
      finalized: false
    };
  }, [currentUser, attendanceRecords, payrollMonth, payrollRecords]);

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

  const processCheckIn = () => {
    if (!settings?.storeLocation) {
      setScanStatus('error');
      setScanMessage('Cửa hàng chưa cấu hình vị trí chấm công');
      return;
    }

    setScanStatus('locating');
    setScanMessage('Đang kiểm tra vị trí của bạn...');

    if (!navigator.geolocation) {
      setScanStatus('error');
      setScanMessage('Trình duyệt không hỗ trợ vị trí');
      return;
    }

    navigator.geolocation.getCurrentPosition(async (position) => {
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

      try {
        const now = new Date();
        const todayStr = format(now, 'yyyy-MM-dd');
        
        const todayRecord = attendanceRecords.find(r => r.userId === currentUser?.id && r.date === todayStr);
        const type = todayRecord?.checkInTime ? 'out' : 'in';

        await onCheckIn({
          userId: currentUser!.id,
          staffName: currentUser!.name,
          date: todayStr,
          [type === 'in' ? 'checkInTime' : 'checkOutTime']: now.toISOString(),
          locationValid: true,
          status: 'present'
        });
        
        setScanStatus('success');
        setScanMessage(`Đã ghi nhận chấm công ${type === 'in' ? 'VÀO CA' : 'RA CA'} thành công!`);
        
        setTimeout(() => {
          setShowScanner(false);
          setScanStatus('idle');
          setScanMessage('');
        }, 3000);
      } catch (err) {
        setScanStatus('error');
        setScanMessage('Có lỗi xảy ra khi lưu dữ liệu');
      }
    }, (error) => {
      setScanStatus('error');
      setScanMessage('Không thể lấy vị trí của bạn. Vui lòng cấp quyền truy cập vị trí.');
    }, { enableHighAccuracy: true });
  };

  if (!currentUser) return null;

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <DollarSign className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
          Lương & Chấm Công
        </h3>
        <button 
          onClick={() => {
            setShowScanner(true);
            setScanStatus('idle');
            setScanMessage('');
          }}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-bold hover:bg-emerald-400 transition-all cursor-pointer shadow-lg shadow-emerald-500/20"
        >
          <QrCode className="w-4 h-4" /> Quét QR Chấm Công
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-6">
            <h4 className="font-bold text-gray-600 dark:text-gray-400 mb-4 text-sm uppercase tracking-wider">Thông tin Lương</h4>
            <div className="space-y-4">
              <div className="flex justify-between items-center pb-4 border-b border-black/10 dark:border-white/10">
                <span className="text-sm text-gray-600 dark:text-gray-400">Hình thức</span>
                <span className="font-bold text-gray-900 dark:text-white">
                  {currentUser.salaryType === 'monthly' ? 'Theo tháng' : currentUser.salaryType === 'daily' ? 'Theo ngày' : 'Theo giờ'}
                </span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b border-black/10 dark:border-white/10">
                <span className="text-sm text-gray-600 dark:text-gray-400">Mức lương cơ bản</span>
                <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                  {currentUser.salaryAmount?.toLocaleString() || 0}đ
                </span>
              </div>
              <div className="flex flex-col pb-4 border-b border-black/10 dark:border-white/10">
                <span className="text-sm text-gray-600 dark:text-gray-400 mb-2 block">Ca làm việc</span>
                <div className="space-y-1">
                  {currentUser.shifts?.map((shift, idx) => (
                    <div key={idx} className="font-bold text-amber-600 dark:text-amber-400 text-sm text-right">
                      {shift.start} - {shift.end}
                    </div>
                  )) || (currentUser.shiftStart ? (
                    <div className="font-bold text-amber-600 dark:text-amber-400 text-sm text-right">
                      {currentUser.shiftStart} - {currentUser.shiftEnd || '17:00'}
                    </div>
                  ) : (
                    <div className="text-right text-sm text-gray-500">Chưa xếp ca</div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-bold text-gray-600 dark:text-gray-400 text-sm uppercase tracking-wider">
                {payrollData?.finalized ? 'Lương đã chốt' : 'Tạm tính tháng này'}
              </h4>
              <input 
                type="month" 
                value={payrollMonth}
                onChange={(e) => setPayrollMonth(e.target.value)}
                className="bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-2 py-1 text-gray-900 dark:text-white text-xs outline-none"
              />
            </div>
            
            <div className="space-y-4 pt-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600 dark:text-gray-400">Tổng công (ngày)</span>
                <span className="font-bold text-blue-600 dark:text-blue-400 text-xl">{payrollData?.presentDays || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600 dark:text-gray-400">Thưởng</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400 font-mono text-lg">+{payrollData?.bonus.toLocaleString() || 0}đ</span>
              </div>
              <div className={cn(
                "flex justify-between items-center p-4 border rounded-xl",
                payrollData?.finalized 
                  ? "bg-emerald-500/20 border-emerald-500/30" 
                  : "bg-amber-500/10 border-amber-500/20"
              )}>
                <span className={cn(
                  "text-sm font-bold",
                  payrollData?.finalized ? "text-emerald-600 dark:text-emerald-500" : "text-amber-600 dark:text-amber-500"
                )}>
                  {payrollData?.finalized ? 'Tổng nhận' : 'Tổng tạm tính'}
                </span>
                <span className={cn(
                  "font-mono font-bold text-2xl",
                  payrollData?.finalized ? "text-emerald-600 dark:text-emerald-500" : "text-amber-600 dark:text-amber-500"
                )}>
                  {payrollData?.totalSalary.toLocaleString() || 0}đ
                </span>
              </div>
              {payrollData?.finalized && (
                <div className="text-center text-xs text-emerald-600 dark:text-emerald-500/80 font-bold uppercase mt-2">
                  <CheckCircle2 className="w-4 h-4 inline-block mr-1 mb-0.5" />
                  Đã chốt lương
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden flex flex-col h-full min-h-[400px]">
            <div className="p-6 border-b border-black/10 dark:border-white/10 flex justify-between items-center bg-black/5 dark:bg-white/5">
              <h4 className="font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <Calendar className="w-5 h-5 text-emerald-600 dark:text-emerald-500" />
                Lịch sử chấm công ({payrollMonth})
              </h4>
            </div>
            
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-white dark:bg-[#1a1b1e] shadow-md z-10">
                  <tr className="text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                    <th className="px-6 py-4 font-medium">Ngày</th>
                    <th className="px-6 py-4 font-medium">Vào ca</th>
                    <th className="px-6 py-4 font-medium">Ra ca</th>
                    <th className="px-6 py-4 font-medium text-center">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {!payrollData?.records?.length ? (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-gray-500 italic">
                        Không có dữ liệu chấm công trong tháng này.
                      </td>
                    </tr>
                  ) : (
                    payrollData.records.map((record) => (
                      <tr key={record.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                        <td className="px-6 py-4">
                          <div className="font-bold text-gray-900 dark:text-white">{format(parseISO(record.date), 'dd/MM/yyyy')}</div>
                        </td>
                        <td className="px-6 py-4">
                          {record.checkInTime ? (
                            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                              <Clock className="w-4 h-4" /> {format(parseISO(record.checkInTime), 'HH:mm')}
                            </div>
                          ) : <span className="text-gray-600">-</span>}
                        </td>
                        <td className="px-6 py-4">
                          {record.checkOutTime ? (
                            <div className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400">
                              <Clock className="w-4 h-4" /> {format(parseISO(record.checkOutTime), 'HH:mm')}
                            </div>
                          ) : <span className="text-gray-600">-</span>}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className={cn(
                            "px-2 py-1 rounded-md text-[10px] font-bold uppercase",
                            record.status === 'present' ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-500" :
                            record.status === 'late' ? "bg-amber-500/20 text-amber-600 dark:text-amber-500" :
                            record.status === 'half-day' ? "bg-blue-500/20 text-blue-600 dark:text-blue-500" :
                            "bg-rose-500/20 text-rose-600 dark:text-rose-500"
                          )}>
                            {record.status === 'present' ? 'Đủ công' :
                             record.status === 'late' ? 'Đi trễ' :
                             record.status === 'half-day' ? 'Nửa công' : 'Vắng'}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {showScanner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-6 border border-black/10 dark:border-white/10 shadow-2xl flex flex-col relative overflow-hidden">
            <button 
              onClick={() => setShowScanner(false)}
              className="absolute top-4 right-4 z-10 w-8 h-8 bg-black/50 text-gray-900 dark:text-white rounded-full flex items-center justify-center hover:bg-black/80"
            >
              ✕
            </button>
            
            <h3 className="text-lg font-bold text-gray-900 dark:text-white text-center mb-4 flex items-center justify-center gap-2">
              <QrCode className="w-5 h-5 text-emerald-600 dark:text-emerald-500" />
              Quét mã QR Chấm Công
            </h3>

            <div className="rounded-2xl overflow-hidden bg-black aspect-square relative mb-4">
              <Scanner
                onResult={(text) => handleScan(text)}
                onError={(error) => console.error(error?.message)}
                options={{
                  delayBetweenScanAttempts: 1000,
                  delayBetweenScanSuccess: 5000,
                }}
              />
              {scanStatus !== 'idle' && (
                <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-6 text-center backdrop-blur-sm z-20">
                  <div className={cn(
                    "p-4 rounded-xl flex flex-col items-center gap-3",
                    scanStatus === 'success' ? 'text-emerald-600 dark:text-emerald-500' :
                    scanStatus === 'error' ? 'text-rose-600 dark:text-rose-500' :
                    'text-blue-600 dark:text-blue-500'
                  )}>
                    {scanStatus === 'success' ? <CheckCircle2 className="w-12 h-12" /> :
                     scanStatus === 'error' ? <div className="w-12 h-12 border-4 border-rose-500 rounded-full flex items-center justify-center text-xl font-bold">✕</div> :
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
      )}
    </div>
  );
};
