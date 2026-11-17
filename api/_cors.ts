/**
 * Middleware xử lý CORS và HTTP OPTIONS preflight request cho toàn bộ API backend serverless (Vercel)
 * Cho phép các ứng dụng Native (Capacitor Android/iOS) và Web localhost/production gọi API mà không bị chặn.
 */
export function handleCors(req: any, res: any): boolean {
  // Tránh ghi đè hoặc tạo duplicate header nếu Vercel / gateway đã thiết lập header trước đó
  const setHeaderIfNotExists = (name: string, value: string) => {
    try {
      if (typeof res.getHeader === 'function') {
        const existing = res.getHeader(name);
        if (existing) return;
      }
      res.setHeader(name, value);
    } catch (_) {
      try { res.setHeader(name, value); } catch (_) {}
    }
  };

  setHeaderIfNotExists('Access-Control-Allow-Origin', '*');
  setHeaderIfNotExists('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  setHeaderIfNotExists('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Auth-Token');
  setHeaderIfNotExists('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

