import { PrinterConfig } from '../types';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { EscPosBuilder } from '../lib/escpos';
import { TcpSocket } from '@deedarb/capacitor-tcp-socket';
import { CapacitorWifi } from '@capgo/capacitor-wifi';

export class PrinterService {

  /**
   * Sends a print job directly to the printer via TCP Socket (Port 9100).
   * This requires the app to be running as a Native APK (Capacitor).
   */
  static async printDirect(printer: PrinterConfig, data: any, systemSettings: any): Promise<boolean> {
    console.log(`Queueing print job for: ${printer.name} (${printer.ipAddress})`);
    
    if (!printer.ipAddress) {
      throw new Error('Máy in chưa được cấu hình địa chỉ IP');
    }

    const template = data.type === 'kitchen' 
      ? (systemSettings.kitchenTemplate || { showTime: true, showStaffName: true, showStoreAddress: false, showStorePhone: false, showLogo: false, showNote: true })
      : (systemSettings.paymentTemplate || { showTime: true, showStaffName: true, showStoreAddress: true, showStorePhone: true, showLogo: true, showNote: true });

    // 1. Khởi tạo Builder
    const builder = new EscPosBuilder();
    builder.init();

    // 2. Tạo DOM element ẩn để render hóa đơn
    const paperWidth = printer.paperSize === '58mm' ? 384 : 576; // pixels

    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.top = '-9999px';
    container.style.left = '-9999px';
    container.style.width = `${paperWidth}px`;
    container.style.backgroundColor = 'white';
    container.style.color = 'black';
    // Sử dụng font không chân sạch sẽ cho dễ đọc
    container.style.fontFamily = 'Arial, sans-serif'; 
    container.style.fontSize = printer.paperSize === '58mm' ? '22px' : '26px';
    container.style.padding = '0';
    container.style.margin = '0';
    container.style.lineHeight = '1.4';

    let html = `<div style="padding: 10px; display: flex; flex-direction: column;">`;
    
    // Header
    html += `<div style="text-align: center; margin-bottom: 15px;">`;
    if (template.showStoreAddress || template.showStorePhone) {
       html += `<strong style="font-size: 1.4em; display: block; margin-bottom: 5px;">${systemSettings.storeName || 'Cửa Hàng'}</strong>`;
       if (template.showStoreAddress && systemSettings.address) html += `<div style="font-size: 0.9em;">${systemSettings.address}</div>`;
       if (template.showStorePhone && systemSettings.phone) html += `<div style="font-size: 0.9em;">Điện thoại: ${systemSettings.phone}</div>`;
    }
    html += `</div>`;

    // Title
    html += `<div style="text-align: center; margin-bottom: 15px;">`;
    html += `<strong style="font-size: 1.6em;">${data.type === 'kitchen' ? 'PHIẾU BẾP' : 'HÓA ĐƠN THANH TOÁN'}</strong>`;
    html += `</div>`;

    // Info
    html += `<div style="margin-bottom: 15px; font-size: 0.95em;">`;
    html += `<div><strong>Bàn: ${data.tableName}</strong></div>`;
    if (template.showTime && data.timeIn) html += `<div>Giờ vào: ${new Date(data.timeIn).toLocaleString('vi-VN')}</div>`;
    if (template.showTime && data.timeOut) html += `<div>Giờ ra: ${new Date(data.timeOut).toLocaleString('vi-VN')}</div>`;
    if (template.showTime && !data.timeIn && !data.timeOut) html += `<div>Thời gian: ${data.date || new Date().toLocaleString('vi-VN')}</div>`;
    if (template.showStaffName) html += `<div>Nhân viên: ${data.staffName || ''}</div>`;
    html += `</div>`;
    
    // Divider
    html += `<div style="border-top: 2px dashed black; margin-bottom: 10px;"></div>`;

    // Table Header
    html += `<div style="display: flex; font-weight: bold; margin-bottom: 10px; font-size: 0.9em;">`;
    if (data.type === 'bill') {
       html += `<div style="flex: 1;">Tên món</div>`;
       html += `<div style="width: 50px; text-align: center;">SL</div>`;
       html += `<div style="width: 100px; text-align: right;">Thành tiền</div>`;
    } else {
       html += `<div style="flex: 1;">Tên món</div>`;
       html += `<div style="width: 50px; text-align: right;">SL</div>`;
    }
    html += `</div>`;
    
    // Divider
    html += `<div style="border-top: 2px dashed black; margin-bottom: 10px;"></div>`;

    // Items
    data.items.forEach((item: any, index: number) => {
       html += `<div style="display: flex; align-items: flex-start; margin-bottom: 5px;">`;
       if (data.type === 'bill') {
           const price = (item.price + (item.selectedAddOns?.reduce((s:any, a:any) => s + a.price, 0) || 0)) * item.quantity;
           html += `<div style="flex: 1; padding-right: 5px;">`;
           html += `<strong>${index + 1}. ${item.name}</strong>`;
           if (item.selectedAddOns && item.selectedAddOns.length > 0) {
               item.selectedAddOns.forEach((addon: any) => {
                   html += `<div style="font-size: 0.85em; padding-left: 10px;">+ ${addon.name}</div>`;
               });
           }
           if (item.note && template.showNote) {
               html += `<div style="font-size: 0.85em; padding-left: 10px; font-style: italic;">Lưu ý: ${item.note}</div>`;
           }
           html += `</div>`;
           html += `<div style="width: 50px; text-align: center;">${item.quantity}</div>`;
           html += `<div style="width: 100px; text-align: right;">${price.toLocaleString()}</div>`;
       } else {
           html += `<div style="flex: 1; padding-right: 5px;">`;
           html += `<strong style="font-size: 1.2em;">${index + 1}. ${item.name}</strong>`;
           if (item.selectedAddOns && item.selectedAddOns.length > 0) {
               item.selectedAddOns.forEach((addon: any) => {
                   html += `<div style="font-size: 0.9em; padding-left: 10px;">+ ${addon.name}</div>`;
               });
           }
           if (item.note && template.showNote) {
               html += `<div style="font-size: 1em; padding-left: 10px; font-style: italic;">Lưu ý: ${item.note}</div>`;
           }
           html += `</div>`;
           html += `<div style="width: 50px; text-align: right;"><strong style="font-size: 1.3em;">x${item.quantity}</strong></div>`;
       }
       html += `</div>`;
    });

    // Divider
    html += `<div style="border-top: 2px dashed black; margin-top: 10px; margin-bottom: 10px;"></div>`;

    // Totals
    if (data.type === 'bill' && data.total !== undefined) {
       if (data.note) html += `<div style="margin-bottom: 10px;">Ghi chú: ${data.note}</div>`;
       
       const subtotal = data.subtotal !== undefined ? data.subtotal : data.items.reduce((acc: number, item: any) => acc + (item.price + (item.selectedAddOns?.reduce((s:any, a:any) => s + a.price, 0) || 0)) * item.quantity, 0);
       
       html += `<div style="display: flex; justify-content: space-between; margin-bottom: 5px;">`;
       html += `<span>Tạm tính:</span><span>${subtotal.toLocaleString()}</span>`;
       html += `</div>`;
       
       if (data.discount) {
           html += `<div style="display: flex; justify-content: space-between; margin-bottom: 5px;">`;
           html += `<span>Giảm giá:</span><span>-${data.discount.toLocaleString()}</span>`;
           html += `</div>`;
       }
       if (data.vat) {
           html += `<div style="display: flex; justify-content: space-between; margin-bottom: 5px;">`;
           html += `<span>VAT (${systemSettings.vatPercent}%):</span><span>${data.vat.toLocaleString()}</span>`;
           html += `</div>`;
       }
       
       html += `<div style="display: flex; justify-content: space-between; margin-top: 10px; margin-bottom: 20px; font-size: 1.3em; font-weight: bold;">`;
       html += `<span>TỔNG CỘNG:</span><span>${data.total.toLocaleString()}</span>`;
       html += `</div>`;
       
       html += `<div style="text-align: center; font-style: italic;">`;
       html += `<div>Cảm ơn quý khách!</div>`;
       html += `<div>Hẹn gặp lại!</div>`;
       html += `</div>`;
    }
    
    html += `</div>`; // End container padding
    container.innerHTML = html;
    document.body.appendChild(container);

    // 3. Render HTML to Canvas
    // Dynamic import to avoid SSR/bundling issues if any, though it's client-side only.
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(container, {
        scale: 1, // Tỉ lệ 1:1 pixel mapping
        logging: false,
        backgroundColor: '#ffffff'
    });

    document.body.removeChild(container);

    // 4. Pass canvas to ESC/POS Builder
    builder.image(canvas).newline(3).cut();
    
    const printData = builder.build();

    const cleanIp = printer.ipAddress.trim();

    if (!Capacitor.isNativePlatform()) {
      console.warn('Printing via TCP Socket is only supported on Native Android/iOS devices.');
      console.log('Mocking print success for web preview. Data size:', printData.length, 'bytes');
      return new Promise(resolve => setTimeout(() => resolve(true), 1000));
    }

    
    let clientId: number | undefined;
    try {
      // Retry logic for iOS Local Network permission delay
      let connectResult: any;
      let lastError: any;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          connectResult = await TcpSocket.connect({ 
            ipAddress: cleanIp, 
            port: printer.port || 9100 
          });
          if (connectResult && connectResult.client !== undefined) {
             break; // Success
          }
        } catch (e) {
          lastError = e;
          console.warn(`[TCP Socket Print] Attempt ${attempt} failed for ${cleanIp}:`, e);
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 2500));
          }
        }
      }

      if (!connectResult || connectResult.client === undefined) {
        throw lastError || new Error("Failed to connect after 3 attempts");
      }

      clientId = connectResult.client;

      // Chuyển Uint8Array thành Base64 để gửi qua plugin
            let binary = '';
      const len = printData.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(printData[i]);
      }
      const base64Data = btoa(binary);
      
      // Gửi dữ liệu
      await TcpSocket.send({ 
        client: clientId,
        data: base64Data,
        
      }); 
      
      console.log('Đã gửi lệnh in qua TCP Socket (Native)');
      
      // Đợi máy in nhận hết dữ liệu trước khi ngắt kết nối
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    } catch (error) {
      console.error('Print error:', error);
      throw new Error(`Lỗi kết nối máy in: ${error instanceof Error ? error.message : 'Không xác định'}`);
    } finally {
      // Luôn đảm bảo đóng kết nối
      if (clientId !== undefined) {
        try {
          await TcpSocket.disconnect({ client: clientId });
        } catch (e) {
          console.error('Lỗi khi đóng kết nối:', e);
        }
      }
    }
  }

  /**
   * Scans the local network for printers (Port 9100) using batching and timeouts.
   * Only works on Native APK.
   */
  static async scanLocalNetwork(onProgress?: (ip: string, percent: number) => void): Promise<{ ip: string; name: string; port: number }[]> {
    if (!Capacitor.isNativePlatform()) {
      console.warn('Network scanning is only supported on Native Android/iOS devices.');
      return new Promise(resolve => {
        setTimeout(() => {
          resolve([
            { ip: '192.168.1.200', name: 'Máy in (Thu ngân)', port: 9100 },
            { ip: '192.168.1.201', name: 'Máy in (Bếp)', port: 9100 }
          ]);
        }, 2000);
      });
    }

    const foundPrinters: { ip: string; name: string; port: number }[] = [];
    let subnet = "192.168.1"; // Mặc định nếu không lấy được IP
    
    try {
      // Yêu cầu quyền vị trí để lấy IP WiFi (Bắt buộc trên Android 8.1+)
      const permissionStatus = await CapacitorWifi.checkPermissions();
      if (permissionStatus.location !== 'granted') {
        const reqStatus = await CapacitorWifi.requestPermissions();
        if (reqStatus.location !== 'granted') {
           console.warn("Location permission not granted. Lấy IP có thể thất bại.");
        }
      }

      // Lấy IP của điện thoại để xác định đúng dải mạng
      const ipResult = await CapacitorWifi.getIpAddress();
      if (ipResult && ipResult.ipAddress) {
        const ipParts = ipResult.ipAddress.split('.');
        if (ipParts.length === 4) {
          subnet = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
          console.log(`Đã phát hiện IP thiết bị: ${ipResult.ipAddress}. Sẽ quét dải: ${subnet}.xxx`);
        }
      }
    } catch (e) {
      console.warn('Không thể lấy IP thiết bị, sử dụng dải mặc định 192.168.1.xxx', e);
    }

    const port = 9100;
    
    // Trigger iOS permission prompt on the first IP (router) before scanning
    
    
    const batchSize = 10; // Tăng số lượng IP quét cùng lúc
    const timeoutMs = 1500; // Tăng thời gian chờ lên 1.5s để đảm bảo máy in kịp phản hồi

    try {
      for (let i = 1; i <= 254; i += batchSize) {
        const batch = [];
        for (let j = 0; j < batchSize && (i + j) <= 254; j++) {
          const ip = `${subnet}.${i + j}`;
          batch.push(this.checkPrinter(ip, port, timeoutMs));
        }

        const results = await Promise.all(batch);
        results.forEach(res => {
          if (res) foundPrinters.push(res);
        });

        if (onProgress) {
          const currentIp = `${subnet}.${Math.min(i + batchSize - 1, 254)}`;
          onProgress(currentIp, Math.round((i / 254) * 100));
        }
        
        // Nghỉ 100ms giữa các batch để tránh làm tràn bộ nhớ đệm mạng của điện thoại
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      return foundPrinters;
    } catch (error) {
      console.error('Scan error:', error);
      return foundPrinters;
    }
  }

  /**
   * Helper to check if a single IP has port 9100 open
   */
  private static async checkPrinter(ip: string, port: number, timeout: number): Promise<{ ip: string; name: string; port: number } | null> {
    let clientId: number | undefined;
    let isTimeout = false;
    
    try {
      // Sử dụng Promise.race để tạo timeout cho việc kết nối. 
      // Xử lý ngầm disconnect nếu promise connect resolve SAU khi timeout.
      const connectionPromise = TcpSocket.connect({ ipAddress: ip, port }).then(result => {
        if (isTimeout && result.client !== undefined) {
          TcpSocket.disconnect({ client: result.client }).catch(() => {});
        }
        return result;
      });

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => {
          isTimeout = true;
          reject(new Error('Timeout'));
        }, timeout)
      );

      const result = await Promise.race([connectionPromise, timeoutPromise]) as any;
      clientId = result.client;
      // Nếu kết nối thành công, đây có thể là máy in
      return { ip, name: `Máy in (${ip})`, port };
    } catch (e) {
      return null;
    } finally {
      // Chỉ disconnect nếu kết nối thành công và không bị timeout (tức là ta lấy được client).
      // Nếu timeout, ngầm xử lý disconnect trong callback của connectionPromise.
      if (clientId !== undefined && !isTimeout) {
        try { await TcpSocket.disconnect({ client: clientId }); } catch (e) {}
      }
    }
  }

  /**
   * Tests connection to a specific IP by sending a small test print.
   */
  static async testConnection(ip: string, port: number = 9100): Promise<boolean> {
    const builder = new EscPosBuilder();
    const testData = builder.init()
                            .alignCenter()
                            .boldOn()
                            .textLine('TEST KẾT NỐI MÁY IN THÀNH CÔNG!')
                            .boldOff()
                            .newline(3)
                            .cut()
                            .build();

    const cleanIp = ip.trim();

    if (!Capacitor.isNativePlatform()) {
      console.log('Mocking test connection for IP:', cleanIp);
      return new Promise(resolve => setTimeout(() => resolve(true), 1000));
    }

    
    let clientId: number | undefined;
    try {
      // Retry logic for iOS Local Network permission delay or slow network
      let connectResult: any;
      let lastError: any;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          connectResult = await TcpSocket.connect({ ipAddress: cleanIp, port: port });
          if (connectResult && connectResult.client !== undefined) {
             break; // Success
          }
        } catch (e) {
          lastError = e;
          console.warn(`[TCP Socket] Attempt ${attempt} failed for ${cleanIp}:`, e);
          if (attempt < 3) {
            // Wait 2.5 seconds before retrying (gives user time to accept prompt on iOS)
            await new Promise(resolve => setTimeout(resolve, 2500));
          }
        }
      }

      if (!connectResult || connectResult.client === undefined) {
        throw lastError || new Error("Failed to connect after 3 attempts");
      }

      clientId = connectResult.client;

      let binary = '';
      const len = testData.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(testData[i]);
      }
      const base64Data = btoa(binary);
      await TcpSocket.send({ 
        client: clientId,
        data: base64Data,
        
      });
      
      // Delay trước khi disconnect để máy in nhận đủ dữ liệu
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    } catch (error) {
      console.error('Test connection error:', error);
      if (Capacitor.getPlatform() === 'ios') {
        alert('Lỗi kết nối trên iOS: ' + error.message + '\n\nĐang cố gắng kết nối nhưng bị từ chối.\n\nNếu bạn vừa thấy hộp thoại hỏi quyền "Mạng cục bộ" (Local Network), hãy chọn "Cho phép" (Allow) và BẤM THỬ LẠI lần nữa.\n\nNếu không thấy, hãy vào Cài đặt > Tên Ứng dụng > Bật Mạng cục bộ.');
      }
      return false;
    } finally {
      if (clientId !== undefined) {
        try {
          await TcpSocket.disconnect({ client: clientId });
        } catch (e) {}
      }
    }
  }
}
