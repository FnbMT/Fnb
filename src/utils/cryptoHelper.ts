/**
 * Tiện ích hỗ trợ băm mật khẩu an toàn tương thích trên mọi trình duyệt web và Capacitor WebView.
 */
export async function computeSha256(text: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(text.trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
