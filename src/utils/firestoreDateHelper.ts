/**
 * Firestore Date and Query Optimization Helpers
 * Computes exact Vietnam timezone (UTC+7) ISO boundaries for queries
 */

export const getVietnamStartOfTodayIso = (): string => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [year, month, day] = formatter.format(now).split('-');
  return new Date(`${year}-${month}-${day}T00:00:00+07:00`).toISOString();
};

export const getVietnamEndOfTodayIso = (): string => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [year, month, day] = formatter.format(now).split('-');
  return new Date(`${year}-${month}-${day}T23:59:59.999+07:00`).toISOString();
};

export const getDateRangeIso = (dateStr: string, type: 'day' | 'month' | 'year') => {
  const now = new Date();
  const todayVn = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now); // 'YYYY-MM-DD'

  let validDateStr = (dateStr || '').trim();
  if (!validDateStr) validDateStr = todayVn;

  if (type === 'day') {
    // Chuẩn hóa sang YYYY-MM-DD an toàn tuyệt đối
    if (validDateStr.length === 7) {
      validDateStr = `${validDateStr}-01`;
    } else if (validDateStr.length === 4) {
      validDateStr = `${validDateStr}-01-01`;
    } else if (validDateStr.length > 10) {
      validDateStr = validDateStr.slice(0, 10);
    }
    const startIso = new Date(`${validDateStr}T00:00:00+07:00`).toISOString();
    const endIso = new Date(`${validDateStr}T23:59:59.999+07:00`).toISOString();
    return { startIso, endIso };
  }

  if (type === 'month') {
    let year = validDateStr.slice(0, 4);
    let month = validDateStr.length >= 7 ? validDateStr.slice(5, 7) : todayVn.slice(5, 7);
    const y = parseInt(year, 10) || now.getFullYear();
    const m = parseInt(month, 10) || (now.getMonth() + 1);
    const mStr = String(m).padStart(2, '0');
    const lastDay = new Date(y, m, 0).getDate();
    const startIso = new Date(`${y}-${mStr}-01T00:00:00+07:00`).toISOString();
    const endIso = new Date(`${y}-${mStr}-${String(lastDay).padStart(2, '0')}T23:59:59.999+07:00`).toISOString();
    return { startIso, endIso };
  }

  // year
  const year = parseInt(validDateStr.slice(0, 4), 10) || now.getFullYear();
  const startIso = new Date(`${year}-01-01T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${year}-12-31T23:59:59.999+07:00`).toISOString();
  return { startIso, endIso };
};
