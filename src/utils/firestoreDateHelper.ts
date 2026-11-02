/**
 * Firestore Date and Query Optimization Helpers
 * Computes exact Vietnam timezone (UTC+7) ISO boundaries for queries
 */

/**
 * Lấy ngày kinh doanh theo giờ Việt Nam (Asia/Ho_Chi_Minh, UTC+7) định dạng YYYY-MM-DD
 * Xử lý chính xác cả chuỗi ISO UTC và Date object, loại bỏ lỗi lệch ngày lúc sáng sớm (trước 07:00)
 */
export const getVietnamBusinessDate = (isoStringOrDate?: string | Date): string => {
  if (!isoStringOrDate) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  const d = typeof isoStringOrDate === 'string' ? new Date(isoStringOrDate) : isoStringOrDate;
  if (isNaN(d.getTime())) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
};

/**
 * Trả về cận bắt đầu (00:00:00+07:00) và cận kết thúc mở (00:00:00+07:00 ngày hôm sau) dưới dạng ISO UTC
 * Cho phép dùng where('date', '>=', startIso) và where('date', '<', endExclusiveIso)
 */
export const getVietnamDayBoundariesIso = (businessDateStr: string) => {
  let cleanDateStr = (businessDateStr || '').trim();
  if (cleanDateStr.length > 10) {
    cleanDateStr = cleanDateStr.slice(0, 10);
  }
  if (!cleanDateStr || cleanDateStr.length !== 10) {
    cleanDateStr = getVietnamBusinessDate();
  }

  const startDate = new Date(`${cleanDateStr}T00:00:00+07:00`);
  const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);

  return {
    startIso: startDate.toISOString(),
    endExclusiveIso: endDate.toISOString()
  };
};

export const getVietnamStartOfTodayIso = (): string => {
  const todayVn = getVietnamBusinessDate();
  return new Date(`${todayVn}T00:00:00+07:00`).toISOString();
};

export const getVietnamEndOfTodayIso = (): string => {
  const todayVn = getVietnamBusinessDate();
  return new Date(`${todayVn}T23:59:59.999+07:00`).toISOString();
};

export const getDateRangeIso = (dateStr: string, type: 'day' | 'month' | 'year') => {
  const todayVn = getVietnamBusinessDate();

  let validDateStr = (dateStr || '').trim();
  if (!validDateStr) validDateStr = todayVn;

  if (type === 'day') {
    if (validDateStr.length === 7) {
      validDateStr = `${validDateStr}-01`;
    } else if (validDateStr.length === 4) {
      validDateStr = `${validDateStr}-01-01`;
    } else if (validDateStr.length > 10) {
      validDateStr = validDateStr.slice(0, 10);
    }
    const { startIso, endExclusiveIso } = getVietnamDayBoundariesIso(validDateStr);
    return { startIso, endIso: endExclusiveIso, endExclusiveIso };
  }

  if (type === 'month') {
    let year = validDateStr.slice(0, 4);
    let month = validDateStr.length >= 7 ? validDateStr.slice(5, 7) : todayVn.slice(5, 7);
    const y = parseInt(year, 10) || new Date().getFullYear();
    const m = parseInt(month, 10) || (new Date().getMonth() + 1);
    const mStr = String(m).padStart(2, '0');
    
    // Ngày đầu tháng
    const startIso = new Date(`${y}-${mStr}-01T00:00:00+07:00`).toISOString();
    // Ngày đầu tháng kế tiếp (exclusive)
    const nextMonth = m === 12 ? 1 : m + 1;
    const nextYear = m === 12 ? y + 1 : y;
    const endExclusiveIso = new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+07:00`).toISOString();
    
    return { startIso, endIso: endExclusiveIso, endExclusiveIso };
  }

  // year
  const year = parseInt(validDateStr.slice(0, 4), 10) || new Date().getFullYear();
  const startIso = new Date(`${year}-01-01T00:00:00+07:00`).toISOString();
  const endExclusiveIso = new Date(`${year + 1}-01-01T00:00:00+07:00`).toISOString();
  return { startIso, endIso: endExclusiveIso, endExclusiveIso };
};

/**
 * Lấy ngày hôm qua theo giờ Việt Nam (YYYY-MM-DD)
 */
export const getVietnamYesterdayDate = (baseDateStr?: string): string => {
  const base = baseDateStr ? new Date(`${baseDateStr.slice(0, 10)}T12:00:00+07:00`) : new Date();
  const d = new Date(base.getTime() - 24 * 60 * 60 * 1000);
  return getVietnamBusinessDate(d);
};

/**
 * Kiểm tra xem một đối tượng có ngày/giờ nằm trong ngày nghiệp vụ Việt Nam hay không
 * Hỗ trợ cả trường businessDate và date ISO string
 */
export const isInvoiceInVietnamDay = (item: { date?: string; businessDate?: string }, targetDay: string): boolean => {
  if (item.businessDate) return item.businessDate === targetDay;
  if (!item.date) return false;
  return getVietnamBusinessDate(item.date) === targetDay;
};

/**
 * Hiển thị chuỗi ngày tháng ở header theo chuẩn múi giờ Việt Nam (Thứ Năm, 29/10/2026)
 */
export const getVietnamHeaderDateString = (date?: Date | string): string => {
  const d = date ? (typeof date === 'string' ? new Date(date) : date) : new Date();
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(d);
};
