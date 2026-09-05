import React, { useState, useMemo, useEffect } from 'react';
import { BarChart3, Search, Calendar, ArrowDownToLine, ArrowUpFromLine, FileText, Download, X, Eye, Wallet, Plus, Printer, ChevronLeft, ChevronRight, Trash2, Check } from 'lucide-react';
import { Invoice, InventoryTransaction, CashTransaction, User, SystemSettings, PayrollRecord } from '../types';
import { format, isSameDay, isSameMonth, isSameYear, parseISO, startOfMonth, endOfMonth, isBefore, startOfDay } from 'date-fns';
import { cn } from '../lib/utils';
import * as XLSX from 'xlsx';

const paymentMethodMap = {
  'cash': 'Tiền mặt',
  'transfer': 'Chuyển khoản',
  'qr': 'QR Code',
  'card': 'Thẻ'
};

export const SummaryView = ({ invoices, inventoryLogs, cashTransactions, payrollRecords, onAddCashTransaction, currentUser, settings, onUpdateSettings, onPrint, activeOrdersCount = 0 }: { 
  invoices: Invoice[], 
  inventoryLogs: InventoryTransaction[],
  cashTransactions: CashTransaction[],
  payrollRecords: PayrollRecord[],
  onAddCashTransaction: (t: Omit<CashTransaction, 'id' | 'storeId'>) => void,
  currentUser: User | null,
  settings: SystemSettings,
  onUpdateSettings: (s: SystemSettings) => void,
  onPrint: (data: any) => void,
  activeOrdersCount?: number
}) => {
  const [activeTab, setActiveTab] = useState<'sales' | 'inventory' | 'items' | 'cash' | 'financial'>('sales');
  const [dateFilter, setDateFilter] = useState(format(new Date(), 'yyyy-MM-dd'));
  const isAdmin = currentUser?.role === 'admin';
  const isAdminOrManager = currentUser?.role === 'admin' || currentUser?.role === 'manager';
  const [filterType, setFilterType] = useState<'day' | 'month' | 'year'>(isAdmin ? 'month' : 'day');
  const [taxRevenueType, setTaxRevenueType] = useState<'under_1b' | 'over_1b'>('under_1b');

  // If user becomes non-admin (e.g. state change), force back to day
  useEffect(() => {
    if (!isAdmin && filterType !== 'day') {
      setFilterType('day');
    }
  }, [isAdmin, filterType]);
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [viewingLog, setViewingLog] = useState<InventoryTransaction | null>(null);
  const [showAddCashModal, setShowAddCashModal] = useState<'income' | 'expense' | null>(null);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [cashFilterType, setCashFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const [newCash, setNewCash] = useState({
    amount: 0,
    paymentMethod: 'cash' as 'cash' | 'transfer',
    category: '',
    note: ''
  });
  const [newCashAmountStr, setNewCashAmountStr] = useState('');

  React.useEffect(() => {
    if (showAddCashModal) {
      setNewCash({ amount: 0, paymentMethod: 'cash', category: '', note: '' });
      setNewCashAmountStr('');
    }
  }, [showAddCashModal]);

  const handleNewCashChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const digits = val.replace(/\D/g, '');
    const num = Number(digits);
    if (!digits) {
      setNewCash({ ...newCash, amount: 0 });
      setNewCashAmountStr('');
    } else {
      setNewCash({ ...newCash, amount: num });
      setNewCashAmountStr(num.toLocaleString('vi-VN'));
    }
  };

  const filteredInvoices = useMemo(() => {
    return invoices.filter(inv => {
      const date = parseISO(inv.date);
      const filterDate = parseISO(dateFilter);
      if (filterType === 'day') return isSameDay(date, filterDate);
      if (filterType === 'month') return isSameMonth(date, filterDate);
      return isSameYear(date, filterDate);
    }).sort((a, b) => b.date.localeCompare(a.date));
  }, [invoices, dateFilter, filterType]);

  const filteredLogs = useMemo(() => {
    return inventoryLogs.filter(log => {
      const date = parseISO(log.date);
      const filterDate = parseISO(dateFilter);
      if (filterType === 'day') return isSameDay(date, filterDate);
      if (filterType === 'month') return isSameMonth(date, filterDate);
      return isSameYear(date, filterDate);
    }).sort((a, b) => b.date.localeCompare(a.date));
  }, [inventoryLogs, dateFilter, filterType]);

  const filteredCash = useMemo(() => {
    return cashTransactions.filter(t => {
      const isAuto = t.category === 'Bán hàng' || t.category === 'Nhập hàng' || t.category === 'Trả hàng';
      if (!isAdminOrManager && (t.staffId !== currentUser?.id || isAuto)) return false;
      
      const date = parseISO(t.date);
      const filterDate = parseISO(dateFilter);
      if (filterType === 'day') return isSameDay(date, filterDate);
      if (filterType === 'month') return isSameMonth(date, filterDate);
      return isSameYear(date, filterDate);
    }).sort((a, b) => b.date.localeCompare(a.date));
  }, [cashTransactions, dateFilter, filterType, isAdminOrManager, currentUser]);

  // Calculate item sales summary
  const itemSales = useMemo(() => {
    const acc: Record<string, { name: string, quantity: number, revenue: number }> = {};
    filteredInvoices.forEach(inv => {
      inv.items.forEach(item => {
        if (!acc[item.id]) {
          acc[item.id] = { name: item.name, quantity: 0, revenue: 0 };
        }
        acc[item.id].quantity += item.quantity;
        acc[item.id].revenue += item.price * item.quantity;
      });
    });
    return Object.values(acc).sort((a, b) => b.revenue - a.revenue);
  }, [filteredInvoices]);

  const sortedItemSales = itemSales;

  // Cash Book Stats
  const cashStats = useMemo(() => {
    const filterDate = parseISO(dateFilter);
    let startDate: Date;
    if (filterType === 'day') startDate = startOfDay(filterDate);
    else if (filterType === 'month') startDate = startOfMonth(filterDate);
    else startDate = new Date(filterDate.getFullYear(), 0, 1);

    const openingCash = cashTransactions
      .filter(t => t.paymentMethod === 'cash' && isBefore(parseISO(t.date), startDate))
      .reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);

    const openingBank = cashTransactions
      .filter(t => t.paymentMethod === 'transfer' && isBefore(parseISO(t.date), startDate))
      .reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);

    const openingBalance = openingCash + openingBank;
    const totalIncome = filteredCash.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
    const totalExpense = filteredCash.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
    const closingBalance = openingBalance + totalIncome - totalExpense;

    const periodCashIncome = filteredCash.filter(t => t.type === 'income' && t.paymentMethod === 'cash').reduce((sum, t) => sum + t.amount, 0);
    const periodCashExpense = filteredCash.filter(t => t.type === 'expense' && t.paymentMethod === 'cash').reduce((sum, t) => sum + t.amount, 0);
    const cashBalance = openingCash + periodCashIncome - periodCashExpense;

    const periodBankIncome = filteredCash.filter(t => t.type === 'income' && t.paymentMethod === 'transfer').reduce((sum, t) => sum + t.amount, 0);
    const periodBankExpense = filteredCash.filter(t => t.type === 'expense' && t.paymentMethod === 'transfer').reduce((sum, t) => sum + t.amount, 0);
    const bankBalance = openingBank + periodBankIncome - periodBankExpense;

    return { openingBalance, totalIncome, totalExpense, closingBalance, cashBalance, bankBalance };
  }, [cashTransactions, filteredCash, dateFilter, filterType]);

  const renderedCashTransactions = useMemo(() => {
    if (cashFilterType === 'all') return filteredCash;
    return filteredCash.filter(t => t.type === cashFilterType);
  }, [filteredCash, cashFilterType]);

  const exportToExcel = () => {
    let dataToExport = [];
    let fileName = '';

    if (activeTab === 'sales') {
      dataToExport = filteredInvoices.map(inv => ({
        'Mã HĐ': inv.id.toUpperCase(),
        'Thời gian': format(parseISO(inv.date), 'HH:mm dd/MM/yyyy'),
        'Bàn': inv.tableName,
        'Nhân viên': inv.staffName,
        'Tổng tiền': inv.total,
        'PTTT': inv.paymentMethod
      }));
      fileName = `Bao_cao_hoa_don_${dateFilter}.xlsx`;
    } else if (activeTab === 'inventory') {
      dataToExport = filteredLogs.map(log => ({
        'Thời gian': format(parseISO(log.date), 'HH:mm dd/MM/yyyy'),
        'Loại': log.type === 'import' ? 'Nhập hàng' : 'Trả hàng',
        'Mặt hàng': log.itemName,
        'Số lượng': log.quantity,
        'Tổng tiền': log.totalPrice
      }));
      fileName = `Bao_cao_kho_${dateFilter}.xlsx`;
    } else if (activeTab === 'items') {
      dataToExport = sortedItemSales.map(item => ({
        'Tên món': item.name,
        'Số lượng bán': item.quantity,
        'Doanh thu': item.revenue
      }));
      fileName = `Bao_cao_mon_ban_chay_${dateFilter}.xlsx`;
    } else if (activeTab === 'cash') {
      dataToExport = renderedCashTransactions.map(t => ({
        'Thời gian': format(parseISO(t.date), 'HH:mm dd/MM/yyyy'),
        'Loại': t.type === 'income' ? 'Thu' : 'Chi',
        'Hạng mục': t.category,
        'Số tiền': t.amount,
        'PTTT': t.paymentMethod,
        'Ghi chú': t.note || ''
      }));
      fileName = `So_quy_${dateFilter}.xlsx`;
    }

    const ws = XLSX.utils.json_to_sheet(dataToExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    
    // Explicitly write to array buffer and create blob to ensure correct MIME type
    const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const data = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalSales = filteredInvoices.reduce((sum, inv) => sum + inv.total, 0);
  const totalCost = filteredInvoices.reduce((sum, inv) => {
    return sum + inv.items.reduce((itemSum, item) => {
      const itemCost = (item.costPrice || 0) * item.quantity;
      const addOnsCost = (item.selectedAddOns || []).reduce((aSum, a) => aSum + ((a.costPrice || 0) * item.quantity), 0);
      return itemSum + itemCost + addOnsCost;
    }, 0);
  }, 0);
  
  const totalProfit = totalSales - totalCost;

  // --- Financial Metrics ---
  const cogsPercentage = totalSales > 0 ? (totalCost / totalSales) * 100 : 0;
  const grossProfit = totalProfit;
  const grossMargin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;

  const monthlyPayrolls = payrollRecords.filter(p => {
    const pDate = parseISO(p.month + '-01');
    const filterDate = parseISO(dateFilter);
    if (filterType === 'day' || filterType === 'month') return isSameMonth(pDate, filterDate);
    return isSameYear(pDate, filterDate);
  });

  let totalPayroll = monthlyPayrolls.reduce((sum, p) => sum + (p.totalSalary || 0), 0);
  
  const allExpenses = renderedCashTransactions.filter(t => t.type === 'expense');
  let rentCost = 0;
  let otherOperatingCost = 0;
  
  allExpenses.forEach(t => {
    const cat = t.category.toLowerCase();
    if (cat.includes('mặt bằng') || cat.includes('thuê nhà')) {
      rentCost += t.amount;
    } else if (cat.includes('lương') || cat.includes('nhân sự') || cat.includes('nhân viên')) {
      totalPayroll += t.amount;
    } else {
      otherOperatingCost += t.amount;
    }
  });

  if (filterType === 'day') {
    totalPayroll = totalPayroll / 30;
    const monthExpenses = cashTransactions.filter(t => t.type === 'expense' && isSameMonth(parseISO(t.date), parseISO(dateFilter)));
    let monthRent = 0;
    monthExpenses.forEach(t => {
      const cat = t.category.toLowerCase();
      if (cat.includes('mặt bằng') || cat.includes('thuê nhà')) monthRent += t.amount;
    });
    rentCost = monthRent / 30;
  }

  const laborCostPercentage = totalSales > 0 ? (totalPayroll / totalSales) * 100 : 0;
  const rentCostPercentage = totalSales > 0 ? (rentCost / totalSales) * 100 : 0;
  const otherCostPercentage = totalSales > 0 ? (otherOperatingCost / totalSales) * 100 : 0;

  const netProfit = grossProfit - totalPayroll - rentCost - otherOperatingCost;
  const netMargin = totalSales > 0 ? (netProfit / totalSales) * 100 : 0;
  // -------------------------


  const totalImport = filteredLogs.filter(l => l.type === 'import').reduce((sum, l) => sum + (l.totalPrice || 0), 0);
  const totalReturn = filteredLogs.filter(l => l.type === 'return').reduce((sum, l) => sum + (l.totalPrice || 0), 0);

  const paginate = (data: any[]) => {
    const startIndex = (currentPage - 1) * rowsPerPage;
    return data.slice(startIndex, startIndex + rowsPerPage);
  };

  const totalPages = (data: any[]) => Math.ceil(data.length / rowsPerPage);

  const handleAddCash = () => {
    if (!currentUser || !showAddCashModal) return;
    onAddCashTransaction({
      date: new Date().toISOString(),
      type: showAddCashModal,
      amount: newCash.amount,
      paymentMethod: newCash.paymentMethod,
      category: newCash.category,
      note: newCash.note,
      staffId: currentUser.id,
      staffName: currentUser.name
    });
    setShowAddCashModal(null);
    setNewCash({ amount: 0, paymentMethod: 'cash', category: '', note: '' });
  };

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
            Tổng kết & Báo cáo
          </h3>
          {activeOrdersCount > 0 && (
            <div className="px-3 py-1 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
              <span className="text-xs text-amber-600 dark:text-amber-500 font-bold">Đang phục vụ: {activeOrdersCount} đơn</span>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button 
            onClick={exportToExcel}
            className="flex items-center gap-2 px-4 py-2 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-sm hover:bg-black/10 dark:hover:bg-white/10 transition-all cursor-pointer"
          >
            <Download className="w-4 h-4" /> Xuất Excel
          </button>
        </div>
      </div>

      {activeTab === 'cash' ? (
        isAdminOrManager ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
              <p className="text-xs text-gray-500 uppercase font-bold">Quỹ đầu kỳ</p>
              <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-gray-600 dark:text-gray-400">{cashStats.openingBalance.toLocaleString('vi-VN')}đ</p>
            </div>
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
              <p className="text-xs text-gray-500 uppercase font-bold">Tổng thu</p>
              <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-emerald-600 dark:text-emerald-500">+{cashStats.totalIncome.toLocaleString('vi-VN')}đ</p>
            </div>
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
              <p className="text-xs text-gray-500 uppercase font-bold">Tổng chi</p>
              <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-rose-600 dark:text-rose-500">-{cashStats.totalExpense.toLocaleString('vi-VN')}đ</p>
            </div>
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
              <p className="text-xs text-gray-500 uppercase font-bold">Tồn quỹ</p>
              <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-blue-600 dark:text-blue-500">{cashStats.closingBalance.toLocaleString('vi-VN')}đ</p>
            </div>
          </div>
        ) : null
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4">
              <span className="flex w-3 h-3">
                {activeOrdersCount > 0 && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>}
                <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
              </span>
            </div>
            <p className="text-xs text-gray-500 uppercase font-bold">Đơn đang phục vụ</p>
            <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-cyan-600 dark:text-cyan-500">{activeOrdersCount || 0}</p>
            <p className="text-xs text-gray-600 dark:text-gray-400">Khách đang tại quán</p>
          </div>
          {isAdminOrManager && (<div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
            <p className="text-xs text-gray-500 uppercase font-bold">Doanh thu bán hàng</p>
            <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-emerald-600 dark:text-emerald-500">{totalSales.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</p>
            <p className="text-xs text-gray-600 dark:text-gray-400">{filteredInvoices.length} hóa đơn</p>
          </div>
          )}
          {isAdminOrManager && (
            <>
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
                <p className="text-xs text-gray-500 uppercase font-bold">Lợi nhuận gộp</p>
                <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-blue-600 dark:text-blue-500">{totalProfit.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</p>
                <p className="text-xs text-gray-600 dark:text-gray-400">Tỷ suất: {totalSales > 0 ? ((totalProfit / totalSales) * 100).toFixed(1) : 0}%</p>
              </div>
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
                <p className="text-xs text-gray-500 uppercase font-bold">Tổng nhập hàng</p>
                <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-amber-600 dark:text-amber-500">{totalImport.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</p>
                <p className="text-xs text-gray-600 dark:text-gray-400">{filteredLogs.filter(l => l.type === 'import').length} phiếu nhập</p>
              </div>
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
                <p className="text-xs text-gray-500 uppercase font-bold">Tổng trả hàng</p>
                <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-rose-600 dark:text-rose-500">{totalReturn.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</p>
                <p className="text-xs text-gray-600 dark:text-gray-400">{filteredLogs.filter(l => l.type === 'return').length} phiếu trả</p>
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4 items-center bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 p-4 rounded-2xl">
        {isAdmin && (
          <div className="flex gap-2 p-1 bg-gray-100 dark:bg-black/20 rounded-xl">
            {(['day', 'month', 'year'] as const).filter(t => t === 'day' || currentUser?.store?.packageFeatures?.invoiceHistory !== 'daily').map(t => (
              <button
                key={t}
                onClick={() => { setFilterType(t); setCurrentPage(1); }}
                className={cn(
                  "px-4 py-2 rounded-lg text-xs font-bold transition-all",
                  filterType === t ? "bg-emerald-500 text-white" : "text-gray-500 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                {t === 'day' ? 'Theo ngày' : t === 'month' ? 'Theo tháng' : 'Theo năm'}
              </button>
            ))}
          </div>
        )}
        <div className="relative flex-1">
          <input 
            type={filterType === 'day' ? 'date' : filterType === 'month' ? 'month' : 'number'}
            className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
            value={filterType === 'year' ? dateFilter.split('-')[0] : dateFilter}
            onChange={(e) => {
              if (filterType === 'year') {
                setDateFilter(`${e.target.value}-01-01`);
              } else {
                setDateFilter(e.target.value);
              }
              setCurrentPage(1);
            }}
            placeholder={filterType === 'year' ? 'Nhập năm' : ''}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex gap-4 border-b border-black/5 dark:border-white/5">
          <button 
            onClick={() => { setActiveTab('sales'); setCurrentPage(1); }}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2",
              activeTab === 'sales' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            Hóa đơn bán hàng
          </button>
          {isAdminOrManager && (<button 
            onClick={() => { setActiveTab('inventory'); setCurrentPage(1); }}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2",
              activeTab === 'inventory' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            Nhập / Trả hàng
          </button>
          )}
          {isAdminOrManager && (<button 
            onClick={() => { setActiveTab('items'); setCurrentPage(1); }}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2",
              activeTab === 'items' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            Món bán chạy
          </button>
          )}
          
          <button 
            onClick={() => { setActiveTab('cash'); setCurrentPage(1); }}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2",
              activeTab === 'cash' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            Sổ quỹ
          </button>
          {currentUser?.store?.packageFeatures?.financialReports && (
          <button 
            onClick={() => { setActiveTab('financial'); setCurrentPage(1); }}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2",
              activeTab === 'financial' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            Báo cáo tài chính
          </button>
          )}


        </div>

        <div className="flex flex-wrap justify-between items-center gap-4 text-xs text-gray-500">
          <div className="flex items-center gap-2">
            {isAdminOrManager && (
            <button
              onClick={exportToExcel}
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 text-emerald-600 dark:text-emerald-500 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/30 transition-all font-bold"
            >
              Xuất Excel
            </button>
            )}
            {activeTab === 'cash' && (
              <select
                className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded px-2 py-1 outline-none text-gray-900 dark:text-white"
                value={cashFilterType}
                onChange={(e) => { setCashFilterType(e.target.value as any); setCurrentPage(1); }}
              >
                <option value="all" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Tất cả Thu/Chi</option>
                <option value="income" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Chỉ phiếu Thu</option>
                <option value="expense" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Chỉ phiếu Chi</option>
              </select>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span>Hiển thị:</span>
            <select 
              className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded px-2 py-1 outline-none text-gray-900 dark:text-white"
              value={rowsPerPage}
              onChange={(e) => { setRowsPerPage(Number(e.target.value)); setCurrentPage(1); }}
            >
              <option value={10} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">10 dòng</option>
              <option value={20} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">20 dòng</option>
              <option value={50} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">50 dòng</option>
              <option value={100} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">100 dòng</option>
            </select>
          </div>
        </div>

        {activeTab === 'sales' ? (
          <div className="space-y-4">
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                    <th className="px-6 py-4 font-medium">Mã HĐ</th>
                    <th className="px-6 py-4 font-medium">Thời gian</th>
                    <th className="px-6 py-4 font-medium">Bàn</th>
                    <th className="px-6 py-4 font-medium">Nhân viên</th>
                    {isAdminOrManager && (<th className="px-6 py-4 font-medium text-right">Tổng tiền</th>)}
                    <th className="px-6 py-4 font-medium text-center">PTTT</th>
                    <th className="px-6 py-4 font-medium text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {filteredInvoices.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-gray-500 italic">Không có dữ liệu hóa đơn</td>
                    </tr>
                  ) : (
                    paginate(filteredInvoices).map(inv => (
                      <tr key={inv.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                        <td className="px-6 py-4 font-mono text-xs text-gray-600 dark:text-gray-400">{inv.id.substr(-6).toUpperCase()}</td>
                        <td className="px-6 py-4 text-sm">{format(parseISO(inv.completedAt || inv.date), 'HH:mm dd/MM/yyyy')}</td>
                        <td className="px-6 py-4 text-sm">{inv.tableName}</td>
                        <td className="px-6 py-4 text-sm">{inv.staffName}</td>
                        {isAdminOrManager && (<td className="px-6 py-4 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500">{inv.total.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</td>)}
                        <td className="px-6 py-4 text-center">
                          <span className="px-2 py-1 bg-black/5 dark:bg-white/5 rounded text-[10px] uppercase">{paymentMethodMap[inv.paymentMethod as keyof typeof paymentMethodMap] || inv.paymentMethod}</span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button 
                            onClick={() => setViewingInvoice(inv)}
                            className="p-2 text-gray-600 dark:text-gray-400 hover:text-emerald-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {filteredInvoices.length > rowsPerPage && (
              <div className="flex justify-center items-center gap-4">
                <button 
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(prev => prev - 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-gray-500">Trang {currentPage} / {totalPages(filteredInvoices)}</span>
                <button 
                  disabled={currentPage === totalPages(filteredInvoices)}
                  onClick={() => setCurrentPage(prev => prev + 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        ) : activeTab === 'inventory' ? (
          <div className="space-y-4">
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                    <th className="px-6 py-4 font-medium">Thời gian</th>
                    <th className="px-6 py-4 font-medium">Loại</th>
                    <th className="px-6 py-4 font-medium">Mặt hàng</th>
                    <th className="px-6 py-4 font-medium text-right">Số lượng</th>
                    <th className="px-6 py-4 font-medium text-right">Tổng tiền</th>
                    <th className="px-6 py-4 font-medium text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-gray-500 italic">Không có dữ liệu nhập/trả hàng</td>
                    </tr>
                  ) : (
                    paginate(filteredLogs).map(log => (
                      <tr key={log.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                        <td className="px-6 py-4 text-sm">{format(parseISO(log.date), 'HH:mm dd/MM/yyyy')}</td>
                        <td className="px-6 py-4">
                          <span className={cn(
                            "px-2 py-1 rounded text-[10px] uppercase font-bold",
                            log.type === 'import' ? "bg-amber-500/20 text-amber-600 dark:text-amber-500" : "bg-rose-500/20 text-rose-600 dark:text-rose-500"
                          )}>
                            {log.type === 'import' ? 'Nhập hàng' : 'Trả hàng'}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm">{log.itemName}</td>
                        <td className="px-6 py-4 text-right font-mono">{log.quantity.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}</td>
                        <td className="px-6 py-4 text-right font-mono font-bold">{(log.totalPrice || 0).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</td>
                        <td className="px-6 py-4 text-right">
                          <button 
                            onClick={() => setViewingLog(log)}
                            className="p-2 text-gray-600 dark:text-gray-400 hover:text-emerald-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {filteredLogs.length > rowsPerPage && (
              <div className="flex justify-center items-center gap-4">
                <button 
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(prev => prev - 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-gray-500">Trang {currentPage} / {totalPages(filteredLogs)}</span>
                <button 
                  disabled={currentPage === totalPages(filteredLogs)}
                  onClick={() => setCurrentPage(prev => prev + 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

        ) : activeTab === 'financial' ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Gross Profit Section */}
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-4">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  Lợi nhuận gộp <span className="text-xs font-normal text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-black/20 px-2 py-1 rounded">(Mục tiêu: {'>'}= 65%)</span>
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-gray-500">Doanh thu</p>
                    <p className="text-lg md:text-xl lg:text-2xl font-mono truncate font-bold text-emerald-600 dark:text-emerald-500">{totalSales.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Giá vốn (COGS) <span className="text-xs">({cogsPercentage.toFixed(1)}%)</span></p>
                    <p className="text-lg md:text-xl lg:text-2xl font-mono truncate font-bold text-rose-600 dark:text-rose-500">-{totalCost.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ</p>
                  </div>
                </div>
                <div className="pt-4 border-t border-black/5 dark:border-white/5 flex justify-between items-center">
                  <p className="text-gray-600 dark:text-gray-400">Lợi nhuận gộp ({grossMargin.toFixed(1)}%)</p>
                  <p className={cn("text-xl md:text-2xl lg:text-3xl font-mono font-bold truncate", grossMargin >= 65 ? "text-blue-600 dark:text-blue-500" : "text-amber-600 dark:text-amber-500")}>
                    {grossProfit.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ
                  </p>
                </div>
                {grossMargin < 65 && totalSales > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-600 dark:text-amber-500 leading-relaxed">
                    ⚠️ <b>Biên lợi nhuận gộp ({grossMargin.toFixed(1)}%) thấp hơn mức lý tưởng (65%).</b> Cần xem lại giá bán hoặc tối ưu chi phí nguyên vật liệu.
                  </div>
                )}
                {cogsPercentage > 35 && totalSales > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-600 dark:text-amber-500 leading-relaxed">
                    ⚠️ <b>Tỷ lệ giá vốn ({cogsPercentage.toFixed(1)}%) vượt mức cho phép (35%).</b> Có thể đang thất thoát nguyên liệu hoặc giá nhập cao.
                  </div>
                )}
              </div>

              {/* Net Profit Section */}
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-4">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  Lợi nhuận ròng <span className="text-xs font-normal text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-black/20 px-2 py-1 rounded">(Mục tiêu: {'>'}= 15%)</span>
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-gray-500">Nhân sự <span className="text-xs">({laborCostPercentage.toFixed(1)}%)</span></p>
                    <p className="text-base md:text-lg lg:text-xl font-mono truncate font-bold text-rose-600 dark:text-rose-400">-{totalPayroll.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ</p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-500">Mặt bằng <span className="text-xs">({rentCostPercentage.toFixed(1)}%)</span></p>
                    <p className="text-base md:text-lg lg:text-xl font-mono truncate font-bold text-rose-600 dark:text-rose-400">-{rentCost.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ</p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-sm text-gray-500">Chi phí khác <span className="text-xs">({otherCostPercentage.toFixed(1)}%)</span></p>
                    <p className="text-base md:text-lg lg:text-xl font-mono truncate font-bold text-rose-600 dark:text-rose-400">-{otherOperatingCost.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ</p>
                  </div>
                </div>
                <div className="pt-4 border-t border-black/5 dark:border-white/5 flex justify-between items-center">
                  <p className="text-gray-600 dark:text-gray-400">Lợi nhuận ròng ({netMargin.toFixed(1)}%)</p>
                  <p className={cn("text-xl md:text-2xl lg:text-3xl font-mono font-bold truncate", netMargin >= 15 ? "text-emerald-600 dark:text-emerald-500" : netMargin > 0 ? "text-amber-600 dark:text-amber-500" : "text-rose-600 dark:text-rose-500")}>
                    {netProfit.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ
                  </p>
                </div>
                {laborCostPercentage > 25 && totalSales > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-600 dark:text-amber-500 leading-relaxed">
                    ⚠️ <b>Chi phí nhân sự ({laborCostPercentage.toFixed(1)}%) vượt mức 25%.</b> Cần tối ưu lại ca làm việc hoặc xem xét năng suất nhân viên.
                  </div>
                )}
                {rentCostPercentage > 15 && totalSales > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-600 dark:text-amber-500 leading-relaxed">
                    ⚠️ <b>Chi phí mặt bằng ({rentCostPercentage.toFixed(1)}%) cao hơn 15%.</b> Doanh thu hiện tại chưa đủ bù đắp chi phí cố định này.
                  </div>
                )}
                {netMargin < 15 && totalSales > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-sm text-amber-600 dark:text-amber-500 leading-relaxed">
                    ⚠️ <b>Biên lợi nhuận ròng ({netMargin.toFixed(1)}%) chưa đạt mức lý tưởng.</b> Cần tăng doanh thu hoặc cắt giảm chi phí vận hành.
                  </div>
                )}
              </div>
            </div>
            {filterType === 'day' && (
              <p className="text-sm text-gray-500 italic text-center">
                Lưu ý: Báo cáo tài chính theo ngày chỉ mang tính chất tham khảo (chi phí cố định như lương, mặt bằng được chia đều cho 30 ngày).
              </p>
            )}
          </div>
        ) : activeTab === 'items' ? (
          <div className="space-y-4">
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                    <th className="px-6 py-4 font-medium">Tên món</th>
                    <th className="px-6 py-4 font-medium text-right">Số lượng bán</th>
                    <th className="px-6 py-4 font-medium text-right">Doanh thu</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {sortedItemSales.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-6 py-12 text-center text-gray-500 italic">Không có dữ liệu bán hàng</td>
                    </tr>
                  ) : (
                    paginate(sortedItemSales).map((item, idx) => (
                      <tr key={idx} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                        <td className="px-6 py-4 text-sm font-bold text-gray-900 dark:text-white">{item.name}</td>
                        <td className="px-6 py-4 text-right font-mono">{item.quantity.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}</td>
                        <td className="px-6 py-4 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500">{item.revenue.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {sortedItemSales.length > rowsPerPage && (
              <div className="flex justify-center items-center gap-4">
                <button 
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(prev => prev - 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-gray-500">Trang {currentPage} / {totalPages(sortedItemSales)}</span>
                <button 
                  disabled={currentPage === totalPages(sortedItemSales)}
                  onClick={() => setCurrentPage(prev => prev + 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              {isAdminOrManager && (
              <div className="flex gap-4">
                <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">Tiền mặt</p>
                  <p className="text-sm font-mono font-bold text-emerald-600 dark:text-emerald-500">{cashStats.cashBalance.toLocaleString('vi-VN')}đ</p>
                </div>
                <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">Ngân hàng</p>
                  <p className="text-sm font-mono font-bold text-blue-600 dark:text-blue-500">{cashStats.bankBalance.toLocaleString('vi-VN')}đ</p>
                </div>
              </div>
              )}
              <div className="flex gap-2">
                <button 
                  onClick={() => setShowAddCashModal('income')}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-bold hover:bg-emerald-400 transition-all cursor-pointer"
                >
                  <ArrowDownToLine className="w-4 h-4" /> Phiếu thu
                </button>
                <button 
                  onClick={() => setShowAddCashModal('expense')}
                  className="flex items-center gap-2 px-4 py-2 bg-rose-500 text-white rounded-xl text-sm font-bold hover:bg-rose-400 transition-all cursor-pointer"
                >
                  <ArrowUpFromLine className="w-4 h-4" /> Phiếu chi
                </button>
              </div>
            </div>

            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                    <th className="px-6 py-4 font-medium">Thời gian</th>
                    <th className="px-6 py-4 font-medium">Hạng mục</th>
                    <th className="px-6 py-4 font-medium">PTTT</th>
                    <th className="px-6 py-4 font-medium text-right">Thu</th>
                    <th className="px-6 py-4 font-medium text-right">Chi</th>
                    <th className="px-6 py-4 font-medium">Ghi chú</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {renderedCashTransactions.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-gray-500 italic">Không có dữ liệu sổ quỹ</td>
                    </tr>
                  ) : (
                    paginate(renderedCashTransactions).map(t => (
                      <tr key={t.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                        <td className="px-6 py-4 text-sm">{format(parseISO(t.date), 'HH:mm dd/MM/yyyy')}</td>
                        <td className="px-6 py-4 text-sm font-bold">{t.category}</td>
                        <td className="px-6 py-4">
                          <span className="px-2 py-1 bg-black/5 dark:bg-white/5 rounded text-[10px] uppercase">{paymentMethodMap[t.paymentMethod as keyof typeof paymentMethodMap] || t.paymentMethod}</span>
                        </td>
                        <td className="px-6 py-4 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500">
                          {t.type === 'income' ? `+${t.amount.toLocaleString('vi-VN')}đ` : ''}
                        </td>
                        <td className="px-6 py-4 text-right font-mono font-bold text-rose-600 dark:text-rose-500">
                          {t.type === 'expense' ? `-${t.amount.toLocaleString('vi-VN')}đ` : ''}
                        </td>
                        <td className="px-6 py-4 text-xs text-gray-500 italic">{t.note}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {renderedCashTransactions.length > rowsPerPage && (
              <div className="flex justify-center items-center gap-4">
                <button 
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(prev => prev - 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-gray-500">Trang {currentPage} / {totalPages(renderedCashTransactions)}</span>
                <button 
                  disabled={currentPage === totalPages(renderedCashTransactions)}
                  onClick={() => setCurrentPage(prev => prev + 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Invoice Detail Modal */}
      {viewingInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white">Chi tiết hóa đơn</h3>
                <p className="text-xs text-gray-500">Mã: {viewingInvoice.id.toUpperCase()}</p>
              </div>
              <button onClick={() => setViewingInvoice(null)} className="text-gray-500 hover:text-gray-900 dark:hover:text-white"><X className="w-6 h-6" /></button>
            </div>

            <div className="space-y-4">
              {viewingInvoice.timeIn && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Giờ vào:</span>
                  <span className="text-gray-900 dark:text-white">{format(parseISO(viewingInvoice.timeIn), 'HH:mm dd/MM/yyyy')}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Giờ ra:</span>
                <span className="text-gray-900 dark:text-white">{format(parseISO(viewingInvoice.date), 'HH:mm dd/MM/yyyy')}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Bàn:</span>
                <span className="text-gray-900 dark:text-white">{viewingInvoice.tableName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Nhân viên:</span>
                <span className="text-gray-900 dark:text-white">{viewingInvoice.staffName}</span>
              </div>

              <div className="border-t border-black/5 dark:border-white/5 pt-4 space-y-3">
                {viewingInvoice.items.map((item, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <div className="flex gap-2">
                        <span className="text-gray-500">x{item.quantity}</span>
                        <span className="text-gray-900 dark:text-white font-medium">{item.name}</span>
                      </div>
                      <span className="text-gray-900 dark:text-white">{(item.price * item.quantity).toLocaleString()}đ</span>
                    </div>
                    {item.selectedAddOns && item.selectedAddOns.length > 0 && (
                      <div className="pl-8 space-y-1">
                        {item.selectedAddOns.map((addon, idx) => (
                          <div key={idx} className="flex justify-between text-[10px] text-emerald-600 dark:text-emerald-500">
                            <span>+ {addon.name}</span>
                            <span>{(addon.price * item.quantity).toLocaleString()}đ</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="border-t border-black/5 dark:border-white/5 pt-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Tạm tính:</span>
                  <span className="text-gray-900 dark:text-white">{viewingInvoice.subtotal.toLocaleString()}đ</span>
                </div>
                {viewingInvoice.discount > 0 && (
                  <div className="flex justify-between text-sm text-rose-600 dark:text-rose-500">
                    <span>Giảm giá:</span>
                    <span>-{viewingInvoice.discount.toLocaleString()}đ</span>
                  </div>
                )}
                {viewingInvoice.vat > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">VAT ({((viewingInvoice.vat / (viewingInvoice.subtotal - viewingInvoice.discount)) * 100).toFixed(0)}%):</span>
                    <span className="text-gray-900 dark:text-white">{viewingInvoice.vat.toLocaleString()}đ</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-bold text-emerald-600 dark:text-emerald-500 pt-2 border-t border-black/5 dark:border-white/5">
                  <span>Tổng cộng:</span>
                  <span>{viewingInvoice.total.toLocaleString()}đ</span>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button 
                onClick={() => {
                  onPrint({
                    type: 'bill',
                    tableName: viewingInvoice.tableName,
                    items: viewingInvoice.items,
                    total: viewingInvoice.total,
                    subtotal: viewingInvoice.subtotal,
                    discount: viewingInvoice.discount,
                    vat: viewingInvoice.vat,
                    staffName: viewingInvoice.staffName,
                    timeIn: viewingInvoice.timeIn,
                    timeOut: viewingInvoice.date,
                    note: viewingInvoice.note
                  });
                  setViewingInvoice(null);
                }}
                className="flex-1 py-3 rounded-xl bg-blue-500 text-gray-900 dark:text-white font-bold hover:bg-blue-400 transition-all flex items-center justify-center gap-2"
              >
                <Printer className="w-4 h-4" /> In hóa đơn
              </button>
              <button 
                onClick={() => setViewingInvoice(null)}
                className="flex-1 py-3 rounded-xl bg-black/5 dark:bg-white/5 text-gray-900 dark:text-white font-bold hover:bg-black/10 dark:hover:bg-white/10 transition-all"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Cash Modal */}
      {showAddCashModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">Thêm phiếu {showAddCashModal === 'income' ? 'thu' : 'chi'}</h3>
              <button onClick={() => setShowAddCashModal(null)} className="text-gray-500 hover:text-gray-900 dark:hover:text-white"><X className="w-6 h-6" /></button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Số tiền</label>
                <input 
                  type="text" 
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                  value={newCashAmountStr}
                  onChange={handleNewCashChange}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">PTTT</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['cash', 'transfer'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setNewCash({...newCash, paymentMethod: m})}
                      className={cn(
                        "py-2 rounded-lg text-xs font-bold border transition-all",
                        newCash.paymentMethod === m ? "bg-emerald-500 text-white border-emerald-500" : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-500"
                      )}
                    >
                      {m === 'cash' ? 'Tiền mặt' : 'Chuyển khoản'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="relative">
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Hạng mục</label>
                <div className="relative">
                  <input
                    type="text"
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    placeholder="Nhập hoặc chọn hạng mục..."
                    value={newCash.category}
                    onChange={(e) => {
                      setNewCash({ ...newCash, category: e.target.value });
                      setShowCategoryDropdown(true);
                    }}
                    onFocus={() => setShowCategoryDropdown(true)}
                  />
                  
                  {showCategoryDropdown && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowCategoryDropdown(false)}></div>
                      <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-[#2a2b2e] border border-black/10 dark:border-white/10 rounded-xl shadow-xl z-50 overflow-hidden">
                        <div className="max-h-48 overflow-y-auto p-2 space-y-1">
                          {settings.cashCategories.filter(c => c.toLowerCase().includes(newCash.category.toLowerCase())).map(cat => (
                            <div key={cat} className="flex justify-between items-center group px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg cursor-pointer text-sm text-gray-900 dark:text-white">
                              <div className="flex-1" onClick={() => {
                                setNewCash({ ...newCash, category: cat });
                                setShowCategoryDropdown(false);
                              }}>
                                {cat}
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`Bạn có chắc chắn muốn xóa hạng mục "${cat}"?`)) {
                                    onUpdateSettings({
                                      ...settings,
                                      cashCategories: settings.cashCategories.filter(c => c !== cat)
                                    });
                                  }
                                }}
                                className="text-gray-500 hover:text-rose-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                                title="Xóa hạng mục này"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                          
                          {newCash.category && !settings.cashCategories.find(c => c.toLowerCase() === newCash.category.toLowerCase()) && (
                            <div 
                              className="flex items-center gap-2 px-3 py-2 hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 rounded-lg cursor-pointer text-sm font-bold"
                              onClick={() => {
                                onUpdateSettings({
                                  ...settings,
                                  cashCategories: [...settings.cashCategories, newCash.category]
                                });
                                setShowCategoryDropdown(false);
                              }}
                            >
                              <Plus className="w-4 h-4" />
                              Thêm mới "{newCash.category}"
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Ghi chú</label>
                <textarea 
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 h-24"
                  value={newCash.note}
                  onChange={(e) => setNewCash({...newCash, note: e.target.value})}
                />
              </div>
            </div>

            <button 
              onClick={handleAddCash}
              className={cn(
                "w-full py-4 rounded-xl font-bold transition-all shadow-lg",
                showAddCashModal === 'income' ? "bg-emerald-500 text-white shadow-emerald-500/20" : "bg-rose-500 text-white shadow-rose-500/20"
              )}
            >
              Xác nhận
            </button>
          </div>
        </div>
      )}

      {/* Log Detail Modal */}
      {viewingLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white">Chi tiết phiếu {viewingLog.type === 'import' ? 'nhập' : 'trả'}</h3>
                <p className="text-xs text-gray-500">Mã: {viewingLog.id.toUpperCase()}</p>
              </div>
              <button onClick={() => setViewingLog(null)} className="text-gray-500 hover:text-gray-900 dark:hover:text-white"><X className="w-6 h-6" /></button>
            </div>

            <div className="space-y-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Thời gian:</span>
                <span className="text-gray-900 dark:text-white">{format(parseISO(viewingLog.date), 'HH:mm dd/MM/yyyy')}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Mặt hàng:</span>
                <span className="text-gray-900 dark:text-white font-bold">{viewingLog.itemName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Số lượng:</span>
                <span className="text-gray-900 dark:text-white">{viewingLog.quantity}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Đơn giá:</span>
                <span className="text-gray-900 dark:text-white">{viewingLog.unitPrice?.toLocaleString()}đ</span>
              </div>
              <div className="flex justify-between text-lg font-bold text-amber-600 dark:text-amber-500 pt-4 border-t border-black/5 dark:border-white/5">
                <span>Tổng tiền:</span>
                <span>{viewingLog.totalPrice?.toLocaleString()}đ</span>
              </div>
              {viewingLog.note && (
                <div className="pt-2">
                  <p className="text-xs text-gray-500 uppercase font-bold mb-1">Ghi chú:</p>
                  <p className="text-sm text-gray-700 dark:text-gray-300 bg-black/5 dark:bg-white/5 p-3 rounded-xl italic">"{viewingLog.note}"</p>
                </div>
              )}
            </div>

            <button 
              onClick={() => setViewingLog(null)}
              className="w-full py-3 rounded-xl bg-black/5 dark:bg-white/5 text-gray-900 dark:text-white font-bold hover:bg-black/10 dark:hover:bg-white/10 transition-all"
            >
              Đóng
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
