import { Capacitor } from '@capacitor/core';

/**
 * Lấy URL gốc của backend API.
 * - Trên môi trường Web: dùng đường dẫn tương đối (hoạt động tốt với Vite proxy, Cloud Run, Vercel)
 * - Trên môi trường Native (Capacitor Android/iOS): Webview chạy ở localhost/capacitor://,
 *   do đó bắt buộc phải gọi đến domain backend thực tế thay vì relative path.
 */
export function getApiBaseUrl(): string {
  // 1. Kiểm tra cấu hình môi trường Vite (nếu được inject khi build APK hoặc web)
  const envUrl = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_SERVER_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/+$/, '');
  }

  // 2. Nếu đang chạy trên Native APK (Android/iOS)
  if (Capacitor.isNativePlatform()) {
    // Cho phép người dùng hoặc admin cấu hình URL máy chủ tùy chỉnh nếu cần
    const savedUrl = localStorage.getItem('fnb_backend_api_url');
    if (savedUrl && savedUrl.trim().length > 0) {
      return savedUrl.trim().replace(/\/+$/, '');
    }

    // URL Cloud Run production mặc định của ứng dụng
    return 'https://ais-dev-6ow7kxztfy55cvar3b722d-91599679751.asia-southeast1.run.app';
  }

  // 3. Môi trường trình duyệt Web: dùng đường dẫn tương đối
  return '';
}

/**
 * Xây dựng URL hoàn chỉnh cho endpoint API
 */
export function apiUrl(endpoint: string): string {
  const base = getApiBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${cleanEndpoint}`;
}
