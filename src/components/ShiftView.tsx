import React from 'react';
import { Wallet, Clock, ArrowRight, Lock, Unlock, History, X, AlertTriangle, Eye, Check, QrCode } from 'lucide-react';
import { Shift, VoidLog, User, Table } from '../types';
import { format, isAfter, subDays } from 'date-fns';
import { cn } from '../lib/utils';

export const ShiftView = ({ 
  activeShift, 
  allActiveShifts = [],
  history, 
  onOpenShift, 
  onCloseShift,
  onResolveDiscrepancy,
  currentUser,
  tables = [],
  hasCheckedInToday,
  onScanQR
}: { 
  activeShift: Shift | null, 
  allActiveShifts?: Shift[],
  history: Shift[],
  onOpenShift: (startCash: number) => void,
  onCloseShift: (endCash: number) => void,
  onResolveDiscrepancy?: (shiftId: string) => void,
  currentUser: User | null,
  tables?: Table[],
  hasCheckedInToday?: boolean,
  onScanQR?: () => void
}) => {
  const [showOpenModal, setShowOpenModal] = React.useState(false);
  const [showCloseModal, setShowCloseModal] = React.useState(false);
  const [selectedShift, setSelectedShift] = React.useState<Shift | null>(null);
  const [cashAmount, setCashAmount] = React.useState(0);
  const [cashAmountStr, setCashAmountStr] = React.useState('');
  const [showVoidLogs, setShowVoidLogs] = React.useState<VoidLog[] | null>(null);
  const [showCheckinReminder, setShowCheckinReminder] = React.useState(false);
  const [showCheckoutReminder, setShowCheckoutReminder] = React.useState(false);
  const [dontRemind, setDontRemind] = React.useState(false);

  const isAdminOrManager = currentUser?.role === 'admin' || currentUser?.role === 'manager';
  const isOrderOnly = currentUser?.role === 'order';

  const proceedToOpenShift = () => {
    if (isOrderOnly) {
      onOpenShift(0);
    } else {
      setShowOpenModal(true);
    }
  };

  const handleOpenShiftClick = () => {
    if (isAdminOrManager || !currentUser?.requiresAttendance || hasCheckedInToday) {
      proceedToOpenShift();
      return;
    }
    setShowCheckinReminder(true);
  };

  React.useEffect(() => {
    if (showOpenModal || showCloseModal) {
      setCashAmount(0);
      setCashAmountStr('');
    }
  }, [showOpenModal, showCloseModal]);

  const handleCashChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const digits = val.replace(/\D/g, '');
    const num = Number(digits);
    if (!digits) {
      setCashAmount(0);
      setCashAmountStr('');
    } else {
      setCashAmount(num);
      setCashAmountStr(num.toLocaleString('vi-VN'));
    }
  };

  // Filter history to last 3 days and by user role
  const recentHistory = history.filter(shift => {
    if (!shift.endTime) return false;
    
    // If not admin/manager, only show their own shifts
    if (!isAdminOrManager && shift.staffId !== currentUser?.id) return false;

    const shiftDate = new Date(shift.endTime);
    const threeDaysAgo = subDays(new Date(), 3);
    return isAfter(shiftDate, threeDaysAgo);
  });

  // Other active shifts (for admin/manager)
  const otherActiveShifts = allActiveShifts.filter(s => s.id !== activeShift?.id);

  return (
    <div className="p-4 md:p-8 space-y-6 md:space-y-8 h-full overflow-y-auto pb-20 md:pb-8">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Wallet className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
          Quản lý Ca làm việc
        </h3>
      </div>
      
      {/* Attendance Check-in Section */}
      {!isAdminOrManager && currentUser?.requiresAttendance && (
         <div className="bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-4 shadow-sm">
             <div className="flex items-center gap-4">
                 <div className={cn("w-12 h-12 rounded-full flex items-center justify-center shrink-0", hasCheckedInToday ? "bg-emerald-500/20 text-emerald-600" : "bg-rose-500/20 text-rose-600")}>
                     {hasCheckedInToday ? <Check className="w-6 h-6" /> : <QrCode className="w-6 h-6" />}
                 </div>
                 <div>
                     <h4 className="font-bold text-gray-900 dark:text-white text-lg">Trạng thái chấm công</h4>
                     <p className={cn("text-sm font-bold mt-0.5", hasCheckedInToday ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                         {hasCheckedInToday ? "Hôm nay bạn đã chấm công thành công" : "Bạn chưa chấm công hôm nay"}
                     </p>
                 </div>
             </div>
             
             <button
                 onClick={() => onScanQR && onScanQR()}
                 className={cn("px-6 py-3 md:w-auto w-full rounded-xl font-bold flex items-center justify-center gap-2 transition-all cursor-pointer",
                     hasCheckedInToday 
                     ? "bg-black/5 dark:bg-white/5 hover:bg-black/10 text-gray-700 dark:text-gray-300 border border-black/10 dark:border-white/10"
                     : "bg-emerald-500 hover:bg-emerald-400 text-white shadow-lg hover:shadow-emerald-500/25"
                 )}
             >
                 <QrCode className="w-5 h-5" />
                 {hasCheckedInToday ? "Quét lại mã QR" : "Quét mã QR Chấm công"}
             </button>
         </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-8">
        {/* Current Active Shift */}
        <div className={cn(
          "lg:col-span-2 rounded-3xl p-6 md:p-8 space-y-6 relative overflow-hidden border-2",
          activeShift 
            ? "bg-emerald-500/5 border-emerald-500/20" 
            : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10"
        )}>
          <div className="absolute top-0 right-0 p-8 opacity-10">
            <Clock className="w-24 h-24 md:w-32 md:h-32" />
          </div>
          
          {activeShift ? (
            <>
              <div className="flex justify-between items-start relative z-10">
                <div>
                  <span className="px-3 py-1 bg-emerald-500 text-white text-[10px] font-bold rounded-full uppercase tracking-widest">Đang hoạt động</span>
                  <h4 className="text-3xl font-bold text-gray-900 dark:text-white mt-4">Ca của bạn</h4>
                  <p className="text-gray-600 dark:text-gray-400 mt-1 flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Bắt đầu lúc: {format(new Date(activeShift.startTime), 'HH:mm, dd/MM/yyyy')}
                  </p>
                </div>
                {!isOrderOnly && (
                  <div className="text-right">
                    <p className="text-sm text-gray-500 uppercase tracking-wider">Doanh thu hiện tại</p>
                    <p className="text-4xl font-mono font-bold text-emerald-600 dark:text-emerald-500">{(activeShift.totalRevenue || 0).toLocaleString()}đ</p>
                  </div>
                )}
              </div>

              {/* Alert for Active Shift - ONLY VISIBLE TO ADMIN/MANAGER */}
              {activeShift.voidLogs && activeShift.voidLogs.length > 0 && isAdminOrManager && (
                <div className="relative z-10 bg-rose-500/10 border border-rose-500/50 rounded-xl p-4 flex items-center justify-between animate-pulse">
                  <div className="flex items-center gap-3 text-rose-600 dark:text-rose-500">
                    <AlertTriangle className="w-6 h-6" />
                    <div>
                      <p className="font-bold text-sm">CẢNH BÁO: Phát hiện chênh lệch!</p>
                      <p className="text-xs opacity-80">Có {activeShift.voidLogs.length} lần giảm món sau khi đã gọi.</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setShowVoidLogs(activeShift.voidLogs || [])}
                    className="px-4 py-2 bg-rose-500 text-white rounded-lg text-xs font-bold hover:bg-rose-600 transition-all"
                  >
                    Xem chi tiết
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 pt-8 border-t border-black/10 dark:border-white/10 relative z-10">
                <div>
                  <p className="text-xs text-gray-500 uppercase font-bold">Tiền đầu ca</p>
                  <p className="text-xl font-mono font-bold text-gray-900 dark:text-white">{(activeShift.startCash || 0).toLocaleString()}đ</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase font-bold">Tiền mặt (Thực thu)</p>
                  <div className="flex flex-col">
                    <span className="text-lg font-mono font-bold text-emerald-600 dark:text-emerald-500">{(activeShift.totalCash || 0).toLocaleString()}đ</span>
                    <div className="flex gap-2">
                      <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400">+{((activeShift.cashIncome || 0)).toLocaleString()}</span>
                      <span className="text-xs font-mono text-rose-600 dark:text-rose-400">-{((activeShift.cashExpense || 0)).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase font-bold">Chuyển khoản (Thực thu)</p>
                  <div className="flex flex-col">
                    <span className="text-lg font-mono font-bold text-blue-600 dark:text-blue-500">{(activeShift.totalTransfer || 0).toLocaleString()}đ</span>
                    <div className="flex gap-2">
                      <span className="text-xs font-mono text-blue-600 dark:text-blue-400">+{((activeShift.transferIncome || 0)).toLocaleString()}</span>
                      <span className="text-xs font-mono text-rose-600 dark:text-rose-400">-{((activeShift.transferExpense || 0)).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
                <div className="bg-emerald-500/10 p-3 -m-3 rounded-xl border border-emerald-500/20">
                  <p className="text-xs text-emerald-700 dark:text-emerald-400 uppercase font-bold">Tiền mặt dự kiến tại két</p>
                  <p className="text-xl font-mono font-bold text-emerald-600 dark:text-emerald-500">{((activeShift.startCash || 0) + (activeShift.totalCash || 0)).toLocaleString()}đ</p>
                </div>
              </div>

              <div className="pt-4 relative z-10">
                <button 
                  onClick={() => {
                    if (isOrderOnly) {
                      const activeTables = tables.filter(t => 
                        t.status !== 'empty' && 
                        t.orders?.some(o => o.status !== 'paid' && o.staffId === currentUser?.id)
                      );
                      if (activeTables.length > 0) {
                        const tableNames = activeTables.map(t => t.name).join(', ');
                        alert(`Không thể đóng ca!\nBạn đang có đơn chưa thanh toán tại các bàn: ${tableNames}\nVui lòng yêu cầu thu ngân thanh toán hoặc bàn giao cho nhân viên khác trước khi đóng ca.`);
                        return;
                      }
                      onCloseShift(0);
                      if (currentUser?.requiresAttendance) {
                        setShowCheckoutReminder(true);
                      }
                    } else {
                      setShowCloseModal(true);
                    }
                  }}
                  className="w-full py-4 bg-rose-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-rose-600 transition-all cursor-pointer"
                >
                  <Lock className="w-5 h-5" /> Kết thúc ca
                </button>
              </div>
            </>
          ) : (
            <div className="h-[400px] flex flex-col items-center justify-center text-gray-500 space-y-6">
              <div className="w-24 h-24 bg-emerald-500/10 rounded-full flex items-center justify-center mb-4">
                <Unlock className="w-12 h-12 text-emerald-500" />
              </div>
              <h4 className="text-2xl font-bold text-gray-900 dark:text-white">Bạn chưa mở ca làm việc nào</h4>
              
              <p className="text-gray-500 text-center max-w-sm mb-6">
                Bạn cần mở ca làm việc mới để bắt đầu ghi nhận doanh thu và thực hiện giao dịch trong ngày.
              </p>
              <button 
                onClick={handleOpenShiftClick}
                className="flex items-center gap-3 px-10 py-5 bg-emerald-500 text-white rounded-2xl text-xl font-bold hover:bg-emerald-400 transition-all shadow-lg hover:shadow-emerald-500/25 active:scale-95 cursor-pointer"
              >
                <Unlock className="w-7 h-7" />
                Mở ca mới ngay
              </button>
            </div>
          )}

          {/* Other Active Shifts for Admin/Manager */}
          {isAdminOrManager && otherActiveShifts.length > 0 && (
            <div className="mt-8 pt-8 border-t border-black/10 dark:border-white/10 relative z-10">
              <h4 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                <Clock className="w-5 h-5 text-blue-600 dark:text-blue-400" /> Các ca đang hoạt động khác
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {otherActiveShifts.map(shift => (
                  <div key={shift.id} onClick={() => setSelectedShift(shift)} className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-4 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 transition-all">
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-gray-900 dark:text-white">{shift.staffName || 'Nhân viên'}</span>
                      <span className="text-xs px-2 py-1 bg-blue-500/20 text-blue-600 dark:text-blue-400 rounded-full">Đang mở</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">Bắt đầu: {format(new Date(shift.startTime), 'HH:mm, dd/MM')}</p>
                    <p className="text-sm">Doanh thu: <span className="text-emerald-600 dark:text-emerald-400 font-mono font-bold">{(shift.totalRevenue || 0).toLocaleString()}đ</span></p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Shift History */}
        <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-6 space-y-6">
          <h4 className="font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <History className="w-5 h-5 text-gray-600 dark:text-gray-400" /> Lịch sử ca gần đây (3 ngày)
          </h4>
          <div className="space-y-4 max-h-[500px] overflow-y-auto custom-scrollbar">
            {recentHistory.length > 0 ? recentHistory.map(shift => (
              <div 
                key={shift.id} 
                onClick={() => setSelectedShift(shift)}
                className={cn(
                  "p-4 rounded-2xl border transition-all cursor-pointer group relative overflow-hidden",
                  ((shift.voidLogs && shift.voidLogs.length > 0) || (shift.discrepancy !== 0 && shift.discrepancy !== undefined && !shift.discrepancyProcessed)) && isAdminOrManager
                    ? "bg-rose-500/5 border-rose-500/30 hover:bg-rose-500/10"
                    : "bg-black/5 dark:bg-white/5 border-black/5 dark:border-white/5 hover:border-emerald-500/50 hover:bg-black/10 dark:hover:bg-white/10"
                )}
              >
                {((shift.voidLogs && shift.voidLogs.length > 0) || (shift.discrepancy !== 0 && shift.discrepancy !== undefined && !shift.discrepancyProcessed)) && isAdminOrManager && (
                  <div className="absolute top-0 right-0 p-1 bg-rose-500 text-white rounded-bl-xl">
                    <AlertTriangle className="w-3 h-3" />
                  </div>
                )}
                <div className="flex justify-between items-center mb-2">
                  <p className={cn("font-bold text-sm transition-colors flex items-center gap-2", ((shift.voidLogs && shift.voidLogs.length > 0) || (shift.discrepancy !== 0 && shift.discrepancy !== undefined && !shift.discrepancyProcessed)) && isAdminOrManager ? "text-rose-600 dark:text-rose-400" : "text-gray-700 dark:text-gray-300 group-hover:text-white")}>
                    {((shift.voidLogs && shift.voidLogs.length > 0) || (shift.discrepancy !== 0 && shift.discrepancy !== undefined && !shift.discrepancyProcessed)) && isAdminOrManager ? ((shift.discrepancy !== 0 && shift.discrepancy !== undefined && !shift.discrepancyProcessed) ? 'LỆCH TIỀN' : 'CÓ HỦY MÓN') : 'Ca đã đóng'}
                    <span className="text-xs font-normal text-gray-500 bg-gray-100 dark:bg-black/20 px-2 py-0.5 rounded-full">{shift.staffName || 'Nhân viên'}</span>
                  </p>
                  <span className="text-[10px] text-gray-500">{format(new Date(shift.endTime!), 'dd/MM/yyyy')}</span>
                </div>
                <div className="flex justify-between items-end">
                  <p className="text-xs text-gray-600 dark:text-gray-400">Doanh thu: <span className="text-gray-900 dark:text-white font-mono">{(((shift.totalRevenue || 0) / 1000000)).toFixed(1)}M</span></p>
                  <div className="text-[10px] text-gray-500">
                    {format(new Date(shift.startTime), 'HH:mm')} - {format(new Date(shift.endTime!), 'HH:mm')}
                  </div>
                </div>
              </div>
            )) : (
              <p className="text-center text-gray-500 py-8 text-sm italic">Chưa có lịch sử ca trong 3 ngày qua</p>
            )}
          </div>
        </div>
      </div>

      {/* Open Shift Modal */}
      {showOpenModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Mở ca làm việc</h3>
            <div className="space-y-2">
              <label className="text-sm text-gray-600 dark:text-gray-400">Tiền mặt đầu ca</label>
              <input 
                type="text" 
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white text-xl font-mono focus:outline-none focus:border-emerald-500"
                placeholder="Nhập số tiền..."
                value={cashAmountStr}
                onChange={handleCashChange}
              />
            </div>
            <div className="flex gap-4 pt-4">
              <button 
                onClick={() => setShowOpenModal(false)}
                className="flex-1 py-3 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-xl font-bold transition-all cursor-pointer"
              >
                Hủy
              </button>
              <button 
                onClick={() => {
                  onOpenShift(cashAmount);
                  setShowOpenModal(false);
                }}
                className="flex-1 py-3 bg-emerald-500 text-white rounded-xl font-bold hover:bg-emerald-400 transition-all cursor-pointer"
              >
                Mở ca
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Close Shift Modal */}
      {showCloseModal && activeShift && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Kết thúc ca</h3>
            <div className="space-y-4">
              {isAdminOrManager && (
                <div className="p-4 bg-black/5 dark:bg-white/5 rounded-xl space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">Doanh thu ca:</span>
                    <span className="text-gray-900 dark:text-white font-bold">{(activeShift.totalRevenue || 0).toLocaleString()}đ</span>
                  </div>
                  
                  <div className="flex justify-between items-center text-sm border-b border-black/5 dark:border-white/5 pb-2">
                    <span className="text-gray-600 dark:text-gray-400">Tiền mặt (Thực thu):</span>
                    <div className="text-right flex flex-col items-end">
                      <span className="text-emerald-600 dark:text-emerald-500 font-bold text-base">{(activeShift.totalCash || 0).toLocaleString()}đ</span>
                      <div className="flex gap-2 text-[10px]">
                        <span className="text-emerald-600 dark:text-emerald-400">+{(activeShift.cashIncome || 0).toLocaleString()}</span>
                        <span className="text-rose-600 dark:text-rose-400">-{(activeShift.cashExpense || 0).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  
                   <div className="flex justify-between items-center text-sm border-b border-black/5 dark:border-white/5 pb-2">
                    <span className="text-gray-600 dark:text-gray-400">Chuyển khoản (Thực thu):</span>
                    <div className="text-right flex flex-col items-end">
                      <span className="text-blue-600 dark:text-blue-500 font-bold text-base">{(activeShift.totalTransfer || 0).toLocaleString()}đ</span>
                      <div className="flex gap-2 text-[10px]">
                        <span className="text-blue-600 dark:text-blue-400">+{(activeShift.transferIncome || 0).toLocaleString()}</span>
                        <span className="text-rose-600 dark:text-rose-400">-{(activeShift.transferExpense || 0).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="border-t border-black/10 dark:border-white/10 pt-2 flex justify-between text-sm">
                    <span className="text-gray-600 dark:text-gray-400">Tiền mặt dự kiến tại két:</span>
                    <span className="text-emerald-600 dark:text-emerald-500 font-bold">{((activeShift.startCash || 0) + (activeShift.totalCash || 0)).toLocaleString()}đ</span>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm text-gray-600 dark:text-gray-400">Tiền mặt thực tế kiểm kê</label>
                <input 
                  type="text" 
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white text-xl font-mono focus:outline-none focus:border-emerald-500"
                  placeholder="Nhập số tiền..."
                  value={cashAmountStr}
                  onChange={handleCashChange}
                />
              </div>
            </div>
            <div className="flex gap-4 pt-4">
              <button 
                onClick={() => setShowCloseModal(false)}
                className="flex-1 py-3 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-xl font-bold transition-all cursor-pointer"
              >
                Quay lại
              </button>
              <button 
                onClick={() => {
                  if (currentUser?.role === 'order' || currentUser?.role === 'cashier' || currentUser?.role === 'order_cashier') {
                    const activeTables = tables.filter(t => 
                      t.status !== 'empty' && 
                      t.orders?.some(o => o.status !== 'paid' && o.staffId === currentUser.id)
                    );
                    
                    if (activeTables.length > 0) {
                      const tableNames = activeTables.map(t => t.name).join(', ');
                      alert(`Không thể đóng ca!\nBạn đang có các bàn chưa thanh toán: ${tableNames}\nVui lòng yêu cầu thu ngân thanh toán hoặc bàn giao cho nhân viên khác trước khi đóng ca.`);
                      return;
                    }
                  }
                  onCloseShift(cashAmount);
                  setShowCloseModal(false);
                  if (currentUser?.requiresAttendance) {
                    setShowCheckoutReminder(true);
                  }
                }}
                className="flex-1 py-3 bg-rose-500 text-white rounded-xl font-bold hover:bg-rose-600 transition-all cursor-pointer"
              >
                Chốt ca
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shift Details Modal */}
      {selectedShift && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-lg rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Chi tiết ca làm việc</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {format(new Date(selectedShift.startTime), 'HH:mm')} - {selectedShift.endTime ? format(new Date(selectedShift.endTime), 'HH:mm, dd/MM/yyyy') : 'Đang mở'}
                </p>
              </div>
              <button onClick={() => setSelectedShift(null)} className="text-gray-500 hover:text-gray-900 dark:hover:text-white">
                <X className="w-6 h-6" />
              </button>
            </div>

            {selectedShift.voidLogs && selectedShift.voidLogs.length > 0 && isAdminOrManager && (
              <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 text-rose-600 dark:text-rose-500 font-bold">
                  <AlertTriangle className="w-5 h-5" />
                  <span>CẢNH BÁO: PHÁT HIỆN CHÊNH LỆCH</span>
                </div>
                <button 
                  onClick={() => {
                    setShowVoidLogs(selectedShift.voidLogs || []);
                    setSelectedShift(null);
                  }}
                  className="w-full py-2 bg-rose-500 text-white rounded-lg text-sm font-bold hover:bg-rose-600 transition-all"
                >
                  Xem chi tiết {selectedShift.voidLogs.length} lần giảm món
                </button>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-black/5 dark:bg-white/5 rounded-xl border border-black/5 dark:border-white/5">
                <p className="text-xs text-gray-500 uppercase mb-1">Tổng doanh thu</p>
                <p className="text-xl font-mono font-bold text-emerald-600 dark:text-emerald-500">{(selectedShift.totalRevenue || 0).toLocaleString()}đ</p>
              </div>
              <div className="p-4 bg-black/5 dark:bg-white/5 rounded-xl border border-black/5 dark:border-white/5">
                <p className="text-xs text-gray-500 uppercase mb-1">Tiền đầu ca</p>
                <p className="text-xl font-mono font-bold text-gray-900 dark:text-white">{(selectedShift.startCash || 0).toLocaleString()}đ</p>
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="font-bold text-sm text-gray-700 dark:text-gray-300 uppercase tracking-wider">Chi tiết thu chi</h4>
              <div className="bg-black/5 dark:bg-white/5 rounded-xl p-4 space-y-4">
                
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-gray-600 dark:text-gray-400 font-bold">Tiền mặt (Thực thu)</span>
                    <span className="font-mono font-bold text-emerald-600 dark:text-emerald-500">{(selectedShift.totalCash || 0).toLocaleString()}đ</span>
                  </div>
                  <div className="pl-4 border-l-2 border-black/10 dark:border-white/10 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Thu:</span>
                      <span className="font-mono text-emerald-600 dark:text-emerald-400">+{(selectedShift.cashIncome || 0).toLocaleString()}đ</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Chi:</span>
                      <span className="font-mono text-rose-600 dark:text-rose-400">-{(selectedShift.cashExpense || 0).toLocaleString()}đ</span>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-gray-600 dark:text-gray-400 font-bold">Chuyển khoản (Thực thu)</span>
                    <span className="font-mono font-bold text-blue-600 dark:text-blue-500">{(selectedShift.totalTransfer || 0).toLocaleString()}đ</span>
                  </div>
                  <div className="pl-4 border-l-2 border-black/10 dark:border-white/10 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Thu:</span>
                      <span className="font-mono text-blue-600 dark:text-blue-400">+{(selectedShift.transferIncome || 0).toLocaleString()}đ</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-500">Chi:</span>
                      <span className="font-mono text-rose-600 dark:text-rose-400">-{(selectedShift.transferExpense || 0).toLocaleString()}đ</span>
                    </div>
                  </div>
                </div>

              </div>
            </div>

            <div className="space-y-3">
              <h4 className="font-bold text-sm text-gray-700 dark:text-gray-300 uppercase tracking-wider">Tổng kết tiền mặt</h4>
              <div className="bg-black/5 dark:bg-white/5 rounded-xl p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-gray-600 dark:text-gray-400">Dự kiến (Đầu ca + Thu)</span>
                  <span className="font-mono font-bold text-gray-900 dark:text-white">{((selectedShift.startCash || 0) + (selectedShift.totalCash || 0)).toLocaleString()}đ</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-600 dark:text-gray-400">Thực tế kiểm kê</span>
                  <span className="font-mono font-bold text-emerald-600 dark:text-emerald-500">{(selectedShift.endCash || 0).toLocaleString()}đ</span>
                </div>
                <div className="border-t border-black/10 dark:border-white/10 pt-2 flex justify-between items-center">
                  <span className="text-gray-600 dark:text-gray-400">Chênh lệch</span>
                  <span className={cn(
                    "font-mono font-bold",
                    (selectedShift.endCash || 0) - ((selectedShift.startCash || 0) + (selectedShift.totalCash || 0)) < 0 ? "text-rose-600 dark:text-rose-500" : "text-emerald-600 dark:text-emerald-500"
                  )}>
                    {((selectedShift.endCash || 0) - ((selectedShift.startCash || 0) + (selectedShift.totalCash || 0))).toLocaleString()}đ
                  </span>
                </div>
                {selectedShift.discrepancy !== undefined && selectedShift.discrepancy !== 0 && isAdminOrManager && (
                  <div className="border-t border-black/10 dark:border-white/10 pt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Trạng thái: </span>
                      {selectedShift.discrepancyProcessed ? (
                        <span className="text-xs text-emerald-600 font-bold flex items-center gap-1"><Check className="w-3 h-3"/> Đã xử lý</span>
                      ) : (
                        <span className="text-xs text-rose-600 font-bold flex items-center gap-1"><AlertTriangle className="w-3 h-3"/> Chưa xử lý</span>
                      )}
                    </div>
                    {!selectedShift.discrepancyProcessed && (
                      <button onClick={() => { if(onResolveDiscrepancy) { onResolveDiscrepancy(selectedShift.id); setSelectedShift({...selectedShift, discrepancyProcessed: true}) } }} className="px-3 py-1.5 bg-emerald-500 text-white rounded font-bold text-xs hover:bg-emerald-600">Xác nhận đã xử lý</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Void Logs Modal */}
      {showVoidLogs && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-3xl rounded-3xl p-8 border border-rose-500/30 shadow-2xl space-y-6 max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3 text-rose-600 dark:text-rose-500">
                <AlertTriangle className="w-8 h-8" />
                <div>
                  <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Nhật ký chênh lệch</h3>
                  <p className="text-sm text-rose-600 dark:text-rose-400">Phát hiện giảm món sau khi đã gọi</p>
                </div>
              </div>
              <button onClick={() => setShowVoidLogs(null)} className="text-gray-500 hover:text-gray-900 dark:hover:text-white">
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar border rounded-xl border-black/10 dark:border-white/10">
              <table className="w-full text-left text-sm">
                <thead className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 font-bold uppercase text-xs sticky top-0">
                  <tr>
                    <th className="p-4">Thời gian</th>
                    <th className="p-4">Nhân viên</th>
                    <th className="p-4">Bàn</th>
                    <th className="p-4">Món</th>
                    <th className="p-4 text-center">Ban đầu</th>
                    <th className="p-4 text-center">Thay đổi</th>
                    <th className="p-4">Lý do</th>
                    <th className="p-4 text-right">Giá trị</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {[...showVoidLogs]
                    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
                    .flatMap((log) => {
                      const isBillVoid = log.type === 'bill_void';
                      const hasDetails = log.details && log.details.length > 0;

                      if (isBillVoid && hasDetails) {
                        return log.details!.map((detail, idx) => (
                          <tr key={`${log.id}-${idx}`} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                            <td className="p-4 text-gray-600 dark:text-gray-400 font-mono align-top">{format(new Date(log.time), 'HH:mm:ss')}</td>
                            <td className="p-4 font-medium align-top">{log.staffName}</td>
                            <td className="p-4 text-gray-600 dark:text-gray-400 align-top">{log.tableName}</td>
                            <td className="p-4 font-medium text-gray-900 dark:text-white align-top">
                              <span className="text-emerald-600 dark:text-emerald-400">{detail.itemName}</span>
                            </td>
                            <td className="p-4 text-center text-gray-600 dark:text-gray-400 align-top">
                              {detail.oldQuantity}
                            </td>
                            <td className="p-4 text-center font-bold text-gray-900 dark:text-white align-top">
                              {detail.newQuantity}
                            </td>
                            <td className="p-4 text-gray-600 dark:text-gray-400 align-top text-xs max-w-[150px]">
                              {idx === 0 ? log.reason : ''}
                            </td>
                            <td className="p-4 text-right font-mono font-bold text-rose-600 dark:text-rose-500 align-top">
                              -{detail.valueDiff.toLocaleString()}đ
                            </td>
                          </tr>
                        ));
                      }
                      return [
                        <tr key={log.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                          <td className="p-4 text-gray-600 dark:text-gray-400 font-mono align-top">{format(new Date(log.time), 'HH:mm:ss')}</td>
                          <td className="p-4 font-medium align-top">{log.staffName}</td>
                          <td className="p-4 text-gray-600 dark:text-gray-400 align-top">{log.tableName}</td>
                          <td className="p-4 font-medium text-gray-900 dark:text-white align-top">
                            <span className="text-emerald-600 dark:text-emerald-400">{log.itemName}</span>
                          </td>
                          <td className="p-4 text-center text-gray-600 dark:text-gray-400 align-top">
                            {log.oldQuantity}
                          </td>
                          <td className="p-4 text-center font-bold text-gray-900 dark:text-white align-top">
                            {log.newQuantity}
                          </td>
                          <td className="p-4 text-gray-600 dark:text-gray-400 align-top text-xs max-w-[150px]">
                            {log.reason}
                          </td>
                          <td className="p-4 text-right font-mono font-bold text-rose-600 dark:text-rose-500 align-top">
                            -{log.valueDiff.toLocaleString()}đ
                          </td>
                        </tr>
                      ];
                    })}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowVoidLogs(null)}
                className="px-6 py-3 bg-black/10 dark:bg-white/10 hover:bg-white/20 rounded-xl font-bold transition-all"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Checkout Reminder Modal */}
      {showCheckoutReminder && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-6 shadow-2xl animate-in fade-in zoom-in duration-200">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <QrCode className="w-6 h-6 text-emerald-500" /> Chấm công ra về
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Ca làm việc đã được đóng thành công! Bạn có muốn quét mã QR chấm công ra về luôn không?
            </p>
            
            <div className="flex gap-4">
              <button 
                onClick={() => setShowCheckoutReminder(false)}
                className="flex-1 py-3 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-xl font-bold transition-all cursor-pointer text-gray-700 dark:text-gray-300"
              >
                Để sau
              </button>
              <button 
                onClick={() => {
                  setShowCheckoutReminder(false);
                  if (onScanQR) onScanQR();
                }}
                className="flex-1 py-3 bg-emerald-500 hover:bg-emerald-400 text-white rounded-xl font-bold transition-all cursor-pointer flex items-center justify-center gap-2"
              >
                <QrCode className="w-5 h-5" />
                Quét mã ra về
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Checkin Reminder Modal */}
      {showCheckinReminder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-6 shadow-2xl animate-in fade-in zoom-in duration-200">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <QrCode className="w-6 h-6 text-emerald-500" /> Yêu cầu chấm công
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              Bạn chưa chấm công hôm nay. Vui lòng chấm công trước khi mở ca thu ngân.
            </p>
            
            <div className="flex gap-4">
              <button 
                onClick={() => setShowCheckinReminder(false)}
                className="flex-1 py-3 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-xl font-bold transition-all cursor-pointer text-gray-700 dark:text-gray-300"
              >
                Hủy
              </button>
              <button 
                onClick={() => {
                  setShowCheckinReminder(false);
                  if (onScanQR) onScanQR();
                }}
                className="flex-1 py-3 bg-emerald-500 hover:bg-emerald-400 text-white rounded-xl font-bold transition-all cursor-pointer flex items-center justify-center gap-2"
              >
                <QrCode className="w-5 h-5" />
                Quét mã QR ngay
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
