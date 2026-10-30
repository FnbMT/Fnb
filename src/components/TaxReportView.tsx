import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { FileText, Download, Printer, Save, Loader2, AlertCircle, RefreshCw, CheckCircle2 } from 'lucide-react';
import { Invoice, User, DailyStats } from '../types';
import { cn } from '../lib/utils';
import * as XLSX from 'xlsx';
import { format, parseISO, isSameDay, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameYear } from 'date-fns';
import { db } from '../lib/firebase';
import { collection, query, where, getDocs, limit, startAfter, orderBy, QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';
import { getVietnamBusinessDate, getVietnamDayBoundariesIso } from '../utils/firestoreDateHelper';
import { dailyStatsFromSources } from '../utils/dataIntegrity';
import { subscribeDateRange } from '../utils/completeDataSource';

// Bộ nhớ đệm ngoài component để bảo toàn cả daily_stats lẫn hóa đơn fallback và phạm vi ngày đã phủ khi rời/quay lại tab
interface TaxYearCache {
  stats: DailyStats[];
  statsMap: Map<string, DailyStats>;
  invoices: Invoice[];
  invoicesByDay: Map<string, Invoice[]>;
  coveredDays: Set<string>; // Tập các ngày đã xác nhận (đã có stats hoặc đã tải hóa đơn đối soát)
  confirmedZeroDays: Set<string>; // Tập các ngày đã xác nhận không có hoạt động/hóa đơn nào
  timestamp: number;
}

const taxStatsCache = new Map<string, TaxYearCache>();

// Gom các ngày rời rạc thành các khoảng liên tục để tối ưu query, tránh query từng ngày lẻ tẻ
function groupContiguousDays(dates: string[]): { start: string; end: string }[] {
  if (dates.length === 0) return [];
  const sorted = [...new Set(dates)].sort();
  const ranges: { start: string; end: string }[] = [];
  let currentStart = sorted[0];
  let currentEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const prev = parseISO(currentEnd);
    const curr = parseISO(sorted[i]);
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / (24 * 3600 * 1000));
    if (diffDays === 1) {
      currentEnd = sorted[i];
    } else {
      ranges.push({ start: currentStart, end: currentEnd });
      currentStart = sorted[i];
      currentEnd = sorted[i];
    }
  }
  ranges.push({ start: currentStart, end: currentEnd });
  return ranges;
}

// Tải đủ hóa đơn của một khoảng ngày; chỉ đánh dấu ngày đã đối soát khi toàn bộ truy vấn thành công.
interface InvoiceFetchResult { invoices: Invoice[]; isComplete: boolean; }
async function fetchInvoicesForInterval(
  storeId: string,
  startDateStr: string,
  endDateStr: string
): Promise<InvoiceFetchResult> {
  const { startIso } = getVietnamDayBoundariesIso(startDateStr);
  const { endExclusiveIso } = getVietnamDayBoundariesIso(endDateStr);
  const results: Invoice[] = [];
  let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;
  try {
    while (true) {
      const constraints: any[] = [
        where('storeId', '==', storeId),
        where('date', '>=', startIso),
        where('date', '<', endExclusiveIso),
        orderBy('date', 'asc'),
        limit(200)
      ];
      if (lastDoc) constraints.push(startAfter(lastDoc));
      const snap = await getDocs(query(collection(db, 'invoices'), ...constraints));
      snap.docs.forEach(d => results.push({ ...d.data(), id: d.id } as Invoice));
      if (snap.docs.length < 200) return { invoices: results, isComplete: true };
      lastDoc = snap.docs[snap.docs.length - 1];
    }
  } catch (error) {
    console.warn('Không thể truy vấn dải ngày, dùng nguồn theo cửa hàng:', error);
    try {
      results.splice(0, results.length);
      const snap = await getDocs(query(collection(db, 'invoices'), where('storeId', '==', storeId)));
      snap.docs.forEach(d => {
        const invoice = { ...d.data(), id: d.id } as Invoice;
        const businessDate = invoice.businessDate || getVietnamBusinessDate(invoice.date || '');
        if ((invoice.date >= startIso && invoice.date < endExclusiveIso) || (businessDate >= startDateStr && businessDate <= endDateStr)) results.push(invoice);
      });
      return { invoices: results, isComplete: true };
    } catch (fallbackError) {
      console.warn('Không thể đối soát hóa đơn:', fallbackError);
      return { invoices: [], isComplete: false };
    }
  }
}

export const TaxReportView = ({ invoices, isInvoicesReady = true, currentUser, onPrint }: {
  invoices: Invoice[];
  isInvoicesReady?: boolean;
  currentUser: User | null;
  onPrint: (data: any) => void;
}) => {
  const [taxRevenueType, setTaxRevenueType] = useState<'under_1b' | 'over_1b'>('under_1b');
  const todayVn = getVietnamBusinessDate();
  const [selectedYear, setSelectedYear] = useState(() => parseInt(todayVn.slice(0, 4), 10));
  const [fromDate, setFromDate] = useState(() => `${todayVn.slice(0, 7)}-01`);
  const [toDate, setToDate] = useState(() => todayVn);
  const [summaryViewMode, setSummaryViewMode] = useState<'quarter' | 'half' | 'year'>('quarter');
  
  // Dữ liệu thống kê ngày (daily_stats) và hóa đơn fallback
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [yearInvoices, setYearInvoices] = useState<Invoice[]>([]);
  const [coveredDays, setCoveredDays] = useState<Set<string>>(new Set());
  const [confirmedZeroDays, setConfirmedZeroDays] = useState<Set<string>>(new Set());
  const [isLoadingYear, setIsLoadingYear] = useState(false);
  const [loadingStatusText, setLoadingStatusText] = useState('');
  const activeRequestId = useRef(0);

  const [refreshKey,setRefreshKey]=useState(0);
  const [taxDataReady,setTaxDataReady]=useState(false);
  const [taxError,setTaxError]=useState('');
  const reconcileDays=useCallback(async (_days:string[])=>{setRefreshKey(value=>value+1);},[]);
  useEffect(()=>{
    setTaxDataReady(false);setTaxError('');setIsLoadingYear(true);setLoadingStatusText('Đang tải đủ hóa đơn của năm từ server...');
    setDailyStats([]);setYearInvoices([]);setCoveredDays(new Set());setConfirmedZeroDays(new Set());
    if(!currentUser?.storeId)return;
    const first=`${selectedYear}-01-01`, last=`${selectedYear}-12-31`;
    const dates=eachDayOfInterval({start:parseISO(first),end:parseISO(last)}).map(d=>format(d,'yyyy-MM-dd')).filter(d=>d<=getVietnamBusinessDate());
    return subscribeDateRange<Invoice>('invoices',currentUser.storeId,first,last,(rows,confirmed)=>{
      const active=rows.filter(i=>i.status!=='cancelled');
      try {
        const stats=dailyStatsFromSources(currentUser.storeId,dates,active,[],confirmed);
        setYearInvoices(active);setDailyStats(stats);setTaxDataReady(confirmed);if(confirmed)setTaxError('');
        setCoveredDays(new Set(confirmed?dates:[]));
        setConfirmedZeroDays(new Set(confirmed?stats.filter(s=>s.invoiceCount===0).map(s=>s.date):[]));
        setIsLoadingYear(!confirmed);setLoadingStatusText(confirmed?'':'Đang chờ xác nhận dữ liệu từ server...');
      }catch(error){setTaxDataReady(false);setIsLoadingYear(false);setTaxError(error instanceof Error?error.message:'Chứng từ không hợp lệ.');}
    },error=>{setTaxDataReady(false);setIsLoadingYear(false);setTaxError(error.message);setLoadingStatusText('');});
  },[currentUser?.storeId,selectedYear,refreshKey,todayVn]);
  const effectiveInvoices=yearInvoices;

  // Thông tin cố định của HKD
  const [hkdInfo, setHkdInfo] = useState({
    name: currentUser?.store?.name || '',
    address: currentUser?.store?.address || '',
    taxCode: '',
    businessLocation: currentUser?.store?.address || ''
  });

  const mergedDailyStats=dailyStats;

  // Helper tính doanh thu và kiểm tra độ đầy đủ của Quý:
  // Kết hợp chuẩn xác stats từ DB và fallback hóa đơn cho các ngày chưa có stats
  const getQuarterInfo = useCallback((startMonth: number, endMonth: number) => {
    const mStartStr = String(startMonth).padStart(2, '0');
    const mEndStr = String(endMonth).padStart(2, '0');
    const startDStr = `${selectedYear}-${mStartStr}-01`;
    const lastDayOfMonth = endOfMonth(new Date(selectedYear, endMonth - 1, 1));
    const endDStr = format(lastDayOfMonth, 'yyyy-MM-dd');

    const startD = parseISO(startDStr);
    const endD = parseISO(endDStr);
    if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || startD > endD) {
      return { revenue: 0, isComplete: true, missingDaysCount: 0, missingDays: [], startMonth, endMonth };
    }

    const allQuarterDays = eachDayOfInterval({ start: startD, end: endD });
    const todayStr = getVietnamBusinessDate();
    const elapsedDays = allQuarterDays.filter(d => format(d, 'yyyy-MM-dd') <= todayStr);

    const statsDates = new Set(mergedDailyStats.filter(s => s.coverageStatus === 'reconciled' || s.coverageStatus === 'zero_activity').map(s => s.date));
    const missingDays: string[] = [];

    elapsedDays.forEach(d => {
      const dStr = format(d, 'yyyy-MM-dd');
      const isCovered = statsDates.has(dStr) || confirmedZeroDays.has(dStr) || coveredDays.has(dStr);
      if (!isCovered) {
        missingDays.push(dStr);
      }
    });

    // 1. Doanh thu từ dailyStats cho các ngày có stats
    const statsRevenue = mergedDailyStats
      .filter(s => {
        const year = parseInt(s.date.slice(0, 4), 10);
        const month = parseInt(s.date.split('-')[1], 10);
        return (s.coverageStatus === 'reconciled' || s.coverageStatus === 'zero_activity') && year === selectedYear && month >= startMonth && month <= endMonth;
      })
      .reduce((sum, s) => sum + (s.totalRevenue || 0), 0);

    // 2. Doanh thu từ hóa đơn fallback cho các ngày không có trong mergedDailyStats
    const fallbackInvoicesRevenue = effectiveInvoices.filter(inv => {
      const invBDate = inv.businessDate || getVietnamBusinessDate(inv.date);
      const invYear = inv.businessYear || parseInt(invBDate.slice(0, 4), 10);
      const invMonth = parseInt(invBDate.slice(5, 7), 10);
      return invYear === selectedYear && invMonth >= startMonth && invMonth <= endMonth && !statsDates.has(invBDate);
    }).reduce((sum, inv) => sum + inv.total, 0);

    const revenue = statsRevenue + fallbackInvoicesRevenue;
    const isComplete = missingDays.length === 0;

    return {
      revenue,
      isComplete,
      missingDaysCount: missingDays.length,
      missingDays,
      startMonth,
      endMonth
    };
  }, [selectedYear, mergedDailyStats, confirmedZeroDays, coveredDays, effectiveInvoices]);

  const q1Info = useMemo(() => getQuarterInfo(1, 3), [getQuarterInfo]);
  const q2Info = useMemo(() => getQuarterInfo(4, 6), [getQuarterInfo]);
  const q3Info = useMemo(() => getQuarterInfo(7, 9), [getQuarterInfo]);
  const q4Info = useMemo(() => getQuarterInfo(10, 12), [getQuarterInfo]);

  // Calculate 6-month revenues and completeness
  const firstHalfInfo = useMemo(() => {
    return {
      revenue: q1Info.revenue + q2Info.revenue,
      isComplete: q1Info.isComplete && q2Info.isComplete,
      missingDaysCount: q1Info.missingDaysCount + q2Info.missingDaysCount,
      missingDays: [...q1Info.missingDays, ...q2Info.missingDays]
    };
  }, [q1Info, q2Info]);

  const secondHalfInfo = useMemo(() => {
    return {
      revenue: q3Info.revenue + q4Info.revenue,
      isComplete: q3Info.isComplete && q4Info.isComplete,
      missingDaysCount: q3Info.missingDaysCount + q4Info.missingDaysCount,
      missingDays: [...q3Info.missingDays, ...q4Info.missingDays]
    };
  }, [q3Info, q4Info]);

  const yearInfo = useMemo(() => {
    return {
      revenue: firstHalfInfo.revenue + secondHalfInfo.revenue,
      isComplete: firstHalfInfo.isComplete && secondHalfInfo.isComplete,
      missingDaysCount: firstHalfInfo.missingDaysCount + secondHalfInfo.missingDaysCount,
      missingDays: [...firstHalfInfo.missingDays, ...secondHalfInfo.missingDays]
    };
  }, [firstHalfInfo, secondHalfInfo]);

  // Danh sách các ngày còn thiếu trong khoảng chọn hiện tại [fromDate, toDate]
  const missingDatesInRange = useMemo(() => {
    const start = parseISO(fromDate);
    const end = parseISO(toDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];

    const days = eachDayOfInterval({ start, end });
    const todayStr = getVietnamBusinessDate();
    const statsDates = new Set(mergedDailyStats.filter(s => s.coverageStatus === 'reconciled' || s.coverageStatus === 'zero_activity').map(s => s.date));
    const missing: string[] = [];

    days.forEach(d => {
      const dStr = format(d, 'yyyy-MM-dd');
      if (dStr <= todayStr) {
        const isCovered = statsDates.has(dStr) || confirmedZeroDays.has(dStr) || coveredDays.has(dStr);
        if (!isCovered) {
          missing.push(dStr);
        }
      }
    });

    return missing;
  }, [fromDate, toDate, mergedDailyStats, confirmedZeroDays, coveredDays]);

  // Calculate daily revenue for the selected date range
  const dailyData = useMemo(() => {
    const start = parseISO(fromDate);
    const end = parseISO(toDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];

    const daysInInterval = eachDayOfInterval({ start, end });
    
    const data = daysInInterval.map(day => {
      const dayStr = format(day, 'yyyy-MM-dd');
      
      let revenue = 0;
      const stat = mergedDailyStats.find(s => s.date === dayStr && (s.coverageStatus === 'reconciled' || s.coverageStatus === 'zero_activity'));
      if (stat && typeof stat.totalRevenue === 'number' && (stat.invoiceCount !== undefined || stat.totalRevenue > 0)) {
        revenue = stat.totalRevenue;
      } else {
        const dailyInvoices = effectiveInvoices.filter(inv => {
          const invBDate = inv.businessDate || getVietnamBusinessDate(inv.date);
          return invBDate === dayStr;
        });
        if (dailyInvoices.length > 0) {
          revenue = dailyInvoices.reduce((sum, inv) => sum + inv.total, 0);
        } else {
          revenue = stat?.totalRevenue || 0;
        }
      }

      return {
        date: day,
        revenue
      };
    }).filter(d => d.revenue > 0); // Chỉ hiển thị ngày có phát sinh doanh thu
    
    return data;
  }, [mergedDailyStats, effectiveInvoices, fromDate, toDate]);

  const totalMonthRevenue = dailyData.reduce((sum, d) => sum + d.revenue, 0);
  const selectedYearStart = `${selectedYear}-01-01`;
  const selectedYearEnd = `${selectedYear}-12-31`;
  const isSelectedRangeValid = fromDate >= selectedYearStart && toDate <= selectedYearEnd && fromDate <= toDate && toDate <= todayVn;
  const canExportCurrentRange = taxDataReady && isSelectedRangeValid && !isLoadingYear && missingDatesInRange.length === 0;
  const ensureExportableRange = () => {
    if (!isSelectedRangeValid) { alert(`Vui lòng chọn khoảng ngày hợp lệ trong năm ${selectedYear} và không vượt quá hôm nay.`); return false; }
    if (!taxDataReady || isLoadingYear || missingDatesInRange.length > 0) { alert('Dữ liệu kỳ này chưa đối soát đầy đủ. Hãy tải đối soát xong trước khi in hoặc xuất Excel.'); return false; }
    return true;
  };

  const handleExportExcel = () => {
    if (!ensureExportableRange()) return;
    const aoaData = [
      [`HỘ, CÁ NHÂN KINH DOANH: ${hkdInfo.name}`, '', '', 'Mẫu số S1a-HKD'],
      [`Địa chỉ: ${hkdInfo.address}`, '', '', '(Kèm theo Thông tư số 152/2025/TT-BTC'],
      [`Mã số thuế: ${hkdInfo.taxCode}`, '', '', 'ngày 31 tháng 12 năm 2025 của Bộ trưởng Bộ Tài chính)'],
      [],
      ['', 'SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ'],
      ['', `Địa điểm kinh doanh: ${hkdInfo.businessLocation}`],
      ['', `Kỳ kê khai: Từ ${format(parseISO(fromDate), 'dd/MM/yyyy')} đến ${format(parseISO(toDate), 'dd/MM/yyyy')}`],
      [],
      ['', '', 'Đơn vị tính: VNĐ'],
      ['Ngày tháng', 'Diễn giải', 'Số tiền'],
      ['A', 'B', '1']
    ];

    dailyData.forEach(d => {
      aoaData.push([
        format(d.date, 'dd/MM/yyyy'),
        'Doanh thu dịch vụ ăn uống',
        d.revenue
      ]);
    });

    aoaData.push(['Tổng cộng', '', totalMonthRevenue]);

    const ws = XLSX.utils.aoa_to_sheet(aoaData);
    
    // Merge cells for headers
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }, 
      { s: { r: 1, c: 0 }, e: { r: 1, c: 2 } }, 
      { s: { r: 2, c: 0 }, e: { r: 2, c: 2 } }, 
      { s: { r: 4, c: 0 }, e: { r: 4, c: 2 } }, 
      { s: { r: 5, c: 0 }, e: { r: 5, c: 2 } }, 
      { s: { r: 6, c: 0 }, e: { r: 6, c: 2 } }, 
    ];

    // Customize column widths
    const colWidths = [
      { wch: 15 }, // Ngày tháng
      { wch: 40 }, // Diễn giải
      { wch: 20 }, // Số tiền
      { wch: 40 }  // Right header
    ];
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S1a-HKD");
    
    const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const data = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `So_doanh_thu_S1a_HKD_${fromDate}_den_${toDate}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintReport = () => {
    if (!ensureExportableRange()) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    
    const rowsHtml = dailyData.map(d => `
      <tr>
        <td>${format(d.date, 'dd/MM/yyyy')}</td>
        <td class="text-left">Doanh thu dịch vụ ăn uống</td>
        <td class="text-right">${d.revenue.toLocaleString('vi-VN')}</td>
      </tr>
    `).join('');

    const html = `
      <html>
        <head>
          <title>In Sổ S1a-HKD - Từ ${format(parseISO(fromDate), 'dd/MM/yyyy')} đến ${format(parseISO(toDate), 'dd/MM/yyyy')}</title>
          <style>
            body { font-family: 'Times New Roman', serif; padding: 20px; font-size: 14px; max-width: 800px; margin: 0 auto; }
            .top-header { display: flex; justify-content: space-between; margin-bottom: 30px; }
            .top-left { font-weight: bold; }
            .top-left p { margin: 2px 0; }
            .top-right { text-align: center; font-style: italic; }
            .top-right p { margin: 2px 0; }
            .title-section { text-align: center; margin-bottom: 20px; }
            .title-section h2 { margin: 0; font-size: 18px; text-transform: uppercase; }
            .title-section p { margin: 5px 0; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { border: 1px solid black; padding: 8px; text-align: center; }
            .text-right { text-align: right; }
            .text-left { text-align: left; }
            .footer { margin-top: 50px; display: flex; justify-content: space-between; padding: 0 50px; }
            .unit { text-align: right; font-style: italic; margin-bottom: 5px; }
          </style>
        </head>
        <body>
          <div class="top-header">
            <div class="top-left">
              <p>HỘ, CÁ NHÂN KINH DOANH: ${hkdInfo.name}</p>
              <p>Địa chỉ: ${hkdInfo.address}</p>
              <p>Mã số thuế: ${hkdInfo.taxCode}</p>
            </div>
            <div class="top-right">
              <p style="font-weight: bold; font-style: normal;">Mẫu số S1a-HKD</p>
              <p>(Kèm theo Thông tư số 152/2025/TT-BTC</p>
              <p>ngày 31 tháng 12 năm 2025 của Bộ trưởng Bộ Tài chính)</p>
            </div>
          </div>
          
          <div class="title-section">
            <h2>SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ</h2>
            <p>Địa điểm kinh doanh: ${hkdInfo.businessLocation}</p>
            <p>Kỳ kê khai: Từ ${format(parseISO(fromDate), 'dd/MM/yyyy')} đến ${format(parseISO(toDate), 'dd/MM/yyyy')}</p>
          </div>
          
          <div class="unit">Đơn vị tính: VNĐ</div>
          
          <table>
            <thead>
              <tr>
                <th>Ngày tháng</th>
                <th>Diễn giải</th>
                <th>Số tiền</th>
              </tr>
              <tr style="font-weight: bold;">
                <th>A</th>
                <th>B</th>
                <th>1</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
              <tr style="font-weight: bold;">
                <td colspan="2">Tổng cộng</td>
                <td class="text-right">${totalMonthRevenue.toLocaleString('vi-VN')}</td>
              </tr>
            </tbody>
          </table>
          <div class="footer">
            <div style="text-align: center;">
              <p><strong>Người ghi sổ</strong></p>
              <p style="margin-top: 80px;">(Ký, ghi rõ họ tên)</p>
            </div>
            <div style="text-align: center;">
              <p>Ngày ..... tháng ..... năm .......</p>
              <p><strong>Đại diện hộ kinh doanh/ Cá nhân kinh doanh</strong></p>
              <p style="margin-top: 80px;">(Ký, ghi rõ họ tên, đóng dấu (nếu có))</p>
            </div>
          </div>
        </body>
      </html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 500);
  };

  return (
    <div className="p-8 space-y-6 pb-20 h-full overflow-y-auto">
      {(!taxDataReady || taxError) && <div role="status" className="p-3 rounded-xl bg-amber-500/10 text-amber-700">{taxError || 'Chưa xác nhận đủ hóa đơn từ server. Chức năng in/xuất sẽ mở sau khi đồng bộ hoàn tất.'}</div>}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-emerald-500" />
            Sổ thống kê & Báo cáo bán hàng
          </h2>
          <p className="text-gray-500">Tổng hợp doanh thu bán hàng nội bộ và trích xuất bảng kê định kỳ.</p>
        </div>
      </div>

      <div className="flex gap-4 border-b border-black/5 dark:border-white/5">
        <button
          onClick={() => setTaxRevenueType('under_1b')}
          className={cn(
            "pb-4 px-4 text-sm font-bold transition-all border-b-2",
            taxRevenueType === 'under_1b' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
          )}
        >
          Doanh thu &lt; 1 tỷ/năm
        </button>
        <button
          onClick={() => setTaxRevenueType('over_1b')}
          className={cn(
            "pb-4 px-4 text-sm font-bold transition-all border-b-2",
            taxRevenueType === 'over_1b' ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
          )}
        >
          Doanh thu &gt; 1 tỷ/năm
        </button>
      </div>

      {taxRevenueType === 'over_1b' ? (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-500 rounded-2xl p-6 text-center">
          <p className="font-bold text-lg">Liên hệ admin SĐT/ zalo : 0988409798 để được hỗ trợ</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
              <div className="flex items-center gap-3">
                <h3 className="font-bold text-lg">Tổng hợp doanh thu</h3>
                <select 
                  value={selectedYear} 
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                  className="bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-lg px-3 py-1 font-bold text-sm outline-none focus:border-emerald-500"
                >
                  {[...Array(5)].map((_, i) => {
                    const year = new Date().getFullYear() - i;
                    return <option key={year} value={year}>Năm {year}</option>;
                  })}
                </select>
                {isLoadingYear && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1.5 bg-amber-500/10 px-2 py-1 rounded-md">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
                    {loadingStatusText || `Đang nạp dữ liệu năm ${selectedYear}...`}
                  </span>
                )}
              </div>
              
              <div className="flex bg-black/5 dark:bg-white/5 p-1 rounded-xl">
                <button
                  onClick={() => setSummaryViewMode('quarter')}
                  className={cn("px-4 py-1.5 rounded-lg text-sm font-bold transition-all", summaryViewMode === 'quarter' ? "bg-white dark:bg-[#151619] shadow-sm text-emerald-600 dark:text-emerald-500" : "text-gray-500 hover:text-gray-900 dark:hover:text-white")}
                >
                  Theo Quý
                </button>
                <button
                  onClick={() => setSummaryViewMode('half')}
                  className={cn("px-4 py-1.5 rounded-lg text-sm font-bold transition-all", summaryViewMode === 'half' ? "bg-white dark:bg-[#151619] shadow-sm text-emerald-600 dark:text-emerald-500" : "text-gray-500 hover:text-gray-900 dark:hover:text-white")}
                >
                  6 Tháng
                </button>
                <button
                  onClick={() => setSummaryViewMode('year')}
                  className={cn("px-4 py-1.5 rounded-lg text-sm font-bold transition-all", summaryViewMode === 'year' ? "bg-white dark:bg-[#151619] shadow-sm text-emerald-600 dark:text-emerald-500" : "text-gray-500 hover:text-gray-900 dark:hover:text-white")}
                >
                  Cả Năm
                </button>
              </div>
            </div>

            {summaryViewMode === 'quarter' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { title: 'Quý 1', info: q1Info },
                  { title: 'Quý 2', info: q2Info },
                  { title: 'Quý 3', info: q3Info },
                  { title: 'Quý 4', info: q4Info }
                ].map(({ title, info }) => (
                  <div key={title} className="bg-white dark:bg-[#151619] border border-black/5 dark:border-white/5 rounded-xl p-4 shadow-sm flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-gray-500 font-bold uppercase">{title}</p>
                        {!info.isComplete && info.missingDaysCount > 0 ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium border border-amber-500/20" title={`Còn ${info.missingDaysCount} ngày chưa có dữ liệu đối soát`}>
                            Chưa đủ ({info.missingDaysCount} ngày)
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                            Đã đối soát
                          </span>
                        )}
                      </div>
                      <p className="text-lg font-bold text-emerald-600 dark:text-emerald-500">{info.revenue.toLocaleString('vi-VN')}đ</p>
                    </div>
                    {!info.isComplete && info.missingDaysCount > 0 && (
                      <button
                        type="button"
                        disabled={isLoadingYear}
                        onClick={() => reconcileDays(info.missingDays)}
                        className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 font-medium mt-2 pt-2 border-t border-black/5 dark:border-white/5 cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Tải đối soát {title}</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {summaryViewMode === 'half' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { title: '6 Tháng Đầu Năm', info: firstHalfInfo },
                  { title: '6 Tháng Cuối Năm', info: secondHalfInfo }
                ].map(({ title, info }) => (
                  <div key={title} className="bg-white dark:bg-[#151619] border border-black/5 dark:border-white/5 rounded-xl p-5 shadow-sm flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm text-gray-500 font-bold uppercase">{title}</p>
                        {!info.isComplete && info.missingDaysCount > 0 ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium border border-amber-500/20">
                            Chưa đủ ({info.missingDaysCount} ngày chưa đối soát)
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                            Đã đối soát
                          </span>
                        )}
                      </div>
                      <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-500">{info.revenue.toLocaleString('vi-VN')}đ</p>
                    </div>
                    {!info.isComplete && info.missingDaysCount > 0 && (
                      <button
                        type="button"
                        disabled={isLoadingYear}
                        onClick={() => reconcileDays(info.missingDays)}
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1.5 font-medium mt-3 pt-2 border-t border-black/5 dark:border-white/5 cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Tải đối soát {title}</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {summaryViewMode === 'year' && (
              <div className="grid grid-cols-1 gap-4">
                <div className="bg-white dark:bg-[#151619] border border-black/5 dark:border-white/5 rounded-xl p-6 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm text-gray-500 font-bold uppercase">Tổng Doanh Thu Cả Năm {selectedYear}</p>
                      {!yearInfo.isComplete && yearInfo.missingDaysCount > 0 ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium border border-amber-500/20">
                          Chưa đủ ({yearInfo.missingDaysCount} ngày chưa đối soát)
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
                          Đã đối soát toàn bộ
                        </span>
                      )}
                    </div>
                    <p className="text-3xl font-bold text-blue-600 dark:text-blue-500">{yearInfo.revenue.toLocaleString('vi-VN')}đ</p>
                  </div>
                  <div className="text-left md:text-right">
                    {!yearInfo.isComplete && yearInfo.missingDaysCount > 0 ? (
                      <button
                        type="button"
                        disabled={isLoadingYear}
                        onClick={() => reconcileDays(yearInfo.missingDays)}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Đối soát toàn năm {selectedYear}</span>
                      </button>
                    ) : (
                      <p className="text-xs text-gray-400 font-medium">Bao gồm toàn bộ hóa đơn đã hoàn thành trong năm {selectedYear}</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-6 space-y-4">
            <h3 className="font-bold text-lg border-b border-black/5 dark:border-white/5 pb-2">Thông tin Hộ kinh doanh</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Tên Hộ, Cá nhân KD</label>
                <input 
                  type="text" 
                  value={hkdInfo.name} 
                  onChange={e => setHkdInfo({...hkdInfo, name: e.target.value})}
                  className="w-full bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 outline-none focus:border-emerald-500"
                  placeholder="VD: Hộ KD Nguyễn Văn A"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Mã số thuế</label>
                <input 
                  type="text" 
                  value={hkdInfo.taxCode} 
                  onChange={e => setHkdInfo({...hkdInfo, taxCode: e.target.value})}
                  className="w-full bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 outline-none focus:border-emerald-500"
                  placeholder="Nhập mã số thuế"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Địa chỉ</label>
                <input 
                  type="text" 
                  value={hkdInfo.address} 
                  onChange={e => setHkdInfo({...hkdInfo, address: e.target.value})}
                  className="w-full bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 outline-none focus:border-emerald-500"
                  placeholder="Địa chỉ đăng ký kinh doanh"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Địa điểm kinh doanh</label>
                <input 
                  type="text" 
                  value={hkdInfo.businessLocation} 
                  onChange={e => setHkdInfo({...hkdInfo, businessLocation: e.target.value})}
                  className="w-full bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 outline-none focus:border-emerald-500"
                  placeholder="Nơi diễn ra hoạt động kinh doanh"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap justify-between items-center gap-4 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-bold">Từ ngày:</label>
                <input 
                  type="date"
                  className="bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 font-bold outline-none focus:border-emerald-500"
                  value={fromDate}
                  onChange={e => setFromDate(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-bold">Đến ngày:</label>
                <input 
                  type="date"
                  className="bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 font-bold outline-none focus:border-emerald-500"
                  value={toDate}
                  onChange={e => setToDate(e.target.value)}
                  min={fromDate}
                />
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={handlePrintReport}
                disabled={!canExportCurrentRange}
                className="flex items-center gap-2 px-4 py-2 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-900 dark:text-white rounded-xl text-sm font-bold transition-all"
              >
                <Printer className="w-4 h-4" /> In Sổ
              </button>
              <button
                onClick={handleExportExcel}
                disabled={!canExportCurrentRange}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-bold hover:bg-emerald-400 transition-all shadow-sm"
              >
                <Download className="w-4 h-4" /> Xuất Excel
              </button>
            </div>
          </div>

          {missingDatesInRange.length > 0 && (
            <div className="p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-xs text-amber-700 dark:text-amber-400 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                <span>
                  Kỳ kê khai từ <strong>{format(parseISO(fromDate), 'dd/MM/yyyy')}</strong> đến <strong>{format(parseISO(toDate), 'dd/MM/yyyy')}</strong> còn <strong>{missingDatesInRange.length}</strong> ngày chưa đối soát đủ dữ liệu.
                </span>
              </div>
              <button
                type="button"
                disabled={isLoadingYear}
                onClick={() => reconcileDays(missingDatesInRange)}
                className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shrink-0 shadow-sm"
              >
                {isLoadingYear ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                <span>Tải đối soát kỳ này</span>
              </button>
            </div>
          )}

          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr>
                  <th colSpan={3} className="px-6 py-4 text-center bg-black/5 dark:bg-white/5">
                    <h4 className="font-bold text-lg">SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ</h4>
                    <p className="text-sm font-normal text-gray-500">Kỳ kê khai: Từ {format(parseISO(fromDate), 'dd/MM/yyyy')} đến {format(parseISO(toDate), 'dd/MM/yyyy')}</p>
                  </th>
                </tr>
                <tr className="bg-black/10 dark:bg-white/10 text-gray-700 dark:text-gray-300 text-xs uppercase tracking-wider">
                  <th className="px-6 py-3 font-medium w-1/4">Ngày tháng (A)</th>
                  <th className="px-6 py-3 font-medium w-1/2">Diễn giải (B)</th>
                  <th className="px-6 py-3 font-medium text-right w-1/4">Số tiền (1)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 dark:divide-white/5">
                {dailyData.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-8 text-center text-gray-500 italic">
                      Không có dữ liệu doanh thu trong khoảng thời gian này
                    </td>
                  </tr>
                ) : (
                  <>
                    {dailyData.map((d, i) => (
                      <tr key={i} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                        <td className="px-6 py-3 text-sm font-bold">
                          {format(d.date, 'dd/MM/yyyy')}
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-600 dark:text-gray-400">
                          Doanh thu dịch vụ ăn uống
                        </td>
                        <td className="px-6 py-3 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500">
                          {d.revenue.toLocaleString('vi-VN')}đ
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-emerald-500/10">
                      <td colSpan={2} className="px-6 py-4 text-sm font-bold text-right uppercase text-emerald-700 dark:text-emerald-400">
                        Tổng cộng
                      </td>
                      <td className="px-6 py-4 text-right font-mono font-bold text-emerald-600 dark:text-emerald-500 text-lg">
                        {totalMonthRevenue.toLocaleString('vi-VN')}đ
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
