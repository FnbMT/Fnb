import React, { useState, useMemo, useEffect, useRef } from 'react';
import { BarChart3, Search, Calendar, ArrowDownToLine, ArrowUpFromLine, FileText, Download, X, Eye, Wallet, Plus, Printer, ChevronLeft, ChevronRight, Trash2, Check, Banknote, CreditCard, Loader2, AlertTriangle, ArrowRight } from 'lucide-react';
import { Invoice, InventoryTransaction, CashTransaction, User, SystemSettings, PayrollRecord, Shift, DailyStats, MenuItem } from '../types';
import { format, isSameDay, isSameMonth, isSameYear, parseISO, startOfMonth, endOfMonth, isBefore, startOfDay, subDays, eachDayOfInterval } from 'date-fns';
import { cn } from '../lib/utils';
import * as XLSX from 'xlsx';
import { db } from '../lib/firebase';
import { collection, query, where, getDocs, orderBy, limit, startAfter, doc, getDoc, QueryDocumentSnapshot, onSnapshot, writeBatch, updateDoc } from 'firebase/firestore';
import { getDateRangeIso, getVietnamBusinessDate, getVietnamYesterdayDate } from '../utils/firestoreDateHelper';
import { calculateInvoiceCost, calculateInvoiceCostSnapshot } from '../utils/costHelper';
import { isCashPayment, isReconciledDailyStat } from '../utils/reportDataIntegrity';
import { dailyStatsFromSources, invoiceCostIsComplete, operationId, receiptMismatch, isSalesCategory, allocatedItemRevenue } from '../utils/dataIntegrity';
import { subscribeDateRange } from '../utils/completeDataSource';

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
  const constraints: any[] = [where('storeId', '==', storeId)];
  if (mode === 'legacy') {
    constraints.push(where('date', '>=', startIso));
    constraints.push(where('date', '<', endExclusiveIso));
  } else {
    const filterField = filterType === 'day' ? 'businessDate' : filterType === 'month' ? 'businessMonth' : 'businessYear';
    const filterVal = filterType === 'day' ? dateFilter.slice(0, 10) : filterType === 'month' ? dateFilter.slice(0, 7) : (parseInt(dateFilter.slice(0, 4), 10) || new Date().getFullYear());
    constraints.push(where(filterField, '==', filterVal));
  }

  if (ordered) {
    constraints.push(orderBy('date', 'desc'));
  }

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
  const constraints: any[] = [where('storeId', '==', storeId)];
  if (mode === 'legacy') {
    constraints.push(where('date', '>=', startIso));
    constraints.push(where('date', '<', endExclusiveIso));
  } else {
    const filterField = filterType === 'day' ? 'businessDate' : filterType === 'month' ? 'businessMonth' : 'businessYear';
    const filterVal = filterType === 'day' ? dateFilter.slice(0, 10) : filterType === 'month' ? dateFilter.slice(0, 7) : (parseInt(dateFilter.slice(0, 4), 10) || new Date().getFullYear());
    constraints.push(where(filterField, '==', filterVal));
  }

  if (ordered) {
    constraints.push(orderBy('date', 'desc'));
  }

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
  onNavigateToMenu
}: { 
  invoices: Invoice[], 
  isInvoicesReady?: boolean,
  inventoryLogs: InventoryTransaction[],
  cashTransactions: CashTransaction[],
  payrollRecords: PayrollRecord[],
  shifts?: Shift[],
  activeShift?: Shift | null,
  onAddCashTransaction: (t: Omit<CashTransaction, 'id' | 'storeId'>, id?: string) => Promise<void>,
  onDeleteInvoice?: (invoiceId: string) => Promise<boolean> | boolean,
  currentUser: User | null,
  settings: SystemSettings,
  onUpdateSettings: (s: SystemSettings) => void,
  onPrint: (data: any) => void,
  activeOrdersCount?: number,
  businessDate?: string,
  menu?: MenuItem[],
  inventoryItems?: any[],
  onNavigateToMenu?: () => void
}) => {
  const isAdmin = currentUser?.role === 'admin';
  const isAdminOrManager = currentUser?.role === 'admin' || currentUser?.role === 'manager';
  const [activeTab, setActiveTab] = useState<'sales' | 'inventory' | 'items' | 'cash' | 'financial'>('sales');
  
  // Khởi tạo ngày theo múi giờ Việt Nam đồng bộ với App.tsx
  const todayVietnam = businessDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [dateFilter, setDateFilter] = useState(todayVietnam);
  const [filterType, setFilterType] = useState<'day' | 'month' | 'year'>('day');
  const [financialCostBasis,setFinancialCostBasis]=useState<'cash'|'payroll'>('cash');
  const [taxRevenueType, setTaxRevenueType] = useState<'under_1b' | 'over_1b'>('under_1b');
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [confirmDeleteInvoice, setConfirmDeleteInvoice] = useState<Invoice | null>(null);
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

  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [historicalInvoices, setHistoricalInvoices] = useState<Invoice[]>([]);
  const [historicalCash, setHistoricalCash] = useState<CashTransaction[]>([]);
  const [historicalLogs, setHistoricalLogs] = useState<InventoryTransaction[]>([]);
  const [periodPayrolls, setPeriodPayrolls] = useState<PayrollRecord[]>([]);
  const [isLoadingHistorical, setIsLoadingHistorical] = useState(false);
  const [reportDataReady, setReportDataReady] = useState(false);
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
  const [invoiceQueryConfig, setInvoiceQueryConfig] = useState<{ mode: 'modern' | 'legacy', ordered: boolean }>({ mode: 'modern', ordered: true });
  const [cashQueryConfig, setCashQueryConfig] = useState<{ mode: 'modern' | 'legacy', ordered: boolean }>({ mode: 'modern', ordered: true });

  // Request ID guard để chống đua lệnh (race condition / abort) khi người dùng đổi ngày/kỳ nhanh
  const activeRequestId = useRef(0);

  // Gộp dữ liệu: Dữ liệu thời gian thực hôm nay (Live) PHẢI GHI ĐÈ LÊN Lịch sử để bản mới nhất luôn thắng, lọc đúng quán hiện tại
  const allInvoices = useMemo(() => historicalInvoices.filter(i => i.storeId === currentUser?.storeId && i.status !== 'cancelled'), [historicalInvoices, currentUser?.storeId]);
  const allCashTransactions = useMemo(() => historicalCash.filter(i => i.storeId === currentUser?.storeId), [historicalCash, currentUser?.storeId]);

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

  // Phân trang Cursor Firestore (startAfter) - Tải thêm hóa đơn dùng chung query builder chuẩn hóa
  const handleLoadMoreInvoices = async () => {
    if (!currentUser?.storeId || !lastInvoiceDoc || isLoadingMoreInvoices) return;
    setIsLoadingMoreInvoices(true);
    const storeId = currentUser.storeId;
    const currentPeriodKey = `${storeId}_${dateFilter}_${filterType}`;
    const reqId = activeRequestId.current;

    try {
      const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
      const nextQuery = buildInvoiceQuery(
        storeId,
        filterType,
        dateFilter,
        startIso,
        endExclusiveIso,
        invoiceQueryConfig.mode,
        invoiceQueryConfig.ordered,
        lastInvoiceDoc,
        30
      );

      const snap = await getDocs(nextQuery);

      // Request Guard: Tránh response về muộn ghi đè cursor hoặc dữ liệu kỳ khác khi đã chuyển ngày/kỳ
      const nowPeriodKey = `${currentUser.storeId}_${dateFilter}_${filterType}`;
      if (currentPeriodKey !== nowPeriodKey || reqId !== activeRequestId.current) {
        return;
      }

      if (!snap.empty) {
        const moreDocs = snap.docs
          .map(d => ({ ...(d.data() as any), id: d.id } as Invoice));
        const newLastDoc = snap.docs[snap.docs.length - 1];
        const newHasMore = snap.docs.length >= 30;

        setHistoricalInvoices(prev => {
          const existingIds = new Set(prev.map(i => i.id));
          const uniqueNewDocs = moreDocs.filter(d => !existingIds.has(d.id));
          const combined = [...prev, ...uniqueNewDocs].sort((a, b) => 
            (b.completedAt || b.date).localeCompare(a.completedAt || a.date)
          );

          const cached = summaryPeriodCache.get(currentPeriodKey);
          if (cached) {
            cached.invoices = combined;
            cached.lastInvoiceDoc = newLastDoc;
            cached.hasMoreInvoices = newHasMore;
          }
          return combined;
        });

        setLastInvoiceDoc(newLastDoc);
        setHasMoreInvoices(newHasMore);
      } else {
        setHasMoreInvoices(false);
        const cached = summaryPeriodCache.get(currentPeriodKey);
        if (cached) {
          cached.hasMoreInvoices = false;
        }
      }
    } catch (err) {
      console.warn('Lỗi tải thêm hóa đơn:', err);
    } finally {
      setIsLoadingMoreInvoices(false);
    }
  };

  // Tải toàn bộ hóa đơn của kỳ khi cần báo cáo hoặc xuất Excel toàn kỳ
  const handleLoadAllInvoices = async () => {
    if (!currentUser?.storeId || !lastInvoiceDoc || isLoadingMoreInvoices) return;
    setIsLoadingMoreInvoices(true);
    const storeId = currentUser.storeId;
    const currentPeriodKey = `${storeId}_${dateFilter}_${filterType}`;
    const reqId = activeRequestId.current;

    try {
      const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
      let cursor: QueryDocumentSnapshot | null = lastInvoiceDoc;
      let hasMore = true;
      let accumulated: Invoice[] = [];

      while (hasMore && cursor) {
        if (reqId !== activeRequestId.current) break;
        const nextQuery = buildInvoiceQuery(
          storeId,
          filterType,
          dateFilter,
          startIso,
          endExclusiveIso,
          invoiceQueryConfig.mode,
          invoiceQueryConfig.ordered,
          cursor,
          100
        );
        const snap = await getDocs(nextQuery);
        if (snap.empty) {
          hasMore = false;
          break;
        }
        const docs = snap.docs.map(d => ({ ...(d.data() as any), id: d.id } as Invoice));
        accumulated = [...accumulated, ...docs];
        cursor = snap.docs[snap.docs.length - 1];
        hasMore = snap.docs.length >= 100;
      }

      if (currentPeriodKey !== `${currentUser.storeId}_${dateFilter}_${filterType}` || reqId !== activeRequestId.current) {
        return;
      }

      setHistoricalInvoices(prev => {
        const existingIds = new Set(prev.map(i => i.id));
        const unique = accumulated.filter(d => !existingIds.has(d.id));
        const combined = [...prev, ...unique].sort((a, b) =>
          (b.completedAt || b.date).localeCompare(a.completedAt || a.date)
        );
        const cached = summaryPeriodCache.get(currentPeriodKey);
        if (cached) {
          cached.invoices = combined;
          cached.lastInvoiceDoc = undefined;
          cached.hasMoreInvoices = false;
        }
        return combined;
      });
      setLastInvoiceDoc(null);
      setHasMoreInvoices(false);
    } catch (e) {
      console.warn("Lỗi tải toàn bộ hóa đơn:", e);
    } finally {
      setIsLoadingMoreInvoices(false);
    }
  };

  // Phân trang Cursor Firestore (startAfter) - Tải thêm chứng từ sổ quỹ dùng chung query builder chuẩn hóa
  const handleLoadMoreCash = async () => {
    if (!currentUser?.storeId || !lastCashDoc || isLoadingMoreCash) return;
    setIsLoadingMoreCash(true);
    const storeId = currentUser.storeId;
    const currentPeriodKey = `${storeId}_${dateFilter}_${filterType}`;
    const reqId = activeRequestId.current;

    try {
      const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
      const nextQuery = buildCashQuery(
        storeId,
        filterType,
        dateFilter,
        startIso,
        endExclusiveIso,
        cashQueryConfig.mode,
        cashQueryConfig.ordered,
        lastCashDoc,
        30
      );

      const snap = await getDocs(nextQuery);

      // Request Guard: Tránh response về muộn ghi đè cursor hoặc dữ liệu kỳ khác khi đã chuyển ngày/kỳ
      const nowPeriodKey = `${currentUser.storeId}_${dateFilter}_${filterType}`;
      if (currentPeriodKey !== nowPeriodKey || reqId !== activeRequestId.current) {
        return;
      }

      if (!snap.empty) {
        const moreDocs = snap.docs
          .map(d => ({ ...(d.data() as any), id: d.id } as CashTransaction));
        const newLastDoc = snap.docs[snap.docs.length - 1];
        const newHasMore = snap.docs.length >= 30;

        setHistoricalCash(prev => {
          const existingIds = new Set(prev.map(c => c.id));
          const uniqueNewDocs = moreDocs.filter(c => !existingIds.has(c.id));
          const combined = [...prev, ...uniqueNewDocs].sort((a, b) => b.date.localeCompare(a.date));

          const cached = summaryPeriodCache.get(currentPeriodKey);
          if (cached) {
            cached.cash = combined;
            cached.lastCashDoc = newLastDoc;
            cached.hasMoreCash = newHasMore;
          }
          return combined;
        });

        setLastCashDoc(newLastDoc);
        setHasMoreCash(newHasMore);
      } else {
        setHasMoreCash(false);
        const cached = summaryPeriodCache.get(currentPeriodKey);
        if (cached) {
          cached.hasMoreCash = false;
        }
      }
    } catch (err) {
      console.warn('Lỗi tải thêm sổ quỹ:', err);
    } finally {
      setIsLoadingMoreCash(false);
    }
  };

  // Phân trang Cursor Firestore (startAfter) - Tải thêm nhật ký kho on-demand dùng chung query builder
  const handleLoadMoreLogs = async () => {
    if (!currentUser?.storeId || !lastLogDoc || isLoadingMoreLogs) return;
    setIsLoadingMoreLogs(true);
    const storeId = currentUser.storeId;
    const currentPeriodKey = `${storeId}_${dateFilter}_${filterType}`;
    const reqId = activeRequestId.current;

    try {
      const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
      const nextQuery = buildLogQuery(storeId, startIso, endExclusiveIso, lastLogDoc, 50);
      const snap = await getDocs(nextQuery);

      // Request Guard
      const nowPeriodKey = `${currentUser.storeId}_${dateFilter}_${filterType}`;
      if (currentPeriodKey !== nowPeriodKey || reqId !== activeRequestId.current) {
        return;
      }

      if (!snap.empty) {
        const moreDocs = snap.docs.map(d => ({ ...(d.data() as any), id: d.id } as InventoryTransaction));
        const newLastDoc = snap.docs[snap.docs.length - 1];
        const newHasMore = snap.docs.length >= 50;

        setHistoricalLogs(prev => {
          const existingIds = new Set(prev.map(l => l.id));
          const uniqueNewDocs = moreDocs.filter(l => !existingIds.has(l.id));
          const combined = [...prev, ...uniqueNewDocs].sort((a, b) => b.date.localeCompare(a.date));

          const cached = summaryPeriodCache.get(currentPeriodKey);
          if (cached) {
            cached.logs = combined;
            cached.lastLogDoc = newLastDoc;
            cached.hasMoreLogs = newHasMore;
          }
          return combined;
        });

        setLastLogDoc(newLastDoc);
        setHasMoreLogs(newHasMore);
      } else {
        setHasMoreLogs(false);
        const cached = summaryPeriodCache.get(currentPeriodKey);
        if (cached) {
          cached.hasMoreLogs = false;
        }
      }
    } catch (err) {
      console.warn('Lỗi tải thêm nhật ký kho:', err);
    } finally {
      setIsLoadingMoreLogs(false);
    }
  };

  // Tải toàn bộ nhật ký kho của kỳ khi cần báo cáo đầy đủ
  const handleLoadAllLogs = async () => {
    if (!currentUser?.storeId || !lastLogDoc || isLoadingMoreLogs) return;
    setIsLoadingMoreLogs(true);
    const storeId = currentUser.storeId;
    const currentPeriodKey = `${storeId}_${dateFilter}_${filterType}`;
    const reqId = activeRequestId.current;

    try {
      const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
      let cursor: QueryDocumentSnapshot | null = lastLogDoc;
      let hasMore = true;
      let accumulated: InventoryTransaction[] = [];

      while (hasMore && cursor) {
        if (reqId !== activeRequestId.current) break;
        const nextQuery = buildLogQuery(storeId, startIso, endExclusiveIso, cursor, 100);
        const snap = await getDocs(nextQuery);
        if (snap.empty) {
          hasMore = false;
          break;
        }
        const docs = snap.docs.map(d => ({ ...(d.data() as any), id: d.id } as InventoryTransaction));
        accumulated = [...accumulated, ...docs];
        cursor = snap.docs[snap.docs.length - 1];
        hasMore = snap.docs.length >= 100;
      }

      if (currentPeriodKey !== `${currentUser.storeId}_${dateFilter}_${filterType}` || reqId !== activeRequestId.current) {
        return;
      }

      setHistoricalLogs(prev => {
        const existingIds = new Set(prev.map(l => l.id));
        const unique = accumulated.filter(l => !existingIds.has(l.id));
        const combined = [...prev, ...unique].sort((a, b) => b.date.localeCompare(a.date));
        const cached = summaryPeriodCache.get(currentPeriodKey);
        if (cached) {
          cached.logs = combined;
          cached.lastLogDoc = undefined;
          cached.hasMoreLogs = false;
        }
        return combined;
      });
      setLastLogDoc(null);
      setHasMoreLogs(false);
    } catch (e) {
      console.warn("Lỗi tải toàn bộ phiếu kho:", e);
    } finally {
      setIsLoadingMoreLogs(false);
    }
  };

  // Financial totals come from complete, live source queries. List pagination is
  // a display concern and cannot determine the financial total of a period.
  useEffect(() => {
    if (!currentUser?.storeId) return;
    const storeId = currentUser.storeId;
    ++activeRequestId.current;
    setIsLoadingHistorical(true); setReportDataReady(false); setPayrollDataReady(false); setReportError('');
    setHistoricalInvoices([]); setHistoricalCash([]); setHistoricalLogs([]); setPeriodPayrolls([]); setDailyStats([]);
    setHasMoreInvoices(false); setHasMoreCash(false); setHasMoreLogs(false);
    setLastInvoiceDoc(null); setLastCashDoc(null); setLastLogDoc(null);
    const expected = getExpectedPeriodDates(dateFilter, filterType, todayVietnam).filter(d => d <= todayVietnam);
    if (!expected.length) { setIsLoadingHistorical(false); setReportError('Vui lòng chọn kỳ không vượt quá ngày hiện tại.'); return; }
    const first = expected[0], last = expected[expected.length-1];
    let invoicesReady = false, cashReady = false, disposed = false;
    const updateReady = () => { if(!disposed) {setReportDataReady(invoicesReady && cashReady); if(invoicesReady&&cashReady)setReportError(''); setIsLoadingHistorical(!(invoicesReady && cashReady));} };
    const error = (err: Error) => { invoicesReady=false;cashReady=false;if(!disposed) { setReportError(err.message || 'Không thể xác nhận đủ chứng từ.'); setReportDataReady(false); setIsLoadingHistorical(false); } };
    const unsubs = [
      subscribeDateRange<Invoice>('invoices',storeId,first,last,(rows,confirmed)=>{ if(disposed)return;setHistoricalInvoices(rows);invoicesReady=confirmed;updateReady(); },error),
      subscribeDateRange<CashTransaction>('cash_transactions',storeId,first,last,(rows,confirmed)=>{ if(disposed)return;setHistoricalCash(rows);cashReady=confirmed;updateReady(); },error)
    ];
    if(activeTab==='inventory') unsubs.push(subscribeDateRange<InventoryTransaction>('inventory_logs',storeId,first,last,(rows)=>{ if(!disposed)setHistoricalLogs(rows); },error));
    if(activeTab==='financial') unsubs.push(onSnapshot(query(collection(db,'payroll_records'),where('storeId','==',storeId)),{includeMetadataChanges:true},snapshot=>{
      if(disposed)return;
      const rows=snapshot.docs.map(d=>({...d.data(),id:d.id} as PayrollRecord));
      setPeriodPayrolls(rows.filter(p=>filterType==='year'?p.month.slice(0,4)===dateFilter.slice(0,4):p.month===dateFilter.slice(0,7)));
      setPayrollDataReady(!snapshot.metadata.fromCache&&!snapshot.metadata.hasPendingWrites);
    },error));
    return () => {disposed=true;unsubs.forEach(fn=>fn());};
  }, [currentUser?.storeId,dateFilter,filterType,activeTab,todayVietnam]);

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
    }).sort((a, b) => (b.completedAt || b.date).localeCompare(a.completedAt || a.date));
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
    }).sort((a, b) => b.date.localeCompare(a.date));
  }, [allInventoryLogs, dateFilter, filterType]);

  // 3. Toàn bộ giao dịch sổ quỹ trong kỳ của cửa hàng (dùng tính số liệu, số dư, P&L, KPI)
  const periodCash = useMemo(() => {
    const { startIso, endExclusiveIso } = getDateRangeIso(dateFilter, filterType);
    const targetDay = dateFilter.slice(0, 10);
    const targetMonth = dateFilter.slice(0, 7);
    const targetYear = dateFilter.slice(0, 4);

    return allCashTransactions.filter(t => {
      const isAuto = isSalesCategory(t.category) || t.category === 'Nhập hàng' || t.category === 'Trả hàng';
      if (!isAdminOrManager && (t.staffId !== currentUser?.id || isAuto)) return false;

      const tDateStr = getVietnamBusinessDate(t.date);
      let matchDate = false;
      if (filterType === 'day') {
        matchDate = tDateStr === targetDay || (t.date >= startIso && t.date < endExclusiveIso);
      } else if (filterType === 'month') {
        matchDate = tDateStr.slice(0, 7) === targetMonth || (t.date >= startIso && t.date < endExclusiveIso);
      } else {
        matchDate = tDateStr.slice(0, 4) === targetYear || (t.date >= startIso && t.date < endExclusiveIso);
      }
      return matchDate;
    }).sort((a, b) => b.date.localeCompare(a.date));
  }, [allCashTransactions, dateFilter, filterType, isAdminOrManager, currentUser]);

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

    const checkCostValid = (num: unknown): boolean =>
      typeof num === 'number' && Number.isFinite(num) && num > 0;

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
            return checkCostValid(ing?.costPrice) && Number.isFinite(r.quantity) && r.quantity > 0;
          });
          if (allIngredientsValid) {
            hasValidCost = true;
          } else {
            reason = 'incomplete_recipe';
          }
        } else {
          // 2. Kiểm tra giá vốn trực tiếp (direct costPrice)
          const directCost = checkCostValid(menuItem?.costPrice)
            ? menuItem!.costPrice
            : checkCostValid(item.costPrice) ? item.costPrice : 0;
          if (checkCostValid(directCost)) {
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

  // Tính toán lại giá vốn thực tế cho từng hóa đơn khi người dùng đã cập nhật giá vốn món ăn trong Thực đơn / Kho
  const { recomputedInvoices, totalRecomputedCost, hasAnyIncompleteInvoice } = useMemo(() => {
    const menuMap = new Map((menu || []).map(m => [m.id, m]));
    const menuByName = new Map((menu || []).map(m => [m.name.toLowerCase().trim(), m]));
    const invMap = new Map((inventoryItems || []).map(i => [i.id, i]));
    const invByName = new Map((inventoryItems || []).map(i => [i.name.toLowerCase().trim(), i]));
    const getCostSource = (id: string, name?: string) => {
      let found = menuMap.get(id) || invMap.get(id);
      if (!found && name) {
        const clean = name.toLowerCase().trim();
        found = menuByName.get(clean) || invByName.get(clean);
      }
      return found;
    };

    let totalCost = 0;
    let anyIncomplete = false;
    const recomputed = periodInvoices.map(inv => {
      if (inv.status === 'cancelled') {
        return { ...inv, effectiveCost: 0, isCostComplete: true, shouldUpdateInDb: false };
      }

      // NGUYÊN TẮC BẤT BIẾN KẾ TOÁN (IMMUTABLE COST SNAPSHOT):
      // Nếu hóa đơn đã có giá vốn hoàn tất từ trước (costStatus === 'complete' và costVersion >= 2):
      // TUYỆT ĐỐI KHÔNG GHI ĐÈ! Giữ nguyên giá vốn lịch sử tại thời điểm bán, việc sửa thực đơn sau này không được làm sai lệch sổ sách cũ.
      if (inv.costStatus === 'complete' && (inv.costVersion || 0) >= 2 && typeof inv.totalCost === 'number' && inv.totalCost >= 0) {
        totalCost += inv.totalCost;
        return {
          ...inv,
          effectiveCost: inv.totalCost,
          isCostComplete: true,
          shouldUpdateInDb: false
        };
      }
      
      // CHỈ bổ sung cho các hóa đơn chưa có giá vốn hoặc đang bị ước tính (costStatus === 'estimated' / thiếu vốn):
      const snapshot = calculateInvoiceCostSnapshot(inv.items || [], getCostSource);
      
      // Nếu sau khi điền giá vốn trong thực đơn, hóa đơn này đã đủ 100% giá vốn:
      if (snapshot.isComplete) {
        totalCost += snapshot.totalCost;
        return {
          ...inv,
          effectiveCost: snapshot.totalCost,
          isCostComplete: true,
          shouldUpdateInDb: true // Nâng cấp từ estimated sang complete
        };
      }

      // Nếu vẫn còn món thiếu giá vốn:
      anyIncomplete = true;
      const fallbackCost = typeof inv.totalCost === 'number' && inv.totalCost > 0 ? inv.totalCost : snapshot.totalCost;
      totalCost += fallbackCost;
      return {
        ...inv,
        effectiveCost: fallbackCost,
        isCostComplete: false,
        shouldUpdateInDb: false
      };
    });

    return {
      recomputedInvoices: recomputed,
      totalRecomputedCost: totalCost,
      hasAnyIncompleteInvoice: anyIncomplete
    };
  }, [periodInvoices, menu, inventoryItems]);

  const [isSyncingCosts, setIsSyncingCosts] = useState(false);
  const [costSyncDone, setCostSyncDone] = useState(false);

  // Tự động đồng bộ giá vốn mới vào tài liệu hóa đơn trên Firestore khi đã đủ 100% giá vốn
  useEffect(() => {
    if (!isAdminOrManager || isSyncingCosts || costSyncDone) return;
    const toUpdate = recomputedInvoices.filter(i => i.shouldUpdateInDb);
    if (toUpdate.length === 0 || hasAnyIncompleteInvoice || missingCostItems.length > 0) return;

    let cancelled = false;
    const syncInvoices = async () => {
      setIsSyncingCosts(true);
      try {
        for (let i = 0; i < toUpdate.length; i += 100) {
          if (cancelled) break;
          const batch = writeBatch(db);
          const chunk = toUpdate.slice(i, i + 100);
          chunk.forEach(inv => {
            batch.update(doc(db, 'invoices', inv.id), {
              totalCost: inv.effectiveCost,
              costStatus: 'complete',
              costVersion: 2
            });
          });
          await batch.commit();
        }
        if (!cancelled) setCostSyncDone(true);
      } catch (err) {
        console.warn('Lỗi tự động đồng bộ giá vốn vào hóa đơn Firestore:', err);
      } finally {
        if (!cancelled) setIsSyncingCosts(false);
      }
    };

    syncInvoices();
    return () => { cancelled = true; };
  }, [isAdminOrManager, recomputedInvoices, hasAnyIncompleteInvoice, missingCostItems.length, isSyncingCosts, costSyncDone]);

  // Tổng hợp dữ liệu đa tầng theo từng ngày (Per-day Single Source of Truth, 100% toàn vẹn)
  const sourceMismatch=useMemo(()=>receiptMismatch(periodInvoices,periodCash),[periodInvoices,periodCash]);
  const statsAggregates = useMemo(() => {
    const dates=getExpectedPeriodDates(dateFilter,filterType,todayVietnam).filter(d=>d<=todayVietnam);
    let stats: DailyStats[];
    try { stats=dailyStatsFromSources(currentUser?.storeId||'',dates,periodInvoices,periodCash,reportDataReady); }
    catch { return null; }
    const totals:any={totalRevenue:0,totalCash:0,totalTransfer:0,invoiceCount:0,totalDiscount:0,totalCost:0,totalIncome:0,totalExpense:0,cashExpense:0,transferExpense:0,cashIncome:0,transferIncome:0,expenseInventory:0,expenseSalary:0,expenseRent:0,expenseOther:0};
    for(const stat of stats)for(const key of Object.keys(totals))totals[key]+=Number((stat as any)[key])||0;
    const sales=periodInvoices.filter(i=>i.status!=='cancelled');
    const isCostFullyResolved = periodInvoices.length > 0 && !hasAnyIncompleteInvoice && missingCostItems.length === 0;
    return {
      ...totals,
      totalCost: isCostFullyResolved ? totalRecomputedCost : totals.totalCost,
      hasExpenseBreakdown:true,
      costStatus: !reportDataReady ? 'partial' : isCostFullyResolved ? 'complete' : sales.every(invoiceCostIsComplete) ? 'complete' : 'estimated',
      coverageStatus:reportDataReady&&!sourceMismatch?'reconciled':'partial',
      missingDaysCount:reportDataReady?0:dates.length,
      reconciledDaysCount:reportDataReady?dates.length:0,
      daysWithSales:stats.filter(s=>s.invoiceCount>0).length,
      daysWithCompleteCost:stats.filter(s=>s.invoiceCount>0&&s.costStatus==='complete').length,
      daysWithEstimatedCost:stats.filter(s=>s.costStatus==='estimated').length,
      daysWithMissingCost:0,
      zeroActivityDaysCount:stats.filter(s=>!s.hasData).length,
      daysUsingFallbackInvoices:0,
      daysUsingFallbackCash:0,
      isInvoicePartial:!reportDataReady,
      isCashPartial:!reportDataReady,
      hasSalesInStats:sales.length>0,
      hasCostInStats:reportDataReady,
      hasExpenseInStats:totals.totalExpense>0,
      hasIncomeInStats:totals.totalIncome>0
    };
  },[periodInvoices,periodCash,reportDataReady,dateFilter,filterType,todayVietnam,currentUser?.storeId,sourceMismatch,hasAnyIncompleteInvoice,missingCostItems.length,totalRecomputedCost]);

  // Cash Book Stats - Tính toán chuẩn xác: Tổng thu = salesReceipts + nonSaleIncome
  const cashStats = useMemo(() => {
    const filterDate = parseISO(dateFilter);
    // 1. Thu ngoài bán hàng (Non-sale income)
    const nonSaleCashIncomeFromList = filteredCash
      .filter(t => t.type === 'income' && !isSalesCategory(t.category) && (t.paymentMethod === 'cash' || !t.paymentMethod))
      .reduce((sum, t) => sum + t.amount, 0);

    const nonSaleBankIncomeFromList = filteredCash
      .filter(t => t.type === 'income' && !isSalesCategory(t.category) && !isCashPayment(t.paymentMethod))
      .reduce((sum, t) => sum + t.amount, 0);

    const nonSaleCashIncome = (statsAggregates && typeof statsAggregates.cashIncome === 'number')
      ? statsAggregates.cashIncome
      : nonSaleCashIncomeFromList;

    const nonSaleBankIncome = (statsAggregates && typeof statsAggregates.transferIncome === 'number')
      ? statsAggregates.transferIncome
      : nonSaleBankIncomeFromList;

    const nonSaleIncome = (statsAggregates && typeof statsAggregates.totalIncome === 'number')
      ? statsAggregates.totalIncome
      : (nonSaleCashIncome + nonSaleBankIncome);

    // 2. Thu từ bán hàng (Sales receipts)
    const filteredCashSalesInTx = filteredCash
      .filter(t => t.type === 'income' && isSalesCategory(t.category) && (t.paymentMethod === 'cash' || !t.paymentMethod))
      .reduce((sum, t) => sum + t.amount, 0);

    const filteredBankSalesInTx = filteredCash
      .filter(t => t.type === 'income' && isSalesCategory(t.category) && !isCashPayment(t.paymentMethod))
      .reduce((sum, t) => sum + t.amount, 0);

    // Ưu tiên nguồn bán hàng đầy đủ từ statsAggregates (toàn bộ kỳ, không bị giới hạn 30 bản ghi)
    const cashSalesAmount = filteredCashSalesInTx;
    const bankSalesAmount = filteredBankSalesInTx;
    const salesReceipts = cashSalesAmount + bankSalesAmount;

    // 3. Tiền vào theo phương thức: Bán hàng + Thu ngoài bán hàng tương ứng
    const periodCashIncome = nonSaleCashIncome + cashSalesAmount;
    const periodBankIncome = nonSaleBankIncome + bankSalesAmount;

    // Tổng tiền vào = Thu bán hàng + Thu ngoài bán hàng (tuyệt đối không cộng đúp doanh thu bán hàng)
    const totalIncome = periodCashIncome + periodBankIncome;

    // 4. Chi phí (Expenses)
    const cashExpensesFromList = filteredCash
      .filter(t => t.type === 'expense' && (t.paymentMethod === 'cash' || !t.paymentMethod))
      .reduce((sum, t) => sum + t.amount, 0);
    const bankExpensesFromList = filteredCash
      .filter(t => t.type === 'expense' && !isCashPayment(t.paymentMethod))
      .reduce((sum, t) => sum + t.amount, 0);

    // Chi phí phân bổ theo phương thức từ statsAggregates nếu có số liệu toàn kỳ
    const totalCashExpense = (statsAggregates && typeof statsAggregates.cashExpense === 'number')
      ? statsAggregates.cashExpense
      : cashExpensesFromList;

    const totalTransferExpense = (statsAggregates && typeof statsAggregates.transferExpense === 'number')
      ? statsAggregates.transferExpense
      : bankExpensesFromList;

    const totalExpense = totalCashExpense + totalTransferExpense;

    // These are period movements. A real carried-forward balance requires a
    // reconciled account ledger; summing successive shift floats double-counts cash.
    const openingBalance=0;
    const closingBalance=totalIncome-totalExpense;
    const cashBalance=periodCashIncome-totalCashExpense;
    const bankBalance=periodBankIncome-totalTransferExpense;

    return {
      openingBalance,
      totalIncome,
      totalExpense,
      closingBalance,
      cashBalance,
      bankBalance,
      salesReceipts,
      nonSaleIncome,
      periodCashIncome,
      periodBankIncome,
      totalCashExpense,
      totalTransferExpense
    };
  }, [filteredCash, statsAggregates, dateFilter, filterType, shifts, activeShift]);

  const renderedCashTransactions = useMemo(() => {
    if (cashFilterType === 'all') return filteredCash;
    return filteredCash.filter(t => t.type === cashFilterType);
  }, [filteredCash, cashFilterType]);

  const exportToExcel = () => {
    if (!reportDataReady || isLoadingHistorical || sourceMismatch) { alert('Chưa xác nhận đủ chứng từ từ server. Vui lòng đợi đồng bộ hoặc kết nối lại trước khi xuất.'); return; }
    let dataToExport = [];
    let fileName = '';

    if (activeTab === 'sales') {
      dataToExport = filteredInvoices.map(inv => ({
        'Mã HĐ': inv.id.toUpperCase(),
        'Thời gian': format(parseISO(inv.date), 'HH:mm dd/MM/yyyy'),
        'Bàn': inv.tableName,
        'Nhân viên': inv.staffName,
        'Tổng tiền': inv.total,
        'PTTT': paymentMethodMap[inv.paymentMethod as keyof typeof paymentMethodMap] || inv.paymentMethod || 'Tiền mặt',
        'Ghi chú': inv.note || ''
      }));
      fileName = hasMoreInvoices
        ? `Bao_cao_hoa_don_${dateFilter}_(da_tai_${filteredInvoices.length}_don).xlsx`
        : `Bao_cao_hoa_don_${dateFilter}_(toan_ky).xlsx`;
    } else if (activeTab === 'inventory') {
      dataToExport = filteredLogs.map(log => ({
        'Thời gian': format(parseISO(log.date), 'HH:mm dd/MM/yyyy'),
        'Loại': log.type === 'import' ? 'Nhập hàng' : 'Trả hàng',
        'Mặt hàng': log.itemName,
        'Số lượng': log.quantity,
        'Tổng tiền': log.totalPrice
      }));
      fileName = hasMoreLogs
        ? `Bao_cao_kho_${dateFilter}_(da_tai_${filteredLogs.length}_phieu).xlsx`
        : `Bao_cao_kho_${dateFilter}_(toan_ky).xlsx`;
    } else if (activeTab === 'items') {
      dataToExport = sortedItemSales.map(item => ({
        'Tên món': item.name,
        'Số lượng bán': item.quantity,
        'Doanh thu': item.revenue
      }));
      fileName = hasMoreInvoices
        ? `Bao_cao_mon_ban_chay_${dateFilter}_(da_tai_${filteredInvoices.length}_don).xlsx`
        : `Bao_cao_mon_ban_chay_${dateFilter}_(toan_ky).xlsx`;
    } else if (activeTab === 'cash') {
      dataToExport = renderedCashTransactions.map(t => ({
        'Thời gian': format(parseISO(t.date), 'HH:mm dd/MM/yyyy'),
        'Loại': t.type === 'income' ? 'Thu' : 'Chi',
        'Hạng mục': t.category,
        'Số tiền': t.amount,
        'PTTT': paymentMethodMap[t.paymentMethod as keyof typeof paymentMethodMap] || t.paymentMethod || 'Tiền mặt',
        'Ghi chú': t.note || ''
      }));
      fileName = hasMoreCash
        ? `So_quy_${dateFilter}_(da_tai_${renderedCashTransactions.length}_phieu).xlsx`
        : `So_quy_${dateFilter}_(toan_ky).xlsx`;
    }

    if (dataToExport.length === 0) {
      alert('Không có dữ liệu trong kỳ này để xuất Excel.');
      return;
    }

    const ws = XLSX.utils.json_to_sheet(dataToExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Báo cáo");
    
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

  const invoicesSum = periodInvoices.reduce((sum, inv) => sum + inv.total, 0);
  const totalSales = statsAggregates ? statsAggregates.totalRevenue : invoicesSum;
  const totalInvoicesCount = statsAggregates ? statsAggregates.invoiceCount : periodInvoices.length;

  const sampleSales = periodInvoices.reduce((sum, inv) => sum + inv.total, 0);
  const sampleCost = periodInvoices.reduce((sum, inv) => {
    if (typeof inv.totalCost === 'number') {
      return sum + inv.totalCost;
    }
    return sum + calculateInvoiceCost(inv.items || []);
  }, 0);

  // CỐ ĐỊNH GIÁ VỐN (COGS) VÀ LỢI NHUẬN: Ưu tiên dùng giá vốn thực tế đã tổng hợp từ daily_stats khi đầy đủ
  let finalCost = 0;
  let isCostEstimated = false;
  let isCostUnavailable = false;
  let costEstimateReason = '';

  // 0. Ưu tiên cao nhất: Nếu các món bán trong kỳ đã được cài đặt đầy đủ 100% giá vốn
  // (toàn bộ các món bán đều có giá vốn/định lượng kho và toàn bộ hóa đơn đã tính đủ giá vốn)
  if (periodInvoices.length > 0 && !hasAnyIncompleteInvoice && missingCostItems.length === 0) {
    finalCost = totalRecomputedCost;
    isCostEstimated = false;
    costEstimateReason = '';
  }
  // 1. Nếu daily_stats có giá vốn đầy đủ toàn bộ các ngày (costStatus === 'complete' và totalCost là số, kể cả 0đ)
  else if (statsAggregates && statsAggregates.costStatus === 'complete' && typeof statsAggregates.totalCost === 'number') {
    finalCost = statsAggregates.totalCost;
    isCostEstimated = false;
    costEstimateReason = '';
  }
  // 2. Nếu daily_stats có giá vốn nhưng là ước tính (costStatus === 'estimated')
  else if (statsAggregates && statsAggregates.costStatus === 'estimated' && typeof statsAggregates.totalCost === 'number') {
    if (periodInvoices.length > 0 && !hasAnyIncompleteInvoice && missingCostItems.length === 0) {
      finalCost = totalRecomputedCost;
      isCostEstimated = false;
      costEstimateReason = '';
    } else {
      finalCost = totalRecomputedCost > 0 ? totalRecomputedCost : statsAggregates.totalCost;
      isCostEstimated = true;
      costEstimateReason = missingCostItems.length > 0
        ? `Có ${missingCostItems.length} món chưa có giá vốn: ${missingCostItems.slice(0, 3).map(m => m.name).join(', ')}${missingCostItems.length > 3 ? '...' : ''}`
        : 'Một số ngày hoặc món hàng sử dụng giá vốn ước tính (chưa có định lượng chuẩn)';
    }
  }
  // 3. Nếu daily_stats có giá vốn một phần (costStatus === 'partial')
  else if (statsAggregates && statsAggregates.costStatus === 'partial' && typeof statsAggregates.totalCost === 'number') {
    if (periodInvoices.length > 0 && !hasAnyIncompleteInvoice && missingCostItems.length === 0 && !hasMoreInvoices) {
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
    if (periodInvoices.length > 0 && !hasAnyIncompleteInvoice && missingCostItems.length === 0) {
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
  const totalCost = finalCost;
  const totalProfit = totalSales - totalCost;

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

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto">
      {activeTab==='items'&&periodInvoices.some(i=>i.total>0&&!i.items?.length)&&<div role="alert" className="p-3 rounded-xl bg-amber-500/10 text-amber-700">Có hóa đơn thiếu chi tiết món. Thống kê theo món chưa đầy đủ; cần đối soát hóa đơn gốc.</div>}
      {sourceMismatch && <div role="alert" className="p-3 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300">{sourceMismatch}</div>}
      {(!reportDataReady || reportError) && <div role="status" className="p-3 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300">{reportError || 'Đang đồng bộ toàn bộ chứng từ. Số liệu dưới đây chưa được xác nhận đầy đủ; chưa thể xuất báo cáo.'}</div>}
      {activeTab === 'financial' && <div className="text-sm text-gray-500">Lợi nhuận dùng doanh thu gồm VAT theo hóa đơn; doanh thu món là trước VAT, sau giảm giá. Lương: {financialCostBasis==='payroll' ? 'tạm tính theo các bảng lương đã chốt; chưa bao gồm nhân viên chưa chốt, phân bổ theo ngày khi xem ngày' : 'theo phiếu chi lương thực tế trong kỳ'}. {financialCostBasis==='payroll'&&!payrollDataReady ? 'Bảng lương đang đồng bộ.' : ''}<select className="ml-2 rounded border bg-transparent p-1" value={financialCostBasis} onChange={event=>setFinancialCostBasis(event.target.value as 'cash'|'payroll')}><option value="cash">Chi lương thực tế</option><option value="payroll">Bảng lương đã chốt (tạm tính)</option></select></div>}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-4">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
            {isAdminOrManager ? 'Tổng kết & Báo cáo' : 'Hóa đơn & Tổng kết'}
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
            <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-emerald-600 dark:text-emerald-500">{totalSales.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</p>
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
                <p className="text-xl md:text-2xl lg:text-3xl font-mono truncate font-bold text-blue-600 dark:text-blue-500">{isCostUnavailable ? '—' : `${totalProfit.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ`}</p>
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
                  {storePaymentStats.cashNet.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ
                </p>
                <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 font-mono pt-1 border-t border-black/5 dark:border-white/5">
                  <span className="text-emerald-600 dark:text-emerald-500 font-medium">Thu: +{storePaymentStats.cashIncome.toLocaleString('vi-VN')}đ</span>
                  <span className="text-rose-600 dark:text-rose-500 font-medium">Chi: -{storePaymentStats.cashExpense.toLocaleString('vi-VN')}đ</span>
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
                  {storePaymentStats.transferNet.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ
                </p>
                <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 font-mono pt-1 border-t border-black/5 dark:border-white/5">
                  <span className="text-emerald-600 dark:text-emerald-500 font-medium">Thu: +{storePaymentStats.transferIncome.toLocaleString('vi-VN')}đ</span>
                  <span className="text-rose-600 dark:text-rose-500 font-medium">Chi: -{storePaymentStats.transferExpense.toLocaleString('vi-VN')}đ</span>
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

      {statsAggregates?.coverageStatus === 'partial' && (
        <div className="p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-xs text-amber-700 dark:text-amber-400 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-base">⚠️</span>
            <span>
              <strong>Dữ liệu chưa đối soát đủ:</strong> {
                (statsAggregates?.missingDaysCount ?? 0) > 0 
                  ? <>Kỳ này còn <strong>{statsAggregates.missingDaysCount}</strong> ngày chưa có dữ liệu tổng hợp. Số liệu đang được kết hợp từ chứng từ đã tải.</>
                  : <>Chứng từ kỳ này chưa tải hết ({statsAggregates?.isInvoicePartial && hasMoreInvoices ? 'còn hóa đơn' : ''}{statsAggregates?.isInvoicePartial && hasMoreInvoices && statsAggregates?.isCashPartial && hasMoreCash ? ', ' : ''}{statsAggregates?.isCashPartial && hasMoreCash ? 'còn sổ quỹ' : ''} trên hệ thống). Số liệu đang tính trên trang đầu tiên.</>
              }
            </span>
          </div>
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
      )}

      <div className="flex flex-col md:flex-row gap-4 items-center bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 p-4 rounded-2xl">
        {isAdminOrManager && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1.5 p-1 bg-gray-100 dark:bg-black/20 rounded-xl">
              {(['day', 'month', 'year'] as const).filter(t => t === 'day' || currentUser?.store?.packageFeatures?.invoiceHistory !== 'daily').map(t => (
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
              const val = e.target.value;
              if (filterType === 'year') {
                setDateFilter(val ? `${val}-01-01` : `${new Date().getFullYear()}-01-01`);
              } else {
                setDateFilter(val);
              }
              setCurrentPage(1);
            }}
            min={filterType === 'year' ? 2020 : undefined}
            max={filterType === 'year' ? 2030 : undefined}
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
          {isAdminOrManager && currentUser?.store?.packageFeatures?.financialReports && (
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
                        <td className="px-6 py-4 text-sm">{format(parseISO(inv.completedAt || inv.date), 'HH:mm dd/MM/yyyy')}</td>
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
                        <td className="px-6 py-4 text-right font-mono">{log.quantity.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</td>
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
                {missingCostItems.length > 0 && (
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
              {missingCostItems.length > 0 && onNavigateToMenu && isAdminOrManager && (
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
                          <td className="px-6 py-4 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500">{item.revenue.toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 1 })}đ</td>
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
                <span className="text-gray-700 dark:text-gray-300">{format(parseISO(confirmDeleteInvoice.completedAt || confirmDeleteInvoice.date), 'HH:mm dd/MM/yyyy')}</span>
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

            <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 leading-relaxed">
              ⚠️ <strong>Lưu ý:</strong> Khi xóa hóa đơn này, hệ thống sẽ xóa vĩnh viễn và tự động tính toán lại toàn bộ doanh thu bán hàng, lợi nhuận gộp, số dư tiền mặt / chuyển khoản và sổ quỹ tương ứng.
            </div>

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
                disabled={isDeletingInvoice}
                onClick={async () => {
                  if (!onDeleteInvoice || !confirmDeleteInvoice) return;
                  setIsDeletingInvoice(true);
                  try {
                    const deletedId = confirmDeleteInvoice.id;
                    const invDateStr = confirmDeleteInvoice.businessDate || getVietnamBusinessDate(confirmDeleteInvoice.date);
                    const deleted = await onDeleteInvoice(deletedId);
                    if (deleted !== true) return;
                    setHistoricalInvoices(prev => prev.filter(inv => inv.id !== deletedId));
                    setHistoricalCash(prev => prev.filter(c => (c as any).invoiceId !== deletedId));
                    summaryPeriodCache.clear();
                    setConfirmDeleteInvoice(null);
                  } catch (err) {
                    console.error(err);
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
