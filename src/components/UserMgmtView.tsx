import React, { useState, useMemo } from 'react';
import { UserPlus, Search, Shield, User as UserIcon, Trash2, Key, Phone, CreditCard, MapPin, DollarSign, Clock, Calendar, CheckCircle2, XCircle, Plus, Minus, Edit2 } from 'lucide-react';
import { User, UserRole, AttendanceRecord, PayrollRecord } from '../types';
import { cn } from '../lib/utils';
import { CurrencyInput } from './CurrencyInput';
import { format, parseISO, startOfMonth, endOfMonth, isWithinInterval } from 'date-fns';

export const UserMgmtView = ({ 
  users, 
  currentUser,
  attendanceRecords,
  payrollRecords,
  onAddUser, 
  onDeleteUser,
  onUpdateUser,
  onFinalizePayroll,
  checkFeatureLimit
}: { 
  users: User[], 
  currentUser?: User,
  attendanceRecords: AttendanceRecord[],
  payrollRecords: PayrollRecord[],
  onAddUser: (user: User) => void,
  onDeleteUser: (id: string) => void,
  onUpdateUser: (user: User) => void,
  onFinalizePayroll: (record: PayrollRecord) => void,
  checkFeatureLimit?: (feature: string, currentUsage: number) => boolean
}) => {
  const [activeTab, setActiveTab] = useState<'accounts' | 'payroll'>('accounts');
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

  const [payrollMonth, setPayrollMonth] = useState(format(new Date(), 'yyyy-MM'));
  
  // Temporary state for bonus inputs
  const [bonusInputs, setBonusInputs] = useState<Record<string, number>>({});
  const [bonusReasonInputs, setBonusReasonInputs] = useState<Record<string, string>>({});
  const [deductionInputs, setDeductionInputs] = useState<Record<string, number>>({});
  const [deductionReasonInputs, setDeductionReasonInputs] = useState<Record<string, string>>({});

  const handleEditUser = (user: User) => {
    setNewUser({
      username: user.username,
      name: user.name,
      password: user.password || '',
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
    
    if (editingUserId) {
      const existingUser = users.find(u => u.id === editingUserId);
      if (existingUser) {
        onUpdateUser({
          ...existingUser,
          ...newUser,
          // Only update password if provided
          password: newUser.password ? newUser.password : existingUser.password
        });
      }
    } else {
      if (!newUser.password) return; // password required for new user
      onAddUser({
        id: '',
        ...newUser,
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

  const payrollData = useMemo(() => {
    const start = startOfMonth(parseISO(`${payrollMonth}-01`));
    const end = endOfMonth(start);
    
    return users.filter(u => u.role !== 'admin').map(user => {
      // Check if finalized payroll exists
      const finalized = payrollRecords.find(p => p.userId === user.id && p.month === payrollMonth && p.status === 'finalized');

      const records = attendanceRecords.filter(r => 
        r.userId === user.id && 
        isWithinInterval(parseISO(r.date), { start, end }) &&
        (r.status === 'present' || r.status === 'half-day' || r.status === 'late')
      );
      
      let presentDays = 0;
      let totalHours = 0;
      records.forEach(r => {
        if (r.status === 'present' || r.status === 'late') presentDays += 1;
        if (r.status === 'half-day') presentDays += 0.5;
        
        if (user.salaryType === 'hourly') {
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
      if (user.salaryType === 'monthly') {
        calculatedSalary = user.salaryAmount || 0;
      } else if (user.salaryType === 'daily') {
        calculatedSalary = (user.salaryAmount || 0) * presentDays;
      } else if (user.salaryType === 'hourly') {
        calculatedSalary = (user.salaryAmount || 0) * totalHours;
      }

      if (finalized) {
        return {
          user,
          presentDays: finalized.presentDays,
          calculatedSalary: finalized.calculatedSalary,
          bonus: finalized.bonus,
          bonusReason: finalized.bonusReason,
          deduction: finalized.deduction || 0,
          deductionReason: finalized.deductionReason,
          totalSalary: finalized.totalSalary,
          records,
          finalized: true
        };
      }

      const bonus = bonusInputs[user.id] || 0;
      const deduction = deductionInputs[user.id] || 0;

      return {
        user,
        presentDays,
        calculatedSalary,
        bonus,
        bonusReason: bonusReasonInputs[user.id] || '',
        deduction,
        deductionReason: deductionReasonInputs[user.id] || '',
        totalSalary: calculatedSalary + bonus - deduction,
        records,
        finalized: false
      };
    });
  }, [users, attendanceRecords, payrollMonth, payrollRecords, bonusInputs, bonusReasonInputs, deductionInputs, deductionReasonInputs]);

  const handleFinalize = (data: any) => {
    if (data.finalized) return;
    
    const record: PayrollRecord = {
      id: '', // Set by App.tsx
      userId: data.user.id,
      storeId: data.user.storeId,
      month: payrollMonth,
      presentDays: data.presentDays,
      baseSalaryAmount: data.user.salaryAmount || 0,
      baseSalaryType: data.user.salaryType || 'daily',
      calculatedSalary: data.calculatedSalary,
      bonus: data.bonus,
      bonusReason: data.bonusReason,
      deduction: data.deduction,
      deductionReason: data.deductionReason,
      totalSalary: data.totalSalary,
      status: 'finalized',
      finalizedAt: new Date().toISOString()
    };
    onFinalizePayroll(record);
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
              <th>Hình thức lương:</th>
              <td>${data.user.salaryType === 'monthly' ? 'Theo tháng' : data.user.salaryType === 'daily' ? 'Theo ngày' : 'Theo giờ'}</td>
            </tr>
            <tr>
              <th>Ngày công:</th>
              <td>${data.presentDays}</td>
            </tr>
            <tr>
              <th>Lương cơ bản:</th>
              <td class="money">${data.calculatedSalary.toLocaleString()}đ</td>
            </tr>
            <tr>
              <th>Thưởng:</th>
              <td class="money">+${data.bonus.toLocaleString()}đ</td>
            </tr>
            ${data.bonusReason ? `<tr><th>Lý do thưởng:</th><td>${data.bonusReason}</td></tr>` : ''}
            <tr>
              <th>Khấu trừ:</th>
              <td class="money">-${(data.deduction || 0).toLocaleString()}đ</td>
            </tr>
            ${data.deductionReason ? `<tr><th>Lý do khấu trừ:</th><td>${data.deductionReason}</td></tr>` : ''}
            <tr class="total">
              <th>TỔNG THỰC NHẬN:</th>
              <td class="money">${data.totalSalary.toLocaleString()}đ</td>
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
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Shield className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
          Quản lý Nhân sự
        </h3>

        {activeTab === 'accounts' && (
          <button 
            onClick={() => {
              if (checkFeatureLimit && !checkFeatureLimit('maxUsers', users.filter(u => u.role !== 'admin').length)) {
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
              "pb-4 px-2 text-sm font-bold transition-all border-b-2",
              activeTab === 'payroll' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            Lương & Chấm công
          </button>
        )}
      </div>

      {activeTab === 'accounts' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {users.filter(u => u.role !== 'admin').map((user) => (
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
                    user.role === 'kitchen' ? "bg-rose-500/20 text-rose-600 dark:text-rose-500" :
                    "bg-emerald-500/20 text-emerald-600 dark:text-emerald-500"
                  )}>
                    {user.role}
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
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-gray-900 dark:text-white font-bold">Bảng lương tháng {payrollMonth}</h4>
            <input 
              type="month" 
              value={payrollMonth}
              onChange={(e) => setPayrollMonth(e.target.value)}
              className="bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead className="bg-white dark:bg-[#1a1b1e]">
                <tr className="text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                  <th className="px-6 py-4 font-medium">Nhân viên</th>
                  <th className="px-6 py-4 font-medium text-center">Ngày công</th>
                  <th className="px-6 py-4 font-medium text-right">Lương tạm tính</th>
                  <th className="px-6 py-4 font-medium text-center">Trạng thái</th>
                  <th className="px-6 py-4 font-medium text-center">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 dark:divide-white/5">
                {payrollData.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                      Không có dữ liệu nhân viên (ngoại trừ Admin).
                    </td>
                  </tr>
                ) : (
                  payrollData.map((row) => (
                    <React.Fragment key={row.user.id}>
                      <tr className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer" onClick={() => setSelectedUserPayroll(selectedUserPayroll === row.user.id ? null : row.user.id)}>
                        <td className="px-6 py-4">
                          <div className="font-bold text-gray-900 dark:text-white flex items-center gap-2">
                            {row.user.name}
                            <span className="text-[10px] px-1.5 py-0.5 bg-black/10 dark:bg-white/10 rounded text-gray-600 dark:text-gray-400">
                              {row.user.salaryType === 'monthly' ? 'Tháng' : row.user.salaryType === 'daily' ? 'Ngày' : 'Giờ'}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-center font-bold text-blue-600 dark:text-blue-400">
                          {row.presentDays}
                        </td>
                        <td className="px-6 py-4 text-right font-mono text-gray-700 dark:text-gray-300">
                          {row.calculatedSalary.toLocaleString()}đ
                        </td>
                        <td className="px-6 py-4 text-center">
                          {row.finalized ? (
                            <span className="px-2 py-1 bg-emerald-500/20 text-emerald-600 dark:text-emerald-500 text-[10px] font-bold uppercase rounded-md">
                              Đã chốt
                            </span>
                          ) : (
                            <span className="px-2 py-1 bg-amber-500/20 text-amber-600 dark:text-amber-500 text-[10px] font-bold uppercase rounded-md">
                              Tạm tính
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-center" onClick={(e) => e.stopPropagation()}>
                          {row.finalized && (
                            <button
                              onClick={() => handlePrintPayroll(row)}
                              className="px-3 py-1.5 bg-blue-500/20 text-blue-600 dark:text-blue-400 border border-blue-500/30 text-xs font-bold rounded-lg hover:bg-blue-500 hover:text-gray-900 dark:hover:text-white transition-all cursor-pointer"
                            >
                              In phiếu lương
                            </button>
                          )}
                        </td>
                      </tr>
                      {/* Expanded View for Attendance details and Payroll Finalization */}
                      {selectedUserPayroll === row.user.id && (
                        <tr className="bg-black/5 dark:bg-white/5 border-t-0">
                          <td colSpan={5} className="p-0">
                            <div className="sticky left-0 w-[calc(100vw-32px)] md:w-full bg-gray-100 dark:bg-[#15161a] p-4 md:p-6 border-b border-black/5 dark:border-white/5 space-y-6">
                              {/* Lương adjustments */}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="space-y-4 bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
                                  <h6 className="text-emerald-600 dark:text-emerald-500 font-bold text-sm uppercase tracking-wider flex items-center gap-2">Thưởng</h6>
                                  {row.finalized ? (
                                    <>
                                      <div className="flex justify-between">
                                        <span className="text-gray-600 dark:text-gray-400 text-sm">Số tiền:</span>
                                        <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">+{row.bonus.toLocaleString()}đ</span>
                                      </div>
                                      {row.bonusReason && (
                                        <div className="flex justify-between border-t border-black/5 dark:border-white/5 pt-2 mt-2">
                                          <span className="text-gray-600 dark:text-gray-400 text-sm">Lý do:</span>
                                          <span className="text-gray-700 dark:text-gray-300 text-sm text-right">{row.bonusReason}</span>
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      <div className="space-y-1">
                                        <label className="text-xs text-gray-600 dark:text-gray-400">Số tiền thưởng (đ)</label>
                                        <CurrencyInput 
                                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 font-mono text-emerald-600 dark:text-emerald-400 focus:outline-none focus:border-emerald-500/50"
                                          placeholder="0"
                                          value={bonusInputs[row.user.id] || ''}
                                          onChange={(val) => setBonusInputs({...bonusInputs, [row.user.id]: Number(val)})}
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <label className="text-xs text-gray-600 dark:text-gray-400">Lý do thưởng</label>
                                        <input 
                                          type="text"
                                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-emerald-500/50"
                                          placeholder="Vd: Chăm chỉ, hoàn thành tốt..."
                                          value={bonusReasonInputs[row.user.id] || ''}
                                          onChange={(e) => setBonusReasonInputs({...bonusReasonInputs, [row.user.id]: e.target.value})}
                                        />
                                      </div>
                                    </>
                                  )}
                                </div>

                                <div className="space-y-4 bg-rose-500/5 border border-rose-500/20 rounded-xl p-4">
                                  <h6 className="text-rose-600 dark:text-rose-500 font-bold text-sm uppercase tracking-wider flex items-center gap-2">Khấu trừ</h6>
                                  {row.finalized ? (
                                    <>
                                      <div className="flex justify-between">
                                        <span className="text-gray-600 dark:text-gray-400 text-sm">Số tiền:</span>
                                        <span className="font-mono text-rose-600 dark:text-rose-400 font-bold">-{row.deduction.toLocaleString()}đ</span>
                                      </div>
                                      {row.deductionReason && (
                                        <div className="flex justify-between border-t border-black/5 dark:border-white/5 pt-2 mt-2">
                                          <span className="text-gray-600 dark:text-gray-400 text-sm">Lý do:</span>
                                          <span className="text-gray-700 dark:text-gray-300 text-sm text-right">{row.deductionReason}</span>
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      <div className="space-y-1">
                                        <label className="text-xs text-gray-600 dark:text-gray-400">Số tiền khấu trừ (đ)</label>
                                        <CurrencyInput 
                                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 font-mono text-rose-600 dark:text-rose-400 focus:outline-none focus:border-rose-500/50"
                                          placeholder="0"
                                          value={deductionInputs[row.user.id] || ''}
                                          onChange={(val) => setDeductionInputs({...deductionInputs, [row.user.id]: Number(val)})}
                                        />
                                      </div>
                                      <div className="space-y-1">
                                        <label className="text-xs text-gray-600 dark:text-gray-400">Lý do khấu trừ</label>
                                        <input 
                                          type="text"
                                          className="w-full bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-lg px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-rose-500/50"
                                          placeholder="Vd: Đi trễ, làm hỏng đồ..."
                                          value={deductionReasonInputs[row.user.id] || ''}
                                          onChange={(e) => setDeductionReasonInputs({...deductionReasonInputs, [row.user.id]: e.target.value})}
                                        />
                                      </div>
                                    </>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center justify-between p-4 bg-white dark:bg-[#1a1b1e] border border-black/5 dark:border-white/5 rounded-xl">
                                <div className="text-gray-600 dark:text-gray-400">Tổng thực nhận:</div>
                                <div className="flex items-center gap-4">
                                  <div className="font-mono text-2xl font-bold text-emerald-600 dark:text-emerald-500">{row.totalSalary.toLocaleString()}đ</div>
                                  {!row.finalized && (
                                    <button
                                      onClick={() => handleFinalize(row)}
                                      className="px-6 py-2 bg-emerald-500 text-white font-bold rounded-lg hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20"
                                    >
                                      Chốt lương
                                    </button>
                                  )}
                                </div>
                              </div>

                              <div className="bg-white dark:bg-[#1a1b1e] rounded-xl p-4 border border-black/5 dark:border-white/5">
                                <h5 className="text-sm font-bold text-gray-600 dark:text-gray-400 mb-3 flex items-center gap-2">
                                  <Calendar className="w-4 h-4" /> Chi tiết chấm công ({payrollMonth})
                                </h5>
                                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                                  {row.records.map(record => (
                                    <div key={record.id} className="bg-black/5 dark:bg-white/5 rounded-lg p-2 flex flex-col gap-1 border border-black/5 dark:border-white/5">
                                      <div className="flex justify-between items-center">
                                        <span className="text-xs font-bold text-gray-900 dark:text-white">{format(parseISO(record.date), 'dd/MM')}</span>
                                        <span className={cn(
                                          "text-[10px] font-bold uppercase",
                                          record.status === 'present' ? "text-emerald-600 dark:text-emerald-500" :
                                          record.status === 'late' ? "text-amber-600 dark:text-amber-500" : "text-blue-600 dark:text-blue-500"
                                        )}>
                                          {record.status === 'present' ? 'Đủ' : record.status === 'late' ? 'Trễ' : 'Nửa'}
                                        </span>
                                      </div>
                                      <div className="text-[10px] text-gray-500">
                                        Vào: {record.checkInTime ? format(parseISO(record.checkInTime), 'HH:mm') : '-'}
                                      </div>
                                      <div className="text-[10px] text-gray-500">
                                        Ra: {record.checkOutTime ? format(parseISO(record.checkOutTime), 'HH:mm') : '-'}
                                      </div>
                                    </div>
                                  ))}
                                  {row.records.length === 0 && (
                                    <div className="col-span-full text-xs text-gray-500 italic">Không có dữ liệu chấm công.</div>
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
                    onChange={(e) => setNewUser({...newUser, username: e.target.value})}
                    disabled={!!editingUserId}
                  />
                </div>
                
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">
                    Mật khẩu {editingUserId ? '(Để trống nếu không đổi)' : '*'}
                  </label>
                  <input 
                    type="password" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newUser.password}
                    onChange={(e) => setNewUser({...newUser, password: e.target.value})}
                  />
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
                    <option value="admin" className="bg-white dark:bg-[#1a1b1e]">Quản trị viên</option>
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
