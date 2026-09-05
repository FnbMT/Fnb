import React, { useState, useEffect } from 'react';
import { Settings, Store, Shield, Bell, Save, User, Lock, X, Printer, Layout, Wifi, Plus, Trash2, CheckCircle2, AlertCircle, Search, Bluetooth, Monitor, Smartphone, Info, MapPin, QrCode, AlertTriangle } from 'lucide-react';
import { SystemSettings, PrinterConfig, User as UserType } from '../types';
import { cn } from '../lib/utils';
import { CurrencyInput } from './CurrencyInput';
import { Capacitor } from '@capacitor/core';
import { CapacitorWifi } from '@capgo/capacitor-wifi';
import { PrinterService } from '../services/printerService';
import { QRCodeSVG } from 'qrcode.react';

export const SettingsView = ({ settings, onUpdateSettings, currentUser, onResetAllTables, onChangePassword, localPrinters, onUpdateLocalPrinters, onDeleteAccount }: { 
  settings: SystemSettings, 
  onUpdateSettings: (s: SystemSettings) => void,
  currentUser: UserType | null,
  onResetAllTables: () => void,
  onChangePassword?: (newPassword: string) => void,
  localPrinters: PrinterConfig[],
  onUpdateLocalPrinters: (p: PrinterConfig[]) => void,
  onDeleteAccount?: () => Promise<void> | void
}) => {
  
  const [networkInfo, setNetworkInfo] = useState<{ ip?: string, defaultGateway?: string, error?: string } | null>(null);
  const [isScanningNetwork, setIsScanningNetwork] = useState(false);

  const getIPv4Address = async (): Promise<string> => {
    return new Promise((resolve, reject) => {
        if ((window as any).networkinterface) {
            (window as any).networkinterface.getWiFiIPAddress(
                (info: any) => {
                   if (typeof info === 'string') resolve(info);
                   else if (info && info.ip) resolve(info.ip);
                   else resolve('');
                },
                (error: any) => reject(error)
            );
        } else {
            reject(new Error('Network interface plugin not available'));
        }
    });
  };

  const handleNetworkScan = async () => {
    setIsScanningNetwork(true);
    setNetworkInfo(null);
    try {
      if (Capacitor.isNativePlatform()) {
         try {
           await CapacitorWifi.requestPermissions();
         } catch(e) {}
         
         let ip: string | undefined = '';
         try {
             const ipResult = await CapacitorWifi.getIpAddress();
             ip = ipResult.ipAddress || (ipResult as any).ip || '';
         } catch(e) {}
         
         // If it's an IPv6 address (contains '%en0' or ':') or missing, try fallback
         if (!ip || typeof ip !== 'string' || ip.includes(':')) {
             try {
                 ip = await getIPv4Address();
             } catch(fallbackError) {
                 console.log('IPv4 fallback failed', fallbackError);
             }
         }
         
         // Ensure ip is a string
         ip = typeof ip === 'string' ? ip : String(ip);

         if (ip && ip.includes('.')) {
            const parts = ip.split('.');
            parts[3] = '1';
            const defaultGateway = parts.join('.');
            setNetworkInfo({ ip, defaultGateway });
         } else {
            setNetworkInfo({ error: 'Hệ thống chỉ quét được địa chỉ IPv6 (' + (ip || 'không rõ') + '), nhưng máy in cần IPv4.\n\nBạn hãy tự xem Default Gateway bằng cách:\n1. Vào Cài đặt Wi-Fi.\n2. Bấm vào chữ (i) hoặc Chi tiết mạng đang kết nối.\n3. Tìm dòng "Bộ định tuyến" (Router).' });
         }
      } else {
         setNetworkInfo({ error: 'Tính năng tự động quét IP chỉ hoạt động trên ứng dụng Android/iOS cài đặt trên máy.\n\nTuy nhiên, bạn có thể tự xem Default Gateway bằng cách:\n1. Vào Cài đặt Wi-Fi trên điện thoại/máy tính.\n2. Bấm vào icon (i) hoặc Chi tiết cạnh tên Wi-Fi đang kết nối.\n3. Tìm dòng "Bộ định tuyến" (Router) hoặc "Cổng" (Gateway).\n\nVí dụ Gateway của bạn là 192.168.1.1, thì IP của máy in thường nằm trong dải 192.168.1.xxx.' });
      }
    } catch (error: any) {
      console.error("Network scan error:", error);
      setNetworkInfo({ error: 'Lỗi khi quét mạng: ' + error.message });
    } finally {
      setIsScanningNetwork(false);
    }
  };

  const [localSettings, setLocalSettings] = useState<SystemSettings>(settings);
  const [showSaved, setShowSaved] = useState(false);
  const [newPersonalPassword, setNewPersonalPassword] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const isAdmin = currentUser?.role === 'admin';
  const isOrder = currentUser?.role === 'order';

  const handleSave = () => {
    onUpdateSettings(localSettings);
    if (newPersonalPassword && onChangePassword) {
      onChangePassword(newPersonalPassword);
      setNewPersonalPassword('');
    }
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 3000);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 400;
        const MAX_HEIGHT = 400;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        setLocalSettings({ ...localSettings, logo: dataUrl });
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleAddPrinter = () => {
    const newPrinter: PrinterConfig = {
      id: Math.random().toString(36).substr(2, 9),
      name: 'Máy in mới',
      connectionType: 'lan',
      ipAddress: '',
      port: 9100,
      type: 'bill',
      isEnabled: true,
      isDefault: localPrinters.length === 0,
      paperSize: '80mm'
    };
    onUpdateLocalPrinters([...localPrinters, newPrinter]);
  };

  const handleUpdatePrinter = (id: string, updates: Partial<PrinterConfig>) => {
    onUpdateLocalPrinters(localPrinters.map(p => p.id === id ? { ...p, ...updates } : p));
    if (updates.ipAddress !== undefined || updates.port !== undefined) {
      setTestResult(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleDeletePrinter = (id: string) => {
    onUpdateLocalPrinters(localPrinters.filter(p => p.id !== id));
  };

  const [testingPrinter, setTestingPrinter] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, 'success' | 'error'>>({});
  const [activeTemplateTab, setActiveTemplateTab] = useState<'kitchen' | 'payment'>('payment');

  const handleSetDefault = (id: string) => {
    onUpdateLocalPrinters(localPrinters.map(p => ({
      ...p,
      isDefault: p.id === id
    })));
  };

  const testConnection = async (id: string) => {
    const printer = localPrinters.find(p => p.id === id);
    if (!printer || !printer.ipAddress) return;

    setTestingPrinter(id);
    console.log(`Testing connection to ${printer.ipAddress}...`);
    
    try {
      const success = await PrinterService.testConnection(printer.ipAddress, printer.port || 9100);
      
      setTestingPrinter(null);
      setTestResult(prev => ({ ...prev, [id]: success ? 'success' : 'error' }));
    } catch (error: any) {
      console.error('Lỗi khi test máy in:', error);
      alert('Không thể kết nối! Vui lòng kiểm tra lại IP hoặc đảm bảo máy in đang bật.\n\nChi tiết lỗi: ' + (error.message || 'Timeout/Invalid IP'));
      setTestingPrinter(null);
      setTestResult(prev => ({ ...prev, [id]: 'error' }));
    }
  };

  const currentTemplate = activeTemplateTab === 'kitchen' ? localSettings.kitchenTemplate : localSettings.paymentTemplate;

  const updateTemplateSetting = (key: keyof typeof currentTemplate, value: any) => {
    const templateKey = activeTemplateTab === 'kitchen' ? 'kitchenTemplate' : 'paymentTemplate';
    setLocalSettings({
      ...localSettings,
      [templateKey]: {
        ...localSettings[templateKey],
        [key]: value
      }
    });
  };


  const printQRCode = () => {
    const qrElement = document.getElementById('attendance-qr-code');
    if (qrElement) {
      const printWindow = window.open('', '', 'width=600,height=600');
      if (printWindow) {
        printWindow.document.write(`
          <html>
            <head>
              <title>In Mã QR Chấm Công</title>
              <style>
                body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: sans-serif; }
                .qr-container { text-align: center; }
                h1 { font-size: 24px; margin-bottom: 20px; }
                p { font-size: 14px; color: #666; margin-top: 10px; }
                svg { width: 300px; height: 300px; }
              </style>
            </head>
            <body>
              <div class="qr-container">
                <h1>MÃ QR CHẤM CÔNG</h1>
                ${qrElement.innerHTML}
                <p>Quét mã để chấm công</p>
              </div>
              <script>
                setTimeout(() => {
                  window.print();
                  window.close();
                }, 500);
              </script>
            </body>
          </html>
        `);
        printWindow.document.close();
      }
    }
  };

  return (
    <div className="p-8 space-y-8 h-full overflow-y-auto max-w-4xl">
      {networkInfo && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-3xl p-8 shadow-2xl relative flex flex-col">
            <button onClick={() => setNetworkInfo(null)} className="absolute top-4 right-4 text-gray-500 hover:text-gray-900 dark:hover:text-white z-10">
              <X className="w-6 h-6" />
            </button>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center text-amber-600 dark:text-amber-500">
                <Wifi className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Thông tin Mạng LAN</h2>
            </div>
            
            {networkInfo.error ? (
              <div className="bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl p-4 mb-6">
                <p className="text-sm text-rose-600 dark:text-rose-400 whitespace-pre-line">{networkInfo.error}</p>
              </div>
            ) : (
              <div className="space-y-4 mb-6">
                <div className="bg-gray-50 dark:bg-black/20 rounded-xl p-4 border border-black/5 dark:border-white/5">
                  <p className="text-xs text-gray-500 mb-1">Địa chỉ IP thiết bị này:</p>
                  <p className="text-lg font-bold text-gray-900 dark:text-white font-mono">{networkInfo.ip}</p>
                </div>
                <div className="bg-emerald-50 dark:bg-emerald-500/10 rounded-xl p-4 border border-emerald-200 dark:border-emerald-500/20">
                  <p className="text-xs text-emerald-600/70 dark:text-emerald-400/70 mb-1">Default Gateway (Dải mạng máy in):</p>
                  <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400 font-mono">{networkInfo.defaultGateway}</p>
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Để cài đặt máy in, hãy sử dụng cùng dải mạng với Default Gateway ở trên. <br/><br/>
                  Ví dụ: Nếu Gateway là <strong>{networkInfo.defaultGateway}</strong>, IP của máy in sẽ thường là <strong>{networkInfo.defaultGateway?.substring(0, networkInfo.defaultGateway.lastIndexOf('.'))}.xxx</strong> (với xxx từ 2 đến 254).
                </p>
              </div>
            )}
            
            <button 
              onClick={() => setNetworkInfo(null)}
              className="w-full py-3 bg-gray-100 hover:bg-gray-200 dark:bg-white/5 dark:hover:bg-white/10 text-gray-900 dark:text-white rounded-xl font-bold transition-colors"
            >
              Đóng
            </button>
          </div>
        </div>
      )}

      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Settings className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
          Cài đặt hệ thống
        </h3>
        <button 
          onClick={handleSave}
          className="flex items-center gap-2 px-6 py-2 bg-emerald-500 text-white rounded-xl font-bold hover:bg-emerald-400 transition-all cursor-pointer"
        >
          <Save className="w-4 h-4" /> Lưu cài đặt
        </button>
      </div>

      {showSaved && (
        <div className="bg-emerald-500/20 border border-emerald-500/50 text-emerald-600 dark:text-emerald-500 px-4 py-3 rounded-xl text-sm font-bold animate-pulse">
          Đã lưu thay đổi thành công!
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Store Info */}
        {isAdmin && (
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6">
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-500">
              <Store className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Thông tin cửa hàng</h4>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Logo cửa hàng</label>
                <div className="flex gap-4 items-center p-4 bg-black/5 dark:bg-white/5 rounded-2xl border border-black/10 dark:border-white/10">
                  <div className="w-20 h-20 bg-gray-100 dark:bg-gray-800 rounded-xl overflow-hidden border border-black/10 dark:border-white/10 flex-shrink-0">
                    {localSettings.logo ? (
                      <img src={localSettings.logo} alt="Logo" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-600">
                        <Store className="w-8 h-8" />
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="inline-block px-4 py-2 bg-emerald-500 text-white rounded-lg text-xs font-bold hover:bg-emerald-400 transition-all cursor-pointer">
                      <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                      Tải ảnh lên
                    </label>
                    <p className="text-[10px] text-gray-500">Dung lượng tối đa 1MB. Ảnh sẽ tự động thu nhỏ.</p>
                  </div>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tên cửa hàng</label>
                <input 
                  type="text" 
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                  value={localSettings.storeName}
                  onChange={(e) => setLocalSettings({...localSettings, storeName: e.target.value})}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Địa chỉ</label>
                <input 
                  type="text" 
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                  value={localSettings.address}
                  onChange={(e) => setLocalSettings({...localSettings, address: e.target.value})}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Số điện thoại</label>
                <input 
                  type="text" 
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                  value={localSettings.phone}
                  onChange={(e) => setLocalSettings({...localSettings, phone: e.target.value})}
                />
              </div>
            </div>
          </div>
        )}

        {/* Printer Settings */}
        <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6 col-span-1 md:col-span-2">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-500">
              <Printer className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Cài đặt máy in</h4>
            </div>
          </div>

          <div className="flex items-center justify-between p-4 bg-emerald-500/5 border border-emerald-500/10 rounded-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-500">
                <Smartphone className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-gray-900 dark:text-white text-sm">In tự động (Silent Print)</p>
                <p className="text-[10px] text-gray-500">Tự động in ra máy in mặc định mà không hiện hộp thoại in của trình duyệt</p>
              </div>
            </div>
            <button 
              onClick={() => setLocalSettings({...localSettings, silentPrinting: !localSettings.silentPrinting})}
              className={cn(
                "w-12 h-6 rounded-full transition-all relative",
                localSettings.silentPrinting ? "bg-emerald-500" : "bg-gray-700"
              )}
            >
              <div className={cn(
                "absolute top-1 w-4 h-4 bg-white rounded-full transition-all",
                localSettings.silentPrinting ? "left-7" : "left-1"
              )} />
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button 
              onClick={handleAddPrinter}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-gray-900 dark:text-white rounded-xl text-xs font-bold hover:bg-blue-400 transition-all"
            >
              <Plus className="w-4 h-4" /> Thêm máy in
            </button>
            <button 
              onClick={handleNetworkScan}
              disabled={isScanningNetwork}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500/20 text-amber-600 dark:text-amber-500 rounded-xl text-xs font-bold hover:bg-amber-500/30 transition-all"
            >
              <Wifi className="w-4 h-4" /> {isScanningNetwork ? 'Đang quét...' : 'Quét Mạng'}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {localPrinters?.length === 0 ? (
              <div className="col-span-full p-12 border-2 border-dashed border-black/5 dark:border-white/5 rounded-3xl text-center space-y-2">
                <Printer className="w-12 h-12 text-gray-700 mx-auto" />
                <p className="text-gray-500 text-sm">Chưa có máy in nào được cài đặt</p>
              </div>
            ) : (
              localPrinters?.map(printer => (
                <div key={printer.id} className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-6 space-y-5 relative group">
                  <div className="flex justify-between items-center">
                    <div className={cn(
                      "px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-2",
                      (printer.status === 'connected' || testResult[printer.id] === 'success') ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-500" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                    )}>
                      <div className={cn("w-2 h-2 rounded-full", (printer.status === 'connected' || testResult[printer.id] === 'success') ? "bg-emerald-500" : "bg-gray-500")} />
                      {(printer.status === 'connected' || testResult[printer.id] === 'success') ? `Đã kết nối: ${printer.name || printer.ipAddress}` : "Chưa kết nối"}
                    </div>
                    
                    <button 
                      onClick={() => handleDeletePrinter(printer.id)}
                      className="p-2 text-gray-500 hover:text-rose-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase font-bold mb-1 block">Tên máy in</label>
                      <input 
                        type="text"
                        className="w-full bg-gray-100 dark:bg-black/20 border border-black/5 dark:border-white/5 rounded-xl py-3 px-4 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                        value={printer.name}
                        onChange={(e) => handleUpdatePrinter(printer.id, { name: e.target.value })}
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2">
                        <label className="text-[10px] text-gray-500 uppercase font-bold mb-1 block">Địa chỉ IP *</label>
                        <input 
                          type="text" inputMode="url"
                          placeholder="192.168.1.xxx"
                          className="w-full bg-gray-100 dark:bg-black/20 border border-black/5 dark:border-white/5 rounded-xl py-3 px-4 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 font-mono"
                          value={printer.ipAddress || ''}
                          onChange={(e) => handleUpdatePrinter(printer.id, { ipAddress: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase font-bold mb-1 block">Cổng (Port)</label>
                        <input 
                          type="number"
                          className="w-full bg-gray-100 dark:bg-black/20 border border-black/5 dark:border-white/5 rounded-xl py-3 px-4 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 font-mono"
                          value={printer.port || 9100}
                          onChange={(e) => handleUpdatePrinter(printer.id, { port: Number(e.target.value) })}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase font-bold mb-1 block">Khổ giấy</label>
                        <select 
                          className="w-full bg-gray-100 dark:bg-black/20 border border-black/5 dark:border-white/5 rounded-xl py-3 px-4 text-sm text-gray-900 dark:text-white focus:outline-none"
                          value={printer.paperSize}
                          onChange={(e) => handleUpdatePrinter(printer.id, { paperSize: e.target.value as any })}
                        >
                          <option value="80mm" className="bg-white dark:bg-[#1a1b1e]">K80 (80mm)</option>
                          <option value="58mm" className="bg-white dark:bg-[#1a1b1e]">K58 (58mm)</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-[10px] text-gray-500 uppercase font-bold mb-1 block">Sử dụng cho</label>
                        <select 
                          className="w-full bg-gray-100 dark:bg-black/20 border border-black/5 dark:border-white/5 rounded-xl py-3 px-4 text-sm text-gray-900 dark:text-white focus:outline-none"
                          value={printer.type}
                          onChange={(e) => handleUpdatePrinter(printer.id, { type: e.target.value as any })}
                        >
                          <option value="bill" className="bg-white dark:bg-[#1a1b1e]">Hóa đơn</option>
                          <option value="kitchen" className="bg-white dark:bg-[#1a1b1e]">Bếp</option>
                          <option value="both" className="bg-white dark:bg-[#1a1b1e]">Cả hai</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-600 dark:text-gray-400 font-bold">Bật máy in này</span>
                        <button 
                          onClick={() => handleUpdatePrinter(printer.id, { isEnabled: !printer.isEnabled })}
                          className={cn(
                            "w-12 h-6 rounded-full transition-all relative",
                            printer.isEnabled ? "bg-emerald-500" : "bg-gray-700"
                          )}
                        >
                          <div className={cn(
                            "absolute top-1 w-4 h-4 bg-white rounded-full transition-all",
                            printer.isEnabled ? "left-7" : "left-1"
                          )} />
                        </button>
                      </div>
                      {!printer.isDefault && (
                        <button 
                          onClick={() => handleSetDefault(printer.id)}
                          className="px-4 py-2 bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs font-bold rounded-xl hover:bg-black/10 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white transition-all"
                        >
                          Đặt mặc định
                        </button>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="pt-4 border-t border-black/5 dark:border-white/5 flex flex-col gap-3">
                      {(!printer.status || printer.status === 'disconnected') && testResult[printer.id] !== 'success' ? (
                        <button 
                          onClick={() => testConnection(printer.id)}
                          disabled={testingPrinter === printer.id}
                          className={cn("w-full py-4 font-bold rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50", testResult[printer.id] === 'error' ? "bg-rose-500/10 text-rose-600 hover:bg-rose-500/20" : "bg-blue-500 text-gray-900 dark:text-white hover:bg-blue-600")}
                        >
                          {testingPrinter === printer.id ? (
                             <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          ) : (
                             <Wifi className="w-5 h-5" />
                          )}
                          {testingPrinter === printer.id ? 'Đang kiểm tra kết nối...' : testResult[printer.id] === 'error' ? 'Kết nối thất bại - Thử lại' : 'Kiểm tra kết nối'}
                        </button>
                      ) : (
                        <div className="flex gap-3">
                          <button 
                            onClick={() => testConnection(printer.id)}
                            disabled={testingPrinter === printer.id}
                            className="flex-1 py-4 bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 font-bold rounded-xl hover:bg-emerald-500/20 transition-all flex items-center justify-center gap-2"
                          >
                            <Printer className="w-5 h-5" />
                            In thử
                          </button>
                          <button 
                            onClick={() => {
                              handleUpdatePrinter(printer.id, { status: 'connected' });
                              handleSave();
                            }}
                            className="flex-1 py-4 bg-emerald-500 text-white font-bold rounded-xl hover:bg-emerald-400 transition-all flex items-center justify-center gap-2"
                          >
                            <Save className="w-5 h-5" />
                            Lưu cấu hình
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Print Template Settings */}
        <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6 col-span-1 md:col-span-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-500">
              <Layout className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Cấu hình mẫu in</h4>
            </div>
            <div className="flex gap-2 bg-black/5 dark:bg-white/5 p-1 rounded-xl">
              <button 
                onClick={() => setActiveTemplateTab('payment')}
                className={cn(
                  "px-4 py-2 rounded-lg text-xs font-bold transition-all",
                  activeTemplateTab === 'payment' ? "bg-emerald-500 text-white" : "text-gray-500 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                Mẫu Hóa đơn
              </button>
              <button 
                onClick={() => setActiveTemplateTab('kitchen')}
                className={cn(
                  "px-4 py-2 rounded-lg text-xs font-bold transition-all",
                  activeTemplateTab === 'kitchen' ? "bg-emerald-500 text-white" : "text-gray-500 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                Mẫu Bếp
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {[
                  { id: 'showTime', label: 'Thời gian in', key: 'showTime' },
                  { id: 'showStaffName', label: 'Tên nhân viên', key: 'showStaffName' },
                  { id: 'showCustomerInfo', label: 'Tên/Loại khách', key: 'showCustomerInfo' },
                  { id: 'showStoreAddress', label: 'Địa chỉ quán', key: 'showStoreAddress' },
                  { id: 'showStorePhone', label: 'Số điện thoại', key: 'showStorePhone' },
                  { id: 'showLogo', label: 'Logo quán', key: 'showLogo' },
                  { id: 'showNote', label: 'Ghi chú món', key: 'showNote' }
                ].map(item => (
                  <button
                    key={item.id}
                    onClick={() => updateTemplateSetting(item.key as any, !currentTemplate[item.key as keyof typeof currentTemplate])}
                    className={cn(
                      "flex items-center justify-between p-4 rounded-2xl border transition-all",
                      currentTemplate[item.key as keyof typeof currentTemplate]
                        ? "bg-emerald-500/10 border-emerald-500 text-emerald-600 dark:text-emerald-500"
                        : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-500 hover:text-gray-400"
                    )}
                  >
                    <span className="text-xs font-bold">{item.label}</span>
                    {currentTemplate[item.key as keyof typeof currentTemplate] && <CheckCircle2 className="w-4 h-4" />}
                  </button>
                ))}
              </div>

              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-3 block">Kích thước chữ</label>
                <div className="flex gap-3">
                  {['small', 'medium', 'large'].map(size => (
                    <button
                      key={size}
                      onClick={() => updateTemplateSetting('fontSize', size)}
                      className={cn(
                        "flex-1 py-3 rounded-xl border text-xs font-bold transition-all uppercase",
                        currentTemplate.fontSize === size
                          ? "bg-emerald-500/10 border-emerald-500 text-emerald-600 dark:text-emerald-500"
                          : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-500 hover:bg-black/10 dark:hover:bg-white/10"
                      )}
                    >
                      {size === 'small' ? 'Nhỏ' : size === 'medium' ? 'Vừa' : 'Lớn'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-xl text-black space-y-4 min-h-[400px] flex flex-col font-mono">
              <div className="text-center border-b border-dashed border-gray-200 pb-4 space-y-1">
                {currentTemplate.showLogo && localSettings.logo && (
                  <img src={localSettings.logo} alt="Logo" className="w-12 h-12 mx-auto mb-2 grayscale" />
                )}
                <h5 className="font-bold text-lg uppercase">{localSettings.storeName}</h5>
                {currentTemplate.showStoreAddress && (
                  <p className="text-[10px] text-gray-600">{localSettings.address || 'Địa chỉ quán...'}</p>
                )}
                {currentTemplate.showStorePhone && (
                  <p className="text-[10px] text-gray-600">ĐT: {localSettings.phone || '0123.456.789'}</p>
                )}
              </div>

              <div className="flex-1 space-y-3">
                <div className="flex justify-between items-end border-b border-gray-100 pb-2">
                  <div>
                    <p className="text-xs font-bold">{activeTemplateTab === 'payment' ? 'HÓA ĐƠN TẠM TÍNH' : 'PHIẾU BẾP'}</p>
                    <p className="text-[9px] text-gray-500">Bàn: Bàn 01</p>
                  </div>
                  <div className="text-right">
                    {currentTemplate.showTime && (
                      <p className="text-[8px] text-gray-600 dark:text-gray-400">06/03/2026 10:30</p>
                    )}
                    {currentTemplate.showStaffName && (
                      <p className="text-[8px] text-gray-600 dark:text-gray-400">NV: Admin</p>
                    )}
                    {currentTemplate.showCustomerInfo && (
                      <p className="text-[8px] text-gray-600 dark:text-gray-400">KH: Nguyễn Văn A (VIP)</p>
                    )}
                  </div>
                </div>

                <table className={cn("w-full", currentTemplate.fontSize === 'small' ? 'text-[9px]' : currentTemplate.fontSize === 'medium' ? 'text-[10px]' : 'text-[12px]')}>
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left py-1">Tên món</th>
                      <th className="text-center py-1">SL</th>
                      {activeTemplateTab === 'payment' && <th className="text-right py-1">T.Tiền</th>}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="py-1">
                        Phở Bò Tái Lăn
                        {currentTemplate.showNote && <div className="text-[8px] italic text-gray-500">(Không hành)</div>}
                      </td>
                      <td className="text-center py-1">2</td>
                      {activeTemplateTab === 'payment' && <td className="text-right py-1">130.000</td>}
                    </tr>
                    <tr>
                      <td className="py-1">Coca Cola</td>
                      <td className="text-center py-1">1</td>
                      {activeTemplateTab === 'payment' && <td className="text-right py-1">15.000</td>}
                    </tr>
                  </tbody>
                </table>
              </div>

              {activeTemplateTab === 'payment' && (
                <div className="border-t border-dashed border-gray-200 pt-4 space-y-1">
                  <div className="flex justify-between text-xs font-bold">
                    <span>TỔNG CỘNG:</span>
                    <span>145.000đ</span>
                  </div>
                  <p className="text-[9px] text-center italic text-gray-500 pt-4">Cảm ơn Quý khách. Hẹn gặp lại!</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Admin Login */}
        {isAdmin ? (
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6">
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-500">
              <Shield className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Tài khoản Admin</h4>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tên đăng nhập</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input 
                    type="text" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 pl-10 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={localSettings.adminUsername}
                    onChange={(e) => setLocalSettings({...localSettings, adminUsername: e.target.value})}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Mật khẩu mới</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input 
                    type="password" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 pl-10 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    placeholder="Để trống nếu không đổi"
                    onChange={(e) => setLocalSettings({...localSettings, adminPassword: e.target.value})}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6">
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-500">
              <User className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Tài khoản cá nhân</h4>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tên đăng nhập</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input 
                    type="text" 
                    disabled
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 pl-10 pr-4 text-gray-600 dark:text-gray-400 cursor-not-allowed"
                    value={currentUser?.username || ''}
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Mật khẩu mới</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input 
                    type="password" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 pl-10 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    placeholder="Để trống nếu không đổi"
                    value={newPersonalPassword}
                    onChange={(e) => setNewPersonalPassword(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* System Data Management */}
        {isAdmin && (
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6">
            <div className="flex items-center gap-3 text-rose-600 dark:text-rose-500">
              <AlertCircle className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Quản lý dữ liệu hệ thống</h4>
            </div>
            <div className="space-y-4">
              <p className="text-xs text-gray-500">Các thao tác dưới đây sẽ ảnh hưởng trực tiếp đến dữ liệu vận hành. Hãy cẩn trọng.</p>
              <button 
                onClick={onResetAllTables}
                className="w-full py-3 bg-rose-500/10 text-rose-600 dark:text-rose-500 border border-rose-500/20 rounded-xl text-sm font-bold hover:bg-rose-500/20 transition-all flex items-center justify-center gap-2"
              >
                <Trash2 className="w-4 h-4" /> Đặt lại toàn bộ bàn (Xóa đơn treo)
              </button>
            </div>
          </div>
        )}

        {/* Kitchen Settings */}
        {isAdmin && (
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6 col-span-1 md:col-span-2">
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-500">
              <Bell className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Cài đặt vận hành</h4>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Thuế VAT (%)</label>
                <input 
                  type="number" 
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                  value={localSettings.vatPercent}
                  onChange={(e) => setLocalSettings({...localSettings, vatPercent: Number(e.target.value)})}
                />
              </div>
              <div className="flex items-center justify-between p-4 bg-black/5 dark:bg-white/5 rounded-2xl border border-black/10 dark:border-white/10">
                <div>
                  <p className="font-bold text-gray-900 dark:text-white text-sm">Chuông báo món mới</p>
                  <p className="text-[10px] text-gray-500">Phát âm thanh khi có đơn hàng mới</p>
                </div>
                <button 
                  onClick={() => setLocalSettings({...localSettings, kitchenBellEnabled: !localSettings.kitchenBellEnabled})}
                  className={cn(
                    "w-12 h-6 rounded-full transition-all relative",
                    localSettings.kitchenBellEnabled ? "bg-emerald-500" : "bg-gray-700"
                  )}
                >
                  <div className={cn(
                    "absolute top-1 w-4 h-4 bg-white rounded-full transition-all",
                    localSettings.kitchenBellEnabled ? "left-7" : "left-1"
                  )} />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Danh mục kho</label>
                <div className="flex flex-wrap gap-2 p-4 bg-black/5 dark:bg-white/5 rounded-2xl border border-black/10 dark:border-white/10">
                  {localSettings.inventoryCategories.map((cat, i) => (
                    <span key={i} className="px-3 py-1 bg-black/5 dark:bg-white/5 rounded-lg text-xs flex items-center gap-2">
                      {cat}
                      <button 
                        onClick={() => setLocalSettings({
                          ...localSettings, 
                          inventoryCategories: localSettings.inventoryCategories.filter((_, idx) => idx !== i)
                        })}
                        className="text-rose-600 dark:text-rose-500 hover:text-rose-400"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  <button 
                    onClick={() => {
                      const newCat = prompt('Nhập danh mục kho mới:');
                      if (newCat) setLocalSettings({
                        ...localSettings, 
                        inventoryCategories: [...localSettings.inventoryCategories, newCat]
                      });
                    }}
                    className="px-3 py-1 border border-dashed border-black/20 dark:border-white/20 rounded-lg text-xs hover:border-white/40"
                  >
                    + Thêm
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Hạng mục thu chi (Sổ quỹ)</label>
                <div className="flex flex-wrap gap-2 p-4 bg-black/5 dark:bg-white/5 rounded-2xl border border-black/10 dark:border-white/10">
                  {localSettings.cashCategories.map((cat, i) => (
                    <span key={i} className="px-3 py-1 bg-black/5 dark:bg-white/5 rounded-lg text-xs flex items-center gap-2">
                      {cat}
                      <button 
                        onClick={() => setLocalSettings({
                          ...localSettings, 
                          cashCategories: localSettings.cashCategories.filter((_, idx) => idx !== i)
                        })}
                        className="text-rose-600 dark:text-rose-500 hover:text-rose-400"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  <button 
                    onClick={() => {
                      const newCat = prompt('Nhập hạng mục mới:');
                      if (newCat) setLocalSettings({
                        ...localSettings, 
                        cashCategories: [...localSettings.cashCategories, newCat]
                      });
                    }}
                    className="px-3 py-1 border border-dashed border-black/20 dark:border-white/20 rounded-lg text-xs hover:border-white/40"
                  >
                    + Thêm
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6">
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-500">
              <QrCode className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Cấu hình in mã VietQR trên hóa đơn</h4>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Ngân Hàng Nhận Tiền</label>
                <input 
                  type="text" 
                  list="bank-list"
                  value={localSettings.bankCode || ''}
                  onChange={e => setLocalSettings(prev => ({ ...prev, bankCode: e.target.value }))}
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-emerald-500"
                  placeholder="Bấm để chọn ngân hàng hoặc nhập mã BIN"
                />
                <datalist id="bank-list">
                  <option value="VCB">Vietcombank</option>
                  <option value="CTG">VietinBank</option>
                  <option value="BIDV">BIDV</option>
                  <option value="VBA">Agribank</option>
                  <option value="MB">MBBank</option>
                  <option value="TCB">Techcombank</option>
                  <option value="ACB">ACB</option>
                  <option value="VPB">VPBank</option>
                  <option value="TPB">TPBank</option>
                  <option value="STB">Sacombank</option>
                  <option value="HDB">HDBank</option>
                  <option value="VIB">VIB</option>
                  <option value="SHB">SHB</option>
                  <option value="SSB">SeABank</option>
                  <option value="MSB">MSB</option>
                  <option value="OCB">OCB</option>
                  <option value="LPB">LPBank (LienVietPostBank)</option>
                  <option value="EIB">Eximbank</option>
                  <option value="VAB">VietABank</option>
                  <option value="SCB">SCB</option>
                  <option value="KLB">KienLongBank</option>
                  <option value="COOPBANK">Co-opBank (Ngân hàng Hợp tác xã Việt Nam)</option>
                  <option value="BAB">Bac A Bank (Bắc Á)</option>
                  <option value="BVB">BVBank (Bản Việt)</option>
                  <option value="NAB">Nam A Bank (Nam Á)</option>
                  <option value="VIETBANK">VietBank (Việt Nam Thương Tín)</option>
                  <option value="BVBANK">BaoViet Bank (Bảo Việt)</option>
                  <option value="NCB">NCB (Quốc Dân)</option>
                  <option value="PGB">PGBank (Thịnh vượng và Phát triển)</option>
                  <option value="SAIGONBANK">Saigonbank</option>
                  <option value="SHINHAN">Shinhan Bank</option>
                  <option value="WOORI">Woori Bank</option>
                </datalist>
                <p className="text-[10px] text-gray-500 italic mt-1">Gợi ý: Bấm đúp vào ô trống (hoặc mũi tên) để chọn ngân hàng, hoặc gõ tên viết tắt (VD: VCB, MB, COOPBANK), hoặc nhập mã BIN (6 số).</p>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Số Tài Khoản</label>
                <input 
                  type="text" 
                  value={localSettings.bankAccountNumber || ''}
                  onChange={e => setLocalSettings(prev => ({ ...prev, bankAccountNumber: e.target.value }))}
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-emerald-500"
                  placeholder="Nhập số tài khoản"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tên Chủ Tài Khoản</label>
                <input 
                  type="text" 
                  value={localSettings.bankAccountName || ''}
                  onChange={e => setLocalSettings(prev => ({ ...prev, bankAccountName: e.target.value }))}
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-emerald-500 uppercase"
                  placeholder="Nhập tên chủ tài khoản (Viết Hoa Không Dấu)"
                />
              </div>
              <p className="text-xs text-gray-500 italic mt-2">Thông tin tài khoản cửa hàng chỉ dùng để in mã VietQR trực tiếp lên phiếu hóa đơn cho khách quét chuyển khoản tại bàn.</p>
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-3xl p-8 space-y-6 col-span-1 md:col-span-2">
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-500">
              <MapPin className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Chấm công & Vị trí</h4>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tọa độ cửa hàng (Kinh độ, Vĩ độ)</label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input 
                      type="text" 
                      className="flex-1 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 relative z-0"
                      value={localSettings.storeLocation ? `${localSettings.storeLocation.lat}, ${localSettings.storeLocation.lng}` : ''}
                      readOnly
                      placeholder="Chưa cấu hình vị trí"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (navigator.geolocation) {
                          navigator.geolocation.getCurrentPosition((position) => {
                            setLocalSettings({
                              ...localSettings,
                              storeLocation: {
                                lat: position.coords.latitude,
                                lng: position.coords.longitude,
                                address: localSettings.storeLocation?.address || ''
                              }
                            });
                          }, (error) => {
                            alert('Không thể lấy vị trí: ' + error.message);
                          });
                        } else {
                          alert('Trình duyệt không hỗ trợ lấy vị trí.');
                        }
                      }}
                      className="px-4 py-3 sm:py-2 bg-emerald-500/20 text-emerald-600 dark:text-emerald-500 rounded-xl hover:bg-emerald-500/30 transition-all font-bold text-sm whitespace-nowrap cursor-pointer relative z-10 active:scale-95"
                    >
                      <MapPin className="w-4 h-4 inline-block mr-1" />
                      Lấy vị trí hiện tại
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">Cài đặt vị trí này để nhân viên có thể chấm công (giới hạn bán kính 30m).</p>
                </div>
                
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Mã bảo mật QR (Secret Key)</label>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      className="flex-1 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                      value={localSettings.attendanceQRSecret || ''}
                      onChange={(e) => setLocalSettings({...localSettings, attendanceQRSecret: e.target.value})}
                      placeholder="Nhập mã ngẫu nhiên..."
                    />
                    <button
                      onClick={() => {
                        const newSecret = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
                        setLocalSettings({...localSettings, attendanceQRSecret: newSecret});
                      }}
                      className="px-4 py-2 bg-black/10 dark:bg-white/10 text-gray-900 dark:text-white rounded-xl hover:bg-white/20 transition-all font-bold text-sm whitespace-nowrap"
                    >
                      Tạo mã mới
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col items-center justify-center bg-black/5 dark:bg-white/5 rounded-2xl p-6 border border-black/10 dark:border-white/10">
                <h5 className="font-bold mb-4 text-sm uppercase text-gray-600 dark:text-gray-400">Mã QR Chấm Công</h5>
                {localSettings.attendanceQRSecret ? (
                  <div className="flex flex-col items-center gap-4">
                    <div id="attendance-qr-code" className="bg-white p-4 rounded-xl">
                      <QRCodeSVG 
                        value={`${window.location.origin}/?checkin=true&storeId=${currentUser?.storeId}&code=${localSettings.attendanceQRSecret}`}
                        size={200}
                        level="H"
                        includeMargin={true}
                      />
                    </div>
                    <button
                      onClick={printQRCode}
                      className="flex items-center justify-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-all shadow-lg shadow-emerald-500/20"
                    >
                      <Printer className="w-5 h-5" />
                      In Mã QR
                    </button>
                  </div>
                ) : (
                  <div className="w-[200px] h-[200px] border-2 border-dashed border-black/20 dark:border-white/20 rounded-xl flex items-center justify-center text-gray-500 text-sm text-center p-4">
                    Vui lòng tạo mã bảo mật để hiển thị QR Code
                  </div>
                )}
                <p className="text-xs text-gray-500 mt-4 text-center">
                  In mã QR này hoặc hiển thị trên màn hình để nhân viên quét chấm công mỗi ngày.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Account Deletion / Danger Zone - Guideline 5.1.1(v) Requirement */}
        {isAdmin && onDeleteAccount && (
          <div className="bg-rose-500/5 dark:bg-rose-950/20 border border-rose-500/20 rounded-3xl p-8 space-y-4 col-span-1 md:col-span-2">
            <div className="flex items-center gap-3 text-rose-600 dark:text-rose-400">
              <AlertTriangle className="w-5 h-5" />
              <h4 className="font-bold uppercase text-xs tracking-wider">Quản lý tài khoản & Vùng nguy hiểm</h4>
            </div>
            
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
              <div className="space-y-1">
                <h5 className="font-bold text-gray-900 dark:text-white text-base">Xóa tài khoản & Toàn bộ dữ liệu</h5>
                <p className="text-xs text-gray-600 dark:text-gray-400 max-w-2xl leading-relaxed">
                  Hành động này sẽ xóa vĩnh viễn tài khoản quản trị <strong className="text-gray-900 dark:text-white font-mono">(@{currentUser?.username})</strong>, thông tin cửa hàng, thực đơn, danh sách nhân viên, dữ liệu kho và lịch sử bán hàng. Dữ liệu sau khi xóa sẽ không thể phục hồi theo quy định bảo mật quyền riêng tư của người dùng.
                </p>
              </div>
              
              <button
                type="button"
                onClick={() => {
                  setDeleteConfirmInput('');
                  setShowDeleteModal(true);
                }}
                className="px-6 py-3 bg-rose-600 hover:bg-rose-700 text-white rounded-xl font-bold text-sm transition-all shadow-lg shadow-rose-600/20 whitespace-nowrap flex items-center gap-2 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                Xóa tài khoản vĩnh viễn
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Account Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-lg rounded-3xl p-8 border border-rose-500/30 shadow-2xl space-y-6 animate-in fade-in zoom-in duration-200">
            <div className="w-14 h-14 bg-rose-100 dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-2xl flex items-center justify-center mx-auto">
              <AlertTriangle className="w-8 h-8" />
            </div>

            <div className="text-center space-y-2">
              <h3 className="text-xl font-bold text-rose-600 dark:text-rose-400">CẢNH BÁO: XÓA TÀI KHOẢN VĨNH VIỄN</h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                Bạn đang chuẩn bị yêu cầu xóa tài khoản quản trị <strong className="text-gray-900 dark:text-white font-mono">@{currentUser?.username}</strong> và toàn bộ dữ liệu của cửa hàng <strong className="text-gray-900 dark:text-white">"{localSettings.storeName}"</strong>.
              </p>
            </div>

            <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 rounded-2xl p-4 text-xs text-rose-700 dark:text-rose-300 space-y-2">
              <p className="font-bold flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 shrink-0" /> Những dữ liệu sau sẽ bị xóa vĩnh viễn ngay lập tức:
              </p>
              <ul className="list-disc pl-5 space-y-1 text-gray-700 dark:text-gray-300">
                <li>Tài khoản đăng nhập và mật khẩu của bạn cùng tất cả tài khoản nhân viên.</li>
                <li>Toàn bộ danh mục thực đơn, công thức định lượng và tồn kho.</li>
                <li>Tất cả hóa đơn, báo cáo doanh thu, sổ quỹ và dữ liệu chấm công.</li>
                <li>Hành động này <strong className="underline">KHÔNG THỂ HOÀN TÁC</strong> sau khi xác nhận.</li>
              </ul>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-gray-600 dark:text-gray-400 block">
                Để xác nhận, vui lòng nhập chữ <strong className="text-rose-600 font-bold">XÓA TÀI KHOẢN</strong> vào ô bên dưới:
              </label>
              <input
                type="text"
                value={deleteConfirmInput}
                onChange={(e) => setDeleteConfirmInput(e.target.value)}
                placeholder="Nhập: XÓA TÀI KHOẢN"
                className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-3 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-rose-500 font-bold"
              />
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                disabled={isDeletingAccount}
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-700 dark:text-gray-300 font-bold hover:bg-black/5 dark:hover:bg-white/5 transition-all cursor-pointer"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={deleteConfirmInput.trim().toUpperCase() !== 'XÓA TÀI KHOẢN' || isDeletingAccount}
                onClick={async () => {
                  if (onDeleteAccount) {
                    setIsDeletingAccount(true);
                    try {
                      await onDeleteAccount();
                    } finally {
                      setIsDeletingAccount(false);
                      setShowDeleteModal(false);
                    }
                  }
                }}
                className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold transition-all shadow-lg shadow-rose-600/30 flex items-center justify-center gap-2 cursor-pointer"
              >
                {isDeletingAccount ? 'Đang xóa...' : 'Xác nhận xóa'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default SettingsView;
