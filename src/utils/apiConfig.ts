import { Capacitor } from '@capacitor/core';

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
