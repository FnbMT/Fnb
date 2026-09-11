import React, { useState, useMemo, useRef } from 'react';
import { User, AttendanceRecord, SystemSettings, PayrollRecord } from '../types';
import { Calendar, DollarSign, Clock, MapPin, CheckCircle2, QrCode } from 'lucide-react';
import { format, parseISO, startOfMonth, endOfMonth, isWithinInterval } from 'date-fns';
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
    let totalHours = 0;
    records.forEach(r => {
      if (r.status === 'present' || r.status === 'late') presentDays += 1;
      if (r.status === 'half-day') presentDays += 0.5;
      
      if (currentUser.salaryType === 'hourly') {
        if (r.checkInTime && r.checkOutTime) {
          const diffMs = new Date(r.checkOutTime).getTime() - new Date(r.checkInTime).getTime();
          totalHours += diffMs / (1000 * 60 * 60);
        } else if (r.status === 'present' || r.status === 'late') {
          totalHours += 8;
        } else if (r.status === 'half-day') {
          totalHours += 4;
        }
      }
    });

    let calculatedSalary = 0;
    if (currentUser.salaryType === 'monthly') {
      calculatedSalary = currentUser.salaryAmount || 0;
    } else if (currentUser.salaryType === 'daily') {
      calculatedSalary = (currentUser.salaryAmount || 0) * presentDays;
    } else if (currentUser.salaryType === 'hourly') {
      calculatedSalary = (currentUser.salaryAmount || 0) * totalHours;
    }

    if (finalized) {
      return {
        presentDays: finalized.presentDays,
        calculatedSalary: finalized.calculatedSalary,
        bonus: finalized.bonus,
        totalSalary: finalized.totalSalary,
        records: records.sort((a, b) => {
          if (a.date === b.date) return new Date(b.checkInTime || 0).getTime() - new Date(a.checkInTime || 0).getTime();
          return b.date.localeCompare(a.date);
        }),
        finalized: true
      };
    }

    return {
      presentDays,
      calculatedSalary,
      bonus: 0,
      totalSalary: calculatedSalary,
      records: records.sort((a, b) => {
        if (a.date === b.date) return new Date(b.checkInTime || 0).getTime() - new Date(a.checkInTime || 0).getTime();
        return b.date.localeCompare(a.date);
      }),
      finalized: false
    };
  }, [currentUser, attendanceRecords, payrollMonth, payrollRecords]);

  if (!currentUser) return null;

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <DollarSign className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
          Lương & Chấm Công
        </h3>
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
            
            <div className="flex-1 overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[400px]">
                <thead className="sticky top-0 bg-white dark:bg-[#1a1b1e] shadow-sm z-10">
                  <tr className="text-gray-600 dark:text-gray-400 text-[11px] sm:text-xs uppercase tracking-wider">
                    <th className="px-3 sm:px-6 py-3 sm:py-4 font-medium whitespace-nowrap">Ngày</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 font-medium whitespace-nowrap">Vào ca</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 font-medium whitespace-nowrap">Ra ca</th>
                    <th className="px-3 sm:px-6 py-3 sm:py-4 font-medium text-center whitespace-nowrap">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {!payrollData?.records?.length ? (
                    <tr>
                      <td colSpan={4} className="px-3 sm:px-6 py-12 text-center text-gray-500 italic">
                        Không có dữ liệu chấm công trong tháng này.
                      </td>
                    </tr>
                  ) : (
                    payrollData.records.map((record) => (
                      <tr key={record.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                        <td className="px-3 sm:px-6 py-3 sm:py-4 whitespace-nowrap">
                          <div className="font-bold text-sm text-gray-900 dark:text-white">{format(parseISO(record.date), 'dd/MM/yyyy')}</div>
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 whitespace-nowrap">
                          {record.checkInTime ? (
                            <div className="flex items-center gap-1.5 text-xs sm:text-sm font-medium text-emerald-600 dark:text-emerald-400">
                              <Clock className="w-3.5 h-3.5" /> {format(parseISO(record.checkInTime), 'HH:mm')}
                            </div>
                          ) : <span className="text-gray-600 dark:text-gray-500 text-sm">-</span>}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 whitespace-nowrap">
                          {record.checkOutTime ? (
                            <div className="flex items-center gap-1.5 text-xs sm:text-sm font-medium text-rose-600 dark:text-rose-400">
                              <Clock className="w-3.5 h-3.5" /> {format(parseISO(record.checkOutTime), 'HH:mm')}
                            </div>
                          ) : <span className="text-gray-600 dark:text-gray-500 text-sm">-</span>}
                        </td>
                        <td className="px-3 sm:px-6 py-3 sm:py-4 text-center whitespace-nowrap">
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
    </div>
  );
};
