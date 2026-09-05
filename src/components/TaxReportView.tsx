import React, { useState, useMemo } from 'react';
import { FileText, Download, Printer, Save } from 'lucide-react';
import { Invoice, User } from '../types';
import { cn } from '../lib/utils';
import * as XLSX from 'xlsx';
import { format, parseISO, isSameDay, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameYear } from 'date-fns';

export const TaxReportView = ({ invoices, currentUser, onPrint }: {
  invoices: Invoice[];
  currentUser: User | null;
  onPrint: (data: any) => void;
}) => {
  const [taxRevenueType, setTaxRevenueType] = useState<'under_1b' | 'over_1b'>('under_1b');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [fromDate, setFromDate] = useState(() => format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [toDate, setToDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  
  // Thông tin cố định của HKD
  const [hkdInfo, setHkdInfo] = useState({
    name: currentUser?.store?.name || '',
    address: currentUser?.store?.address || '',
    taxCode: '',
    businessLocation: currentUser?.store?.address || ''
  });

  // Calculate 6-month revenues
  const firstHalfRevenue = useMemo(() => {
    return invoices.filter(inv => {
      const d = new Date(inv.date);
      return d.getFullYear() === selectedYear && d.getMonth() < 6;
    }).reduce((sum, inv) => sum + inv.total, 0);
  }, [invoices, selectedYear]);

  const secondHalfRevenue = useMemo(() => {
    return invoices.filter(inv => {
      const d = new Date(inv.date);
      return d.getFullYear() === selectedYear && d.getMonth() >= 6;
    }).reduce((sum, inv) => sum + inv.total, 0);
  }, [invoices, selectedYear]);

  const totalYearRevenue = firstHalfRevenue + secondHalfRevenue;

  // Calculate daily revenue for the selected month
  const dailyData = useMemo(() => {
    const start = new Date(fromDate);
    const end = new Date(toDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];

    const daysInInterval = eachDayOfInterval({ start, end });
    
    const data = daysInInterval.map(day => {
      const dailyInvoices = invoices.filter(inv => {
        const invDate = new Date(inv.date);
        return invDate.getDate() === day.getDate() && 
               invDate.getMonth() === day.getMonth() && 
               invDate.getFullYear() === day.getFullYear();
      });
      
      const revenue = dailyInvoices.reduce((sum, inv) => sum + inv.total, 0);
      return {
        date: day,
        revenue
      };
    }).filter(d => d.revenue > 0); // Only show days with revenue
    
    return data;
  }, [invoices, fromDate, toDate]);

  const totalMonthRevenue = dailyData.reduce((sum, d) => sum + d.revenue, 0);

  const handleExportExcel = () => {
    const aoaData = [
      [`HỘ, CÁ NHÂN KINH DOANH: ${hkdInfo.name}`, '', '', 'Mẫu số S1a-HKD'],
      [`Địa chỉ: ${hkdInfo.address}`, '', '', '(Kèm theo Thông tư số 152/2025/TT-BTC'],
      [`Mã số thuế: ${hkdInfo.taxCode}`, '', '', 'ngày 31 tháng 12 năm 2025 của Bộ trưởng Bộ Tài chính)'],
      [],
      ['', 'SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ'],
      ['', `Địa điểm kinh doanh: ${hkdInfo.businessLocation}`],
      ['', `Kỳ kê khai: Từ ${format(new Date(fromDate), 'dd/MM/yyyy')} đến ${format(new Date(toDate), 'dd/MM/yyyy')}`],
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
          <title>In Sổ S1a-HKD - Từ ${format(new Date(fromDate), 'dd/MM/yyyy')} đến ${format(new Date(toDate), 'dd/MM/yyyy')}</title>
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
            <p>Kỳ kê khai: Từ ${format(new Date(fromDate), 'dd/MM/yyyy')} đến ${format(new Date(toDate), 'dd/MM/yyyy')}</p>
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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4">
              <p className="text-sm text-gray-500 font-bold mb-1">6 tháng đầu năm</p>
              <p className="text-xl font-bold text-emerald-600 dark:text-emerald-500">{firstHalfRevenue.toLocaleString('vi-VN')}đ</p>
            </div>
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4">
              <p className="text-sm text-gray-500 font-bold mb-1">6 tháng cuối năm</p>
              <p className="text-xl font-bold text-emerald-600 dark:text-emerald-500">{secondHalfRevenue.toLocaleString('vi-VN')}đ</p>
            </div>
            <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-4">
              <p className="text-sm text-gray-500 font-bold mb-1">Cả năm {selectedYear}</p>
              <p className="text-xl font-bold text-blue-600 dark:text-blue-500">{totalYearRevenue.toLocaleString('vi-VN')}đ</p>
            </div>
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
                className="flex items-center gap-2 px-4 py-2 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-900 dark:text-white rounded-xl text-sm font-bold transition-all"
              >
                <Printer className="w-4 h-4" /> In Sổ
              </button>
              <button
                onClick={handleExportExcel}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-bold hover:bg-emerald-400 transition-all shadow-sm"
              >
                <Download className="w-4 h-4" /> Xuất Excel
              </button>
            </div>
          </div>

          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr>
                  <th colSpan={3} className="px-6 py-4 text-center bg-black/5 dark:bg-white/5">
                    <h4 className="font-bold text-lg">SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ</h4>
                    <p className="text-sm font-normal text-gray-500">Kỳ kê khai: Từ {format(new Date(fromDate), 'dd/MM/yyyy')} đến {format(new Date(toDate), 'dd/MM/yyyy')}</p>
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
