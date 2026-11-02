export class EscPosBuilder {
  private buffer: number[] = [];

  constructor() {
  }

  /** Khởi tạo máy in (Xóa các cài đặt cũ) */
  init() {
    this.buffer.push(0x1B, 0x40);
    return this;
  }

  /** Căn lề */
  alignLeft() { this.buffer.push(0x1B, 0x61, 0x00); return this; }
  alignCenter() { this.buffer.push(0x1B, 0x61, 0x01); return this; }
  alignRight() { this.buffer.push(0x1B, 0x61, 0x02); return this; }

  /** In đậm */
  boldOn() { this.buffer.push(0x1B, 0x45, 0x01); return this; }
  boldOff() { this.buffer.push(0x1B, 0x45, 0x00); return this; }

  /** Kích thước chữ */
  sizeNormal() { this.buffer.push(0x1D, 0x21, 0x00); return this; }
  sizeDouble() { this.buffer.push(0x1D, 0x21, 0x11); return this; }
  sizeDoubleHeight() { this.buffer.push(0x1D, 0x21, 0x01); return this; }

  /** Xuống dòng */
  newline(count: number = 1) {
    for (let i = 0; i < count; i++) {
      this.buffer.push(0x0A);
    }
    return this;
  }

  /** Cắt giấy */
  cut() {
    this.buffer.push(0x1D, 0x56, 0x41, 0x10);
    return this;
  }

  /** Mở két tiền */
  openCashDrawer() {
    this.buffer.push(0x1B, 0x70, 0x00, 0x19, 0xFA);
    return this;
  }

  /** Thêm văn bản (Chỉ hỗ trợ không dấu cho lệnh test) */
  text(str: string) {
    const processStr = this.removeVietnameseAccents(str);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(processStr);
    this.buffer.push(...Array.from(bytes));
    return this;
  }

  /** Thêm văn bản và tự động xuống dòng */
  textLine(str: string) {
    return this.text(str).newline();
  }

  /** Kẻ đường gạch ngang */
  divider(char: string = '-') {
    return this.textLine(char.repeat(48));
  }

  /** 
   * Hỗ trợ in ảnh Bitmap (Dùng để in hóa đơn render từ HTML Canvas)
   */
  image(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return this;

    const width = canvas.width;
    const height = canvas.height;
    const imageData = ctx.getImageData(0, 0, width, height);
    const pixels = imageData.data;

    // ESC/POS raster bit image command: GS v 0
    // Width in bytes (rounded up to nearest multiple of 8)
    const widthBytes = Math.ceil(width / 8);

    // Command header: GS v 0 m xL xH yL yH
    this.buffer.push(0x1D, 0x76, 0x30, 0x00);
    this.buffer.push(widthBytes & 0xFF, (widthBytes >> 8) & 0xFF);
    this.buffer.push(height & 0xFF, (height >> 8) & 0xFF);

    // Xử lý từng pixel để tạo bitmap monochrome (đen trắng)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < widthBytes; x++) {
        let byte = 0;
        for (let b = 0; b < 8; b++) {
          const pixelX = x * 8 + b;
          if (pixelX < width) {
            const index = (y * width + pixelX) * 4;
            const r = pixels[index];
            const g = pixels[index + 1];
            const b_color = pixels[index + 2];
            const a = pixels[index + 3];

            // Trắng (background), trong suốt hoặc màu sáng => pixel trắng (0). Đen hoặc màu tối => đen (1)
            // Luma threshold < 128 = đen
            const luma = 0.299 * r + 0.587 * g + 0.114 * b_color;
            if (a > 128 && luma < 128) {
              byte |= (1 << (7 - b));
            }
          }
        }
        this.buffer.push(byte);
      }
    }

    return this;
  }

  /** Xuất ra mảng byte (Uint8Array) để gửi qua TCP Socket */
  build(): Uint8Array {
    return new Uint8Array(this.buffer);
  }

  /** Hàm phụ trợ: Xóa dấu Tiếng Việt */
  private removeVietnameseAccents(str: string): string {
    return str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D');
  }
}
