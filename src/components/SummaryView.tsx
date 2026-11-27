import React, { useState, useMemo, useEffect, useRef } from 'react';
import { BarChart3, Search, Calendar, ArrowDownToLine, ArrowUpFromLine, FileText, Download, X, Eye, Wallet, Plus, Printer, ChevronLeft, ChevronRight, Trash2, Check, Banknote, CreditCard, Loader2, AlertTriangle, ArrowRight } from 'lucide-react';
import { Invoice, InventoryTransaction, CashTransaction, User, SystemSettings, PayrollRecord, Shift, DailyStats, MenuItem } from '../types';
import { format, isSameDay, isSameMonth, isSameYear, parseISO, startOfMonth, endOfMonth, isBefore, startOfDay, subDays, eachDayOfInterval } from 'date-fns';
import { cn } from '../lib/utils';
import * as XLSX from 'xlsx';
import { db } from '../lib/firebase';
import { collection, query, where, getDocs, getDocsFromServer, orderBy, limit, startAfter, doc, getDoc, QueryDocumentSnapshot, onSnapshot, writeBatch, updateDoc, Query, runTransaction, getDocFromServer } from 'firebase/firestore';
import { getDateRangeIso, getVietnamBusinessDate, getVietnamYesterdayDate, getVietnamDayBoundariesIso } from '../utils/firestoreDateHelper';
import { calculateInvoiceCost, calculateInvoiceCostSnapshot, isCostExplicitlyVerified } from '../utils/costHelper';
import { isCashPayment, isReconciledDailyStat } from '../utils/reportDataIntegrity';
import { invoiceCostIsComplete, operationId, receiptMismatch, isSalesCategory, allocatedItemRevenue, validInvoiceAmount, validCashAmount, reconcileDay } from '../utils/dataIntegrity';
import { subscribeDateRange, fetchDateRangeRows, fetchFinancialPeriodSources } from '../utils/completeDataSource';
import { subscribeSharedQuery } from '../utils/sharedFirestoreQuery';
import { mergeDaySources, reconciledSource, verifiedDayCost, contiguousDateRanges, cashBookTotals, aggregateReportDays } from '../utils/reportSources';
import { legacyReceiptCandidates, MissingInvoiceReceiptError, type InvoiceCancellation } from '../services/dataOperations';
import { reconcileStoreDaysBatch } from '../services/reportReconciliation';
import { checkStoreTabPermission } from '../utils/packagePermissions';

export function safeFormatDate(dateVal: any, formatStr: string = 'HH:mm dd/MM/yyyy', fallback: string = '—'): string {
  if (!dateVal) return fallback;
  try {
    const d = typeof dateVal === 'string' ? parseISO(dateVal) : new Date(dateVal);
    if (isNaN(d.getTime())) return fallback;
    return format(d, formatStr);
  } catch {
    return fallback;
  }
}

// Hàm xác định toàn bộ danh sách ngày dự kiến trong kỳ (không lấy ngày tương lai vượt quá hôm nay)
function getExpectedPeriodDates(dateFilter: string, filterType: 'day' | 'month' | 'year', todayStr: string): string[] {
  if (filterType === 'day') {
    return [dateFilter.slice(0, 10)];
  }
  if (filterType === 'month') {
    try {
      const monthStart = startOfMonth(parseISO(dateFilter.slice(0, 7) + '-01'));
      const monthEnd = endOfMonth(monthStart);
      const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
      return days.map(d => format(d, 'yyyy-MM-dd')).filter(dStr => dStr <= todayStr);
    } catch {
      return [dateFilter.slice(0, 10)];
    }
  }
  // filterType === 'year'
  try {
    const yearStr = dateFilter.slice(0, 4);
    const yearStart = parseISO(`${yearStr}-01-01`);
    const yearEnd = parseISO(`${yearStr}-12-31`);
    const days = eachDayOfInterval({ start: yearStart, end: yearEnd });
    return days.map(d => format(d, 'yyyy-MM-dd')).filter(dStr => dStr <= todayStr);
  } catch {
    return [dateFilter.slice(0, 10)];
  }
}

// Đánh giá trạng thái giá vốn của một ngày từ daily_stats theo chuẩn chung
export type DayCostEvaluation = 'complete' | 'estimated' | 'missing' | 'none';

/**
 * Đánh giá trạng thái giá vốn của một ngày từ tài liệu daily_stats
 * - 'none': Ngày không bán hàng (hóa đơn = 0 & doanh thu = 0). Giá vốn tự nhiên là 0đ, không làm mất tính toàn vẹn của kỳ.
 * - 'complete': Ngày có bán hàng và đã đối soát đầy đủ 100% giá vốn nguyên liệu.
 * - 'estimated': Ngày có bán hàng nhưng giá vốn ước tính (do thiếu công thức/giá vốn nguyên liệu).
 * - 'missing': Ngày có bán hàng nhưng hoàn toàn thiếu giá vốn hoặc tài liệu thống kê không tồn tại.
 */
export function evaluateDailyStatCostStatus(stat: DailyStats | undefined | null): DayCostEvaluation {
  if (!stat) return 'missing';
  const hasSales = (stat.invoiceCount !== undefined && stat.invoiceCount > 0) || (stat.totalRevenue !== undefined && stat.totalRevenue > 0);
  if (!hasSales) {
    return 'none';
  }
  if (stat.costStatus === 'complete') return 'complete';
  if (stat.costStatus === 'estimated') return 'estimated';
  if (stat.costStatus === 'missing') return 'missing';
  if (typeof stat.totalCost === 'number' && stat.totalCost >= 0) {
    // Có ghi nhận số nhưng chưa đánh dấu complete -> ước tính
    return 'estimated';
  }
  return 'missing';
}

// Hàm kiểm tra tính toàn vẹn và độ đầy đủ của số liệu daily_stats theo từng ngày
function checkStatsCompleteness(
  stats: DailyStats[],
  expectedDates: string[],
  todayStr: string,
  isViewingCurrentPeriod: boolean
): {
  isFullyCovered: boolean;
  hasCompleteCost: boolean;
  missingDates: string[];
} {
  if (!stats || stats.length === 0) {
    if (expectedDates.length === 1 && expectedDates[0] === todayStr && isViewingCurrentPeriod) {
      return { isFullyCovered: true, hasCompleteCost: true, missingDates: [] };
    }
    return { isFullyCovered: false, hasCompleteCost: false, missingDates: expectedDates };
  }

  const map = new Map<string, DailyStats>(stats.map(s => [s.date, s]));
  const missingDates: string[] = [];
  let allCostsComplete = true;

  expectedDates.forEach(d => {
    if (d === todayStr && isViewingCurrentPeriod) {
      return; // Được phục vụ realtime từ live listener
    }
    const stat = map.get(d);
    if (!stat) {
      missingDates.push(d);
      allCostsComplete = false;
    } else {
      const isReconciled = stat.coverageStatus === 'reconciled' || stat.coverageStatus === 'zero_activity';
      if (!isReconciled) {
        missingDates.push(d);
      }
      const costEval = evaluateDailyStatCostStatus(stat);
      if (costEval === 'missing' || costEval === 'estimated') {
        allCostsComplete = false;
      }
    }
  });

  return {
    isFullyCovered: missingDates.length === 0,
    hasCompleteCost: allCostsComplete && missingDates.length === 0,
    missingDates
  };
}


// Bộ nhớ đệm ngoài component để tránh gọi Firestore lại khi rời tab và quay lại SummaryView
interface SummaryPeriodCacheItem {
  dailyStats?: DailyStats[];
  invoices?: Invoice[];
  cash?: CashTransaction[];
  logs?: InventoryTransaction[];
  periodPayrolls?: PayrollRecord[];
  hasMoreInvoices?: boolean;
  lastInvoiceDoc?: QueryDocumentSnapshot;
  invoiceQueryMode?: 'modern' | 'legacy';
  invoiceQueryOrdered?: boolean;
  hasMoreCash?: boolean;
  lastCashDoc?: QueryDocumentSnapshot;
  cashQueryMode?: 'modern' | 'legacy';
  cashQueryOrdered?: boolean;
  hasMoreLogs?: boolean;
  lastLogDoc?: QueryDocumentSnapshot;
  timestamp: number;
}
const summaryPeriodCache = new Map<string, SummaryPeriodCacheItem>();

const paymentMethodMap = {
  'cash': 'Tiền mặt',
  'transfer': 'Chuyển khoản',
  'qr': 'QR Code',
  'card': 'Thẻ'
};

// Hàm tạo query dùng chung chuẩn hóa giữa Trang đầu và các Trang tiếp theo (startAfter cursor)
const buildInvoiceQuery = (
  storeId: string,
  filterType: 'day' | 'month' | 'year',
  dateFilter: string,
  startIso: string,
  endExclusiveIso: string,
  mode: 'modern' | 'legacy',
  ordered: boolean,
  cursor?: QueryDocumentSnapshot | null,
  pageSize = 30
) => {
  const constraints: any[] = [where('storeId', '==', storeId), where('date', '>=', startIso),
    where('date', '<', endExclusiveIso), orderBy('date', 'desc')];

  if (cursor) {
    constraints.push(startAfter(cursor));
  }

  constraints.push(limit(pageSize));
  return query(collection(db, 'invoices'), ...constraints);
};

const buildCashQuery = (
  storeId: string,
  filterType: 'day' | 'month' | 'year',
  dateFilter: string,
  startIso: string,
  endExclusiveIso: string,
  mode: 'modern' | 'legacy',
  ordered: boolean,
  cursor?: QueryDocumentSnapshot | null,
  pageSize = 30
) => {
  const constraints: any[] = [where('storeId', '==', storeId), where('date', '>=', startIso),
    where('date', '<', endExclusiveIso), orderBy('date', 'desc')];

  if (cursor) {
    constraints.push(startAfter(cursor));
  }

  constraints.push(limit(pageSize));
  return query(collection(db, 'cash_transactions'), ...constraints);
};

const buildLogQuery = (
  storeId: string,
  startIso: string,
  endExclusiveIso: string,
  cursor?: QueryDocumentSnapshot | null,
  pageSize = 50
) => {
  const constraints: any[] = [
    where('storeId', '==', storeId),
    where('date', '>=', startIso),
    where('date', '<', endExclusiveIso),
    orderBy('date', 'desc')
  ];
  if (cursor) {
    constraints.push(startAfter(cursor));
  }
  constraints.push(limit(pageSize));
  return query(collection(db, 'inventory_logs'), ...constraints);
};

export const SummaryView = ({ 
  invoices, 
  isInvoicesReady = true,
  todaySourceEnabled = false,
  inventoryLogs, 
  cashTransactions, 
  payrollRecords, 
  shifts = [],
  activeShift = null,
  onAddCashTransaction, 
  onDeleteInvoice, 
  currentUser, 
  settings, 
  onUpdateSettings, 
  onPrint, 
  activeOrdersCount = 0,
  businessDate,
  menu = [],
  inventoryItems = [],
  onNavigateToMenu,
  packages = []
}: { 
  invoices: Invoice[], 
  isInvoicesReady?: boolean,
  todaySourceEnabled?: boolean,
  inventoryLogs: InventoryTransaction[],
  cashTransactions: CashTransaction[],
  payrollRecords: PayrollRecord[],
  shifts?: Shift[],
  activeShift?: Shift | null,
  onAddCashTransaction: (t: Omit<CashTransaction, 'id' | 'storeId'>, id?: string) => Promise<void>,
  onDeleteInvoice?: (invoiceId: string, confirmedReceiptId?: string) => Promise<InvoiceCancellation>,
  currentUser: User | null,
  settings: SystemSettings,
  onUpdateSettings: (s: SystemSettings) => void,
  onPrint: (data: any) => void,
  activeOrdersCount?: number,
  businessDate?: string,
  menu?: MenuItem[],
  inventoryItems?: any[],
  onNavigateToMenu?: () => void,
  packages?: any[]
}) => {
  const isAdmin = currentUser?.role === 'admin';
  const isAdminOrManager = currentUser?.role === 'admin' || currentUser?.role === 'manager';
  const currentPackageId = currentUser?.store?.subscription?.packageId || 'trial';
  const currentPkg = packages.find((p: any) => p?.id === currentPackageId);
  const isFinancialReportsUnlocked = checkStoreTabPermission('reports', currentUser, packages);
  const isHistoryLimitedToDaily = currentPkg?.features?.invoiceHistory === 'daily';
  const [activeTab, setActiveTab] = useState<'sales' | 'inventory' | 'items' | 'cash' | 'financial'>('sales');
  
  // Khởi tạo ngày theo múi giờ Việt Nam đồng bộ với App.tsx
  const todayVietnam = businessDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [dateFilter, setDateFilter] = useState(todayVietnam);
  const [filterType, setFilterType] = useState<'day' | 'month' | 'year'>('day');
  const [financialCostBasis,setFinancialCostBasis]=useState<'cash'|'payroll'>('cash');
  const [taxRevenueType, setTaxRevenueType] = useState<'under_1b' | 'over_1b'>('under_1b');
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [confirmDeleteInvoice, setConfirmDeleteInvoice] = useState<Invoice | null>(null);
  const [cancelError, setCancelError] = useState('');
  const [receiptReview, setReceiptReview] = useState<{ invoiceId: string; candidates: CashTransaction[]; selectedId: string } | null>(null);
  useEffect(() => {
    setCancelError('');
    setReceiptReview(null);
  }, [confirmDeleteInvoice?.id]);
  const [isDeletingInvoice, setIsDeletingInvoice] = useState(false);
  const [showMissingCostModal, setShowMissingCostModal] = useState(false);
  const [onlyShowMissingCostItems, setOnlyShowMissingCostItems] = useState(false);

  // Non-admin/manager can only view sales invoices and cash transactions
  useEffect(() => {
    if (!isAdminOrManager && (activeTab === 'inventory' || activeTab === 'items' || activeTab === 'financial')) {
      setActiveTab('sales');
    }
  }, [isAdminOrManager, activeTab]);

  useEffect(() => {
    if (!isAdminOrManager && filterType !== 'day') {
      setFilterType('day');
    }
  }, [isAdminOrManager, filterType]);
  const [viewingInvoice, setViewingInvoice] = useState<Invoice | null>(null);
  const [viewingLog, setViewingLog] = useState<InventoryTransaction | null>(null);
  const [showAddCashModal, setShowAddCashModal] = useState<'income' | 'expense' | null>(null);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [showQuickAddCategory, setShowQuickAddCategory] = useState(false);
  const [quickCategoryInput, setQuickCategoryInput] = useState('');
  const [cashFilterType, setCashFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [cashMethodFilter, setCashMethodFilter] = useState<'all' | 'cash' | 'transfer'>('all');
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);

  const handleSaveNewCategory = (catName: string) => {
    const trimmed = catName.trim();
    if (!trimmed) return;
    const currentCats = settings.cashCategories && settings.cashCategories.length > 0
      ? settings.cashCategories
      : ['Bán hàng', 'Tiền điện', 'Tiền nước', 'Tiền mặt bằng', 'Nhập hàng', 'Lương nhân viên', 'Khác'];
    
    const exists = currentCats.some(c => c.toLowerCase() === trimmed.toLowerCase());
    if (!exists) {
      const updated = [...currentCats, trimmed];
      onUpdateSettings({
        ...settings,
        cashCategories: updated
      });
    }
    setNewCash(prev => ({ ...prev, category: trimmed }));
    setShowQuickAddCategory(false);
    setQuickCategoryInput('');
    setShowCategoryDropdown(false);
  };

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

  interface RawDataScope {
    periodKey: string;
    invoicesConfirmed: boolean;
    invoicesStartDay: string;
    invoicesEndDay: string;
    cashConfirmed: boolean;
    cashStartDay: string;
    cashEndDay: string;
    isFullPeriod: boolean;
  }

  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [dailyStatsReady, setDailyStatsReady] = useState(false);
  const [rawScope, setRawScope] = useState<RawDataScope>({
    periodKey: '',
    invoicesConfirmed: false,
    invoicesStartDay: '',
    invoicesEndDay: '',
    cashConfirmed: false,
    cashStartDay: '',
    cashEndDay: '',
    isFullPeriod: false
  });
  const [historicalInvoices, setHistoricalInvoices] = useState<Invoice[]>([]);
  const [historicalCash, setHistoricalCash] = useState<CashTransaction[]>([]);
  const [historicalLogs, setHistoricalLogs] = useState<InventoryTransaction[]>([]);
  const [periodPayrolls, setPeriodPayrolls] = useState<PayrollRecord[]>([]);
  const [isLoadingHistorical, setIsLoadingHistorical] = useState(false);
  const needsInv = activeTab === 'sales' || activeTab === 'items' || activeTab === 'financial';
  const needsCash = activeTab === 'cash' || activeTab === 'financial';
  const usesParentToday = todaySourceEnabled && getExpectedPeriodDates(dateFilter, filterType, todayVietnam).includes(todayVietnam);
  const [reportError, setReportError] = useState('');
  const [payrollDataReady, setPayrollDataReady] = useState(false);
  const [isSavingCash, setIsSavingCash] = useState(false);
  const cashOperationRef = useRef<{ id: string; date: string; signature: string } | null>(null);
  const [hasMoreInvoices, setHasMoreInvoices] = useState(false);
  const [lastInvoiceDoc, setLastInvoiceDoc] = useState<QueryDocumentSnapshot | null>(null);
  const [isLoadingMoreInvoices, setIsLoadingMoreInvoices] = useState(false);
  const [hasMoreCash, setHasMoreCash] = useState(false);
  const [lastCashDoc, setLastCashDoc] = useState<QueryDocumentSnapshot | null>(null);
  const [isLoadingMoreCash, setIsLoadingMoreCash] = useState(false);
  const [hasMoreLogs, setHasMoreLogs] = useState(false);
  const [lastLogDoc, setLastLogDoc] = useState<QueryDocumentSnapshot | null>(null);
  const [isLoadingMoreLogs, setIsLoadingMoreLogs] = useState(false);
  const [invoiceQueryConfig, setInvoiceQueryConfig] = useState<{ mode: 'modern' | 'legacy', ordered: boolean }>({ mode: 'legacy', ordered: true });
  const [cashQueryConfig, setCashQueryConfig] = useState<{ mode: 'modern' | 'legacy', ordered: boolean }>({ mode: 'legacy', ordered: true });

  // Request ID guard để chống đua lệnh (race condition / abort) khi người dùng đổi ngày/kỳ nhanh
  const activeRequestId = useRef(0);
  const periodKey = `${currentUser?.storeId}_${dateFilter}_${filterType}`;
  const currentPeriodRef = useRef(periodKey);
  currentPeriodRef.current = periodKey;
  const [inventoryDataReady, setInventoryDataReady] = useState(false);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [statsPeriodKey, setStatsPeriodKey] = useState('');
  const [statsFailed, setStatsFailed] = useState(false);
  const reportDataReady = Boolean(
    filterType === 'day'
      ? (rawScope.periodKey === periodKey && rawScope.isFullPeriod &&
          (!needsInv || rawScope.invoicesConfirmed) &&
          (!needsCash || rawScope.cashConfirmed) && (!usesParentToday || isInvoicesReady))
      : (statsLoaded && (dailyStatsReady || statsFailed) &&
          (!needsInv || rawScope.invoicesConfirmed) &&
          (!needsCash || rawScope.cashConfirmed) && (!usesParentToday || isInvoicesReady))
  );
  const [supplemental, setSupplemental] = useState<{ key: string; invoices: Invoice[]; cash: CashTransaction[]; invoiceDays: string[]; cashDays: string[] }>({ key: '', invoices: [], cash: [], invoiceDays: [], cashDays: [] });
  const [isExporting, setIsExporting] = useState(false);
  const exportLock = useRef(false);
  const pageLocks = useRef(new Set<string>());
  const detailNeeds = { invoices: filterType === 'day' || needsInv, cash: filterType === 'day' || needsCash,
    todayReady: !usesParentToday || isInvoicesReady || (invoices && invoices.length > 0) };
  const detailNeedsRef = useRef(detailNeeds);
  detailNeedsRef.current = detailNeeds;
  const detailController = useRef<{ ensure: (invoices: boolean, cash: boolean) => void } | null>(null);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;


  // Gộp dữ liệu: Dữ liệu thời gian thực hôm nay (Live) PHẢI GHI ĐÈ LÊN Lịch sử để bản mới nhất luôn thắng, lọc đúng quán hiện tại
  const allInvoices = useMemo(() => {
    const storeId = currentUser?.storeId;
    const map = new Map<string, Invoice>();
    historicalInvoices.forEach(i => {
      if ((!storeId || i.storeId === storeId) && i.status !== 'cancelled' && !(isInvoicesReady && (i.businessDate || getVietnamBusinessDate(i.date)) === todayVietnam) && !(supplemental.key === periodKey && supplemental.invoiceDays.includes(i.businessDate || getVietnamBusinessDate(i.date)))) map.set(i.id, i);
    });
    if (supplemental.key === periodKey) supplemental.invoices.forEach(i => { if (i.status !== 'cancelled' && i.storeId === storeId) map.set(i.id, i); });
    (invoices || []).forEach(i => {
      const day = i.businessDate || getVietnamBusinessDate(i.date);
      const confirmedRaw = (rawScope.periodKey === periodKey && rawScope.invoicesConfirmed
        && day >= rawScope.invoicesStartDay && day <= rawScope.invoicesEndDay)
        || (supplemental.key === periodKey && supplemental.invoiceDays.includes(day));
      if ((!storeId || i.storeId === storeId) && i.status !== 'cancelled' && (isInvoicesReady || !confirmedRaw)) map.set(i.id, i);
    });
    return Array.from(map.values());
  }, [historicalInvoices, invoices, currentUser?.storeId, supplemental, periodKey, isInvoicesReady, todayVietnam, rawScope]);

  const allCashTransactions = useMemo(() => {
    const storeId = currentUser?.storeId;
    const map = new Map<string, CashTransaction>();
    historicalCash.forEach(c => {
      if ((!storeId || c.storeId === storeId) && !(isInvoicesReady && (c.businessDate || getVietnamBusinessDate(c.date)) === todayVietnam) && !(supplemental.key === periodKey && supplemental.cashDays.includes(c.businessDate || getVietnamBusinessDate(c.date)))) map.set(c.id, c);
    });
    if (supplemental.key === periodKey) supplemental.cash.forEach(c => { if (c.storeId === storeId) map.set(c.id, c); });
    (cashTransactions || []).forEach(c => {
      const day = c.businessDate || getVietnamBusinessDate(c.date);
      const confirmedRaw = (rawScope.periodKey === periodKey && rawScope.cashConfirmed
        && day >= rawScope.cashStartDay && day <= rawScope.cashEndDay)
        || (supplemental.key === periodKey && supplemental.cashDays.includes(day));
      if ((!storeId || c.storeId === storeId) && (isInvoicesReady || !confirmedRaw)) map.set(c.id, c);
    });
    return Array.from(map.values());
  }, [historicalCash, cashTransactions, currentUser?.storeId, supplemental, periodKey, isInvoicesReady, todayVietnam, rawScope]);

  const allInventoryLogs = useMemo(() => {
    const storeId = currentUser?.storeId;
    const map = new Map<string, InventoryTransaction>();
    historicalLogs.forEach(l => {
      if (!storeId || l.storeId === storeId) map.set(l.id, l);
    });
    inventoryLogs.forEach(l => {
      if (!storeId || l.storeId === storeId) map.set(l.id, l);
    });
    return Array.from(map.values());
  }, [inventoryLogs, historicalLogs, currentUser?.storeId]);

  // Kiểm tra xem kỳ đang xem có chứa ngày hôm nay không
  const isViewingCurrentPeriod = useMemo(() => {
    const todayStr = businessDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (filterType === 'day') return dateFilter.slice(0, 10) === todayStr;
    if (filterType === 'month') return dateFilter.slice(0, 7) === todayStr.slice(0, 7);
    return dateFilter.slice(0, 4) === todayStr.slice(0, 4);
  }, [dateFilter, filterType, businessDate]);

  const isViewingTodayOnly = useMemo(() => {
    const todayStr = businessDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return filterType === 'day' && dateFilter.slice(0, 10) === todayStr;
  }, [dateFilter, filterType, businessDate]);

  const [loadingInvoiceDetailId, setLoadingInvoiceDetailId] = useState<string | null>(null);

  // Lazy-load chi tiết hóa đơn on-demand khi bấm con mắt 👁️ (chỉ dành riêng cho Admin)
  const handleViewInvoice = async (inv: Invoice) => {
    if (!isAdmin) return;
    if (inv.items && inv.items.length > 0) {
      setViewingInvoice(inv);
      return;
    }
    setLoadingInvoiceDetailId(inv.id);
    try {
      const snap = await getDoc(doc(db, 'invoices', inv.id));
      if (snap.exists()) {
        const fullInv = { ...(snap.data() as any), id: snap.id } as Invoice;
        setViewingInvoice(fullInv);
        setHistoricalInvoices(prev => prev.map(x => x.id === inv.id ? fullInv : x));
      } else {
        setViewingInvoice(inv);
      }
    } catch (err) {
      console.warn('Lỗi tải chi tiết hóa đơn:', err);
      setViewingInvoice(inv);
    } finally {
      setLoadingInvoiceDetailId(null);
    }
  };

  const handlePrintInvoice = async (inv: Invoice) => {
    let fullInv = inv;
    if (!inv.items || inv.items.length === 0) {
      try {
        const snap = await getDoc(doc(db, 'invoices', inv.id));
        if (snap.exists()) {
          fullInv = { ...(snap.data() as any), id: snap.id } as Invoice;
        }
      } catch (err) {
        console.warn('Lỗi tải items khi in HĐ:', err);
      }
    }
    onPrint({
      type: 'bill',
      tableName: fullInv.tableName,
      items: fullInv.items || [],
      total: fullInv.total,
      subtotal: fullInv.subtotal,
      discount: fullInv.discount,
      vat: fullInv.vat,
      staffName: fullInv.staffName,
      timeIn: fullInv.timeIn,
      timeOut: fullInv.date,
      note: fullInv.note
    });
  };

  const loadMoreSource = async (source: 'invoices' | 'cash_transactions' | 'inventory_logs') => {
    const cursor = source === 'invoices' ? lastInvoiceDoc : source === 'cash_transactions' ? lastCashDoc : lastLogDoc;
    if (!currentUser?.storeId || !cursor || pageLocks.current.has(source)) return;
    const key = periodKey, requestId = activeRequestId.current;
    const pageSize = source === 'inventory_logs' ? 50 : 30;
    pageLocks.current.add(source);
    const setLoading = source === 'invoices' ? setIsLoadingMoreInvoices : source === 'cash_transactions' ? setIsLoadingMoreCash : setIsLoadingMoreLogs;
    setLoading(true);
    try {
      const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
      const target = source === 'invoices' ? buildInvoiceQuery(currentUser.storeId, filterType, dateFilter, startIso, endExclusiveIso, 'legacy', true, cursor, pageSize)
        : source === 'cash_transactions' ? buildCashQuery(currentUser.storeId, filterType, dateFilter, startIso, endExclusiveIso, 'legacy', true, cursor, pageSize)
        : buildLogQuery(currentUser.storeId, startIso, endExclusiveIso, cursor, pageSize);
      const snapshot = await getDocsFromServer(target);
      if (key !== currentPeriodRef.current || requestId !== activeRequestId.current) return;
      if (snapshot.metadata.hasPendingWrites) throw new Error('Chứng từ đang chờ lưu. Vui lòng đợi đồng bộ.');
      const rows = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
      const merge = (previous: any[]) => Array.from(new Map([...previous, ...rows].map(row => [row.id, row])).values()).sort((x: any, y: any) => String(y.date || '').localeCompare(String(x.date || '')));
      const last = snapshot.docs[snapshot.docs.length - 1] || null, more = snapshot.size >= pageSize;
      if (source === 'invoices') { setHistoricalInvoices(merge); setLastInvoiceDoc(last); setHasMoreInvoices(more); }
      else if (source === 'cash_transactions') { setHistoricalCash(merge); setLastCashDoc(last); setHasMoreCash(more); }
      else { setHistoricalLogs(merge); setLastLogDoc(last); setHasMoreLogs(more); }
      setReportError('');
    } catch (error) {
      if (key === currentPeriodRef.current && requestId === activeRequestId.current) setReportError(error instanceof Error ? error.message : 'Không thể tải tiếp chứng từ.');
    } finally {
      if (key === currentPeriodRef.current && requestId === activeRequestId.current) {
        pageLocks.current.delete(source); setLoading(false);
      }
    }
  };

  const loadAllSource = async (source: 'invoices' | 'cash_transactions' | 'inventory_logs') => {
    if (!currentUser?.storeId) throw new Error('Vui lòng đăng nhập lại.');
    const key = periodKey, requestId = activeRequestId.current;
    const dates = getExpectedPeriodDates(dateFilter, filterType, todayVietnam);
    const setLoading = source === 'invoices' ? setIsLoadingMoreInvoices : source === 'cash_transactions' ? setIsLoadingMoreCash : setIsLoadingMoreLogs;
    setLoading(true);
    try {
      const rows = (await fetchDateRangeRows<any>(source, currentUser.storeId, dates[0], dates[dates.length - 1])).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      if (key !== currentPeriodRef.current || requestId !== activeRequestId.current) throw new Error('Kỳ báo cáo đã thay đổi. Vui lòng thực hiện lại.');
      if (source === 'invoices') { setHistoricalInvoices(rows); setLastInvoiceDoc(null); setHasMoreInvoices(false); }
      else if (source === 'cash_transactions') { setHistoricalCash(rows); setLastCashDoc(null); setHasMoreCash(false); }
      else { setHistoricalLogs(rows); setLastLogDoc(null); setHasMoreLogs(false); }
      return rows;
    } finally {
      if (key === currentPeriodRef.current && requestId === activeRequestId.current) setLoading(false);
    }
  };
  const handleLoadMoreInvoices = () => loadMoreSource('invoices');
  const handleLoadMoreCash = () => loadMoreSource('cash_transactions');
  const handleLoadMoreLogs = () => loadMoreSource('inventory_logs');
  const loadAllForDisplay = async (source: 'invoices' | 'cash_transactions' | 'inventory_logs') => {
    const key = periodKey, requestId = activeRequestId.current;
    try { return await loadAllSource(source); }
    catch (error) {
      if (key === currentPeriodRef.current && requestId === activeRequestId.current)
        setReportError(error instanceof Error ? error.message : 'Không thể tải đủ chứng từ.');
      return [];
    }
  };
  const handleLoadAllInvoices = () => loadAllForDisplay('invoices');
  const handleLoadAllCash = () => loadAllForDisplay('cash_transactions');
  const handleLoadAllLogs = () => loadAllForDisplay('inventory_logs');

  const [isReconcilingMissingDays, setIsReconcilingMissingDays] = useState(false);

  const handleReconcileMissingDays = async () => {
    if (!currentUser?.storeId || isReconcilingMissingDays) return;
    const storeId = currentUser.storeId;
    const byDate = new Map<string, DailyStats>(dailyStats.map(stat => [stat.date, stat]));
    const pastDates = getExpectedPeriodDates(dateFilter, filterType, todayVietnam).filter(day => day < todayVietnam);
    const missingDays = pastDates.filter(day => !reconciledSource(byDate.get(day), 'invoices') || !reconciledSource(byDate.get(day), 'cash'));

    if (missingDays.length === 0) {
      alert('Tất cả các ngày trong kỳ đã được đối soát đầy đủ.');
      return;
    }

    if (!window.confirm(`Bạn có muốn đối soát và chốt số liệu thống kê cho ${missingDays.length} ngày trong quá khứ không? Dữ liệu sau khi chốt sẽ được lưu vào máy chủ để tăng tốc độ tải báo cáo và tiết kiệm lượt đọc.`)) {
      return;
    }

    setIsReconcilingMissingDays(true);

    try {
      const { saved: successCount, skipped } = await reconcileStoreDaysBatch(storeId, missingDays, todayVietnam);
      if (skipped.length > 0) {
        alert(`Đã đối soát và chốt thành công ${successCount}/${missingDays.length} ngày.\nBỏ qua ${skipped.length} ngày cần kiểm tra chứng từ:\n- ${skipped.slice(0, 5).join('\n- ')}`);
      } else {
        alert(`Đã đối soát và chốt thành công ${successCount}/${missingDays.length} ngày vào máy chủ!`);
      }
    } catch (err) {
      console.error('Lỗi quá trình đối soát ngày cũ:', err);
      alert('Có lỗi xảy ra trong quá trình đối soát ngày cũ.');
    } finally {
      setIsReconcilingMissingDays(false);
    }
  };

  useEffect(() => {
    if (invoiceSearch.trim().length < 2 || filterType === 'day' || activeTab !== 'sales' || !hasMoreInvoices) return;
    const timer = setTimeout(() => { handleLoadAllInvoices().catch(error => {
      if (currentPeriodRef.current === periodKey) setReportError(error instanceof Error ? error.message : 'Không thể tải đủ kết quả tìm kiếm.');
    }); }, 500);
    return () => clearTimeout(timer);
  }, [invoiceSearch, periodKey, activeTab, hasMoreInvoices]);

  // 1. Lắng nghe daily_stats theo kỳ đã chọn (Độc lập khỏi activeTab để không bao giờ bị hủy/tải lại khi chuyển tab)
  useEffect(() => {
    if (!currentUser?.storeId) return;
    const storeId = currentUser.storeId;
    let disposed = false;

    setDailyStats([]);
    setStatsPeriodKey(periodKey);
    setDailyStatsReady(false);
    setStatsLoaded(false);
    setStatsFailed(false);

    try {
      let statsQuery: Query;
      if (filterType === 'year') {
        const targetYear = Number(dateFilter.slice(0, 4));
        statsQuery = query(
          collection(db, 'daily_stats'),
          where('storeId', '==', storeId),
          where('year', '==', targetYear)
        );
      } else if (filterType === 'month') {
        const targetMonth = dateFilter.slice(0, 7);
        statsQuery = query(
          collection(db, 'daily_stats'),
          where('storeId', '==', storeId),
          where('month', '==', targetMonth)
        );
      } else {
        const targetDay = dateFilter.slice(0, 10);
        statsQuery = query(
          collection(db, 'daily_stats'),
          where('storeId', '==', storeId),
          where('date', '==', targetDay)
        );
      }

      const unsub = subscribeSharedQuery(statsQuery, (snapshot) => {
        if (disposed) return;
        const isStatsConfirmed = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
        const list = snapshot.docs.map(d => ({
          ...d.data(),
          id: d.id,
          _fromCache: snapshot.metadata.fromCache
        } as DailyStats & { _fromCache?: boolean }));
        list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        setDailyStats(list);
        setDailyStatsReady(isStatsConfirmed);
        if (isStatsConfirmed) setStatsLoaded(true);
      }, (err) => {
        console.warn('Lỗi tải daily_stats trong SummaryView:', err);
        if (!disposed) { setDailyStatsReady(false); setStatsFailed(true); setStatsLoaded(true); }
      });

      return () => {
        disposed = true;
        unsub();
      };
    } catch (statsErr) {
      console.warn('Không thể khởi tạo query daily_stats trong SummaryView:', statsErr);
      if (!disposed) { setStatsFailed(true); setStatsLoaded(true); }
    }
  }, [currentUser?.storeId, dateFilter, filterType]);

  // Giữ nguồn TOÀN KỲ đã mở cho tới khi đổi kỳ/rời màn hình.
  // Đổi sales/items/financial không hủy và tải lại cùng nguồn; không có query 30 dòng
  // ghi đè mảng chứng từ đã xác nhận đầy đủ.
  useEffect(() => {
    const requestId = ++activeRequestId.current;
    let disposed = false;
    const current = () => !disposed && requestId === activeRequestId.current && periodKey === currentPeriodRef.current;
    const sources = {
      invoices: { requested: false, confirmed: false, stop: undefined as (() => void) | undefined, error: '' },
      cash: { requested: false, confirmed: false, stop: undefined as (() => void) | undefined, error: '' },
    };
    pageLocks.current.clear();
    setIsLoadingMoreInvoices(false); setIsLoadingMoreCash(false); setIsLoadingMoreLogs(false);
    setHistoricalInvoices([]); setHistoricalCash([]);
    setHasMoreInvoices(false); setHasMoreCash(false); setLastInvoiceDoc(null); setLastCashDoc(null);
    setRawScope({ periodKey, invoicesConfirmed: false, invoicesStartDay: '', invoicesEndDay: '',
      cashConfirmed: false, cashStartDay: '', cashEndDay: '', isFullPeriod: false });
    setReportError('');
    if (typeof detailController !== 'undefined' && detailController) detailController.current = null;
    const dates = getExpectedPeriodDates(dateFilter, filterType, todayVietnam).filter(day => day <= todayVietnam);
    if (!currentUser?.storeId || !dates.length) {
      setIsLoadingHistorical(false);
      if (currentUser?.storeId) setReportError('Vui lòng chọn kỳ không vượt quá ngày hiện tại.');
      return () => { disposed = true; };
    }
    // Hôm nay đã được App đồng bộ đầy đủ: chỉ đọc phần lịch sử chưa có trên máy.
    // Dùng cờ nguồn được bật, không dùng cờ confirmed để quyết định phạm vi query;
    // nhờ đó pending/offline không làm bật thêm một query trùng hôm nay.
    const isTodayEnabled = typeof todaySourceEnabled !== 'undefined' && Boolean(todaySourceEnabled);
    const queryDates = isTodayEnabled ? dates.filter(day => day !== todayVietnam) : dates;
    const storeId = currentUser.storeId, first = queryDates[0] || '', last = queryDates[queryDates.length - 1] || '';
    let sourceError = '';
    const publishSourceError = () => {
      const previous = sourceError;
      const next = [sources.invoices.error, sources.cash.error].filter(Boolean).join('\n');
      sourceError = next;
      // Chỉ xóa lỗi của chính nguồn này; không xóa nhầm lỗi xuất file/thao tác khác.
      setReportError(value => (next || value === previous) ? next : value);
    };
    const update = () => {
      if (!current()) return;
      const isDay = filterType === 'day';
      setRawScope({ periodKey,
        invoicesConfirmed: sources.invoices.confirmed,
        invoicesStartDay: sources.invoices.requested && isDay ? first : '',
        invoicesEndDay: sources.invoices.requested && isDay ? last : '',
        cashConfirmed: sources.cash.confirmed,
        cashStartDay: sources.cash.requested && isDay ? first : '',
        cashEndDay: sources.cash.requested && isDay ? last : '',
        isFullPeriod: isDay && (sources.invoices.requested || sources.cash.requested) });
      const reqInvoices = typeof detailNeedsRef !== 'undefined' && detailNeedsRef ? detailNeedsRef.current.invoices : (typeof detailNeeds !== 'undefined' ? detailNeeds.invoices : (filterType === 'day' || activeTab === 'sales' || activeTab === 'items' || activeTab === 'financial'));
      const reqCash = typeof detailNeedsRef !== 'undefined' && detailNeedsRef ? detailNeedsRef.current.cash : (typeof detailNeeds !== 'undefined' ? detailNeeds.cash : (filterType === 'day' || activeTab === 'cash' || activeTab === 'financial'));
      const reqTodayReady = typeof detailNeedsRef !== 'undefined' && detailNeedsRef ? detailNeedsRef.current.todayReady : (typeof detailNeeds !== 'undefined' ? detailNeeds.todayReady : true);
      const isViewingTodayOnly = filterType === 'day' && dateFilter === todayVietnam;
      setIsLoadingHistorical(!isViewingTodayOnly && (
        (reqInvoices && !sources.invoices.confirmed)
        || (reqCash && !sources.cash.confirmed) || !reqTodayReady
      ));
    };
    const fail = (kind: 'invoices' | 'cash', error: Error) => {
      if (!current()) return;
      sources[kind].confirmed = false; sources[kind].error = error.message || 'Chưa xác nhận đủ chứng từ.';
      update(); setIsLoadingHistorical(false);
      publishSourceError();
    };
    const controller = {
      ensure(invoices: boolean, cash: boolean) {
        if (!current()) return;
        if (invoices && !sources.invoices.requested) {
          sources.invoices.requested = true;
          if (!queryDates.length) {
            sources.invoices.confirmed = true;
            update();
          } else if (filterType === 'day') {
            sources.invoices.stop = subscribeDateRange<Invoice>('invoices', storeId, first, last, (rows, confirmed) => {
              if (!current()) return;
              setHistoricalInvoices(rows); sources.invoices.confirmed = confirmed;
              if (confirmed) sources.invoices.error = '';
              update(); publishSourceError();
            }, error => fail('invoices', error));
          } else {
            // Phân trang danh sách chi tiết (30 dòng đầu) khi xem theo kỳ tháng / năm
            const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
            const q = buildInvoiceQuery(storeId, filterType, dateFilter, startIso, endExclusiveIso, 'legacy', true, null, 30);
            getDocsFromServer(q).then(snapshot => {
              if (!current()) return;
              if (snapshot.metadata.hasPendingWrites) throw new Error('Chứng từ đang chờ lưu. Vui lòng đợi đồng bộ.');
              const rows = snapshot.docs.map(d => ({ ...d.data(), id: d.id } as Invoice));
              setHistoricalInvoices(rows);
              setLastInvoiceDoc(snapshot.docs[snapshot.docs.length - 1] || null);
              setHasMoreInvoices(snapshot.size >= 30);
              sources.invoices.confirmed = true;
              sources.invoices.error = '';
              update();
              publishSourceError();
            }).catch(error => fail('invoices', error));
          }
        }
        if (cash && !sources.cash.requested) {
          sources.cash.requested = true;
          if (!queryDates.length) {
            sources.cash.confirmed = true;
            update();
          } else if (filterType === 'day') {
            sources.cash.stop = subscribeDateRange<CashTransaction>('cash_transactions', storeId, first, last, (rows, confirmed) => {
              if (!current()) return;
              setHistoricalCash(rows); sources.cash.confirmed = confirmed;
              if (confirmed) sources.cash.error = '';
              update(); publishSourceError();
            }, error => fail('cash', error));
          } else {
            // Phân trang danh sách chi tiết (30 dòng đầu) khi xem theo kỳ tháng / năm
            const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
            const q = buildCashQuery(storeId, filterType, dateFilter, startIso, endExclusiveIso, 'legacy', true, null, 30);
            getDocsFromServer(q).then(snapshot => {
              if (!current()) return;
              if (snapshot.metadata.hasPendingWrites) throw new Error('Chứng từ đang chờ lưu. Vui lòng đợi đồng bộ.');
              const rows = snapshot.docs.map(d => ({ ...d.data(), id: d.id } as CashTransaction));
              setHistoricalCash(rows);
              setLastCashDoc(snapshot.docs[snapshot.docs.length - 1] || null);
              setHasMoreCash(snapshot.size >= 30);
              sources.cash.confirmed = true;
              sources.cash.error = '';
              update();
              publishSourceError();
            }).catch(error => fail('cash', error));
          }
        }
        update();
      },
    };
    if (typeof detailController !== 'undefined' && detailController) detailController.current = controller;
    const reqInvoices = typeof detailNeeds !== 'undefined' ? detailNeeds.invoices : (filterType === 'day' || activeTab === 'sales' || activeTab === 'items' || activeTab === 'financial');
    const reqCash = typeof detailNeeds !== 'undefined' ? detailNeeds.cash : (filterType === 'day' || activeTab === 'cash' || activeTab === 'financial');
    controller.ensure(reqInvoices, reqCash);

    return () => {
      disposed = true;
      if (requestId === activeRequestId.current) activeRequestId.current++;
      if (typeof detailController !== 'undefined' && detailController && detailController.current === controller) detailController.current = null;
      sources.invoices.stop?.(); sources.cash.stop?.();
    };
  }, [currentUser?.storeId, dateFilter, filterType, todayVietnam, todaySourceEnabled]);

  useEffect(() => {
    detailController.current?.ensure(detailNeeds.invoices, detailNeeds.cash);
  }, [currentUser?.storeId, dateFilter, filterType, todayVietnam, todaySourceEnabled,
    detailNeeds.invoices, detailNeeds.cash, detailNeeds.todayReady]);

  // Chỉ bổ sung những ngày mà tổng hợp chưa bao phủ đủ nguồn; không ghi ngược dữ liệu.
  const supplementPlan = useMemo(() => {
    type Plan = { kind: 'invoices' | 'cash'; start: string; end: string; dates: string[] };
    if (!statsLoaded || statsPeriodKey !== periodKey) return [] as Plan[];
    const byDate = new Map<string, DailyStats>(dailyStats.map(stat => [stat.date, stat]));
    const pastDates = getExpectedPeriodDates(dateFilter, filterType, todayVietnam).filter(day => day < todayVietnam);
    // Không mở nguồn bổ sung cho phần đang có listener TOÀN KỲ (kể cả đang đợi server).
    // Nguồn toàn kỳ lỗi vẫn giữ trạng thái chưa xác nhận; không giả định số 0.
    const fullInvoices = filterType === 'day' ? detailNeeds.invoices : (rawScope.periodKey === periodKey && Boolean(rawScope.invoicesStartDay));
    const fullCash = filterType === 'day' ? detailNeeds.cash : (rawScope.periodKey === periodKey && Boolean(rawScope.cashStartDay));
    const plans: Plan[] = [];
    for (const kind of ['invoices', 'cash'] as const) {
      if (kind === 'invoices' ? fullInvoices : fullCash) continue;
      // Tối ưu hóa Reads: Khi xem kỳ Tháng / Năm, chỉ tải bù nguồn chứng từ nào mà tab hoặc chỉ tiêu hiện tại cần
      if (filterType !== 'day') {
        if (kind === 'invoices' && !detailNeeds.invoices) continue;
        if (kind === 'cash' && !detailNeeds.cash) continue;
      }
      const missing = pastDates.filter(day => statsFailed || !reconciledSource(byDate.get(day), kind));
      plans.push(...contiguousDateRanges(missing).map(range => ({ ...range, kind })));
    }
    return plans;
  }, [statsLoaded, statsPeriodKey, periodKey, dailyStats, statsFailed, dateFilter, filterType, todayVietnam,
    detailNeeds.invoices, detailNeeds.cash, rawScope.periodKey, rawScope.invoicesStartDay, rawScope.cashStartDay]);
  const supplementPlanKey = supplementPlan.map(range => range.kind + ':' + range.start + ':' + range.end).join('|');
  useEffect(() => {
    let disposed = false;
    const sources = new Map<string, { kind: 'invoices' | 'cash'; dates: string[]; rows: any[]; confirmed: boolean }>();
    const stops: (() => void)[] = [];
    setSupplemental({ key: periodKey, invoices: [], cash: [], invoiceDays: [], cashDays: [] });
    if (!currentUser?.storeId) return;
    const publish = () => {
      if (disposed || periodKey !== currentPeriodRef.current) return;
      const invoices = new Map<string, Invoice>(), cash = new Map<string, CashTransaction>();
      const invoiceDays = new Set<string>(), cashDays = new Set<string>();
      for (const source of sources.values()) {
        const target = source.kind === 'invoices' ? invoices : cash;
        source.rows.forEach(row => target.set(row.id, row));
        if (source.confirmed) source.dates.forEach(day => (source.kind === 'invoices' ? invoiceDays : cashDays).add(day));
      }
      setSupplemental({ key: periodKey, invoices: [...invoices.values()], cash: [...cash.values()], invoiceDays: [...invoiceDays], cashDays: [...cashDays] });
    };
    for (const range of supplementPlan) {
      const kind = range.kind;
      const key = kind + ':' + range.start + ':' + range.end;
      sources.set(key, { kind, dates: range.dates, rows: [], confirmed: false });
      stops.push(subscribeDateRange<any>(kind === 'invoices' ? 'invoices' : 'cash_transactions', currentUser.storeId, range.start, range.end, (rows, confirmed) => {
        if (disposed) return;
        sources.set(key, { kind, dates: range.dates, rows, confirmed }); publish();
      }, failure => {
        if (disposed || periodKey !== currentPeriodRef.current) return;
        sources.get(key)!.confirmed = false; publish(); setReportError(failure.message);
      }));
    }
    return () => { disposed = true; stops.forEach(stop => stop()); };
  }, [currentUser?.storeId, periodKey, supplementPlanKey]);

  // 2. Chỉ tải inventory_logs khi người dùng chủ động mở tab Kho
  useEffect(() => {
    if (!currentUser?.storeId || activeTab !== 'inventory') return;
    const storeId = currentUser.storeId;
    const expected = getExpectedPeriodDates(dateFilter, filterType, todayVietnam).filter(d => d <= todayVietnam);
    if (!expected.length) return;
    const first = expected[0], last = expected[expected.length-1];
    let disposed = false;
    setHistoricalLogs([]); setInventoryDataReady(false); setHasMoreLogs(false); setLastLogDoc(null);
    const unsub = subscribeDateRange<InventoryTransaction>('inventory_logs',storeId,first,last,(rows, confirmed)=>{ if(!disposed){setHistoricalLogs(rows);setInventoryDataReady(confirmed);} },(err)=>{if(!disposed){setInventoryDataReady(false);setReportError(err.message);}});
    return () => { disposed = true; unsub(); };
  }, [currentUser?.storeId, dateFilter, filterType, activeTab, todayVietnam]);

  // 3. Chỉ tải payroll_records khi người dùng chủ động mở tab Tài chính VÀ chọn chỉ tiêu tính theo bảng lương đã chốt
  // (Mặc định báo cáo Tài chính tính theo phiếu chi lương thực tế nên không cần tải bảng lương, tiết kiệm reads)
  useEffect(() => {
    if (!currentUser?.storeId || activeTab !== 'financial' || financialCostBasis !== 'payroll') {
      setPayrollDataReady(false);
      setPeriodPayrolls([]);
      return;
    }
    const storeId = currentUser.storeId;
    let disposed = false;
    setPayrollDataReady(false);

    let payrollQuery: Query;
    if (filterType === 'year') {
      const targetYear = dateFilter.slice(0, 4);
      payrollQuery = query(
        collection(db, 'payroll_records'),
        where('storeId', '==', storeId),
        where('month', '>=', `${targetYear}-01`),
        where('month', '<=', `${targetYear}-12`),
        orderBy('month', 'desc')
      );
    } else {
      const targetMonth = dateFilter.slice(0, 7);
      payrollQuery = query(
        collection(db, 'payroll_records'),
        where('storeId', '==', storeId),
        where('month', '==', targetMonth)
      );
    }

    const unsub = onSnapshot(payrollQuery, { includeMetadataChanges: true }, snapshot => {
      if (disposed) return;
      const rows = snapshot.docs.map(d => ({ ...d.data(), id: d.id } as PayrollRecord));
      setPeriodPayrolls(rows.filter(p => filterType === 'year' ? p.month.slice(0, 4) === dateFilter.slice(0, 4) : p.month === dateFilter.slice(0, 7)));
      setPayrollDataReady(!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites);
    }, (err) => {
      console.warn('Lỗi tải payroll trong Summary:', err);
      if (!disposed) setPayrollDataReady(false);
    });
    return () => { disposed = true; unsub(); };
  }, [currentUser?.storeId, dateFilter, filterType, activeTab, financialCostBasis]);

  // 1. Toàn bộ hóa đơn thuộc kỳ được chọn của cửa hàng (KHÔNG bị lọc bởi ô tìm kiếm) dùng để tính toán số liệu, KPI, COGS
  const periodInvoices = useMemo(() => {
    const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
    const targetDay = dateFilter.slice(0, 10);
    const targetMonth = dateFilter.slice(0, 7);
    const targetYear = dateFilter.slice(0, 4);

    return allInvoices.filter(inv => {
      let matchDate = false;
      const invBDate = inv.businessDate || getVietnamBusinessDate(inv.date);
      if (filterType === 'day') {
        matchDate = invBDate === targetDay || (inv.date >= startIso && inv.date < endExclusiveIso);
      } else if (filterType === 'month') {
        matchDate = invBDate.slice(0, 7) === targetMonth || (inv.date >= startIso && inv.date < endExclusiveIso);
      } else {
        matchDate = invBDate.slice(0, 4) === targetYear || (inv.date >= startIso && inv.date < endExclusiveIso);
      }
      return matchDate;
    }).sort((a, b) => String(b.completedAt || b.date || '').localeCompare(String(a.completedAt || a.date || '')));
  }, [allInvoices, dateFilter, filterType]);

  // 2. Danh sách hóa đơn hiển thị trong bảng (áp dụng thêm bộ lọc tìm kiếm mã HĐ, tên bàn, nhân viên)
  const visibleInvoices = useMemo(() => {
    if (!invoiceSearch.trim()) return periodInvoices;
    const q = invoiceSearch.toLowerCase().trim();
    return periodInvoices.filter(inv => {
      const matchId = (inv.id || '').toLowerCase().includes(q);
      const matchTable = (inv.tableName || '').toLowerCase().includes(q);
      const matchStaff = (inv.staffName || '').toLowerCase().includes(q);
      return matchId || matchTable || matchStaff;
    });
  }, [periodInvoices, invoiceSearch]);

  const filteredInvoices = visibleInvoices;

  const filteredLogs = useMemo(() => {
    const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
    const targetDay = dateFilter.slice(0, 10);
    const targetMonth = dateFilter.slice(0, 7);
    const targetYear = dateFilter.slice(0, 4);

    return allInventoryLogs.filter(log => {
      const lDateStr = getVietnamBusinessDate(log.date);
      let matchDate = false;
      if (filterType === 'day') {
        matchDate = lDateStr === targetDay || (log.date >= startIso && log.date < endExclusiveIso);
      } else if (filterType === 'month') {
        matchDate = lDateStr.slice(0, 7) === targetMonth || (log.date >= startIso && log.date < endExclusiveIso);
      } else {
        matchDate = lDateStr.slice(0, 4) === targetYear || (log.date >= startIso && log.date < endExclusiveIso);
      }
      return matchDate;
    }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }, [allInventoryLogs, dateFilter, filterType]);

  // Nguồn tính/đối soát dùng đủ chứng từ trong phạm vi; bộ lọc quyền chỉ áp dụng danh sách hiển thị.
  const sourcePeriodCash = useMemo(() => {
    const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
    return allCashTransactions.filter(row => {
      const day = getVietnamBusinessDate(row.date);
      const matches = filterType === 'day' ? day === dateFilter.slice(0, 10)
        : filterType === 'month' ? day.slice(0, 7) === dateFilter.slice(0, 7) : day.slice(0, 4) === dateFilter.slice(0, 4);
      return matches || (row.date >= startIso && row.date < endExclusiveIso);
    }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }, [allCashTransactions, dateFilter, filterType]);
  const periodCash = useMemo(() => sourcePeriodCash.filter(row => {
    const automatic = isSalesCategory(row.category) || row.category === 'Nhập hàng' || row.category === 'Trả hàng';
    return isAdminOrManager || (row.staffId === currentUser?.id && !automatic);
  }), [sourcePeriodCash, isAdminOrManager, currentUser?.id]);
  const filteredCash = periodCash;

  // Calculate item sales summary từ toan bo hóa đơn trong kỳ (không bị ảnh hưởng bởi ô tìm kiếm)
  const itemSales = useMemo(() => {
    const acc: Record<string, { name: string, quantity: number, revenue: number }> = {};
    periodInvoices.forEach(inv => {
      const revenues=allocatedItemRevenue(inv);
      (inv.items||[]).forEach((item,index) => {
        if (!acc[item.id]) {
          acc[item.id] = { name: item.name, quantity: 0, revenue: 0 };
        }
        acc[item.id].quantity += item.quantity;
        acc[item.id].revenue += revenues[index];
      });
    });
    return Object.values(acc).sort((a, b) => b.revenue - a.revenue);
  }, [periodInvoices]);

  const sortedItemSales = itemSales;

  // Danh sách các món bán trong kỳ nhưng thiếu giá vốn trực tiếp hoặc thiếu định lượng nguyên liệu kho
  interface MissingCostItemInfo {
    id: string;
    name: string;
    quantitySold: number;
    revenue: number;
    reason: 'no_cost_price' | 'incomplete_recipe';
  }

  const missingCostItems = useMemo<MissingCostItemInfo[]>(() => {
    const missingMap = new Map<string, MissingCostItemInfo>();
    const menuMap = new Map((menu || []).map(m => [m.id, m]));
    const menuByName = new Map((menu || []).map(m => [m.name.toLowerCase().trim(), m]));
    const invMap = new Map((inventoryItems || []).map(i => [i.id, i]));
    const invByName = new Map((inventoryItems || []).map(i => [i.name.toLowerCase().trim(), i]));

    const checkCostValid = (num: unknown, itemObj?: any): boolean => {
      const explicitVerified = Boolean(itemObj?.costVerified || itemObj?.isFreeCost);
      const price = typeof itemObj?.price === 'number' ? itemObj.price : 0;
      return isCostExplicitlyVerified(typeof num === 'number' ? num : undefined, price, explicitVerified);
    };

    const findSource = (id: string, name?: string) => {
      let found = menuMap.get(id) || invMap.get(id);
      if (!found && name) {
        const clean = name.toLowerCase().trim();
        found = menuByName.get(clean) || invByName.get(clean);
      }
      return found;
    };

    periodInvoices.forEach(inv => {
      if (inv.status === 'cancelled') return;
      const revenues = allocatedItemRevenue(inv);
      (inv.items || []).forEach((item, index) => {
        const menuItem = findSource(item.id, item.name);
        
        let hasValidCost = false;
        let reason: 'no_cost_price' | 'incomplete_recipe' = 'no_cost_price';

        // 1. Kiểm tra định lượng công thức (recipe)
        const recipe = (menuItem?.recipe && menuItem.recipe.length > 0)
          ? menuItem.recipe
          : (item.recipe && item.recipe.length > 0) ? item.recipe : null;

        if (recipe && recipe.length > 0) {
          const allIngredientsValid = recipe.every(r => {
            const ing = findSource(r.ingredientId, r.name);
            return checkCostValid(ing?.costPrice, ing) && Number.isFinite(r.quantity) && r.quantity > 0;
          });
          if (allIngredientsValid) {
            hasValidCost = true;
          } else {
            reason = 'incomplete_recipe';
          }
        } else {
          // 2. Kiểm tra giá vốn trực tiếp (direct costPrice)
          const directCost = (typeof menuItem?.costPrice === 'number' && menuItem.costPrice > 0)
            ? menuItem.costPrice
            : (typeof item.costPrice === 'number' && item.costPrice > 0)
              ? item.costPrice
              : (menuItem?.costPrice === 0 || item.costPrice === 0)
                ? 0
                : undefined;

          if (checkCostValid(directCost, menuItem || item)) {
            hasValidCost = true;
          } else {
            reason = 'no_cost_price';
          }
        }

        if (!hasValidCost) {
          const key = item.id || item.name;
          const rev = revenues[index] ?? ((item.price || 0) * (item.quantity || 1));
          const existing = missingMap.get(key);
          if (existing) {
            existing.quantitySold += (item.quantity || 1);
            existing.revenue += rev;
          } else {
            missingMap.set(key, {
              id: item.id,
              name: item.name,
              quantitySold: item.quantity || 1,
              revenue: rev,
              reason
            });
          }
        }

        // 3. Kiểm tra các món thêm (toppings / add-ons) có thu tiền
        (item.selectedAddOns || []).forEach(addon => {
          const addonPrice = typeof addon.price === 'number' ? addon.price : 0;
          if (addonPrice > 0) {
            let addonCostValid = false;
            if (addon.inventoryItemId) {
              const src = findSource(addon.inventoryItemId, addon.name);
              const cost = (typeof addon.costPrice === 'number' && addon.costPrice > 0)
                ? addon.costPrice
                : src?.costPrice;
              addonCostValid = checkCostValid(cost, src || addon);
            } else {
              const src = findSource('', addon.name);
              const cost = (typeof addon.costPrice === 'number' && addon.costPrice > 0)
                ? addon.costPrice
                : src?.costPrice;
              addonCostValid = checkCostValid(cost, src || addon);
            }

            if (!addonCostValid) {
              const addonKey = `addon_${addon.inventoryItemId || addon.name}`;
              const existing = missingMap.get(addonKey);
              const addonRev = addonPrice * (item.quantity || 1);
              if (existing) {
                existing.quantitySold += (item.quantity || 1);
                existing.revenue += addonRev;
              } else {
                missingMap.set(addonKey, {
                  id: addon.inventoryItemId || addon.id || addonKey,
                  name: `Món thêm: ${addon.name}`,
                  quantitySold: item.quantity || 1,
                  revenue: addonRev,
                  reason: 'no_cost_price'
                });
              }
            }
          }
        });
      });
    });

    return Array.from(missingMap.values()).sort((a, b) => b.quantitySold - a.quantitySold);
  }, [periodInvoices, menu, inventoryItems]);

  const missingCostIdSet = useMemo(() => new Set(missingCostItems.map(m => m.id)), [missingCostItems]);
  const missingCostNameSet = useMemo(() => new Set(missingCostItems.map(m => m.name.toLowerCase().trim())), [missingCostItems]);

  const displayedItemSales = useMemo(() => {
    if (!onlyShowMissingCostItems) return sortedItemSales;
    return sortedItemSales.filter(item => 
      missingCostIdSet.has(item.id) || missingCostNameSet.has(item.name.toLowerCase().trim())
    );
  }, [sortedItemSales, onlyShowMissingCostItems, missingCostIdSet, missingCostNameSet]);

  // Tính giá vốn từ hóa đơn: Giữ nguyên snapshot giá vốn đã lưu trên hóa đơn tại thời điểm bán,
  // tuyệt đối không tính lại từ thực đơn hiện tại làm sai lệch dữ liệu lịch sử.
  const { recomputedInvoices, totalRecomputedCost, hasAnyIncompleteInvoice } = useMemo(() => {
    let totalCost = 0, incomplete = false;

    const rows = periodInvoices.map(invoice => {
      if (invoice.status === 'cancelled') return { ...invoice, effectiveCost: 0, isCostComplete: true, shouldUpdateInDb: false };
      const complete = invoiceCostIsComplete(invoice);
      let cost = 0;
      if (typeof invoice.totalCost === 'number' && Number.isFinite(invoice.totalCost) && invoice.totalCost >= 0) {
        cost = invoice.totalCost;
      } else {
        cost = Math.max(0, calculateInvoiceCost(invoice.items || []));
      }
      totalCost += cost;
      if (!complete && cost === 0) incomplete = true;
      return { ...invoice, effectiveCost: cost, isCostComplete: complete || cost > 0, shouldUpdateInDb: false };
    });
    return { recomputedInvoices: rows, totalRecomputedCost: Math.max(0, totalCost), hasAnyIncompleteInvoice: incomplete };
  }, [periodInvoices]);

  const [isSyncingCosts, setIsSyncingCosts] = useState(false);
  const [costSyncDone, setCostSyncDone] = useState(false);

  // Báo cáo tuân thủ nguyên tắc Chỉ Đọc (Read-Only): Không tự động kích hoạt batch writes vào Firestore khi chỉ mở xem báo cáo
  useEffect(() => {
    // Giá vốn và KPI đã được tính toán động chính xác 100% trong bộ nhớ (recomputedInvoices/statsAggregates).
    // Không ghi ngược vào Firestore để tránh kích hoạt vòng lặp docChanges và hàng nghìn reads lan truyền cho các máy khác.
    return;
  }, []);

  // Tổng hợp dữ liệu đa tầng theo từng ngày (Per-day Single Source of Truth, 100% toàn vẹn)
  const expectedReportDates = useMemo(() => getExpectedPeriodDates(dateFilter, filterType, todayVietnam).filter(day => day <= todayVietnam), [dateFilter, filterType, todayVietnam]);
  const sourceCoverage = useMemo(() => {
    const invoiceDays = new Set<string>(), cashDays = new Set<string>();
    for (const day of expectedReportDates) {
      if (day === todayVietnam && (todaySourceEnabled || isInvoicesReady || periodInvoices.length > 0 || (invoices && invoices.length > 0))) {
        invoiceDays.add(day);
        cashDays.add(day);
      }
      if (rawScope.periodKey === periodKey) {
        if (rawScope.invoicesConfirmed && day >= rawScope.invoicesStartDay && day <= rawScope.invoicesEndDay) invoiceDays.add(day);
        if (rawScope.cashConfirmed && day >= rawScope.cashStartDay && day <= rawScope.cashEndDay) cashDays.add(day);
      }
    }
    if (supplemental.key === periodKey) {
      supplemental.invoiceDays.forEach(day => invoiceDays.add(day));
      supplemental.cashDays.forEach(day => cashDays.add(day));
    }
    return { invoiceDays, cashDays };
  }, [expectedReportDates, todayVietnam, isInvoicesReady, rawScope, periodKey, supplemental, todaySourceEnabled, periodInvoices.length, invoices]);
  const rawReport = useMemo(() => aggregateReportDays(currentUser?.storeId || '', expectedReportDates, periodInvoices, sourcePeriodCash, sourceCoverage),
    [currentUser?.storeId, expectedReportDates, periodInvoices, sourcePeriodCash, sourceCoverage]);
  const sourceMismatch = [...rawReport.receiptIssues].map(([day, issue]) => `${day} · ${issue}`).join('\n');
  const statsAggregates = useMemo(() => {
    const dates = getExpectedPeriodDates(dateFilter, filterType, todayVietnam).filter(d => d <= todayVietnam);
    const statsByDate = new Map<string, DailyStats>((statsPeriodKey === periodKey ? dailyStats : []).map(s => [s.date, s]));

    // 1. Xác định phạm vi ngày thực sự đã tải và xác nhận cho từng nguồn (invoices vs cash)
    const isDayInRawInvoices = (day: string) => sourceCoverage.invoiceDays.has(day);
    const isDayInRawCash = (day: string) => sourceCoverage.cashDays.has(day);

    const isDayInAnyRaw = (d: string) => isDayInRawInvoices(d) || isDayInRawCash(d);
    const isDayInBothRaw = (d: string) => isDayInRawInvoices(d) && isDayInRawCash(d);

    const rawByDate = rawReport.stats;

    // Helper: Hợp nhất an toàn giữa rawStat và serverStat theo từng chỉ tiêu và từng nguồn ngày
    // Tuyệt đối không để nguồn chưa tải (hoặc chỉ tải hôm nay) ghi đè 0 vào dữ liệu ngày quá khứ
    const buildMergedRawStat = (raw: DailyStats, server: DailyStats | undefined, day: string): DailyStats =>
      mergeDaySources(raw, server, isDayInRawInvoices(day), isDayInRawCash(day));

    // Hợp nhất dữ liệu: Đảm bảo nguyên tắc 1 nguồn duy nhất trọn vẹn cho từng ngày (Single Source of Truth)
    const stats: (DailyStats & { _source: 'serverStat' | 'rawStat' | 'empty' })[] = dates.map(d => {
      const serverStat = statsByDate.get(d);
      const isServerStatConfirmed = Boolean(serverStat && !(serverStat as any)._fromCache && dailyStatsReady);
      const isServerStatReconciled = reconciledSource(serverStat, 'invoices') && reconciledSource(serverStat, 'cash');

      const dayHasRaw = isDayInAnyRaw(d);
      const dayHasBothRaw = isDayInBothRaw(d);
      const rawStat = dayHasRaw ? rawByDate.get(d) : undefined;

      // 1. Ngày hôm nay (Live data)
      if (d === todayVietnam) {
        if (rawStat) {
          const merged = buildMergedRawStat(rawStat, serverStat, d);
          return {
            ...merged,
            coverageStatus: 'live_tracking',
            _source: 'rawStat'
          };
        }
        if (serverStat) {
          return {
            ...serverStat,
            coverageStatus: 'live_tracking',
            _source: 'serverStat'
          };
        }
        return {
          id: `${currentUser?.storeId}_${d}`,
          storeId: currentUser?.storeId || '',
          date: d,
          month: d.slice(0, 7),
          year: Number(d.slice(0, 4)),
          totalRevenue: 0,
          totalCash: 0,
          totalTransfer: 0,
          invoiceCount: 0,
          totalDiscount: 0,
          totalCost: 0,
          coverageStatus: 'missing',
          costStatus: 'missing',
          hasData: false,
          _source: 'empty'
        };
      }

      // 2. Ngày quá khứ (d < todayVietnam)
      // Cả hai nguồn chứng từ đã đầy đủ: giữ đúng số và trạng thái giá vốn của chứng từ.
      // Không lấy costStatus/chi tiết thu chi cũ từ daily_stats chỉ vì tổng tiền trùng nhau.
      if (dayHasBothRaw && rawStat) {
        return {
          ...rawStat,
          coverageStatus: !rawReport.invoiceDays.has(d) || !rawReport.cashDays.has(d) || rawReport.receiptIssues.has(d)
            ? 'partial' : rawStat.hasData ? 'reconciled' : 'zero_activity',
          _source: 'rawStat'
        };
      }

      // Tình huống 2b: Server stats đã xác nhận từ server và đã đối soát (ưu tiên dùng khi chỉ tải 1 nguồn raw hoặc không tải raw)
      if (isServerStatConfirmed && isServerStatReconciled) {
        if (rawStat && dayHasRaw) {
          const merged = buildMergedRawStat(rawStat, serverStat, d);
          return {
            ...merged,
            coverageStatus: 'reconciled',
            _source: 'serverStat'
          };
        }
        return {
          ...serverStat!,
          coverageStatus: serverStat!.coverageStatus || 'reconciled',
          _source: 'serverStat'
        };
      }

      // Tình huống 2c: Ngày quá khứ có rawStat (được merge an toàn với serverStat)
      if (rawStat && dayHasRaw) {
        const merged = buildMergedRawStat(rawStat, serverStat, d);
        return {
          ...merged,
          coverageStatus: dayHasBothRaw && !sourceMismatch ? (rawStat.hasData ? 'reconciled' : 'zero_activity') : 'partial',
          _source: 'rawStat'
        };
      }

      // Tình huống 2d: Tạm hiển thị serverStat trong lúc đang đồng bộ
      if (serverStat) {
        return {
          ...serverStat,
          coverageStatus: 'partial',
          _source: 'serverStat'
        };
      }

      return {
        id: `${currentUser?.storeId}_${d}`,
        storeId: currentUser?.storeId || '',
        date: d,
        month: d.slice(0, 7),
        year: Number(d.slice(0, 4)),
        totalRevenue: 0,
        totalCash: 0,
        totalTransfer: 0,
        invoiceCount: 0,
        totalDiscount: 0,
        totalCost: 0,
        coverageStatus: 'missing',
        costStatus: 'missing',
        hasData: false,
        _source: 'empty'
      };
    });

    const totals: any = {
      totalRevenue: 0, totalCash: 0, totalTransfer: 0, invoiceCount: 0,
      totalDiscount: 0, totalCost: 0, totalIncome: 0, totalExpense: 0,
      cashExpense: 0, transferExpense: 0, cashIncome: 0, transferIncome: 0,
      expenseInventory: 0, expenseSalary: 0, expenseRent: 0, expenseOther: 0,
      salesCashIncome: 0, salesTransferIncome: 0
    };
    for (const stat of stats) {
      for (const key of Object.keys(totals)) {
        const value = stat[key as keyof DailyStats];
        if (typeof value === 'number' && Number.isFinite(value)) totals[key] += value;
      }
    }
    const sales = periodInvoices.filter(i => i.status !== 'cancelled');

    // Chỉ cho phép dùng totalRecomputedCost khi toàn bộ các ngày trong kỳ đều dùng nguồn raw
    // VÀ toàn bộ hóa đơn của kỳ đã được xác nhận đầy đủ từ máy chủ không bị phân trang dở
    const isEntirePeriodRawAndReady = reportDataReady && !hasMoreInvoices && periodInvoices.length > 0 && stats.every(s => s._source === 'rawStat');
    const isCostFullyResolved = isEntirePeriodRawAndReady && dates.every(day => rawReport.invoiceDays.has(day))
      && !hasAnyIncompleteInvoice && missingCostItems.length === 0;

    // Đánh giá trạng thái xác nhận theo từng chỉ tiêu độc lập cho từng ngày
    const isDayRevenueConfirmed = (d: string) => {
      if (isDayInRawInvoices(d)) return rawReport.invoiceDays.has(d);
      if (d === todayVietnam) return isInvoicesReady;
      const srv = statsByDate.get(d);
      return Boolean(srv && !(srv as any)._fromCache && dailyStatsReady && reconciledSource(srv, 'invoices'));
    };

    const isDayExpenseConfirmed = (d: string) => {
      if (isDayInRawCash(d)) return rawReport.cashDays.has(d);
      if (d === todayVietnam) return isInvoicesReady;
      const srv = statsByDate.get(d);
      return Boolean(srv && !(srv as any)._fromCache && dailyStatsReady && reconciledSource(srv, 'cash'));
    };

    const isDayCostConfirmed = (d: string) => {
      if (d === todayVietnam) {
        return isDayRevenueConfirmed(d) && !hasAnyIncompleteInvoice && missingCostItems.length === 0;
      }
      const s = stats.find(stat => stat.date === d);
      return isDayRevenueConfirmed(d) && verifiedDayCost(s);
    };

    const isRevenueComplete = dates.length > 0 && dates.every(isDayRevenueConfirmed);
    const isExpenseComplete = dates.length > 0 && dates.every(isDayExpenseConfirmed);
    const isCostComplete = dates.length > 0 && dates.every(isDayCostConfirmed);
    const isProfitComplete = isRevenueComplete && isExpenseComplete && isCostComplete;

    // Trạng thái đầy đủ theo từng phân hệ/tab
    let isComplete = false;
    if (activeTab === 'sales' || activeTab === 'items') {
      isComplete = isRevenueComplete;
    } else if (activeTab === 'cash') {
      isComplete = isExpenseComplete;
    } else if (activeTab === 'financial') {
      isComplete = isProfitComplete;
    } else {
      isComplete = isProfitComplete;
    }

    // Đánh giá ngày đã xác nhận chung: ngày đó phải có ít nhất 1 nguồn hợp lệ
    const isDayConfirmed = (stat: DailyStats & { _source: 'serverStat' | 'rawStat' | 'empty' }) =>
      stat._source !== 'empty' && isDayRevenueConfirmed(stat.date) && isDayExpenseConfirmed(stat.date);

    // Số ngày thiếu: Là những ngày không có nguồn dữ liệu nào được xác nhận (missing / empty)
    const missingDaysCount = stats.filter(s => !isDayConfirmed(s)).length;
    const reconciledDaysCount = stats.filter(s => s.coverageStatus === 'reconciled' || s.coverageStatus === 'zero_activity' || s.coverageStatus === 'live_tracking').length;
    const daysUsingServerStats = stats.filter(s => s._source === 'serverStat').length;
    const daysUsingRawStats = stats.filter(s => s._source === 'rawStat').length;

    // Trạng thái giá vốn toàn kỳ:
    const hasAnyCostEstimated = stats.some(s => s.costStatus === 'estimated');
    const calculatedCostStatus: 'complete' | 'estimated' | 'partial' = !isRevenueComplete ? 'partial'
      : isCostComplete ? 'complete' : hasAnyCostEstimated ? 'estimated' : 'partial';

    // Trạng thái đối soát toàn kỳ (coverageStatus):
    const isAllReconciledOrZero = stats.every(s => 
      s.coverageStatus === 'reconciled' || 
      s.coverageStatus === 'zero_activity' || 
      s.coverageStatus === 'live_tracking'
    );
    const isTodayConfirmed = isViewingTodayOnly && isRevenueComplete && isExpenseComplete && !hasAnyIncompleteInvoice && missingCostItems.length === 0;
    const calculatedCoverageStatus: 'reconciled' | 'partial' = (isProfitComplete || isTodayConfirmed) && !sourceMismatch && missingDaysCount === 0 && isAllReconciledOrZero
      ? 'reconciled'
      : 'partial';

    return {
      ...totals,
      totalCost: isCostFullyResolved ? totalRecomputedCost : totals.totalCost,
      hasExpenseBreakdown: true,
      costStatus: calculatedCostStatus,
      coverageStatus: calculatedCoverageStatus,
      isComplete,
      isRevenueComplete,
      isExpenseComplete,
      isCostComplete,
      isProfitComplete,
      missingDaysCount,
      reconciledDaysCount,
      daysUsingServerStats,
      daysUsingRawStats,
      daysWithSales: stats.filter(s => (s.invoiceCount || 0) > 0).length,
      daysWithCompleteCost: stats.filter(s => (s.invoiceCount || 0) > 0 && s.costStatus === 'complete').length,
      daysWithEstimatedCost: stats.filter(s => s.costStatus === 'estimated').length,
      daysWithMissingCost: stats.filter(s => s.costStatus === 'missing').length,
      zeroActivityDaysCount: stats.filter(s => !s.hasData && s.coverageStatus === 'zero_activity').length,
      daysUsingFallbackInvoices: 0,
      daysUsingFallbackCash: 0,
      isInvoicePartial: !isRevenueComplete,
      isCashPartial: !isExpenseComplete,
      hasSalesInStats: sales.length > 0 || totals.totalRevenue > 0,
      hasCostInStats: isCostComplete,
      hasExpenseInStats: totals.totalExpense > 0,
      hasIncomeInStats: totals.totalIncome > 0
    };
  }, [dailyStats, dailyStatsReady, statsPeriodKey, periodKey, periodInvoices, sourceCoverage, rawReport, reportDataReady, hasMoreInvoices, dateFilter, filterType, todayVietnam, currentUser?.storeId, sourceMismatch, hasAnyIncompleteInvoice, missingCostItems.length, totalRecomputedCost, activeTab]);

  const cashStats = useMemo(() => cashBookTotals(filteredCash, statsAggregates), [filteredCash, statsAggregates]);

  const renderedCashTransactions = useMemo(() => {
    let result = filteredCash;
    if (cashFilterType !== 'all') {
      result = result.filter(t => t.type === cashFilterType);
    }
    if (cashMethodFilter !== 'all') {
      result = result.filter(t => {
        const method = t.paymentMethod || 'cash';
        return method === cashMethodFilter;
      });
    }
    return result;
  }, [filteredCash, cashFilterType, cashMethodFilter]);

  const exportToExcel = async () => {
    if (!currentUser?.storeId || exportLock.current) return;
    const key = periodKey, requestId = activeRequestId.current;
    const dates = getExpectedPeriodDates(dateFilter, filterType, todayVietnam).filter(day => day <= todayVietnam);
    if (!dates.length) { alert('Vui lòng chọn kỳ hợp lệ.'); return; }
    exportLock.current = true; setIsExporting(true);
    try {
      let dataToExport: Record<string, any>[] = [], fileName = '';
      const current = () => key === currentPeriodRef.current && requestId === activeRequestId.current && activeTabRef.current === activeTab;
      if (activeTab === 'inventory') {
        const rows = (inventoryDataReady && !hasMoreLogs)
          ? filteredLogs
          : await fetchDateRangeRows<InventoryTransaction>('inventory_logs', currentUser.storeId, dates[0], dates[dates.length - 1]);
        if (!current()) throw new Error('Kỳ báo cáo đã thay đổi. Vui lòng xuất lại.');
        dataToExport = [...rows].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map(row => ({
          'Thời gian': safeFormatDate(row.date), 'Loại': row.type === 'import' ? 'Nhập hàng' : 'Trả hàng',
          'PTTT': row.paymentMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt', 'Mặt hàng': row.itemName,
          'Số lượng': row.quantity, 'Tổng tiền': row.totalPrice,
        }));
        fileName = `Bao_cao_kho_${dateFilter}_(toan_ky).xlsx`;
      } else {
        // Nếu đang xem 1 ngày và cả 2 nguồn chứng từ gốc đã được máy chủ xác nhận đầy đủ trong bộ nhớ (0 phân trang),
        // tái sử dụng trực tiếp để tiết kiệm 100% lượt đọc lặp mà vẫn kiểm tra toàn vẹn chéo receiptMismatch.
        const canReuseConfirmedMemory = filterType === 'day'
          && !hasMoreInvoices
          && !hasMoreCash
          && (isViewingTodayOnly
            ? Boolean(todaySourceEnabled && isInvoicesReady && rawReport.invoiceDays.has(todayVietnam) && rawReport.cashDays.has(todayVietnam))
            : Boolean(rawScope.periodKey === periodKey && rawScope.isFullPeriod && rawScope.invoicesConfirmed && rawScope.cashConfirmed));

        const sources = canReuseConfirmedMemory
          ? { invoices: periodInvoices.filter(i => i.status !== 'cancelled'), cash: sourcePeriodCash }
          : await fetchFinancialPeriodSources(currentUser.storeId, dates[0], dates[dates.length - 1]);
        if (!current()) throw new Error('Kỳ báo cáo đã thay đổi. Vui lòng xuất lại.');
        const invalidInvoice = sources.invoices.find(invoice => !validInvoiceAmount(invoice));
        const invalidCash = sources.cash.find(receipt => !validCashAmount(receipt));
        if (invalidInvoice) throw new Error(`Hóa đơn ${invalidInvoice.id} có số liệu không hợp lệ.`);
        if (invalidCash) throw new Error(`Phiếu thu/chi ${invalidCash.id} có số liệu không hợp lệ.`);
        const mismatch = receiptMismatch(sources.invoices, sources.cash);
        if (mismatch) throw new Error(mismatch);
        const invoices = [...sources.invoices].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
        if (activeTab === 'sales') {
          const search = invoiceSearch.trim().toLowerCase();
          dataToExport = invoices.filter(row => !search || [row.id, row.tableName, row.staffName].some(value => (value || '').toLowerCase().includes(search))).map(row => ({
            'Mã HĐ': row.id.toUpperCase(), 'Thời gian': safeFormatDate(row.date),
            'Bàn': row.tableName, 'Nhân viên': row.staffName, 'Tổng tiền': row.total,
            'PTTT': paymentMethodMap[row.paymentMethod] || row.paymentMethod || 'Tiền mặt', 'Ghi chú': row.note || '',
          }));
          fileName = `Bao_cao_hoa_don_${dateFilter}_(toan_ky).xlsx`;
        } else if (activeTab === 'cash') {
          dataToExport = sources.cash.filter(row => {
            const automatic = isSalesCategory(row.category) || row.category === 'Nhập hàng' || row.category === 'Trả hàng';
            return (isAdminOrManager || (row.staffId === currentUser.id && !automatic))
              && (cashFilterType === 'all' || row.type === cashFilterType)
              && (cashMethodFilter === 'all' || (row.paymentMethod || 'cash') === cashMethodFilter);
          }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map(row => ({
            'Thời gian': safeFormatDate(row.date), 'Loại': row.type === 'income' ? 'Thu' : 'Chi',
            'Hạng mục': row.category, 'Số tiền': row.amount, 'PTTT': paymentMethodMap[row.paymentMethod] || row.paymentMethod || 'Tiền mặt', 'Ghi chú': row.note || '',
          }));
          fileName = `So_quy_${dateFilter}_(toan_ky).xlsx`;
        } else if (activeTab === 'items') {
          const totals = new Map<string, { name: string; quantity: number; revenue: number }>();
          for (const invoice of invoices) {
            if (invoice.total > 0 && !invoice.items?.length) throw new Error('Có hóa đơn thiếu chi tiết món. Cần đối soát trước khi xuất thống kê món.');
            const revenues = allocatedItemRevenue(invoice);
            (invoice.items || []).forEach((item, index) => {
              const row = totals.get(item.id) || { name: item.name, quantity: 0, revenue: 0 };
              row.quantity += item.quantity; row.revenue += revenues[index]; totals.set(item.id, row);
            });
          }
          dataToExport = [...totals.values()].sort((a, b) => b.revenue - a.revenue).map(row => ({ 'Tên món': row.name, 'Số lượng bán': row.quantity, 'Doanh thu': row.revenue }));
          fileName = `Bao_cao_mon_ban_chay_${dateFilter}_(toan_ky).xlsx`;
        }
      }
      if (!dataToExport.length) { alert('Không có dữ liệu trong kỳ này để xuất Excel.'); return; }
      const sheet = XLSX.utils.json_to_sheet(dataToExport), book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Báo cáo');
      const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Không thể xác nhận đủ dữ liệu để xuất báo cáo.');
    } finally { exportLock.current = false; setIsExporting(false); }
  };

  const invoicesSum = periodInvoices.reduce((sum, inv) => sum + inv.total, 0);
  const totalSales = (statsAggregates && statsAggregates.totalRevenue > 0)
    ? statsAggregates.totalRevenue
    : (invoicesSum > 0 ? invoicesSum : (statsAggregates ? statsAggregates.totalRevenue : invoicesSum));
  const totalInvoicesCount = (statsAggregates && statsAggregates.invoiceCount > 0)
    ? statsAggregates.invoiceCount
    : (periodInvoices.length > 0 ? periodInvoices.length : (statsAggregates ? statsAggregates.invoiceCount : periodInvoices.length));

  const sampleSales = periodInvoices.reduce((sum, inv) => sum + inv.total, 0);
  const sampleCost = periodInvoices.reduce((sum, inv) => {
    if (typeof inv.totalCost === 'number') {
      return sum + inv.totalCost;
    }
    return sum + calculateInvoiceCost(inv.items || []);
  }, 0);

  // CỐ ĐỊNH GIÁ VỐN (COGS) VÀ LỢI NHUẬN: Ưu tiên dùng giá vốn thực tế đã tổng hợp từ daily_stats khi đầy đủ
  const isPeriodFullyLoadedFromRaw = Boolean(reportDataReady && !hasMoreInvoices && periodInvoices.length > 0 && (statsAggregates?.daysUsingServerStats === 0));
  let finalCost = 0;
  let isCostEstimated = false;
  let isCostUnavailable = false;
  let costEstimateReason = '';

  // 0a. Khi đang xem hôm nay: Tính trực tiếp từ công thức định lượng và hóa đơn live thời gian thực
  if (isViewingTodayOnly && totalRecomputedCost > 0) {
    finalCost = totalRecomputedCost;
    isCostEstimated = missingCostItems.length > 0 || hasAnyIncompleteInvoice;
    costEstimateReason = isCostEstimated
      ? (missingCostItems.length > 0 ? `Có ${missingCostItems.length} món chưa có giá vốn: ${missingCostItems.slice(0, 3).map(m => m.name).join(', ')}` : 'Một số món chưa chốt giá vốn')
      : '';
  }
  // 0b. Chỉ dùng totalRecomputedCost khi toàn bộ kỳ được nạp đầy đủ 100% từ chứng từ gốc đã xác nhận từ server
  else if (isPeriodFullyLoadedFromRaw && !hasAnyIncompleteInvoice && missingCostItems.length === 0) {
    finalCost = totalRecomputedCost;
    isCostEstimated = false;
    costEstimateReason = '';
  }
  // 1. Nếu daily_stats có giá vốn đầy đủ toàn bộ các ngày (costStatus === 'complete' và totalCost là số không âm)
  else if (statsAggregates && statsAggregates.costStatus === 'complete' && typeof statsAggregates.totalCost === 'number' && statsAggregates.totalCost >= 0) {
    finalCost = statsAggregates.totalCost;
    isCostEstimated = false;
    costEstimateReason = '';
  }
  // 2. Nếu daily_stats có giá vốn nhưng là ước tính (costStatus === 'estimated')
  else if (statsAggregates && statsAggregates.costStatus === 'estimated' && typeof statsAggregates.totalCost === 'number' && statsAggregates.totalCost >= 0) {
    if (isPeriodFullyLoadedFromRaw && !hasAnyIncompleteInvoice && missingCostItems.length === 0) {
      finalCost = totalRecomputedCost;
      isCostEstimated = false;
      costEstimateReason = '';
    } else {
      finalCost = statsAggregates.totalCost;
      isCostEstimated = true;
      costEstimateReason = missingCostItems.length > 0
        ? `Có ${missingCostItems.length} món chưa có giá vốn: ${missingCostItems.slice(0, 3).map(m => m.name).join(', ')}${missingCostItems.length > 3 ? '...' : ''}`
        : 'Một số ngày hoặc món hàng sử dụng giá vốn ước tính (chưa có định lượng chuẩn)';
    }
  }
  // 3. Nếu daily_stats có giá vốn một phần (costStatus === 'partial')
  else if (statsAggregates && statsAggregates.costStatus === 'partial' && typeof statsAggregates.totalCost === 'number' && statsAggregates.totalCost >= 0) {
    if (isPeriodFullyLoadedFromRaw && !hasAnyIncompleteInvoice && missingCostItems.length === 0) {
      finalCost = totalRecomputedCost;
      isCostEstimated = false;
      costEstimateReason = '';
    } else {
      finalCost = statsAggregates.totalCost;
      isCostEstimated = true;
      costEstimateReason = (statsAggregates.isInvoicePartial && hasMoreInvoices)
        ? `Mới tải ${periodInvoices.length} hóa đơn đầu tiên (chưa tải hết toàn kỳ)`
        : `Kỳ này còn ${(statsAggregates.missingDaysCount || 0) + (statsAggregates.daysWithMissingCost || 0)} ngày chưa đối soát đủ giá vốn`;
    }
  }
  // 4. Nếu daily_stats có ghi nhận totalCost > 0 nhưng rơi vào status khác (dữ liệu migrate hoặc legacy)
  // TUYỆT ĐỐI KHÔNG VỨT BỎ GIÁ VỐN ĐÃ BIẾT ĐỂ RƠI VỀ 35%!
  else if (statsAggregates && typeof statsAggregates.totalCost === 'number' && statsAggregates.totalCost > 0) {
    if (isPeriodFullyLoadedFromRaw && !hasAnyIncompleteInvoice && missingCostItems.length === 0) {
      finalCost = totalRecomputedCost;
      isCostEstimated = false;
      costEstimateReason = '';
    } else {
      finalCost = statsAggregates.totalCost;
      isCostEstimated = true;
      costEstimateReason = missingCostItems.length > 0
        ? `Có ${missingCostItems.length} món chưa có giá vốn: ${missingCostItems.slice(0, 3).map(m => m.name).join(', ')}${missingCostItems.length > 3 ? '...' : ''}`
        : 'Sử dụng tổng giá vốn đã ghi nhận trong hệ thống';
    }
  }
  // 5. Nếu đã tải toàn bộ hóa đơn chi tiết (hoặc đang xem hôm nay), dùng trực tiếp tổng giá vốn từ hóa đơn
  else if (periodInvoices.length > 0 && (!hasMoreInvoices || isViewingTodayOnly)) {
    finalCost = totalRecomputedCost > 0 ? totalRecomputedCost : sampleCost;
    if (missingCostItems.length > 0 || hasAnyIncompleteInvoice) {
      isCostEstimated = true;
      costEstimateReason = missingCostItems.length > 0
        ? `Có ${missingCostItems.length} món chưa có giá vốn: ${missingCostItems.slice(0, 3).map(m => m.name).join(', ')}${missingCostItems.length > 3 ? '...' : ''}`
        : 'Một số món bán chưa có giá vốn chuẩn xác từ nguyên liệu';
    } else {
      isCostEstimated = false;
      costEstimateReason = '';
    }
  }
  // 6. Nếu có mẫu hóa đơn nhưng chưa nạp hết (phân trang), ước tính theo tỷ lệ mẫu thực tế
  else if (sampleSales > 0 && sampleCost > 0) {
    const estimatedCogsRatio = sampleCost / sampleSales;
    finalCost = statsAggregates ? Math.round(totalSales * estimatedCogsRatio) : sampleCost;
    isCostEstimated = true;
    costEstimateReason = `Ước tính theo mẫu ${periodInvoices.length} HĐ (${(estimatedCogsRatio * 100).toFixed(1)}%)`;
  }
  else {
    isCostUnavailable = true;
    costEstimateReason = 'Chưa có dữ liệu giá vốn đủ để tính lợi nhuận';
  }
  finalCost = Math.max(0, finalCost);
  const totalCost = finalCost;
  const totalProfit = Math.round(totalSales - totalCost);

  // --- Financial Metrics ---
  const cogsPercentage = totalSales > 0 ? (totalCost / totalSales) * 100 : 0;
  const grossProfit = totalProfit;
  const grossMargin = totalSales > 0 ? (grossProfit / totalSales) * 100 : 0;

  // 1. Nhân sự (Labor Cost):
  // Ưu tiên 1: Bảng lương đã chốt của kỳ (periodPayrolls nạp độc lập từ Firestore)
  // Ưu tiên 2: props.payrollRecords nếu có
  const effectivePayrolls = periodPayrolls;
  const accruedPayrollTotal = effectivePayrolls.reduce((sum, p) => sum + (p.totalSalary || 0), 0);

  // Tính chi phí lương bằng tiền mặt từ cashTransactions / statsAggregates
  const cashSalaryExpense = statsAggregates?.expenseSalary !== undefined
    ? statsAggregates.expenseSalary
    : filteredCash.filter(t => t.type === 'expense' && (t.category.toLowerCase().includes('lương') || t.category.toLowerCase().includes('nhân sự') || t.category.toLowerCase().includes('nhân viên'))).reduce((sum, t) => sum + t.amount, 0);

  // NGUYÊN TẮC: Nếu đã có bảng lương chốt thì dùng bảng lương chốt (kế toán dồn tích);
  // Nếu chưa chốt bảng lương thì dùng phiếu chi lương thực tế; TUYỆT ĐỐI KHÔNG CỘNG CẢ HAI!
  let laborCost = financialCostBasis==='payroll' ? accruedPayrollTotal : cashSalaryExpense;

  // 2. Chi phí mặt bằng (Rent Cost):
  const cashRentExpense = statsAggregates?.expenseRent !== undefined
    ? statsAggregates.expenseRent
    : filteredCash.filter(t => t.type === 'expense' && (t.category.toLowerCase().includes('mặt bằng') || t.category.toLowerCase().includes('thuê nhà') || t.category.toLowerCase().includes('tiền nhà'))).reduce((sum, t) => sum + t.amount, 0);
  let rentCost = cashRentExpense;

  // 3. Chi phí vận hành khác (Other Operating Cost - điện, nước, dịch vụ...):
  // CRITICAL: KHÔNG BAO GỒM "Nhập hàng" vì chi phí hàng hóa đã được phản ánh 100% trong Giá vốn (COGS / totalCost).
  const cashOtherExpense = statsAggregates?.expenseOther !== undefined
    ? statsAggregates.expenseOther
    : filteredCash.filter(t => {
        if (t.type !== 'expense') return false;
        const cat = t.category.toLowerCase();
        const isInv = cat.includes('nhập hàng') || cat.includes('mua hàng') || cat.includes('nguyên liệu');
        const isRent = cat.includes('mặt bằng') || cat.includes('thuê nhà') || cat.includes('tiền nhà');
        const isSal = cat.includes('lương') || cat.includes('nhân sự') || cat.includes('nhân viên');
        return !isInv && !isRent && !isSal;
      }).reduce((sum, t) => sum + t.amount, 0);
  let otherOperatingCost = cashOtherExpense;

  // Monthly finalized payroll may be allocated across actual calendar days.
  // A cash payment already selected for this day must never be divided again.
  if (filterType === 'day' && financialCostBasis==='payroll') {
    const [year,month]=dateFilter.slice(0,7).split('-').map(Number);
    laborCost=accruedPayrollTotal/new Date(year,month,0).getDate();
  }

  // Alias để tương thích giao diện hiển thị
  const totalPayroll = laborCost;

  const laborCostPercentage = totalSales > 0 ? (totalPayroll / totalSales) * 100 : 0;
  const rentCostPercentage = totalSales > 0 ? (rentCost / totalSales) * 100 : 0;
  const otherCostPercentage = totalSales > 0 ? (otherOperatingCost / totalSales) * 100 : 0;

  const netProfit = grossProfit - totalPayroll - rentCost - otherOperatingCost;
  const netMargin = totalSales > 0 ? (netProfit / totalSales) * 100 : 0;
  // -------------------------

  const totalImport = filteredLogs.filter(l => l.type === 'import').reduce((sum, l) => sum + (l.totalPrice || 0), 0);
  const totalReturn = filteredLogs.filter(l => l.type === 'return').reduce((sum, l) => sum + (l.totalPrice || 0), 0);

  // Tự động liên kết số liệu thu chi theo bộ lọc (ngày, tháng, năm) để đối soát TIỀN MẶT và CHUYỂN KHOẢN
  // Đồng bộ 100% với cashStats, loại bỏ hoàn toàn khả năng lệch giữa thẻ tổng quan và Sổ quỹ
  const storePaymentStats = useMemo(() => {
    return {
      cashIncome: cashStats.periodCashIncome,
      cashExpense: cashStats.totalCashExpense,
      cashNet: cashStats.periodCashIncome - cashStats.totalCashExpense,
      transferIncome: cashStats.periodBankIncome,
      transferExpense: cashStats.totalTransferExpense,
      transferNet: cashStats.periodBankIncome - cashStats.totalTransferExpense
    };
  }, [cashStats]);

  const paginate = (data: any[]) => {
    const startIndex = (currentPage - 1) * rowsPerPage;
    return data.slice(startIndex, startIndex + rowsPerPage);
  };

  const totalPages = (data: any[]) => Math.ceil(data.length / rowsPerPage);

  const handleAddCash = async () => {
    if (!currentUser || !showAddCashModal || isSavingCash) return;
    if (!Number.isFinite(newCash.amount) || newCash.amount <= 0) { alert('Số tiền phải lớn hơn 0.'); return; }
    const category=newCash.category.trim() || (showAddCashModal==='income'?'Thu khác':'Chi khác');
    if(isSalesCategory(category)) {alert('Thu bán hàng được tạo từ hóa đơn. Hãy chọn hạng mục thu khác cho khoản thu thủ công.');return;}
    const signature=JSON.stringify({...newCash,category,type:showAddCashModal});
    if(cashOperationRef.current?.signature!==signature)cashOperationRef.current={id:operationId('cash'),date:new Date().toISOString(),signature};
    setIsSavingCash(true);
    try {
      await onAddCashTransaction({date:cashOperationRef.current!.date,type:showAddCashModal,amount:newCash.amount,paymentMethod:newCash.paymentMethod,category,note:newCash.note,staffId:currentUser.id,staffName:currentUser.name},cashOperationRef.current!.id);
      setShowAddCashModal(null);setNewCash({amount:0,paymentMethod:'cash',category:'',note:''});cashOperationRef.current=null;
    } catch(error) {alert(error instanceof Error?error.message:'Không thể lưu phiếu. Nội dung đã được giữ để thử lại.');}
    finally {setIsSavingCash(false);}
  };

  const isSummaryDataReady = activeTab === 'inventory' ? inventoryDataReady
    : activeTab === 'items' ? Boolean(statsAggregates?.isRevenueComplete && expectedReportDates.every(day => sourceCoverage.invoiceDays.has(day)))
    : activeTab === 'financial' ? Boolean(statsAggregates?.isProfitComplete && (financialCostBasis !== 'payroll' || payrollDataReady))
    : activeTab === 'cash' ? Boolean(statsAggregates?.isRevenueComplete && statsAggregates?.isExpenseComplete)
    : Boolean(statsAggregates?.isRevenueComplete);

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto">
      {isAdmin && activeTab==='items'&&periodInvoices.some(i=>i.total>0&&!i.items?.length)&&<div role="alert" className="p-3 rounded-xl bg-amber-500/10 text-amber-700">Có hóa đơn thiếu chi tiết món. Thống kê theo món chưa đầy đủ; cần đối soát hóa đơn gốc.</div>}
      {isAdminOrManager && (rawReport.issues.length > 0 || sourceMismatch) && (
        <details className="p-3 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300" open>
          <summary>Chứng từ cần đối soát</summary>
          <ul className="list-disc pl-5 max-h-48 overflow-auto">
            {[...rawReport.issues, ...[...rawReport.receiptIssues].map(([day, issue]) => `${day} · ${issue}`)].map((issue, index) => <li key={index}>{issue}</li>)}
          </ul>
        </details>
      )}
      {isAdmin && (!isSummaryDataReady || reportError) && <div role="status" className="p-3 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300">{reportError || 'Đang đồng bộ dữ liệu từ máy chủ. Số liệu dưới đây chưa được xác nhận đầy đủ; chưa thể xuất báo cáo.'}</div>}
      {isAdmin && activeTab === 'financial' && <div className="text-sm text-gray-500">Lợi nhuận dùng doanh thu gồm VAT theo hóa đơn; doanh thu món là trước VAT, sau giảm giá. Lương: {financialCostBasis==='payroll' ? 'tạm tính theo các bảng lương đã chốt; chưa bao gồm nhân viên chưa chốt, phân bổ theo ngày khi xem ngày' : 'theo phiếu chi lương thực tế trong kỳ'}. {financialCostBasis==='payroll'&&!payrollDataReady ? 'Bảng lương đang đồng bộ.' : ''}<select className="ml-2 rounded border bg-transparent p-1" value={financialCostBasis} onChange={event=>setFinancialCostBasis(event.target.value as 'cash'|'payroll')}><option value="cash">Chi lương thực tế</option><option value="payroll">Bảng lương đã chốt (tạm tính)</option></select></div>}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
            {isAdmin ? 'Tổng kết & Báo cáo' : 'Hóa đơn & In ấn'}
          </h3>
          {isAdminOrManager && activeOrdersCount > 0 && (
            <div className="px-3 py-1 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
              <span className="text-xs text-amber-600 dark:text-amber-500 font-bold">Đang phục vụ: {activeOrdersCount} đơn</span>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {isAdminOrManager && (
            <button 
              onClick={exportToExcel}
              disabled={isExporting}
              className="flex items-center gap-2 px-4 py-2 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-sm hover:bg-black/10 dark:hover:bg-white/10 transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" /> Xuất Excel
            </button>
          )}
        </div>
      </div>

      {activeTab === 'cash' ? (
        isAdminOrManager ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
              <p className="text-xs text-gray-500 uppercase font-bold">Số dư đầu kỳ chưa đối soát</p>
              <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-gray-600 dark:text-gray-400">Chưa đối soát</p>
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
              <p className="text-xs text-gray-500 uppercase font-bold">Thu − chi trong kỳ</p>
              <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-blue-600 dark:text-blue-500">{cashStats.closingBalance.toLocaleString('vi-VN')}đ</p>
            </div>
          </div>
        ) : null
      ) : isAdminOrManager ? (
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
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500 uppercase font-bold">Doanh thu bán hàng</p>
              {statsAggregates?.coverageStatus === 'partial' && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 font-medium">
                  {statsAggregates.isInvoicePartial && hasMoreInvoices ? `Chưa tải hết (${periodInvoices.length} HĐ)` : 'Chưa đủ kỳ'}
                </span>
              )}
            </div>
            <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-emerald-600 dark:text-emerald-500">{Math.round(totalSales).toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ</p>
            <p className="text-xs text-gray-600 dark:text-gray-400">{totalInvoicesCount} hóa đơn {hasMoreInvoices && statsAggregates?.isInvoicePartial ? '(còn hóa đơn trên hệ thống)' : statsAggregates?.missingDaysCount ? `(thiếu ${statsAggregates.missingDaysCount} ngày)` : ''}</p>
          </div>
          )}
          {isAdminOrManager && (
            <>
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500 uppercase font-bold">Lợi nhuận gộp</p>
                  {isCostEstimated && (
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      {missingCostItems.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowMissingCostModal(true)}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/15 hover:bg-rose-500/25 text-rose-600 dark:text-rose-400 border border-rose-500/30 font-bold flex items-center gap-1 transition-all cursor-pointer animate-pulse"
                          title={`Có ${missingCostItems.length} món chưa có giá vốn. Bấm để xem danh sách chi tiết.`}
                        >
                          <AlertTriangle className="w-3 h-3 text-rose-500" />
                          <span>{missingCostItems.length} món thiếu vốn</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => missingCostItems.length > 0 && setShowMissingCostModal(true)}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 font-medium cursor-pointer hover:bg-amber-500/20 transition-all"
                        title={costEstimateReason}
                      >
                        Ước tính
                      </button>
                    </div>
                  )}
                  {!isCostEstimated && totalSales > 0 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-medium flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      {isSyncingCosts ? 'Đang lưu vào HĐ...' : 'Chuẩn xác'}
                    </span>
                  )}
                </div>
                <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-blue-600 dark:text-blue-500">{isCostUnavailable ? '—' : `${Math.round(totalProfit).toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ`}</p>
                <p className="text-xs text-gray-600 dark:text-gray-400">Tỷ suất: {isCostUnavailable ? 'chưa đối soát giá vốn' : `${totalSales > 0 ? ((totalProfit / totalSales) * 100).toFixed(1) : 0}%`}</p>
              </div>
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500 uppercase font-bold flex items-center gap-1.5">
                    <Banknote className="w-4 h-4 text-emerald-500" />
                    TIỀN MẶT
                  </p>
                  <span className={cn(
                    "text-[10px] font-semibold px-2 py-0.5 rounded-full",
                    hasMoreCash && statsAggregates?.isCashPartial 
                      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20" 
                      : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  )}>
                    {hasMoreCash && statsAggregates?.isCashPartial ? 'Chưa tải hết sổ quỹ' : 'Thu - Chi'}
                  </span>
                </div>
                <p className={cn(
                  "text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold",
                  storePaymentStats.cashNet >= 0 ? "text-emerald-600 dark:text-emerald-500" : "text-rose-600 dark:text-rose-500"
                )}>
                  {Math.round(storePaymentStats.cashNet).toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ
                </p>
                <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 font-mono pt-1 border-t border-black/5 dark:border-white/5">
                  <span className="text-emerald-600 dark:text-emerald-500 font-medium">Thu: +{Math.round(storePaymentStats.cashIncome).toLocaleString('vi-VN')}đ</span>
                  <span className="text-rose-600 dark:text-rose-500 font-medium">Chi: -{Math.round(storePaymentStats.cashExpense).toLocaleString('vi-VN')}đ</span>
                </div>
              </div>
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-500 uppercase font-bold flex items-center gap-1.5">
                    <CreditCard className="w-4 h-4 text-blue-500" />
                    CHUYỂN KHOẢN
                  </p>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    Thu - Chi
                  </span>
                </div>
                <p className={cn(
                  "text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold",
                  storePaymentStats.transferNet >= 0 ? "text-blue-600 dark:text-blue-500" : "text-rose-600 dark:text-rose-500"
                )}>
                  {Math.round(storePaymentStats.transferNet).toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ
                </p>
                <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 font-mono pt-1 border-t border-black/5 dark:border-white/5">
                  <span className="text-emerald-600 dark:text-emerald-500 font-medium">Thu: +{Math.round(storePaymentStats.transferIncome).toLocaleString('vi-VN')}đ</span>
                  <span className="text-rose-600 dark:text-rose-500 font-medium">Chi: -{Math.round(storePaymentStats.transferExpense).toLocaleString('vi-VN')}đ</span>
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* Thông báo chi tiết các món chưa có giá vốn - Chỉ hiển thị cho tài khoản Quản trị viên (Admin) */}
      {isAdmin && isCostEstimated && missingCostItems.length > 0 && (
        <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-xs text-amber-900 dark:text-amber-300 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="p-2 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
              <AlertTriangle className="w-5 h-5" />
            </span>
            <div className="space-y-1.5">
              <div className="font-bold text-sm text-amber-950 dark:text-amber-200 flex items-center gap-2 flex-wrap">
                <span>Phát hiện {missingCostItems.length} món bán trong kỳ chưa có giá vốn</span>
                <span className="text-[11px] font-normal px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-900 dark:text-amber-300 border border-amber-500/30">
                  Giá vốn đang tính 0đ &rarr; Lợi nhuận gộp bị [Ước tính]
                </span>
              </div>
              <p className="text-amber-800/90 dark:text-amber-300/80 leading-relaxed">
                Các món dưới đây chưa được cài đặt giá vốn trực tiếp hoặc nguyên liệu kho chưa có giá nhập. Vui lòng bổ sung để số liệu lợi nhuận chuẩn xác 100%:
              </p>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {missingCostItems.slice(0, 6).map(m => (
                  <span key={m.id || m.name} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-black/5 dark:bg-white/10 font-medium text-gray-900 dark:text-white border border-black/5 dark:border-white/10 text-xs">
                    <span>{m.name}</span>
                    <span className="opacity-70 font-mono text-[10px]">({m.quantitySold} suất)</span>
                  </span>
                ))}
                {missingCostItems.length > 6 && (
                  <span className="text-gray-500 dark:text-gray-400 font-medium italic text-xs self-center">
                    +{missingCostItems.length - 6} món khác...
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
            <button
              type="button"
              onClick={() => setShowMissingCostModal(true)}
              className="px-3 py-2 bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-gray-900 dark:text-white font-bold rounded-xl transition-all cursor-pointer text-xs"
            >
              Xem danh sách ({missingCostItems.length})
            </button>
            {onNavigateToMenu && isAdminOrManager && (
              <button
                type="button"
                onClick={onNavigateToMenu}
                className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white font-bold rounded-xl transition-all flex items-center gap-1.5 cursor-pointer text-xs shadow-sm shadow-emerald-500/20"
              >
                <span>Bổ sung giá vốn</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {isAdmin && statsAggregates?.coverageStatus === 'partial' && (
        <div className="p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-xs text-amber-700 dark:text-amber-400 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-base">⚠️</span>
            <span>
              <strong>Dữ liệu chưa đối soát đủ:</strong> {
                (statsAggregates?.missingDaysCount ?? 0) > 0 
                  ? <>Kỳ này còn <strong>{statsAggregates.missingDaysCount}</strong> ngày chưa có dữ liệu tổng hợp. Số liệu đang được kết hợp từ chứng từ đã tải.</>
                  : (hasMoreInvoices || hasMoreCash)
                    ? <>Chứng từ kỳ này chưa tải hết ({statsAggregates?.isInvoicePartial && hasMoreInvoices ? 'còn hóa đơn' : ''}{statsAggregates?.isInvoicePartial && hasMoreInvoices && statsAggregates?.isCashPartial && hasMoreCash ? ', ' : ''}{statsAggregates?.isCashPartial && hasMoreCash ? 'còn sổ quỹ' : ''} trên hệ thống). Số liệu đang tính trên trang đầu tiên.</>
                    : <>Một số chứng từ chưa được xác nhận đầy đủ từ máy chủ.</>
              }
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {((statsAggregates?.missingDaysCount ?? 0) > 0) && (
              <button
                type="button"
                disabled={isReconcilingMissingDays}
                onClick={handleReconcileMissingDays}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
              >
                {isReconcilingMissingDays ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>Chốt đối soát {statsAggregates?.missingDaysCount} ngày thiếu</span>
              </button>
            )}
            {hasMoreInvoices && (
              <button
                type="button"
                disabled={isLoadingMoreInvoices}
                onClick={handleLoadAllInvoices}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
              >
                {isLoadingMoreInvoices ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>Tải toàn bộ kỳ để đối soát</span>
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-4 items-center bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 p-4 rounded-2xl">
        {isAdminOrManager && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1.5 p-1 bg-gray-100 dark:bg-black/20 rounded-xl">
              {(['day', 'month', 'year'] as const).filter(t => t === 'day' || !isHistoryLimitedToDaily).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setFilterType(t);
                    setCurrentPage(1);
                    if (t === 'month') {
                      setDateFilter(prev => prev.slice(0, 7));
                    } else if (t === 'year') {
                      setDateFilter(prev => `${prev.slice(0, 4)}-01-01`);
                    } else {
                      setDateFilter(prev => {
                        if (prev.length === 10) return prev;
                        if (prev.length === 7) return `${prev}-01`;
                        return `${prev.slice(0, 4)}-01-01`;
                      });
                    }
                  }}
                  className={cn(
                    "px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer",
                    filterType === t ? "bg-emerald-500 text-white shadow-sm" : "text-gray-500 hover:text-gray-900 dark:hover:text-white"
                  )}
                >
                  {t === 'day' ? 'Theo ngày' : t === 'month' ? 'Theo tháng' : 'Theo năm'}
                </button>
              ))}
            </div>

            {/* Phím tắt chọn nhanh kỳ báo cáo */}
            <div className="flex items-center gap-1 text-xs">
              {filterType === 'day' && (
                <>
                  <button
                    type="button"
                    onClick={() => { setDateFilter(todayVietnam); setCurrentPage(1); }}
                    className={cn(
                      "px-2.5 py-1.5 rounded-lg font-medium transition-all cursor-pointer",
                      dateFilter === todayVietnam 
                        ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold border border-emerald-500/30" 
                        : "bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400"
                    )}
                  >
                    Hôm nay
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const yStr = getVietnamYesterdayDate(todayVietnam);
                      setDateFilter(yStr);
                      setCurrentPage(1);
                    }}
                    className={cn(
                      "px-2.5 py-1.5 rounded-lg font-medium transition-all cursor-pointer",
                      dateFilter === getVietnamYesterdayDate(todayVietnam)
                        ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold border border-emerald-500/30"
                        : "bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400"
                    )}
                  >
                    Hôm qua
                  </button>
                </>
              )}
              {filterType === 'month' && (
                <button
                  type="button"
                  onClick={() => { setDateFilter(todayVietnam.slice(0, 7)); setCurrentPage(1); }}
                  className={cn(
                    "px-2.5 py-1.5 rounded-lg font-medium transition-all cursor-pointer",
                    dateFilter.slice(0, 7) === todayVietnam.slice(0, 7)
                      ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold border border-emerald-500/30"
                      : "bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400"
                  )}
                >
                  Tháng này
                </button>
              )}
              {filterType === 'year' && (
                <button
                  type="button"
                  onClick={() => { setDateFilter(`${todayVietnam.slice(0, 4)}-01-01`); setCurrentPage(1); }}
                  className={cn(
                    "px-2.5 py-1.5 rounded-lg font-medium transition-all cursor-pointer",
                    dateFilter.slice(0, 4) === todayVietnam.slice(0, 4)
                      ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 font-bold border border-emerald-500/30"
                      : "bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400"
                  )}
                >
                  Năm nay
                </button>
              )}
            </div>
          </div>
        )}
        <div className="relative flex-1 w-full">
          <input 
            type={filterType === 'day' ? 'date' : filterType === 'month' ? 'month' : 'number'}
            className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 pr-32 font-medium"
            value={filterType === 'year' ? dateFilter.slice(0, 4) : filterType === 'month' ? dateFilter.slice(0, 7) : dateFilter.slice(0, 10)}
            onChange={(e) => {
              let val = e.target.value;
              if (filterType === 'year') {
                setDateFilter(val ? `${val}-01-01` : `${new Date().getFullYear()}-01-01`);
              } else {
                if (filterType === 'day' && val > todayVietnam) {
                  val = todayVietnam;
                } else if (filterType === 'month' && val > todayVietnam.slice(0, 7)) {
                  val = todayVietnam.slice(0, 7);
                }
                setDateFilter(val);
              }
              setCurrentPage(1);
            }}
            min={filterType === 'year' ? 2020 : undefined}
            max={filterType === 'year' ? 2030 : filterType === 'month' ? todayVietnam.slice(0, 7) : todayVietnam}
            placeholder={filterType === 'year' ? 'Nhập năm (VD: 2026)' : ''}
          />
          {isLoadingHistorical && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1.5 bg-amber-500/10 px-2 py-0.5 rounded-md">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
              Đang tải...
            </span>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex gap-4 border-b border-black/5 dark:border-white/5 overflow-x-auto no-scrollbar">
          <button 
            onClick={() => { setActiveTab('sales'); setCurrentPage(1); }}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2 whitespace-nowrap",
              activeTab === 'sales' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            Hóa đơn bán hàng
          </button>
          {isAdminOrManager && (
            <>
              <button 
                onClick={() => { setActiveTab('inventory'); setCurrentPage(1); }}
                className={cn(
                  "pb-4 px-2 text-sm font-bold transition-all border-b-2 whitespace-nowrap",
                  activeTab === 'inventory' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                Nhập / Trả hàng
              </button>
              <button 
                onClick={() => { setActiveTab('items'); setCurrentPage(1); }}
                className={cn(
                  "pb-4 px-2 text-sm font-bold transition-all border-b-2 whitespace-nowrap",
                  activeTab === 'items' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                Món bán chạy
              </button>
            </>
          )}
          
          <button 
            onClick={() => { setActiveTab('cash'); setCurrentPage(1); }}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2 whitespace-nowrap",
              activeTab === 'cash' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            Sổ quỹ
          </button>
          {isAdminOrManager && isFinancialReportsUnlocked && (
          <button 
            onClick={() => { setActiveTab('financial'); setCurrentPage(1); }}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2 whitespace-nowrap",
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
              disabled={isExporting}
              className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 text-emerald-600 dark:text-emerald-500 border border-emerald-500/30 rounded-lg hover:bg-emerald-500/30 transition-all font-bold"
            >
              Xuất Excel
            </button>
            )}
            {activeTab === 'sales' && (
              <div className="relative">
                <input 
                  type="text"
                  placeholder={hasMoreInvoices ? `Tìm trong ${filteredInvoices.length} HĐ đã nạp...` : "Tìm bàn, mã HĐ..."}
                  value={invoiceSearch}
                  onChange={(e) => { setInvoiceSearch(e.target.value); setCurrentPage(1); }}
                  className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg px-3 py-1.5 text-xs text-gray-900 dark:text-white placeholder-gray-400 outline-none focus:border-emerald-500 w-48 sm:w-64"
                />
                {invoiceSearch && (
                  <button 
                    onClick={() => setInvoiceSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xs"
                  >
                    ×
                  </button>
                )}
              </div>
            )}
            {activeTab === 'cash' && (
              <div className="flex items-center gap-2">
                <select
                  className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded px-2 py-1 outline-none text-gray-900 dark:text-white text-xs"
                  value={cashFilterType}
                  onChange={(e) => { setCashFilterType(e.target.value as any); setCurrentPage(1); }}
                >
                  <option value="all" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Tất cả Thu/Chi</option>
                  <option value="income" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Chỉ phiếu Thu</option>
                  <option value="expense" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Chỉ phiếu Chi</option>
                </select>
                <select
                  className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded px-2 py-1 outline-none text-gray-900 dark:text-white text-xs"
                  value={cashMethodFilter}
                  onChange={(e) => { setCashMethodFilter(e.target.value as any); setCurrentPage(1); }}
                >
                  <option value="all" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Tất cả PTTT</option>
                  <option value="cash" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Chỉ Tiền mặt</option>
                  <option value="transfer" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">Chỉ Chuyển khoản</option>
                </select>
              </div>
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
                    <th className="px-6 py-4 font-medium text-center">PTTT</th>
                    <th className="px-6 py-4 font-medium text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {filteredInvoices.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-gray-500 italic">Không có dữ liệu hóa đơn</td>
                    </tr>
                  ) : (
                    paginate(filteredInvoices).map(inv => (
                      <tr key={inv.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                        <td className="px-6 py-4 font-mono text-xs text-gray-600 dark:text-gray-400 font-bold">{inv.id.substr(-6).toUpperCase()}</td>
                        <td className="px-6 py-4 text-sm">{safeFormatDate(inv.completedAt || inv.date)}</td>
                        <td className="px-6 py-4 text-sm font-semibold text-gray-900 dark:text-white">
                          <div>{inv.tableName}</div>
                          {inv.note && (
                            <div className="text-[11px] text-amber-600 dark:text-amber-400 font-normal italic mt-0.5">
                              {inv.note}
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm">{inv.staffName}</td>
                        <td className="px-6 py-4 text-center">
                          <span className="px-2 py-1 bg-black/5 dark:bg-white/5 rounded text-[10px] uppercase font-medium">{paymentMethodMap[inv.paymentMethod as keyof typeof paymentMethodMap] || inv.paymentMethod}</span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button 
                              title="In hóa đơn cho khách"
                              onClick={() => handlePrintInvoice(inv)}
                              className="px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
                            >
                              <Printer className="w-3.5 h-3.5" />
                              <span>In HĐ</span>
                            </button>
                            {isAdmin && (
                              <button 
                                title="Xem chi tiết hóa đơn"
                                onClick={() => handleViewInvoice(inv)}
                                disabled={loadingInvoiceDetailId === inv.id}
                                className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 rounded-lg transition-all cursor-pointer disabled:opacity-50"
                              >
                                {loadingInvoiceDetailId === inv.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            )}
                            {isAdmin && (
                              <button 
                                title="Xóa hóa đơn bán hàng"
                                onClick={() => setConfirmDeleteInvoice(inv)}
                                className="p-1.5 text-rose-500 hover:text-rose-600 hover:bg-rose-500/10 dark:hover:bg-rose-500/20 rounded-lg transition-all cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
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
            {hasMoreInvoices && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-black/5 dark:bg-white/5 rounded-xl border border-black/10 dark:border-white/10 text-xs mt-3">
                <span className="text-gray-500">
                  Phạm vi: Đang hiển thị <strong className="text-gray-900 dark:text-white font-mono">{filteredInvoices.length}</strong> hóa đơn gần nhất trong kỳ. Còn hóa đơn cũ hơn trên hệ thống.
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isLoadingMoreInvoices}
                    onClick={handleLoadMoreInvoices}
                    className="px-3 py-1.5 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 text-gray-900 dark:text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isLoadingMoreInvoices ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    <span>Tải thêm 30 HĐ</span>
                  </button>
                  <button
                    type="button"
                    disabled={isLoadingMoreInvoices}
                    onClick={handleLoadAllInvoices}
                    className="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isLoadingMoreInvoices ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    <span>Tải toàn bộ kỳ</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : activeTab === 'inventory' ? (
          <div className="space-y-4">
            {/* Thẻ thống kê tổng nhập / trả kho kèm nhãn phạm vi */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-4">
                <span className="text-xs text-gray-500 font-medium">Tổng tiền nhập hàng</span>
                <div className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-500 mt-1">
                  {totalImport.toLocaleString('vi-VN')}đ
                </div>
                <span className="text-[10px] text-gray-400 mt-0.5 block">
                  Phạm vi: {filteredLogs.filter(l => l.type === 'import').length} phiếu {hasMoreLogs ? '(theo phiếu đã tải)' : '(toàn kỳ)'}
                </span>
              </div>
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-4">
                <span className="text-xs text-gray-500 font-medium">Tổng tiền trả hàng</span>
                <div className="text-lg font-bold font-mono text-rose-600 dark:text-rose-500 mt-1">
                  {totalReturn.toLocaleString('vi-VN')}đ
                </div>
                <span className="text-[10px] text-gray-400 mt-0.5 block">
                  Phạm vi: {filteredLogs.filter(l => l.type === 'return').length} phiếu {hasMoreLogs ? '(theo phiếu đã tải)' : '(toàn kỳ)'}
                </span>
              </div>
              <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-4">
                <span className="text-xs text-gray-500 font-medium">Tổng số phiếu kho</span>
                <div className="text-lg font-bold font-mono text-gray-900 dark:text-white mt-1">
                  {filteredLogs.length} phiếu
                </div>
                <span className="text-[10px] text-gray-400 mt-0.5 block">
                  {hasMoreLogs ? 'Chưa tải hết toàn bộ kỳ' : 'Đầy đủ toàn bộ kỳ'}
                </span>
              </div>
            </div>

            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                    <th className="px-6 py-4 font-medium">Thời gian</th>
                    <th className="px-6 py-4 font-medium">Loại</th>
                    <th className="px-6 py-4 font-medium">PTTT</th>
                    <th className="px-6 py-4 font-medium">Mặt hàng</th>
                    <th className="px-6 py-4 font-medium text-right">Số lượng</th>
                    <th className="px-6 py-4 font-medium text-right">Tổng tiền</th>
                    <th className="px-6 py-4 font-medium text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {filteredLogs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-gray-500 italic">Không có dữ liệu nhập/trả hàng</td>
                    </tr>
                  ) : (
                    paginate(filteredLogs).map(log => (
                      <tr key={log.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                        <td className="px-6 py-4 text-sm">{safeFormatDate(log.date)}</td>
                        <td className="px-6 py-4">
                          <span className={cn(
                            "px-2 py-1 rounded text-[10px] uppercase font-bold",
                            log.type === 'import' ? "bg-amber-500/20 text-amber-600 dark:text-amber-500" : "bg-rose-500/20 text-rose-600 dark:text-rose-500"
                          )}>
                            {log.type === 'import' ? 'Nhập hàng' : 'Trả hàng'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          {log.paymentMethod === 'transfer' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                              <CreditCard className="w-3 h-3" />
                              Chuyển khoản
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                              <Banknote className="w-3 h-3" />
                              Tiền mặt
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">{log.itemName}</td>
                        <td className="px-6 py-4 text-right font-mono">{log.quantity.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</td>
                        <td className="px-6 py-4 text-right font-mono font-bold">{Math.round(log.totalPrice || 0).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}đ</td>
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
            {hasMoreLogs && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-black/5 dark:bg-white/5 rounded-xl border border-black/10 dark:border-white/10 text-xs mt-3">
                <span className="text-gray-500">
                  Phạm vi: Đang hiển thị <strong className="text-gray-900 dark:text-white font-mono">{filteredLogs.length}</strong> phiếu kho gần nhất trong kỳ. Còn phiếu kho cũ hơn.
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isLoadingMoreLogs}
                    onClick={handleLoadMoreLogs}
                    className="px-3 py-1.5 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 text-gray-900 dark:text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isLoadingMoreLogs ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    <span>Tải thêm 50 phiếu</span>
                  </button>
                  <button
                    type="button"
                    disabled={isLoadingMoreLogs}
                    onClick={handleLoadAllLogs}
                    className="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isLoadingMoreLogs ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    <span>Tải toàn bộ kỳ</span>
                  </button>
                </div>
              </div>
            )}
          </div>

        ) : activeTab === 'financial' ? (
          <div className="space-y-6">
            {isCostEstimated && (
              <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-xs text-amber-700 dark:text-amber-400 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-base">⚠️</span>
                  <span><strong>Lưu ý về giá vốn:</strong> {costEstimateReason}. Số liệu lợi nhuận hiển thị dưới đây là ước tính, chưa phải số liệu thực tế đã đối soát hoàn tất.</span>
                </div>
                {hasMoreInvoices && (
                  <button
                    type="button"
                    disabled={isLoadingMoreInvoices}
                    onClick={handleLoadMoreInvoices}
                    className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isLoadingMoreInvoices ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Đang tải...</span>
                      </>
                    ) : (
                      <span>Tải thêm hóa đơn để tính chuẩn</span>
                    )}
                  </button>
                )}
              </div>
            )}
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
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-sm text-gray-500">Giá vốn (COGS) <span className="text-xs">({cogsPercentage.toFixed(1)}%)</span></p>
                      {isCostEstimated && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 font-medium">
                          Ước tính
                        </span>
                      )}
                    </div>
                    <p className="text-lg md:text-xl lg:text-2xl font-mono truncate font-bold text-rose-600 dark:text-rose-500">-{totalCost.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ</p>
                  </div>
                </div>
                <div className="pt-4 border-t border-black/5 dark:border-white/5 flex justify-between items-center">
                  <p className="text-gray-600 dark:text-gray-400">Lợi nhuận gộp ({grossMargin.toFixed(1)}%)</p>
                  <p className={cn("text-xl md:text-2xl lg:text-3xl font-mono font-bold truncate", grossMargin >= 65 ? "text-blue-600 dark:text-blue-500" : "text-amber-600 dark:text-amber-500")}>
                    {isCostUnavailable ? '—' : `${grossProfit.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ`}
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
                  <p className="text-gray-600 dark:text-gray-400">Lợi nhuận ròng {financialCostBasis==='payroll'?'tạm tính ':''}({netMargin.toFixed(1)}%)</p>
                  <p className={cn("text-xl md:text-2xl lg:text-3xl font-mono font-bold truncate", netMargin >= 15 ? "text-emerald-600 dark:text-emerald-500" : netMargin > 0 ? "text-amber-600 dark:text-amber-500" : "text-rose-600 dark:text-rose-500")}>
                    {isCostUnavailable ? '—' : `${netProfit.toLocaleString('vi-VN', { maximumFractionDigits: 0 })}đ`}
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
            {hasMoreInvoices && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-700 dark:text-amber-400 flex flex-col sm:flex-row items-center justify-between gap-3">
                <span>
                  ℹ️ Báo cáo món bán chạy đang được tổng hợp từ <strong>{filteredInvoices.length}</strong> hóa đơn đã tải (chưa tải hết toàn kỳ).
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isLoadingMoreInvoices}
                    onClick={handleLoadMoreInvoices}
                    className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-900 dark:text-amber-200 font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    <span>Tải thêm 30 HĐ</span>
                  </button>
                  <button
                    type="button"
                    disabled={isLoadingMoreInvoices}
                    onClick={handleLoadAllInvoices}
                    className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isLoadingMoreInvoices ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    <span>Tải toàn bộ kỳ để xem 100% món bán</span>
                  </button>
                </div>
              </div>
            )}
            {/* Bộ lọc xem tất cả món hoặc chỉ xem món thiếu giá vốn */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOnlyShowMissingCostItems(false);
                    setCurrentPage(1);
                  }}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer",
                    !onlyShowMissingCostItems
                      ? "bg-emerald-500 text-white shadow-sm"
                      : "bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                  )}
                >
                  Tất cả món ({sortedItemSales.length})
                </button>
                {isAdmin && missingCostItems.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setOnlyShowMissingCostItems(true);
                      setCurrentPage(1);
                    }}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5",
                      onlyShowMissingCostItems
                        ? "bg-rose-500 text-white shadow-sm"
                        : "bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 border border-rose-500/20"
                    )}
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Món chưa có giá vốn ({missingCostItems.length})</span>
                  </button>
                )}
              </div>
              {isAdmin && missingCostItems.length > 0 && onNavigateToMenu && (
                <button
                  type="button"
                  onClick={onNavigateToMenu}
                  className="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white font-bold rounded-lg text-xs transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
                >
                  <span>Cập nhật trong Thực đơn</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

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
                  {displayedItemSales.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-6 py-12 text-center text-gray-500 italic">
                        {onlyShowMissingCostItems ? 'Tất cả các món đã bán đều có đầy đủ giá vốn!' : 'Không có dữ liệu bán hàng'}
                      </td>
                    </tr>
                  ) : (
                    paginate(displayedItemSales).map((item, idx) => {
                      const isItemMissingCost = missingCostIdSet.has(item.id) || missingCostNameSet.has(item.name.toLowerCase().trim());
                      return (
                        <tr key={idx} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                          <td className="px-6 py-4 text-sm font-bold text-gray-900 dark:text-white">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span>{item.name}</span>
                              {isItemMissingCost && (
                                <button
                                  type="button"
                                  onClick={() => setShowMissingCostModal(true)}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30 hover:bg-rose-500/25 transition-all cursor-pointer"
                                  title="Món này chưa có giá vốn trực tiếp hoặc nguyên liệu kho. Bấm để xem chi tiết."
                                >
                                  <AlertTriangle className="w-2.5 h-2.5" />
                                  <span>Chưa có giá vốn</span>
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right font-mono">{item.quantity.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}</td>
                          <td className="px-6 py-4 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500">{Math.round(item.revenue).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}đ</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            {displayedItemSales.length > rowsPerPage && (
              <div className="flex justify-center items-center gap-4">
                <button 
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(prev => prev - 1)}
                  className="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 disabled:opacity-30"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-sm text-gray-500">Trang {currentPage} / {totalPages(displayedItemSales)}</span>
                <button 
                  disabled={currentPage === totalPages(displayedItemSales)}
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
                  <p className="text-[10px] text-gray-500 uppercase font-bold">Phát sinh ròng tiền mặt</p>
                  <p className="text-sm font-mono font-bold text-emerald-600 dark:text-emerald-500">{cashStats.cashBalance.toLocaleString('vi-VN')}đ</p>
                </div>
                <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">Phát sinh ròng chuyển khoản</p>
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
                        <td className="px-6 py-4 text-sm">{safeFormatDate(t.date)}</td>
                        <td className="px-6 py-4 text-sm font-bold">{t.category}</td>
                        <td className="px-6 py-4">
                          {t.paymentMethod === 'transfer' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                              <CreditCard className="w-3 h-3" />
                              Chuyển khoản
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                              <Banknote className="w-3 h-3" />
                              Tiền mặt
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500">
                          {t.type === 'income' ? validCashAmount(t) ? `+${t.amount.toLocaleString('vi-VN')}đ` : 'Số tiền lỗi' : ''}
                        </td>
                        <td className="px-6 py-4 text-right font-mono font-bold text-rose-600 dark:text-rose-500">
                          {t.type === 'expense' ? validCashAmount(t) ? `-${t.amount.toLocaleString('vi-VN')}đ` : 'Số tiền lỗi' : ''}
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
            {hasMoreCash && (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 bg-black/5 dark:bg-white/5 rounded-xl border border-black/10 dark:border-white/10 text-xs mt-3">
                <span className="text-gray-500">
                  Đang hiển thị <strong className="text-gray-900 dark:text-white font-mono">{renderedCashTransactions.length}</strong> chứng từ gần nhất trong kỳ. Số dư và tổng thu chi trên thẻ tóm tắt luôn phản ánh 100% toàn bộ kỳ.
                </span>
                <button
                  type="button"
                  disabled={isLoadingMoreCash}
                  onClick={handleLoadMoreCash}
                  className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0"
                >
                  {isLoadingMoreCash ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Đang nạp thêm...</span>
                    </>
                  ) : (
                    <span>Tải thêm 30 chứng từ cũ hơn</span>
                  )}
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
                  <span className="text-gray-900 dark:text-white">{safeFormatDate(viewingInvoice.timeIn)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Giờ ra:</span>
                <span className="text-gray-900 dark:text-white">{safeFormatDate(viewingInvoice.date)}</span>
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
                {(!viewingInvoice.items || viewingInvoice.items.length === 0) ? (
                  <div className="text-center py-4 text-xs text-gray-500 italic">
                    Không có chi tiết món hoặc hóa đơn tóm tắt
                  </div>
                ) : (
                  viewingInvoice.items.map((item, i) => (
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
                ))
              )}
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

                {viewingInvoice.note && (
                  <div className="pt-2 border-t border-dashed border-black/10 dark:border-white/10">
                    <p className="text-xs text-gray-500 uppercase font-bold mb-1">Ghi chú (Gộp/Chuyển bàn/Món):</p>
                    <p className="text-sm text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/20 p-2.5 rounded-xl italic font-medium">
                      "{viewingInvoice.note}"
                    </p>
                  </div>
                )}
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
                className="flex-1 py-3 rounded-xl bg-blue-500 text-gray-900 dark:text-white font-bold hover:bg-blue-400 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <Printer className="w-4 h-4" /> In hóa đơn
              </button>
              {isAdmin && (
                <button 
                  onClick={() => {
                    const toDelete = viewingInvoice;
                    setViewingInvoice(null);
                    setConfirmDeleteInvoice(toDelete);
                  }}
                  className="px-4 py-3 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400 font-bold hover:bg-rose-500/20 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  title="Xóa hóa đơn bán hàng"
                >
                  <Trash2 className="w-4 h-4" /> Xóa
                </button>
              )}
              <button 
                onClick={() => setViewingInvoice(null)}
                className="flex-1 py-3 rounded-xl bg-black/5 dark:bg-white/5 text-gray-900 dark:text-white font-bold hover:bg-black/10 dark:hover:bg-white/10 transition-all cursor-pointer"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delete Invoice Modal */}
      {confirmDeleteInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl border border-black/10 dark:border-white/10 p-6 md:p-7 shadow-2xl space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 flex items-center justify-center shrink-0">
                <Trash2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Xác nhận xóa hóa đơn</h3>
                <p className="text-xs text-gray-500">Chỉ quản trị viên mới có thể thực hiện thao tác này</p>
              </div>
            </div>

            <div className="bg-black/5 dark:bg-white/5 rounded-2xl p-4 text-sm space-y-2 border border-black/5 dark:border-white/5">
              <div className="flex justify-between">
                <span className="text-gray-500">Mã hóa đơn:</span>
                <span className="font-mono font-bold text-gray-900 dark:text-white">#{confirmDeleteInvoice.id.substr(-6).toUpperCase()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Bàn:</span>
                <span className="font-semibold text-gray-900 dark:text-white">{confirmDeleteInvoice.tableName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Thời gian:</span>
                <span className="text-gray-700 dark:text-gray-300">{safeFormatDate(confirmDeleteInvoice.completedAt || confirmDeleteInvoice.date)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Nhân viên:</span>
                <span className="text-gray-700 dark:text-gray-300">{confirmDeleteInvoice.staffName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">PTTT:</span>
                <span className="font-medium text-gray-900 dark:text-white uppercase text-xs">{paymentMethodMap[confirmDeleteInvoice.paymentMethod as keyof typeof paymentMethodMap] || confirmDeleteInvoice.paymentMethod}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-black/5 dark:border-white/5">
                <span className="font-bold text-gray-900 dark:text-white">Tổng tiền:</span>
                <span className="font-bold text-rose-600 dark:text-rose-400 text-base">{confirmDeleteInvoice.total.toLocaleString()}đ</span>
              </div>
            </div>

            <p className="text-sm text-amber-700 dark:text-amber-400">
              Khi hủy, hệ thống lưu hóa đơn và phiếu thu vào lịch sử hủy, rồi cập nhật các số liệu liên quan.
            </p>
            {cancelError && <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{cancelError}</p>}
            {receiptReview?.invoiceId === confirmDeleteInvoice.id && receiptReview.candidates.length > 0 && (
              <label className="block text-sm space-y-2">
                <span>Chọn phiếu thu sau khi kiểm tra chứng từ gốc</span>
                <select value={receiptReview.selectedId} disabled={isDeletingInvoice}
                  onChange={event => setReceiptReview({ ...receiptReview, selectedId: event.target.value })}
                  className="w-full p-2 rounded-xl border border-black/10 bg-white dark:bg-[#1a1b1e] dark:border-white/10">
                  <option value="">Chọn phiếu thu đã xác nhận</option>
                  {receiptReview.candidates.map(row => <option key={row.id} value={row.id}>
                    {safeFormatDate(row.date)} · {row.amount.toLocaleString('vi-VN')}đ · {row.note || row.category} · {row.id}
                  </option>)}
                </select>
              </label>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                disabled={isDeletingInvoice}
                onClick={() => setConfirmDeleteInvoice(null)}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-900 dark:text-white font-bold hover:bg-black/5 dark:hover:bg-white/5 transition-all cursor-pointer disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={isDeletingInvoice || (receiptReview?.invoiceId === confirmDeleteInvoice.id && !receiptReview.selectedId)}
                onClick={async () => {
                  if (!onDeleteInvoice || !confirmDeleteInvoice || !currentUser) return;
                  const invoice = confirmDeleteInvoice;
                  const review = receiptReview?.invoiceId === invoice.id ? receiptReview : null;
                  if (review && !review.selectedId) return;
                  setIsDeletingInvoice(true);
                  setCancelError('');
                  try {
                    const result = await onDeleteInvoice(invoice.id, review?.selectedId || undefined);
                    if (!result.deleted) throw new Error('Hóa đơn đã thay đổi. Vui lòng tải lại báo cáo.');
                    setHistoricalInvoices(prev => prev.filter(inv => inv.id !== invoice.id));
                    setHistoricalCash(prev => prev.filter(row => row.invoiceId !== invoice.id && row.id !== result.receiptId));
                    summaryPeriodCache.clear();
                    setConfirmDeleteInvoice(null);
                  } catch (error) {
                    setCancelError(error instanceof Error ? error.message : 'Không thể hủy hóa đơn.');
                    if (error instanceof MissingInvoiceReceiptError) {
                      try {
                        const candidates = await legacyReceiptCandidates(currentUser, invoice);
                        setReceiptReview({ invoiceId: invoice.id, candidates, selectedId: '' });
                        if (!candidates.length) setCancelError('Chưa tìm thấy phiếu thu cũ cùng ngày, số tiền và phương thức. Vui lòng kiểm tra lại chứng từ gốc.');
                      } catch (failure) {
                        setCancelError(failure instanceof Error ? failure.message : 'Không thể tải phiếu thu để đối soát.');
                      }
                    }
                  } finally {
                    setIsDeletingInvoice(false);
                  }
                }}
                className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold transition-all shadow-lg shadow-rose-600/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isDeletingInvoice ? (
                  <span>Đang xóa...</span>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    <span>Xác nhận xóa</span>
                  </>
                )}
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
                <label className="text-xs text-gray-500 uppercase font-bold mb-1.5 block">
                  Phương thức thanh toán <span className="text-rose-500">*</span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setNewCash({...newCash, paymentMethod: 'cash'})}
                    className={cn(
                      "py-3 px-4 rounded-xl text-xs font-bold border flex items-center justify-center gap-2 transition-all cursor-pointer",
                      newCash.paymentMethod === 'cash' 
                        ? "bg-emerald-500 text-white border-emerald-500 shadow-md shadow-emerald-500/20" 
                        : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-black/10 dark:hover:bg-white/10"
                    )}
                  >
                    <Banknote className="w-4 h-4" />
                    <span>Tiền mặt</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewCash({...newCash, paymentMethod: 'transfer'})}
                    className={cn(
                      "py-3 px-4 rounded-xl text-xs font-bold border flex items-center justify-center gap-2 transition-all cursor-pointer",
                      newCash.paymentMethod === 'transfer' 
                        ? "bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-600/20" 
                        : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-700 dark:text-gray-300 hover:bg-black/10 dark:hover:bg-white/10"
                    )}
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>Chuyển khoản</span>
                  </button>
                </div>
                <div className={cn(
                  "mt-2 p-2.5 rounded-xl text-[11px] leading-relaxed border flex items-start gap-2",
                  newCash.paymentMethod === 'cash'
                    ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                    : "bg-blue-500/10 border-blue-500/20 text-blue-700 dark:text-blue-400"
                )}>
                  {newCash.paymentMethod === 'cash' ? (
                    <>
                      <Banknote className="w-4 h-4 shrink-0 mt-0.5" />
                      <span><strong>Tiền mặt:</strong> {showAddCashModal === 'expense' ? 'Trừ trực tiếp' : 'Cộng trực tiếp'} vào két tiền mặt của ca & cửa hàng, ảnh hưởng đến số dư tiền mặt thực tế.</span>
                    </>
                  ) : (
                    <>
                      <CreditCard className="w-4 h-4 shrink-0 mt-0.5" />
                      <span><strong>Chuyển khoản:</strong> Ghi nhận vào số dư ngân hàng, <strong>không</strong> làm thay đổi tiền mặt tại két.</span>
                    </>
                  )}
                </div>
              </div>
              <div className="relative">
                <div className="flex justify-between items-center mb-1">
                  <label className="text-xs text-gray-500 uppercase font-bold">Hạng mục</label>
                  <button
                    type="button"
                    onClick={() => {
                      setQuickCategoryInput(newCash.category.trim());
                      setShowQuickAddCategory(true);
                    }}
                    className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline flex items-center gap-1 font-semibold cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" /> Thêm hạng mục
                  </button>
                </div>
                <div className="flex gap-2 items-center">
                  <div className="relative flex-1">
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
                            {(settings.cashCategories || ['Bán hàng', 'Tiền điện', 'Tiền nước', 'Tiền mặt bằng', 'Nhập hàng', 'Lương nhân viên', 'Khác'])
                              .filter(c => c.toLowerCase().includes(newCash.category.toLowerCase()))
                              .map(cat => (
                              <div key={cat} className="flex justify-between items-center group px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg cursor-pointer text-sm text-gray-900 dark:text-white">
                                <div className="flex-1 font-medium" onClick={() => {
                                  setNewCash({ ...newCash, category: cat });
                                  setShowCategoryDropdown(false);
                                }}>
                                  {cat}
                                </div>
                                {isAdminOrManager && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (window.confirm(`Bạn có chắc chắn muốn xóa hạng mục "${cat}"?`)) {
                                        onUpdateSettings({
                                          ...settings,
                                          cashCategories: (settings.cashCategories || []).filter(c => c !== cat)
                                        });
                                      }
                                    }}
                                    className="text-gray-500 hover:text-rose-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                                    title="Xóa hạng mục này"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            ))}
                            
                            {newCash.category.trim() && !(settings.cashCategories || []).some(c => c.toLowerCase() === newCash.category.trim().toLowerCase()) && (
                              <div 
                                className="flex items-center gap-2 px-3 py-2 hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 rounded-lg cursor-pointer text-sm font-bold"
                                onClick={() => handleSaveNewCategory(newCash.category)}
                              >
                                <Plus className="w-4 h-4" />
                                Thêm mới "{newCash.category.trim()}"
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      const trimmed = newCash.category.trim();
                      if (trimmed && !(settings.cashCategories || []).some(c => c.toLowerCase() === trimmed.toLowerCase())) {
                        handleSaveNewCategory(trimmed);
                      } else {
                        setQuickCategoryInput(trimmed);
                        setShowQuickAddCategory(true);
                      }
                    }}
                    className="h-[46px] w-[46px] rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white flex items-center justify-center shrink-0 transition-all cursor-pointer shadow-sm shadow-emerald-500/20"
                    title="Thêm hạng mục mới"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
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
              disabled={isSavingCash}
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

      {/* Quick Add Category Modal */}
      {showQuickAddCategory && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#202124] w-full max-w-sm rounded-2xl p-6 border border-black/10 dark:border-white/10 shadow-2xl space-y-4">
            <div className="flex justify-between items-center">
              <h4 className="font-bold text-gray-900 dark:text-white">Thêm hạng mục mới</h4>
              <button onClick={() => setShowQuickAddCategory(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div>
              <label className="text-xs text-gray-500 font-bold mb-1 block">Tên hạng mục thu/chi</label>
              <input
                type="text"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2.5 px-3 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500"
                placeholder="VD: Mua đá, Văn phòng phẩm..."
                value={quickCategoryInput}
                onChange={(e) => setQuickCategoryInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSaveNewCategory(quickCategoryInput);
                  }
                }}
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowQuickAddCategory(false)}
                className="flex-1 py-2.5 rounded-xl border border-black/10 dark:border-white/10 text-sm font-semibold text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => handleSaveNewCategory(quickCategoryInput)}
                disabled={!quickCategoryInput.trim()}
                className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-sm font-bold text-white shadow-lg shadow-emerald-500/20"
              >
                Lưu lại
              </button>
            </div>
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
                <span className="text-gray-900 dark:text-white">{safeFormatDate(viewingLog.date)}</span>
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
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Phương thức TT:</span>
                <span className="text-gray-900 dark:text-white font-medium flex items-center gap-1.5">
                  {viewingLog.paymentMethod === 'transfer' ? (
                    <>
                      <CreditCard className="w-3.5 h-3.5 text-blue-500" />
                      <span className="text-blue-600 dark:text-blue-400 font-bold">Chuyển khoản</span>
                    </>
                  ) : (
                    <>
                      <Banknote className="w-3.5 h-3.5 text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400 font-bold">Tiền mặt</span>
                    </>
                  )}
                </span>
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

      {/* Modal danh sách món chưa có giá vốn */}
      {showMissingCostModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-2xl rounded-3xl p-6 md:p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6 max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-start">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="p-2 rounded-xl bg-rose-500/10 text-rose-500">
                    <AlertTriangle className="w-5 h-5" />
                  </span>
                  <h3 className="text-lg md:text-xl font-bold text-gray-900 dark:text-white">
                    Món chưa có giá vốn ({missingCostItems.length} món)
                  </h3>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  Các món này đã bán trong kỳ nhưng chưa có giá vốn trực tiếp hoặc nguyên liệu kho chưa có đơn giá nhập. Hệ thống đang tính giá vốn các món này bằng 0đ khiến Lợi nhuận gộp bị gắn nhãn <strong>[Ước tính]</strong>.
                </p>
              </div>
              <button 
                type="button" 
                onClick={() => setShowMissingCostModal(false)}
                className="p-1.5 text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 rounded-xl transition-all cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar border border-black/10 dark:border-white/10 rounded-2xl">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 font-semibold uppercase tracking-wider sticky top-0 backdrop-blur bg-white/90 dark:bg-[#1a1b1e]/90">
                    <th className="px-4 py-3">STT</th>
                    <th className="px-4 py-3">Tên món</th>
                    <th className="px-4 py-3 text-right">Đã bán</th>
                    <th className="px-4 py-3 text-right">Doanh thu</th>
                    <th className="px-4 py-3">Tình trạng</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {missingCostItems.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500 italic">
                        Tuyệt vời! Tất cả các món đã bán trong kỳ đều có giá vốn đầy đủ.
                      </td>
                    </tr>
                  ) : (
                    missingCostItems.map((item, index) => (
                      <tr key={item.id || item.name} className="hover:bg-black/5 dark:hover:bg-white/5">
                        <td className="px-4 py-3 font-mono text-gray-500">{index + 1}</td>
                        <td className="px-4 py-3 font-bold text-gray-900 dark:text-white">{item.name}</td>
                        <td className="px-4 py-3 text-right font-mono font-medium">{item.quantitySold}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500">
                          {item.revenue.toLocaleString('vi-VN')}đ
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 whitespace-nowrap">
                            {item.reason === 'incomplete_recipe' ? 'Thiếu giá nguyên liệu' : 'Chưa có giá vốn (0đ)'}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2 border-t border-black/5 dark:border-white/5 text-xs">
              <span className="text-gray-500 dark:text-gray-400">
                💡 <strong>Cách xử lý:</strong> Vào <em>Thực đơn</em> &rarr; Chọn món &rarr; Điền <em>Giá vốn</em> hoặc kiểm tra <em>Kho hàng</em> để nhập phiếu nhập nguyên liệu.
              </span>
              <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
                <button
                  type="button"
                  onClick={() => setShowMissingCostModal(false)}
                  className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl border border-black/10 dark:border-white/10 text-gray-700 dark:text-gray-300 font-bold hover:bg-black/5 dark:hover:bg-white/5 transition-all cursor-pointer"
                >
                  Đóng
                </button>
                {onNavigateToMenu && isAdminOrManager && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowMissingCostModal(false);
                      onNavigateToMenu();
                    }}
                    className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm shadow-emerald-500/20"
                  >
                    <span>Cập nhật trong Thực đơn</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
