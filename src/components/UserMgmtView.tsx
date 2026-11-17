import React, { useState, useMemo } from 'react';
import { UserPlus, Search, Shield, User as UserIcon, Trash2, Key, Phone, CreditCard, MapPin, DollarSign, Clock, Calendar, CheckCircle2, XCircle, Plus, Minus, Edit2, Lock, Unlock, ChevronDown, ChevronUp } from 'lucide-react';
import { User, UserRole, AttendanceRecord, PayrollRecord, ROLE_LABELS } from '../types';
import { cn } from '../lib/utils';
import { attendanceTotals, computeAttendanceFingerprint } from '../utils/dataIntegrity';
import { CurrencyInput } from './CurrencyInput';
import { format, parseISO, startOfMonth, endOfMonth, isWithinInterval } from 'date-fns';

function formatWorkHours(hours: number): string {
  if (!hours || hours <= 0) return '0h';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}p`;
  if (h > 0) return `${h}h`;
  return `${m}p`;
}

function getRecordDurationInfo(record: AttendanceRecord) {
  const inMs = record.checkInTime ? Date.parse(record.checkInTime) : NaN;
  const outMs = record.checkOutTime ? Date.parse(record.checkOutTime) : NaN;
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs) || outMs < inMs) {
    return {
      hours: 0,
      formattedText: 'Đang làm...',
      isOpen: true,
      isOvernight: false
    };
  }
  const diffMs = outMs - inMs;
  const totalMinutes = Math.round(diffMs / 60000);
  const hours = diffMs / 3600000;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  
  const inDateStr = record.checkInTime ? record.checkInTime.slice(0, 10) : '';
  const outDateStr = record.checkOutTime ? record.checkOutTime.slice(0, 10) : '';
  const isOvernight = Boolean(inDateStr && outDateStr && inDateStr !== outDateStr);

  let formattedText = '';
  if (h > 0 && m > 0) formattedText = `${h}h ${m}p`;
  else if (h > 0) formattedText = `${h}h`;
  else formattedText = `${m}p`;

  return {
    hours,
    formattedText,
    isOpen: false,
    isOvernight
  };
}

function getVietnameseDayOfWeek(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    const days = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    return days[d.getDay()] || '';
  } catch {
    return '';
  }
}

export const UserMgmtView = ({ 
  users,
  isDataReady = false,
  currentUser,
  payrollMonth: propPayrollMonth,
  onPayrollMonthChange,
  attendanceRecords,
  payrollRecords,
  onAddUser, 
  onDeleteUser,
  onUpdateUser,
  onFinalizePayroll,
  onUnfinalizePayroll,
  checkFeatureLimit,
  isAttendanceUnlocked = true,
  onUpgrade,
  activeTab: propActiveTab,
  onTabChange
}: { 
  users: User[],
  isDataReady?: boolean, 
  currentUser?: User,
  payrollMonth?: string,
  onPayrollMonthChange?: (month: string) => void,
  attendanceRecords: AttendanceRecord[],
  payrollRecords: PayrollRecord[],
  onAddUser: (user: User) => void,
  onDeleteUser: (id: string) => void,
  onUpdateUser: (user: User) => void,
  onFinalizePayroll: (record: PayrollRecord) => Promise<void>,
  onUnfinalizePayroll?: (payrollId: string) => Promise<void>,
  checkFeatureLimit?: (feature: string, currentUsage: number) => boolean,
  isAttendanceUnlocked?: boolean,
  onUpgrade?: () => void,
  activeTab?: 'accounts' | 'payroll',
  onTabChange?: (tab: 'accounts' | 'payroll') => void
}) => {
  const isSuperAdmin = currentUser?.role === 'superadmin' || Boolean((currentUser as any)?.isSuperAdmin);
  const [internalTab, setInternalTab] = useState<'accounts' | 'payroll'>('accounts');
  const activeTab = propActiveTab !== undefined ? propActiveTab : internalTab;
  const setActiveTab = (tab: 'accounts' | 'payroll') => {
    setInternalTab(tab);
    onTabChange?.(tab);
  };
  const [showAdd, setShowAdd] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [selectedUserPayroll, setSelectedUserPayroll] = useState<string | null>(null);
  
  const defaultNewUser = { 
    username: '', 
    name: '', 
    password: '', 
    role: 'order' as UserRole,
    phone: '',
    cccd: '',
    address: '',
    salaryType: 'daily' as 'daily' | 'monthly' | 'hourly',
    salaryAmount: 0,
    shifts: [{ start: '08:00', end: '17:00' }],
    requiresAttendance: false
  };
  const [newUser, setNewUser] = useState(defaultNewUser);

  const [isFinalizing,setIsFinalizing]=useState(false);
  const [isUnfinalizing, setIsUnfinalizing] = useState(false);
  const [internalMonth, setInternalMonth] = useState(format(new Date(), 'yyyy-MM'));
  const payrollMonth = propPayrollMonth || internalMonth;
  const handleMonthChange = (val: string) => {
    setInternalMonth(val);
    onPayrollMonthChange?.(val);
  };
  
  // Temporary state for bonus inputs
  const [bonusInputs, setBonusInputs] = useState<Record<string, number>>({});
  const [bonusReasonInputs, setBonusReasonInputs] = useState<Record<string, string>>({});
  const [deductionInputs, setDeductionInputs] = useState<Record<string, number>>({});
  const [deductionReasonInputs, setDeductionReasonInputs] = useState<Record<string, string>>({});

  const handleEditUser = (user: User) => {
    setNewUser({
      username: user.username,
      name: user.name,
      password: '', // Luôn để trống, tuyệt đối không nạp lại mật khẩu vào form
      role: user.role,
      phone: user.phone || '',
      cccd: user.cccd || '',
      address: user.address || '',
      salaryType: user.salaryType || 'daily',
      salaryAmount: user.salaryAmount || 0,
      shifts: user.shifts || (user.shiftStart ? [{start: user.shiftStart, end: user.shiftEnd || '17:00'}] : [{start: '08:00', end: '17:00'}]),
      requiresAttendance: user.requiresAttendance || false
    });
    setEditingUserId(user.id);
    setShowAdd(true);
  };

  const handleSave = () => {
    if (!newUser.username || !newUser.name) return;
    
    const formattedUser = {
      ...newUser,
      username: newUser.username.toLowerCase().trim()
    };
    
    if (editingUserId) {
      const existingUser = users.find(u => u.id === editingUserId);
      if (existingUser) {
        onUpdateUser({
          ...existingUser,
          ...formattedUser,
          // Chỉ gửi mật khẩu nếu người quản lý nhập mật khẩu mới
          password: formattedUser.password ? formattedUser.password : undefined
        });
      }
    } else {
      if (!formattedUser.password) return; // password required for new user
      onAddUser({
        id: '',
        ...formattedUser,
        storeId: ''
      });
    }
    setNewUser(defaultNewUser);
    setEditingUserId(null);
    setShowAdd(false);
  };

  const addShift = () => {
    setNewUser(prev => ({
      ...prev,
      shifts: [...(prev.shifts || []), { start: '08:00', end: '17:00' }]
    }));
  };

  const updateShift = (index: number, field: 'start' | 'end', value: string) => {
    const newShifts = [...(newUser.shifts || [])];
    newShifts[index] = { ...newShifts[index], [field]: value };
    setNewUser(prev => ({ ...prev, shifts: newShifts }));
  };

  const removeShift = (index: number) => {
    const newShifts = [...(newUser.shifts || [])];
    newShifts.splice(index, 1);
    setNewUser(prev => ({ ...prev, shifts: newShifts }));
  };

  const staffUsers = useMemo(() => {
    return users.filter(u => u.role !== 'admin' && !(u as any).isDeleted && (u as any).status !== 'deleted');
  }, [users]);

  const payrollData = useMemo(() => {
    const start = startOfMonth(parseISO(`${payrollMonth}-01`));
    const end = endOfMonth(start);
    
    return staffUsers.map(user => {
      // Check if finalized payroll exists
      const finalized = payrollRecords.find(p => p.userId === user.id && p.month === payrollMonth && p.status === 'finalized');

      const records = attendanceRecords.filter(r => 
        r.userId === user.id && 
        (r.date ? r.date.startsWith(payrollMonth) : true) &&
        (r.status === 'present' || r.status === 'half-day' || r.status === 'late' || !r.status)
      );
      
      const {presentDays,totalHours,hasOpenSession}=attendanceTotals(records);

      let calculatedSalary = 0;
      if (user.salaryType === 'monthly') {
        calculatedSalary = Math.round(user.salaryAmount || 0);
      } else if (user.salaryType === 'daily') {
        calculatedSalary = Math.round((user.salaryAmount || 0) * presentDays);
      } else if (user.salaryType === 'hourly') {
        calculatedSalary = Math.round((user.salaryAmount || 0) * totalHours);
      }

      const sortedRecords = records.sort((a, b) => {
        if (a.date === b.date) return (Date.parse(b.checkInTime || '') || 0) - (Date.parse(a.checkInTime || '') || 0);
        return b.date.localeCompare(a.date);
      });

      if (finalized) {
        return {
          user,
          presentDays: finalized.presentDays,
          totalHours: finalized.totalHours ?? totalHours,
          calculatedSalary: Math.round(finalized.calculatedSalary),
          bonus: Math.round(finalized.bonus),
          bonusReason: finalized.bonusReason,
          deduction: Math.round(finalized.deduction || 0),
          deductionReason: finalized.deductionReason,
          totalSalary: Math.round(finalized.totalSalary),
          records: sortedRecords,
          finalized: true
        };
      }

      const bonus = Math.round(bonusInputs[user.id] || 0);
      const deduction = Math.round(deductionInputs[user.id] || 0);

      return {
        user,
        presentDays,
        totalHours,
        calculatedSalary,
        bonus,
        bonusReason: bonusReasonInputs[user.id] || '',
        deduction,
        deductionReason: deductionReasonInputs[user.id] || '',
        totalSalary: Math.round(calculatedSalary + bonus - deduction),
        records: sortedRecords,
        finalized: false,
        hasOpenSession
      };
    });
  }, [users, attendanceRecords, payrollMonth, payrollRecords, bonusInputs, bonusReasonInputs, deductionInputs, deductionReasonInputs]);

  const handleFinalize = async (data: any) => {
    if (data.finalized || isFinalizing) return;
    if(!isDataReady || data.hasOpenSession){alert('Cần đồng bộ đủ dữ liệu và hoàn tất các lượt chấm công trước khi chốt.');return;}
    
    const record: PayrollRecord = {
      id: '', // Set by App.tsx
      userId: data.user.id,
      storeId: data.user.storeId,
      month: payrollMonth,
      presentDays: data.presentDays,
      totalHours: data.totalHours,
      baseSalaryAmount: data.user.salaryAmount || 0,
      baseSalaryType: data.user.salaryType || 'daily',
      calculatedSalary: data.calculatedSalary,
      bonus: data.bonus,
      bonusReason: data.bonusReason,
      deduction: data.deduction,
      deductionReason: data.deductionReason,
      totalSalary: data.totalSalary,
      status: 'finalized',
      finalizedAt: new Date().toISOString(),
      attendanceSnapshotHash: computeAttendanceFingerprint(data.records || []),
      attendanceRecordIds: (data.records || []).map((r: AttendanceRecord) => r.id),
    };
    setIsFinalizing(true);
    try{await onFinalizePayroll(record);}catch(error){alert(error instanceof Error?error.message:'Không thể chốt lương.');}finally{setIsFinalizing(false);}
  };

  const handleUnfinalize = async (row: any) => {
    if (isUnfinalizing) return;
    const confirmed = window.confirm(
      `Bạn có chắc chắn muốn mở lại chốt bảng lương tháng ${payrollMonth} của nhân viên "${row.user.name}" không?\n\nSau khi mở chốt, trạng thái sẽ chuyển về "Tạm tính" để bạn có thể cập nhật lại thưởng, phạt hoặc tính lại lương từ chấm công mới nhất.`
    );
    if (!confirmed) return;

    const payrollId = `${currentUser?.storeId || row.user.storeId}_${row.user.id}_${payrollMonth}`;
    setIsUnfinalizing(true);
    try {
      if (onUnfinalizePayroll) {
        await onUnfinalizePayroll(payrollId);
      }
    } catch (err: any) {
      alert(err instanceof Error ? err.message : 'Có lỗi xảy ra khi mở chốt lương.');
    } finally {
      setIsUnfinalizing(false);
    }
  };

  const handlePrintPayroll = (data: any) => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Vui lòng cho phép popup để in!');
      return;
    }
    
    const content = `
      <html>
        <head>
          <title>Phiếu Lương - ${data.user.name}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; color: #000; }
            .header { text-align: center; margin-bottom: 20px; }
            .header h1 { margin: 0; font-size: 24px; }
            .header p { margin: 5px 0; color: #555; }
            .details { width: 100%; max-width: 600px; margin: 0 auto; border-collapse: collapse; }
            .details th, .details td { padding: 10px; border-bottom: 1px solid #ccc; text-align: left; }
            .details th { width: 40%; font-weight: bold; }
            .details td.money { font-family: monospace; text-align: right; }
            .total { font-weight: bold; font-size: 18px; }
            .footer { margin-top: 40px; text-align: right; max-width: 600px; margin-left: auto; margin-right: auto; }
            .footer p { margin-bottom: 60px; }
            @media print {
              body { padding: 0; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>PHIẾU LƯƠNG</h1>
            <p>Tháng: ${payrollMonth}</p>
          </div>
          <table class="details">
            <tr>
              <th>Nhân viên:</th>
              <td>${data.user.name}</td>
            </tr>
            <tr>
              <th>Hình thức & Mức lương:</th>
              <td>${data.user.salaryType === 'monthly' ? 'Theo tháng' : data.user.salaryType === 'daily' ? 'Theo ngày' : 'Theo giờ'} (${(data.user.salaryAmount || 0).toLocaleString('vi-VN')}đ)</td>
            </tr>
            <tr>
              <th>Ngày công:</th>
              <td>${data.presentDays} công</td>
            </tr>
            <tr>
              <th>Tổng thời gian làm việc:</th>
              <td>${formatWorkHours(data.totalHours)} (${(data.totalHours || 0).toFixed(1)} giờ)</td>
            </tr>
            <tr>
              <th>Lương theo công/giờ:</th>
              <td class="money">${Math.round(data.calculatedSalary).toLocaleString('vi-VN')}đ</td>
            </tr>
            <tr>
              <th>Thưởng:</th>
              <td class="money">+${Math.round(data.bonus || 0).toLocaleString('vi-VN')}đ</td>
            </tr>
            ${data.bonusReason ? `<tr><th>Lý do thưởng:</th><td>${data.bonusReason}</td></tr>` : ''}
            <tr>
              <th>Khấu trừ:</th>
              <td class="money">-${Math.round(data.deduction || 0).toLocaleString('vi-VN')}đ</td>
            </tr>
            ${data.deductionReason ? `<tr><th>Lý do khấu trừ:</th><td>${data.deductionReason}</td></tr>` : ''}
            <tr class="total">
              <th>TỔNG THỰC NHẬN:</th>
              <td class="money">${Math.round(data.totalSalary).toLocaleString('vi-VN')}đ</td>
            </tr>
          </table>
          <div class="footer">
            <p>Người lập phiếu</p>
            <div>(Ký & ghi rõ họ tên)</div>
          </div>
        </body>
      </html>
    `;
    
    printWindow.document.write(content);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 500);
  };

  return (
    <div className="p-4 md:p-8 space-y-6 h-full overflow-y-auto">
      {!isDataReady && <div role="status" className="p-3 rounded-xl bg-amber-500/10 text-amber-700">Dữ liệu chấm công/lương chưa được server xác nhận đầy đủ; số tiền hiện là tạm tính.</div>}
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Shield className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
          Quản lý Nhân sự
        </h3>

        {activeTab === 'accounts' && (
          <button 
            onClick={() => {
              if (checkFeatureLimit && !checkFeatureLimit('maxUsers', staffUsers.length)) {
                return;
              }
              setEditingUserId(null);
              setNewUser(defaultNewUser);
              setShowAdd(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-bold hover:bg-emerald-400 transition-all cursor-pointer"
          >
            <UserPlus className="w-4 h-4" /> Thêm nhân viên
          </button>
        )}

      </div>

      <div className="flex border-b border-black/10 dark:border-white/10 gap-6">
        <button 
          onClick={() => setActiveTab('accounts')}
          className={cn(
            "pb-4 px-2 text-sm font-bold transition-all border-b-2",
            activeTab === 'accounts' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
          )}
        >
          Tài khoản
        </button>
        {currentUser?.role !== 'manager' && (
          <button 
            onClick={() => setActiveTab('payroll')}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2 flex items-center gap-1.5",
              activeTab === 'payroll' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            <span>Lương & Chấm công</span>
            {!isAttendanceUnlocked && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-semibold flex items-center gap-1">
                <Lock className="w-3 h-3" /> Gói
              </span>
            )}
          </button>
        )}
      </div>

      {activeTab === 'accounts' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {staffUsers.map((user) => (
            <div key={user.id} className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-6 relative group flex flex-col">
              {user.role !== 'admin' && (
                <div className="absolute top-4 right-4 flex gap-2">
                  <button 
                    onClick={() => handleEditUser(user)}
                    className="p-2 bg-blue-500/10 text-blue-600 dark:text-blue-500 hover:bg-blue-500/20 rounded-lg cursor-pointer"
                    title="Chỉnh sửa"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => onDeleteUser(user.id)}
                    className="p-2 bg-rose-500/10 text-rose-600 dark:text-rose-500 hover:bg-rose-500/20 rounded-lg cursor-pointer"
                    title="Xóa"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )}
              
              <div className="flex items-center gap-4 mb-4">
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-500 font-bold text-xl">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h4 className="font-bold text-gray-900 dark:text-white text-lg">{user.name}</h4>
                  <span className={cn(
                    "px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider inline-block mt-1",
                    user.role === 'admin' ? "bg-amber-500/20 text-amber-600 dark:text-amber-500" :
                    user.role === 'cashier' ? "bg-blue-500/20 text-blue-600 dark:text-blue-500" :
                    user.role === 'order_cashier' ? "bg-purple-500/20 text-purple-600 dark:text-purple-500" :
                    user.role === 'kitchen' ? "bg-rose-500/20 text-rose-600 dark:text-rose-500" :
                    user.role === 'manager' ? "bg-indigo-500/20 text-indigo-600 dark:text-indigo-500" :
                    "bg-emerald-500/20 text-emerald-600 dark:text-emerald-500"
                  )}>
                    {ROLE_LABELS[user.role] || user.role}
                  </span>
                </div>
              </div>

              <div className="space-y-3 mt-4 text-sm flex-1">
                <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
                  <UserIcon className="w-4 h-4 text-gray-500" />
                  {user.username}
                </div>
                {user.phone && (
                  <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
                    <Phone className="w-4 h-4 text-gray-500" />
                    {user.phone}
                  </div>
                )}
                {user.role !== 'admin' && (
                  <>
                    <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400">
                      <DollarSign className="w-4 h-4 text-gray-500" />
                      {user.salaryAmount?.toLocaleString() || 0}đ / {user.salaryType === 'monthly' ? 'Tháng' : user.salaryType === 'daily' ? 'Ngày' : 'Giờ'}
                    </div>
                    <div className="flex flex-col gap-1 mt-2 text-gray-600 dark:text-gray-400">
                      <div className="flex items-center gap-3">
                        <Clock className="w-4 h-4 text-gray-500" /> Ca làm việc:
                      </div>
                      <div className="pl-7 text-xs space-y-1">
                        {user.shifts?.map((shift, idx) => (
                          <div key={idx} className="bg-black/5 dark:bg-white/5 px-2 py-1 rounded inline-block mr-1">
                            {shift.start} - {shift.end}
                          </div>
                        )) || (user.shiftStart ? (
                          <div className="bg-black/5 dark:bg-white/5 px-2 py-1 rounded inline-block mr-1">
                            {user.shiftStart} - {user.shiftEnd || '17:00'}
                          </div>
                        ) : 'Chưa xếp ca')}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'payroll' && (
        !isAttendanceUnlocked ? (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-8 text-center space-y-4 max-w-xl mx-auto my-8">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center border border-amber-400/60 shadow-inner">
              <Lock className="w-8 h-8 text-amber-500" />
            </div>
            <div className="space-y-2">
              <h4 className="text-lg font-bold text-gray-900 dark:text-white">
                Tính năng Chấm công & Bảng lương chưa được kích hoạt
              </h4>
              <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                Gói dịch vụ hiện tại của cửa hàng chưa mở khóa tính năng <span className="font-semibold text-gray-900 dark:text-white">Chấm công nhân viên</span>. Để quản lý bảng chấm công, tính công và chốt lương tự động, vui lòng nâng cấp gói dịch vụ.
              </p>
            </div>
            {onUpgrade && (
              <button
                type="button"
                onClick={onUpgrade}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white font-bold rounded-xl text-xs md:text-sm transition-all shadow-md shadow-emerald-500/20 cursor-pointer"
              >
                <Lock className="w-4 h-4" />
                Xem & Nâng cấp gói dịch vụ
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-gray-900 dark:text-white font-bold">Bảng lương tháng {payrollMonth}</h4>
            <input 
              type="month" 
              value={payrollMonth}
              onChange={(e) => handleMonthChange(e.target.value)}
              className="bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-x-auto shadow-sm">
            <table className="w-full text-left border-collapse min-w-[920px]">
              <thead className="bg-white dark:bg-[#1a1b1e] border-b border-black/10 dark:border-white/10">
                <tr className="text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                  <th className="px-5 py-4 font-bold">Nhân viên</th>
                  <th className="px-4 py-4 font-bold">Hình thức & Mức lương</th>
                  <th className="px-4 py-4 font-bold text-center">Ngày công</th>
                  <th className="px-4 py-4 font-bold text-center">Tổng giờ làm</th>
                  <th className="px-5 py-4 font-bold text-right">Lương tạm tính</th>
                  <th className="px-4 py-4 font-bold text-center">Trạng thái</th>
                  <th className="px-5 py-4 font-bold text-center">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 dark:divide-white/5">
                {payrollData.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                      Không có dữ liệu nhân viên (ngoại trừ Admin).
                    </td>
                  </tr>
                ) : (
                  payrollData.map((row) => (
                    <React.Fragment key={row.user.id}>
                      <tr 
                        className={cn(
                          "transition-colors cursor-pointer border-b border-black/5 dark:border-white/5",
                          selectedUserPayroll === row.user.id 
                            ? "bg-emerald-500/10 dark:bg-emerald-500/15" 
                            : "hover:bg-black/5 dark:hover:bg-white/5"
                        )}
                        onClick={() => setSelectedUserPayroll(selectedUserPayroll === row.user.id ? null : row.user.id)}
                      >
                        {/* 1. Nhân viên */}
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-bold flex items-center justify-center text-xs border border-emerald-500/20 shrink-0">
                              {row.user.name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-bold text-gray-900 dark:text-white text-sm">
                                {row.user.name}
                              </div>
                              <div className="text-[11px] text-gray-500">
                                @{row.user.username}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* 2. Hình thức & Mức lương */}
                        <td className="px-4 py-4">
                          <div className="space-y-0.5">
                            <span className={cn(
                              "text-[10px] font-bold px-2 py-0.5 rounded-full inline-block uppercase",
                              row.user.salaryType === 'monthly' ? "bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/25" :
                              row.user.salaryType === 'hourly' ? "bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/25" :
                              "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25"
                            )}>
                              {row.user.salaryType === 'monthly' ? 'Theo tháng' : row.user.salaryType === 'hourly' ? 'Theo giờ' : 'Theo ngày'}
                            </span>
                            <div className="font-mono text-xs font-semibold text-gray-800 dark:text-gray-200">
                              {(row.user.salaryAmount || 0).toLocaleString('vi-VN')}đ/{row.user.salaryType === 'monthly' ? 'th' : row.user.salaryType === 'hourly' ? 'h' : 'ngày'}
                            </div>
                          </div>
                        </td>

                        {/* 3. Ngày công */}
                        <td className="px-4 py-4 text-center">
                          <span className="font-mono font-bold text-blue-600 dark:text-blue-400 text-sm px-2.5 py-1 bg-blue-500/10 dark:bg-blue-500/20 rounded-lg inline-block border border-blue-500/20">
                            {row.presentDays} công
                          </span>
                        </td>

                        {/* 4. Ô tính số giờ làm */}
                        <td className="px-4 py-4 text-center">
                          <div className="inline-flex items-center gap-1.5 font-mono font-bold text-purple-600 dark:text-purple-400 text-xs px-2.5 py-1 bg-purple-500/10 dark:bg-purple-500/20 rounded-lg border border-purple-500/20" title={`Tổng thời gian làm: ${row.totalHours.toFixed(2)} giờ`}>
                            <Clock className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                            <span>{formatWorkHours(row.totalHours)}</span>
                            <span className="text-[10px] text-purple-400 font-normal">({row.totalHours.toFixed(1)}h)</span>
                          </div>
                        </td>

                        {/* 5. Lương tạm tính */}
                        <td className="px-5 py-4 text-right">
                          <div className="font-mono font-bold text-emerald-600 dark:text-emerald-400 text-base">
                            {Math.round(row.totalSalary).toLocaleString('vi-VN')}đ
                          </div>
                          {(row.bonus > 0 || row.deduction > 0) && (
                            <div className="text-[10px] text-gray-500 font-mono">
                              {row.bonus > 0 ? `+${Math.round(row.bonus).toLocaleString('vi-VN')}đ ` : ''}
                              {row.deduction > 0 ? `-${Math.round(row.deduction).toLocaleString('vi-VN')}đ` : ''}
                            </div>
                          )}
                        </td>

                        {/* 6. Trạng thái */}
                        <td className="px-4 py-4 text-center">
                          {row.finalized ? (
                            <span className="px-2.5 py-1 bg-emerald-500/20 text-emerald-600 dark:text-emerald-500 text-[11px] font-bold uppercase rounded-md border border-emerald-500/30 inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" />
                              Đã chốt
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 bg-amber-500/20 text-amber-600 dark:text-amber-500 text-[11px] font-bold uppercase rounded-md border border-amber-500/30 inline-flex items-center gap-1">
                              Tạm tính
                            </span>
                          )}
                        </td>

                        {/* 7. Thao tác */}
                        <td className="px-5 py-4 text-center" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-center gap-1.5">
                            {row.finalized ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handlePrintPayroll(row)}
                                  className="px-2.5 py-1 bg-blue-500/15 hover:bg-blue-500/25 text-blue-600 dark:text-blue-400 border border-blue-500/30 text-xs font-bold rounded-lg transition-all cursor-pointer"
                                  title="In phiếu lương cho nhân viên"
                                >
                                  In phiếu
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleUnfinalize(row)}
                                  disabled={isUnfinalizing}
                                  className="px-2.5 py-1 bg-amber-500/15 hover:bg-amber-500/25 text-amber-600 dark:text-amber-400 border border-amber-500/30 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1"
                                  title="Mở lại bảng lương để chỉnh sửa hoặc tính lại"
                                >
                                  <Unlock className="w-3.5 h-3.5" />
                                  Mở chốt
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setSelectedUserPayroll(selectedUserPayroll === row.user.id ? null : row.user.id)}
                                className="px-3 py-1 bg-black/5 dark:bg-white/10 hover:bg-emerald-500 hover:text-white text-gray-700 dark:text-gray-300 text-xs font-semibold rounded-lg transition-all flex items-center gap-1 cursor-pointer"
                              >
                                Chi tiết
                                {selectedUserPayroll === row.user.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Chi tiết mở rộng khi bấm vào nhân viên */}
                      {selectedUserPayroll === row.user.id && (
                        <tr className="bg-black/5 dark:bg-white/5 border-t-0">
                          <td colSpan={7} className="p-0">
                            <div className="sticky left-0 w-[calc(100vw-32px)] md:w-full bg-gray-100 dark:bg-[#15161a] p-4 md:p-6 border-b border-black/5 dark:border-white/5 space-y-5">
                              {/* 1. Khối tổng quan công thức tính lương & giờ làm việc */}
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {/* Cột 1: Cơ sở tính lương */}
                                <div className="bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl p-4 space-y-2">
                                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                                    <DollarSign className="w-3.5 h-3.5 text-emerald-500" />
                                    Cơ cấu lương cơ bản
                                  </div>
                                  <div className="space-y-1.5 text-sm">
                                    <div className="flex justify-between items-center">
                                      <span className="text-gray-500 text-xs">Hình thức:</span>
                                      <span className="font-semibold text-gray-800 dark:text-gray-200 text-xs">
                                        {row.user.salaryType === 'monthly' ? 'Theo tháng' : row.user.salaryType === 'daily' ? 'Theo ngày' : 'Theo giờ'}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center">
                                      <span className="text-gray-500 text-xs">Đơn giá lương:</span>
                                      <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400 text-xs">
                                        {(row.user.salaryAmount || 0).toLocaleString('vi-VN')}đ / {row.user.salaryType === 'monthly' ? 'tháng' : row.user.salaryType === 'daily' ? 'ngày' : 'giờ'}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center pt-1 border-t border-black/5 dark:border-white/5">
                                      <span className="text-gray-500 text-xs">Công thức:</span>
                                      <span className="text-xs font-mono text-gray-700 dark:text-gray-300 font-semibold">
                                        {row.user.salaryType === 'daily' ? (
                                          `${row.presentDays} công × ${(row.user.salaryAmount || 0).toLocaleString('vi-VN')}đ`
                                        ) : row.user.salaryType === 'hourly' ? (
                                          `${row.totalHours.toFixed(1)}h × ${(row.user.salaryAmount || 0).toLocaleString('vi-VN')}đ`
                                        ) : (
                                          'Lương cố định tháng'
                                        )}
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center font-bold text-sm text-gray-900 dark:text-white pt-0.5">
                                      <span className="text-xs text-gray-600 dark:text-gray-400">Lương theo công/giờ:</span>
                                      <span className="font-mono text-blue-600 dark:text-blue-400">{Math.round(row.calculatedSalary).toLocaleString('vi-VN')}đ</span>
                                    </div>
                                  </div>
                                </div>

                                {/* Cột 2: Thống kê thời gian làm việc & ngày công */}
                                <div className="bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl p-4 space-y-2">
                                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                                    <Clock className="w-3.5 h-3.5 text-purple-500" />
                                    Thời gian làm việc
                                  </div>
                                  <div className="space-y-1.5 text-sm">
                                    <div className="flex justify-between items-center">
                                      <span className="text-gray-500 text-xs">Tổng giờ làm:</span>
                                      <span className="font-mono font-bold text-purple-600 dark:text-purple-400 text-sm">
                                        {formatWorkHours(row.totalHours)} ({row.totalHours.toFixed(1)} giờ)
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center">
                                      <span className="text-gray-500 text-xs">Tổng ngày công:</span>
                                      <span className="font-mono font-bold text-blue-600 dark:text-blue-400 text-sm">
                                        {row.presentDays} công
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center pt-1 border-t border-black/5 dark:border-white/5 text-xs text-gray-500">
                                      <span>TB giờ làm / công:</span>
                                      <span className="font-mono font-semibold text-gray-700 dark:text-gray-300">
                                        {row.presentDays > 0 ? (row.totalHours / row.presentDays).toFixed(1) : '0'} giờ/công
                                      </span>
                                    </div>
                                    <div className="flex justify-between items-center text-xs text-gray-500">
                                      <span>Số lượt chấm công:</span>
                                      <span className="font-mono font-medium text-gray-700 dark:text-gray-300">{row.records.length} lượt</span>
                                    </div>
                                  </div>
                                </div>

                                {/* Cột 3: Thực nhận & thao tác chốt */}
                                <div className="bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent border border-emerald-500/25 rounded-xl p-4 flex flex-col justify-between space-y-3">
                                  <div>
                                    <div className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider mb-1">
                                      {row.finalized ? 'Lương thực nhận (Đã chốt)' : 'Lương tạm tính (Chưa chốt)'}
                                    </div>
                                    <div className="font-mono text-2xl lg:text-3xl font-extrabold text-emerald-600 dark:text-emerald-400">
                                      {Math.round(row.totalSalary).toLocaleString('vi-VN')}đ
                                    </div>
                                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                                      = {Math.round(row.calculatedSalary).toLocaleString('vi-VN')}đ (cơ bản)
                                      {row.bonus > 0 ? ` + ${Math.round(row.bonus).toLocaleString('vi-VN')}đ (thưởng)` : ''}
                                      {row.deduction > 0 ? ` - ${Math.round(row.deduction).toLocaleString('vi-VN')}đ (phạt)` : ''}
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2 pt-2 border-t border-emerald-500/20">
                                    {row.finalized ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => handlePrintPayroll(row)}
                                          className="flex-1 py-2 px-3 bg-blue-500 hover:bg-blue-600 text-white font-bold rounded-lg text-xs transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer"
                                        >
                                          In phiếu lương
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleUnfinalize(row)}
                                          disabled={isUnfinalizing}
                                          className="py-2 px-3 bg-amber-500/15 hover:bg-amber-500/25 text-amber-600 dark:text-amber-400 border border-amber-500/30 font-bold rounded-lg text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                                        >
                                          <Unlock className="w-3.5 h-3.5" />
                                          Mở chốt
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => handleFinalize(row)}
                                        disabled={!isDataReady || row.hasOpenSession || isFinalizing}
                                        className="w-full py-2.5 px-4 bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white font-bold rounded-lg text-sm transition-all shadow-md shadow-emerald-500/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                      >
                                        <Lock className="w-4 h-4" />
                                        Chốt bảng lương
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {/* 2. Điều chỉnh Thưởng & Khấu trừ */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
                                  <h6 className="text-emerald-600 dark:text-emerald-500 font-bold text-xs uppercase tracking-wider flex items-center gap-2">
                                    <Plus className="w-3.5 h-3.5" /> Tiền Thưởng thêm
                                  </h6>
                                  {row.finalized ? (
                                    <div className="space-y-1.5 text-sm">
                                      <div className="flex justify-between items-center">
                                        <span className="text-gray-500 text-xs">Số tiền thưởng:</span>
                                        <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">+{Math.round(row.bonus).toLocaleString('vi-VN')}đ</span>
                                      </div>
                                      {row.bonusReason && (
                                        <div className="flex justify-between border-t border-black/5 dark:border-white/5 pt-1.5 text-xs">
                                          <span className="text-gray-500">Lý do:</span>
                                          <span className="text-gray-800 dark:text-gray-200 text-right font-medium">{row.bonusReason}</span>
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <>
                                      <div className="space-y-1">
                                        <label className="text-[11px] font-medium text-gray-600 dark:text-gray-400">Số tiền thưởng (đ)</label>
                                        <CurrencyInput 
                                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-3 py-1.5 font-mono text-sm text-emerald-600 dark:text-emerald-400 focus:outline-none focus:border-emerald-500/50"
                                          placeholder="0"
                                          value={bonusInputs[row.user.id] || ''}
                                          onChange={(val) => setBonusInputs({...bonusInputs, [row.user.id]: Number(val)})}
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <label className="text-[11px] font-medium text-gray-600 dark:text-gray-400">Lý do thưởng</label>
                                        <input 
                                          type="text"
                                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-3 py-1.5 text-gray-900 dark:text-white text-xs focus:outline-none focus:border-emerald-500/50"
                                          placeholder="Vd: Chăm chỉ, doanh số cao, làm thêm giờ..."
                                          value={bonusReasonInputs[row.user.id] || ''}
                                          onChange={(e) => setBonusReasonInputs({...bonusReasonInputs, [row.user.id]: e.target.value})}
                                        />
                                      </div>
                                    </>
                                  )}
                                </div>

                                <div className="space-y-3 bg-rose-500/5 border border-rose-500/20 rounded-xl p-4">
                                  <h6 className="text-rose-600 dark:text-rose-500 font-bold text-xs uppercase tracking-wider flex items-center gap-2">
                                    <Minus className="w-3.5 h-3.5" /> Tiền Khấu trừ / Phạt
                                  </h6>
                                  {row.finalized ? (
                                    <div className="space-y-1.5 text-sm">
                                      <div className="flex justify-between items-center">
                                        <span className="text-gray-500 text-xs">Số tiền khấu trừ:</span>
                                        <span className="font-mono text-rose-600 dark:text-rose-400 font-bold">-{Math.round(row.deduction).toLocaleString('vi-VN')}đ</span>
                                      </div>
                                      {row.deductionReason && (
                                        <div className="flex justify-between border-t border-black/5 dark:border-white/5 pt-1.5 text-xs">
                                          <span className="text-gray-500">Lý do:</span>
                                          <span className="text-gray-800 dark:text-gray-200 text-right font-medium">{row.deductionReason}</span>
                                        </div>
                                      )}
                                    </div>
                                  ) : (
                                    <>
                                      <div className="space-y-1">
                                        <label className="text-[11px] font-medium text-gray-600 dark:text-gray-400">Số tiền khấu trừ (đ)</label>
                                        <CurrencyInput 
                                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-3 py-1.5 font-mono text-sm text-rose-600 dark:text-rose-400 focus:outline-none focus:border-rose-500/50"
                                          placeholder="0"
                                          value={deductionInputs[row.user.id] || ''}
                                          onChange={(val) => setDeductionInputs({...deductionInputs, [row.user.id]: Number(val)})}
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <label className="text-[11px] font-medium text-gray-600 dark:text-gray-400">Lý do khấu trừ</label>
                                        <input 
                                          type="text"
                                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-3 py-1.5 text-gray-900 dark:text-white text-xs focus:outline-none focus:border-rose-500/50"
                                          placeholder="Vd: Đi trễ, vi phạm quy định, làm bể đồ..."
                                          value={deductionReasonInputs[row.user.id] || ''}
                                          onChange={(e) => setDeductionReasonInputs({...deductionReasonInputs, [row.user.id]: e.target.value})}
                                        />
                                      </div>
                                    </>
                                  )}
                                </div>
                              </div>

                              {/* 3. Chi tiết chấm công & Số giờ làm trên mỗi ngày */}
                              <div className="bg-white dark:bg-[#1a1b1e] rounded-xl p-4 border border-black/5 dark:border-white/5 space-y-3">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 pb-2 border-b border-black/5 dark:border-white/5">
                                  <h5 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
                                    <Calendar className="w-4 h-4 text-emerald-500" />
                                    <span>Chi tiết chấm công tháng {payrollMonth} ({row.records.length} lượt)</span>
                                  </h5>
                                  <span className="text-xs text-gray-500">
                                    {row.user.salaryType === 'daily' 
                                      ? 'Hiển thị số giờ làm và tiền công tương ứng theo từng ngày' 
                                      : 'Hiển thị số giờ làm và tiền lương theo từng lượt chấm công'}
                                  </span>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                  {row.records.map(record => {
                                    const dur = getRecordDurationInfo(record);
                                    const dayWeight = record.status === 'half-day' ? 0.5 : 1;
                                    const dayName = getVietnameseDayOfWeek(record.date);
                                    const dailyWage = Math.round((row.user.salaryAmount || 0) * dayWeight);
                                    const hourlyWage = Math.round((row.user.salaryAmount || 0) * dur.hours);

                                    return (
                                      <div 
                                        key={record.id} 
                                        className="bg-black/[0.02] dark:bg-white/[0.03] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] rounded-xl p-3 flex flex-col gap-2 border border-black/5 dark:border-white/5 transition-all shadow-xs"
                                      >
                                        {/* Tiêu đề ngày & Trạng thái công */}
                                        <div className="flex justify-between items-center">
                                          <div className="flex items-center gap-1.5">
                                            <span className="text-xs font-bold text-gray-900 dark:text-white">
                                              {dayName ? `${dayName}, ` : ''}{format(parseISO(record.date), 'dd/MM')}
                                            </span>
                                            {dur.isOvernight && (
                                              <span className="text-[9px] font-bold px-1.5 py-0.2 bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/25 rounded" title="Ca làm việc qua đêm">
                                                Qua đêm
                                              </span>
                                            )}
                                          </div>
                                          <span className={cn(
                                            "text-[10px] font-bold uppercase px-2 py-0.5 rounded-full",
                                            record.status === 'present' ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20" :
                                            record.status === 'late' ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20" : 
                                            "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                                          )}>
                                            {record.status === 'present' ? '1.0 công' : record.status === 'late' ? 'Trễ (1 công)' : '0.5 công'}
                                          </span>
                                        </div>

                                        {/* Giờ vào & Giờ ra */}
                                        <div className="grid grid-cols-2 gap-1 text-[11px] text-gray-600 dark:text-gray-400 py-1 border-t border-b border-black/5 dark:border-white/5">
                                          <div>Vào: <span className="font-mono font-bold text-gray-800 dark:text-gray-200">{record.checkInTime ? format(parseISO(record.checkInTime), 'HH:mm') : '---'}</span></div>
                                          <div>Ra: <span className="font-mono font-bold text-gray-800 dark:text-gray-200">{record.checkOutTime ? format(parseISO(record.checkOutTime), 'HH:mm') : '---'}</span></div>
                                        </div>

                                        {/* Số giờ làm trong ngày */}
                                        <div className="flex items-center justify-between text-xs font-semibold text-purple-700 dark:text-purple-400 bg-purple-500/10 px-2.5 py-1.5 rounded-lg">
                                          <span className="flex items-center gap-1 text-[11px]">
                                            <Clock className="w-3 h-3 text-purple-500" />
                                            Số giờ làm:
                                          </span>
                                          <span className="font-mono font-bold">
                                            {dur.isOpen ? <span className="text-amber-500 text-[11px]">Đang làm...</span> : `${dur.formattedText} (${dur.hours.toFixed(1)}h)`}
                                          </span>
                                        </div>

                                        {/* Với nhân viên tính lương theo ngày: hiển thị tiền công ngày đó */}
                                        {row.user.salaryType === 'daily' && (
                                          <div className="flex items-center justify-between text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-1.5 rounded-lg">
                                            <span className="text-[10px] text-gray-600 dark:text-gray-400">Tiền công ngày:</span>
                                            <span className="font-mono font-bold">
                                              {dailyWage.toLocaleString('vi-VN')}đ
                                            </span>
                                          </div>
                                        )}

                                        {/* Với nhân viên tính lương theo giờ: hiển thị lương theo số giờ của ca đó */}
                                        {row.user.salaryType === 'hourly' && (
                                          <div className="flex items-center justify-between text-[11px] font-semibold text-blue-700 dark:text-blue-400 bg-blue-500/10 px-2.5 py-1.5 rounded-lg">
                                            <span className="text-[10px] text-gray-600 dark:text-gray-400">Lương ca ({dur.hours.toFixed(1)}h):</span>
                                            <span className="font-mono font-bold">
                                              {hourlyWage.toLocaleString('vi-VN')}đ
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                  {row.records.length === 0 && (
                                    <div className="col-span-full py-6 text-center text-xs text-gray-500 italic">
                                      Nhân viên này chưa có lượt chấm công nào trong tháng {payrollMonth}.
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )
    )}

      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-2xl rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6 my-8 max-h-[90vh] flex flex-col relative">
            <button 
              onClick={() => setShowAdd(false)}
              className="absolute top-6 right-6 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
            >
              <XCircle className="w-6 h-6" />
            </button>
            <h3 className="text-xl font-bold text-gray-900 dark:text-white flex-shrink-0">
              {editingUserId ? 'Chỉnh sửa nhân viên' : 'Thêm nhân viên mới'}
            </h3>
            
            <div className="overflow-y-auto custom-scrollbar flex-1 pr-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tên nhân viên *</label>
                  <input 
                    type="text" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newUser.name}
                    onChange={(e) => setNewUser({...newUser, name: e.target.value})}
                  />
                </div>
                
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tên đăng nhập *</label>
                  <input 
                    type="text" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newUser.username}
                    onChange={(e) => setNewUser({...newUser, username: e.target.value.toLowerCase().replace(/\s/g, '')})}
                    disabled={!!editingUserId}
                  />
                </div>
                
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                    Mật khẩu {editingUserId ? '(Để trống nếu không muốn đổi)' : '*'}
                  </label>
                  <input 
                    type="password" 
                    placeholder={editingUserId ? "Để trống nếu không đổi mật khẩu" : "Nhập mật khẩu cho nhân viên"}
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newUser.password}
                    onChange={(e) => setNewUser({...newUser, password: e.target.value})}
                  />
                  {editingUserId && (
                    <p className="text-[11px] text-gray-400 mt-1">
                      Mật khẩu nhân viên được bảo mật một chiều. Nếu nhân viên quên, bạn có thể nhập mật khẩu mới tại đây để đặt lại.
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Vai trò</label>
                  <select 
                    className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newUser.role}
                    onChange={(e) => setNewUser({...newUser, role: e.target.value as UserRole})}
                  >
                    <option value="order" className="bg-white dark:bg-[#1a1b1e]">Nhân viên Order</option>
                    <option value="cashier" className="bg-white dark:bg-[#1a1b1e]">Thu ngân</option>
                    <option value="order_cashier" className="bg-white dark:bg-[#1a1b1e]">Order & Thu ngân</option>
                    <option value="kitchen" className="bg-white dark:bg-[#1a1b1e]">Bếp / Pha chế</option>
                    <option value="manager" className="bg-white dark:bg-[#1a1b1e]">Quản lý</option>
                    {isSuperAdmin && (
                      <option value="admin" className="bg-white dark:bg-[#1a1b1e]">Quản trị viên</option>
                    )}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Số điện thoại</label>
                  <input 
                    type="text" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newUser.phone}
                    onChange={(e) => setNewUser({...newUser, phone: e.target.value})}
                    placeholder="Không bắt buộc"
                  />
                </div>

                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">CCCD</label>
                  <input 
                    type="text" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newUser.cccd}
                    onChange={(e) => setNewUser({...newUser, cccd: e.target.value})}
                    placeholder="Không bắt buộc"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Địa chỉ</label>
                  <textarea 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 resize-none h-16"
                    value={newUser.address}
                    onChange={(e) => setNewUser({...newUser, address: e.target.value})}
                    placeholder="Không bắt buộc"
                  />
                </div>

                <div className="md:col-span-2 border-t border-black/10 dark:border-white/10 pt-4 mt-2">
                  <h4 className="font-bold text-gray-900 dark:text-white mb-4 text-sm flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-500" /> Thông tin Lương & Ca làm
                  </h4>
                  {currentUser?.role !== 'manager' && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Hình thức lương</label>
                        <select 
                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                          value={newUser.salaryType}
                          onChange={(e) => setNewUser({...newUser, salaryType: e.target.value as 'daily' | 'monthly' | 'hourly'})}
                        >
                          <option value="daily" className="bg-white dark:bg-[#1a1b1e]">Theo ngày</option>
                          <option value="monthly" className="bg-white dark:bg-[#1a1b1e]">Theo tháng</option>
                          <option value="hourly" className="bg-white dark:bg-[#1a1b1e]">Theo giờ</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Mức lương cơ bản</label>
                        <CurrencyInput 
                          className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                          value={newUser.salaryAmount || ''}
                          onChange={(val) => setNewUser({...newUser, salaryAmount: Number(val)})}
                          placeholder="VD: 5000000"
                        />
                      </div>
                    </div>
                  )}

                  <div className="mt-4 flex items-center justify-between p-4 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                    <div>
                      <h4 className="font-bold text-gray-900 dark:text-white">Yêu cầu chấm công</h4>
                      <p className="text-xs text-gray-500">Bắt buộc quét mã QR khi vào ca và đóng ca</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        className="sr-only peer"
                        checked={newUser.requiresAttendance || false}
                        onChange={(e) => setNewUser({...newUser, requiresAttendance: e.target.checked})}
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-emerald-500"></div>
                    </label>
                  </div>

                  <div className="mt-4">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs text-gray-500 uppercase font-bold block">Ca làm việc</label>
                      <button 
                        onClick={addShift}
                        className="flex items-center gap-1 px-2 py-1 bg-emerald-500/20 text-emerald-600 dark:text-emerald-500 text-xs rounded font-bold hover:bg-emerald-500/30 transition-colors"
                      >
                        <Plus className="w-3 h-3" /> Thêm ca
                      </button>
                    </div>
                    <div className="space-y-2">
                      {newUser.shifts?.map((shift, idx) => (
                        <div key={idx} className="flex gap-2 items-center bg-black/5 dark:bg-white/5 p-2 rounded-xl border border-black/5 dark:border-white/5">
                          <div className="flex-1">
                            <span className="text-[10px] text-gray-500 uppercase block mb-1">Từ giờ</span>
                            <input 
                              type="time" 
                              className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg py-1 px-2 text-gray-900 dark:text-white text-sm focus:outline-none"
                              value={shift.start}
                              onChange={(e) => updateShift(idx, 'start', e.target.value)}
                            />
                          </div>
                          <div className="flex-1">
                            <span className="text-[10px] text-gray-500 uppercase block mb-1">Đến giờ</span>
                            <input 
                              type="time" 
                              className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg py-1 px-2 text-gray-900 dark:text-white text-sm focus:outline-none"
                              value={shift.end}
                              onChange={(e) => updateShift(idx, 'end', e.target.value)}
                            />
                          </div>
                          <button 
                            onClick={() => removeShift(idx)}
                            className="mt-5 p-1.5 bg-rose-500/10 text-rose-600 dark:text-rose-500 rounded-lg hover:bg-rose-500/20 disabled:opacity-30"
                            disabled={newUser.shifts?.length === 1}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-4 border-t border-black/10 dark:border-white/10 flex-shrink-0">
              <button 
                onClick={() => setShowAdd(false)}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-600 dark:text-gray-400 font-bold hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Hủy
              </button>
              <button 
                onClick={handleSave}
                disabled={!newUser.username || (!newUser.password && !editingUserId) || !newUser.name}
                className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-400 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Lưu nhân viên
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
