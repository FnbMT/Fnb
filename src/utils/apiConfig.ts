import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Lấy URL gốc của backend API.
 * - Trên môi trường Web: dùng đường dẫn tương đối (hoạt động tốt với Vite proxy, Cloud Run, Vercel)
 * - Trên môi trường Native (Capacitor Android/iOS): Webview chạy ở localhost/capacitor://,
 *   do đó bắt buộc phải gọi đến domain backend thực tế thay vì relative path.
 */
export function getApiBaseUrl(): string {
  // 1. Kiểm tra URL máy chủ do người dùng hoặc quản trị viên cấu hình thủ công trong ứng dụng
  const savedUrl = localStorage.getItem('fnb_backend_api_url');
  if (savedUrl && savedUrl.trim().length > 0) {
    const trimmed = savedUrl.trim().replace(/\/+$/, '');
    // Tự động bỏ qua URL Cloud Run cũ đã ngừng hoạt động hoặc link placeholder không hợp lệ
    const isDefunct = trimmed.includes('asia-southeast1.run.app') || 
                      trimmed.includes('fnb-20.vercel.app') ||
                      trimmed === 'https://fnb-xxx.vercel.app';
    if (!isDefunct) {
      return trimmed;
    } else {
      localStorage.removeItem('fnb_backend_api_url');
    }
  }

  // 2. Kiểm tra cấu hình biến môi trường Vite (được nhúng khi build)
  const envUrl = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_SERVER_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/+$/, '');
  }

  // 3. Nếu đang chạy trên ứng dụng Native (Android APK hoặc iOS TestFlight / App Store):
  // Luôn trỏ mặc định về máy chủ backend Vercel production chính thức
  if (Capacitor.isNativePlatform()) {
    return 'https://fnb-master.vercel.app';
  }

  // 4. Môi trường trình duyệt Web:
  // Nếu đang mở trên localhost / 127.0.0.1 (máy dev không cấu hình Firebase Admin SDK nội bộ),
  // tự động chuyển hướng gọi API sang backend Vercel production để đảm bảo đăng nhập thành công.
  if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    return 'https://fnb-master.vercel.app';
  }

  // Môi trường web production (chạy trực tiếp trên domain Vercel fnb-master.vercel.app)
  return '';
}

export function getCustomApiUrl(): string {
  return localStorage.getItem('fnb_backend_api_url') || '';
}

export function setCustomApiUrl(url: string): void {
  const clean = url.trim().replace(/\/+$/, '');
  if (!clean || clean.includes('asia-southeast1.run.app') || clean.includes('fnb-20.vercel.app') || clean === 'https://fnb-xxx.vercel.app') {
    localStorage.removeItem('fnb_backend_api_url');
  } else {
    localStorage.setItem('fnb_backend_api_url', clean);
  }
}

/**
 * Xây dựng URL hoàn chỉnh cho endpoint API
 */
export function apiUrl(endpoint: string): string {
  const base = getApiBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${cleanEndpoint}`;
}

export interface ApiResponse<T = any> {
  ok: boolean;
  status: number;
  json: () => Promise<T>;
  text: () => Promise<string>;
}

/**
 * Gửi HTTP request an toàn:
 * - Trên Native (Android/iOS): Ưu tiên dùng CapacitorHttp trực tiếp cho API call này
 *   (tránh bị chặn bởi CORS/mixed content và không cần bật CapacitorHttp globally làm hỏng Firestore WebChannel)
 * - Trên Web: Dùng fetch tiêu chuẩn
 */
export async function safeApiRequest<T = any>(
  endpoint: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    signal?: AbortSignal;
  } = {}
): Promise<ApiResponse<T>> {
  const url = apiUrl(endpoint);

  if (Capacitor.isNativePlatform()) {
    try {
      let data = options.body;
      if (typeof options.body === 'string') {
        try {
          data = JSON.parse(options.body);
        } catch {
          data = options.body;
        }
      }
      const requestOptions: any = {
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
      };
      if (data !== undefined) {
        requestOptions.data = data;
      }
      const nativeResp = await CapacitorHttp.request(requestOptions);

      return {
        ok: nativeResp.status >= 200 && nativeResp.status < 300,
        status: nativeResp.status,
        json: async () => {
          if (typeof nativeResp.data === 'object' && nativeResp.data !== null) return nativeResp.data;
          if (typeof nativeResp.data === 'string' && nativeResp.data.trim().length > 0) {
            try { return JSON.parse(nativeResp.data); } catch { return {}; }
          }
          return {};
        },
        text: async () => (typeof nativeResp.data === 'string' ? nativeResp.data : JSON.stringify(nativeResp.data || '')),
      };
    } catch (nativeErr) {
      console.warn('[safeApiRequest] Native HTTP request warning, falling back to fetch:', nativeErr);
    }
  }

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: typeof options.body === 'object' && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
      signal: options.signal,
    });

    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json(),
      text: () => res.text(),
    };
  } catch (fetchErr: any) {
    // Nếu đang chạy trên web localhost và fetch đến server từ xa bị lỗi (CORS / mạng / offline):
    // Tự động fallback sang endpoint cục bộ cùng origin localhost (Vite proxy / Express server)
    const isLocalhost = typeof window !== 'undefined' && 
      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    const isRemoteUrl = url.startsWith('http://') || url.startsWith('https://');

    if (isLocalhost && isRemoteUrl) {
      const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
      try {
        console.warn(`[safeApiRequest] Fetch đến remote URL (${url}) thất bại, tự động chuyển về server local: ${cleanEndpoint}`);
        const localRes = await fetch(cleanEndpoint, {
          method: options.method || 'GET',
          headers: options.headers,
          body: typeof options.body === 'object' && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
          signal: options.signal,
        });

        return {
          ok: localRes.ok,
          status: localRes.status,
          json: () => localRes.json(),
          text: () => localRes.text(),
        };
      } catch (localErr) {
        console.error('[safeApiRequest] Cả remote và local endpoint đều thất bại:', localErr);
      }
    }

    throw fetchErr;
  }
}
