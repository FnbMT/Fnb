import React, { useState } from 'react';
import { Package, Plus, Search, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, X, Edit2, Trash2, ClipboardCheck, History, List, ChevronRight, Info } from 'lucide-react';
import { MenuItem, InventoryAudit, AuditItem, StockCardEntry, User } from '../types';
import { cn } from '../lib/utils';
import { CurrencyInput } from './CurrencyInput';
import { format } from 'date-fns';

export const InventoryView = ({ menu, onImportStock, onAddItem, onUpdateItem, onDeleteItem, categories, onUpdateCategories, audits, onAudit, stockCard, currentUser }: { 
  menu: MenuItem[], 
  onImportStock: (itemId: string, quantity: number, unitPrice: number) => void,
  onAddItem: (item: MenuItem) => void,
  onUpdateItem: (item: MenuItem) => void,
  onDeleteItem: (id: string) => void,
  categories: string[],
  onUpdateCategories: (cats: string[]) => void,
  audits: InventoryAudit[],
  onAudit: (audit: InventoryAudit) => void,
  stockCard: StockCardEntry[],
  currentUser: User | null
}) => {
  const [activeTab, setActiveTab] = useState<'items' | 'audit' | 'history' | 'stock_card'>('items');
  const [search, setSearch] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showAddNew, setShowAddNew] = useState(false);
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [importData, setImportData] = useState({ itemId: '', quantity: 0, unitPrice: 0 });
  const [newItem, setNewItem] = useState({ name: '', unit: 'kg', category: categories[0] || 'Nguyên liệu', costPrice: 0, minStock: 10, trackStock: true });
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCat, setNewCat] = useState('');
  
  // Audit state
  const [auditItems, setAuditItems] = useState<Record<string, number>>({});
  const [showAuditConfirm, setShowAuditConfirm] = useState(false);
  const [viewingAudit, setViewingAudit] = useState<InventoryAudit | null>(null);

  // Stock Card state
  const [selectedStockCardItem, setSelectedStockCardItem] = useState<string | null>(null);
  const [stockStartDate, setStockStartDate] = useState<string>('');
  const [stockEndDate, setStockEndDate] = useState<string>('');

  const inventoryItems = menu.filter(item => item.isInventory || item.type === 'goods');
  
  const totalInventoryValue = inventoryItems.reduce((sum, item) => sum + ((item.stock || 0) * (item.costPrice || 0)), 0);
  
  const filtered = inventoryItems.filter(item => 
    item.name.toLowerCase().includes(search.toLowerCase()) ||
    item.code.toLowerCase().includes(search.toLowerCase())
  );

  const handleImport = () => {
    if (!importData.itemId || importData.quantity <= 0) return;
    onImportStock(importData.itemId, importData.quantity, importData.unitPrice);
    setShowImport(false);
    setImportData({ itemId: '', quantity: 0, unitPrice: 0 });
  };

  const handleSaveItem = () => {
    if (!newItem.name) return;
    
    if (editingItem) {
      onUpdateItem({
        ...editingItem,
        name: newItem.name,
        unit: newItem.unit,
        category: newItem.category,
        costPrice: newItem.costPrice,
        minStock: newItem.minStock,
        trackStock: newItem.trackStock
      });
    } else {
      const count = menu.filter(i => i.code.startsWith('NL')).length + 1;
      const code = `NL${count.toString().padStart(3, '0')}`;

      onAddItem({
        id: Math.random().toString(36).substr(2, 9),
        code,
        name: newItem.name,
        unit: newItem.unit,
        category: newItem.category,
        price: 0,
        costPrice: newItem.costPrice,
        minStock: newItem.minStock,
        status: 'available',
        stock: 0,
        type: 'goods',
        isInventory: true,
        trackStock: newItem.trackStock
      });
    }
    setShowAddNew(false);
    setEditingItem(null);
    setNewItem({ name: '', unit: 'kg', category: 'Nguyên liệu', costPrice: 0, minStock: 10, trackStock: true });
  };

  const handleConfirmAudit = () => {
    if (!currentUser) return;

    const auditData: AuditItem[] = inventoryItems.map(item => {
      const actual = auditItems[item.id] ?? item.stock;
      return {
        itemId: item.id,
        itemName: item.name,
        systemStock: item.stock,
        actualStock: actual,
        discrepancy: actual - item.stock,
        unit: item.unit
      };
    }).filter(item => item.discrepancy !== 0 || auditItems[item.itemId] !== undefined);

    if (auditData.length === 0) {
      alert("Không có thay đổi nào để kiểm kho!");
      return;
    }

    onAudit({
      id: Math.random().toString(36).substr(2, 9),
      date: new Date().toISOString(),
      items: auditData,
      staffId: currentUser.id,
      staffName: currentUser.name
    });

    setAuditItems({});
    setShowAuditConfirm(false);
    setActiveTab('history');
  };

  const renderItems = () => (
    <div className="space-y-6">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input 
          type="text" 
          placeholder="Tìm theo mã hàng hoặc tên..."
          className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 pl-10 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[800px] text-sm">
          <thead>
            <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium sticky left-0 z-10 bg-[#f9fafb] dark:bg-[#1a1b1e] shadow-[1px_0_0_0_rgba(0,0,0,0.1)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">Tên mặt hàng</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium">Mã hàng</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium">Đơn vị</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Tồn kho</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Giá vốn</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium">Trạng thái</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5 dark:divide-white/5">
            {filtered.map(item => (
              <tr key={item.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                <td className="px-4 py-3 md:px-6 md:py-4 sticky left-0 z-10 bg-[#f9fafb] dark:bg-[#1a1b1e] group-hover:bg-[#f3f4f6] dark:group-hover:bg-[#25262b] shadow-[1px_0_0_0_rgba(0,0,0,0.1)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">
                  <p className="font-medium text-gray-900 dark:text-white">{item.name}</p>
                  <p className="text-xs text-gray-500">{item.category}</p>
                </td>
                <td className="px-4 py-3 md:px-6 md:py-4 font-mono text-xs text-gray-600 dark:text-gray-400">{item.code}</td>
                <td className="px-4 py-3 md:px-6 md:py-4 text-sm">{item.unit}</td>
                <td className="px-4 py-3 md:px-6 md:py-4 text-right font-mono">
                  {item.trackStock !== false ? (
                    <span className={cn(
                      "px-2 py-1 rounded-lg",
                      item.stock < (item.minStock || 10) ? "bg-rose-500/20 text-rose-600 dark:text-rose-500" : "text-emerald-600 dark:text-emerald-400"
                    )}>
                      {item.stock.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                    </span>
                  ) : (
                    <span className="text-gray-500 text-xs">-</span>
                  )}
                </td>
                <td className="px-4 py-3 md:px-6 md:py-4 text-right font-mono text-sm">
                  {item.costPrice.toLocaleString()}đ
                </td>
                <td className="px-4 py-3 md:px-6 md:py-4">
                  {item.trackStock !== false ? (
                    item.stock < (item.minStock || 10) ? (
                      <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
                        <AlertTriangle className="w-3 h-3" /> Sắp hết hàng
                      </div>
                    ) : (
                      <span className="text-xs text-emerald-600 dark:text-emerald-500">Bình thường</span>
                    )
                  ) : (
                    <span className="text-xs text-gray-500">Không theo dõi</span>
                  )}
                </td>
                <td className="px-4 py-3 md:px-6 md:py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <button 
                      onClick={() => {
                        setEditingItem(item);
                        setNewItem({ 
                          name: item.name, 
                          unit: item.unit, 
                          category: item.category, 
                          costPrice: item.costPrice,
                          minStock: item.minStock || 10,
                          trackStock: item.trackStock ?? true
                        });
                        setShowAddNew(true);
                      }}
                      className="p-2 text-gray-600 dark:text-gray-400 hover:text-emerald-500 transition-colors"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => onDeleteItem(item.id)}
                      className="p-2 text-gray-600 dark:text-gray-400 hover:text-rose-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderAudit = () => (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-emerald-500/10 border border-emerald-500/20 p-6 rounded-2xl">
        <div>
          <h4 className="text-lg font-bold text-emerald-600 dark:text-emerald-500">Kiểm kho thực tế</h4>
          <p className="text-sm text-gray-600 dark:text-gray-400">Nhập số lượng tồn kho thực tế để đối soát với hệ thống</p>
        </div>
        <button 
          onClick={() => setShowAuditConfirm(true)}
          className="px-6 py-3 bg-emerald-500 text-white font-bold rounded-xl hover:bg-emerald-400 transition-all cursor-pointer"
        >
          Xác nhận kiểm kho
        </button>
      </div>

      <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[800px] text-sm">
          <thead>
            <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium sticky left-0 z-10 bg-[#f9fafb] dark:bg-[#1a1b1e] shadow-[1px_0_0_0_rgba(0,0,0,0.1)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">Mặt hàng</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Tồn hệ thống</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-center w-48">Tồn thực tế</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Chênh lệch</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5 dark:divide-white/5">
            {inventoryItems.map(item => {
              const actual = auditItems[item.id] ?? item.stock;
              const diff = actual - item.stock;
              return (
                <tr key={item.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                  <td className="px-4 py-3 md:px-6 md:py-4 sticky left-0 z-10 bg-[#f9fafb] dark:bg-[#1a1b1e] group-hover:bg-[#f3f4f6] dark:group-hover:bg-[#25262b] shadow-[1px_0_0_0_rgba(0,0,0,0.1)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">
                    <p className="font-medium text-gray-900 dark:text-white">{item.name}</p>
                    <p className="text-xs text-gray-500">{item.unit}</p>
                  </td>
                  <td className="px-4 py-3 md:px-6 md:py-4 text-right font-mono text-gray-600 dark:text-gray-400">
                    {item.stock.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                  </td>
                  <td className="px-4 py-3 md:px-6 md:py-4">
                    <input 
                      type="number" 
                      className="w-full bg-gray-100 dark:bg-black/20 border border-black/10 dark:border-white/10 rounded-lg py-2 px-3 text-center text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                      value={auditItems[item.id] ?? ''}
                      placeholder={item.stock.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                      onChange={(e) => setAuditItems({...auditItems, [item.id]: e.target.value === '' ? item.stock : Number(e.target.value)})}
                    />
                  </td>
                  <td className="px-4 py-3 md:px-6 md:py-4 text-right font-mono font-bold">
                    {diff === 0 ? (
                      <span className="text-gray-500">0</span>
                    ) : diff > 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-500">+{diff.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                    ) : (
                      <span className="text-rose-600 dark:text-rose-500">{diff.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderHistory = () => (
    <div className="space-y-4">
      <div className="bg-amber-500/10 border border-amber-500/20 p-4 rounded-xl flex items-center gap-3">
        <Info className="w-5 h-5 text-amber-600 dark:text-amber-500" />
        <p className="text-sm text-amber-200/80">Lịch sử kiểm kho được lưu trữ trong vòng 45 ngày để tối ưu dung lượng.</p>
      </div>

      <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[800px] text-sm">
          <thead>
            <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium sticky left-0 z-10 bg-[#f9fafb] dark:bg-[#1a1b1e] shadow-[1px_0_0_0_rgba(0,0,0,0.1)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">Thời gian</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium">Nhân viên</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Số mặt hàng lệch</th>
              <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5 dark:divide-white/5">
            {audits.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-gray-500 italic">Chưa có lịch sử kiểm kho</td>
              </tr>
            ) : (
              audits.map(audit => (
                <tr key={audit.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                  <td className="px-4 py-3 md:px-6 md:py-4 text-sm sticky left-0 z-10 bg-[#f9fafb] dark:bg-[#1a1b1e] group-hover:bg-[#f3f4f6] dark:group-hover:bg-[#25262b] shadow-[1px_0_0_0_rgba(0,0,0,0.1)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">
                    {format(new Date(audit.date), 'HH:mm dd/MM/yyyy')}
                  </td>
                  <td className="px-4 py-3 md:px-6 md:py-4 text-sm">{audit.staffName}</td>
                  <td className="px-4 py-3 md:px-6 md:py-4 text-right font-mono text-rose-600 dark:text-rose-400">
                    {audit.items.filter(i => i.discrepancy !== 0).length}
                  </td>
                  <td className="px-4 py-3 md:px-6 md:py-4 text-right">
                    <button 
                      onClick={() => setViewingAudit(audit)}
                      className="text-emerald-600 dark:text-emerald-500 hover:text-emerald-400 text-sm font-bold flex items-center gap-1 ml-auto"
                    >
                      Xem chi tiết <ChevronRight className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderStockCard = () => {
    let filteredEntries = selectedStockCardItem 
      ? stockCard.filter(e => e.itemId === selectedStockCardItem)
      : stockCard;

    if (stockStartDate) {
      filteredEntries = filteredEntries.filter(e => e.date.substring(0, 10) >= stockStartDate);
    }
    if (stockEndDate) {
      filteredEntries = filteredEntries.filter(e => e.date.substring(0, 10) <= stockEndDate);
    }

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex-1 min-w-[250px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <select 
              className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 pl-10 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 appearance-none"
              value={selectedStockCardItem || ''}
              onChange={(e) => setSelectedStockCardItem(e.target.value || null)}
            >
              <option value="" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">-- Tất cả mặt hàng --</option>
              {inventoryItems.map(item => (
                <option key={item.id} value={item.id} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">{item.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 items-center text-sm">
            <span className="text-gray-600 dark:text-gray-400">Từ:</span>
            <input 
              type="date"
              className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-3 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
              value={stockStartDate}
              onChange={(e) => setStockStartDate(e.target.value)}
            />
          </div>
          <div className="flex gap-2 items-center text-sm">
            <span className="text-gray-600 dark:text-gray-400">Đến:</span>
            <input 
              type="date"
              className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-2 px-3 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
              value={stockEndDate}
              onChange={(e) => setStockEndDate(e.target.value)}
            />
          </div>
        </div>

        <div className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl overflow-hidden overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px] text-sm">
            <thead>
              <tr className="bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 md:px-6 md:py-4 font-medium sticky left-0 z-10 bg-[#f9fafb] dark:bg-[#1a1b1e] shadow-[1px_0_0_0_rgba(0,0,0,0.1)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">Mặt hàng</th>
                <th className="px-4 py-3 md:px-6 md:py-4 font-medium">Thời gian</th>
                <th className="px-4 py-3 md:px-6 md:py-4 font-medium">Loại</th>
                <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Thay đổi</th>
                <th className="px-4 py-3 md:px-6 md:py-4 font-medium text-right">Tồn cuối</th>
                <th className="px-4 py-3 md:px-6 md:py-4 font-medium">Ghi chú</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 dark:divide-white/5">
              {filteredEntries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-gray-500 italic">Không có dữ liệu thẻ kho</td>
                </tr>
              ) : (
                filteredEntries.map(entry => (
                  <tr key={entry.id} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                    <td className="px-4 py-3 md:px-6 md:py-4 text-sm font-medium text-gray-900 dark:text-white sticky left-0 z-10 bg-[#f9fafb] dark:bg-[#1a1b1e] group-hover:bg-[#f3f4f6] dark:group-hover:bg-[#25262b] shadow-[1px_0_0_0_rgba(0,0,0,0.1)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">
                      {entry.itemName}
                    </td>
                    <td className="px-4 py-3 md:px-6 md:py-4 text-xs text-gray-600 dark:text-gray-400">
                      {format(new Date(entry.date), 'HH:mm dd/MM/yyyy')}
                    </td>
                    <td className="px-4 py-3 md:px-6 md:py-4">
                      <span className={cn(
                        "px-2 py-1 rounded text-[10px] uppercase font-bold",
                        entry.type === 'sale' ? "bg-blue-500/20 text-blue-600 dark:text-blue-500" :
                        entry.type === 'import' ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-500" :
                        entry.type === 'audit' ? "bg-amber-500/20 text-amber-600 dark:text-amber-500" :
                        "bg-rose-500/20 text-rose-600 dark:text-rose-500"
                      )}>
                        {entry.type === 'sale' ? 'Bán hàng' : 
                         entry.type === 'import' ? 'Nhập kho' :
                         entry.type === 'audit' ? 'Kiểm kho' : 'Khác'}
                      </span>
                    </td>
                    <td className="px-4 py-3 md:px-6 md:py-4 text-right font-mono font-bold">
                      {entry.change > 0 ? (
                        <span className="text-emerald-600 dark:text-emerald-500">+{entry.change.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                      ) : (
                        <span className="text-rose-600 dark:text-rose-500">{entry.change.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 md:px-6 md:py-4 text-right font-mono font-bold text-gray-900 dark:text-white">
                      {entry.remaining.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                    </td>
                    <td className="px-4 py-3 md:px-6 md:py-4 text-xs text-gray-500 max-w-xs truncate">
                      {entry.note}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto">
      <div className="flex flex-col md:flex-row md:justify-between items-start md:items-center gap-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Package className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
            Quản lý kho & Nguyên liệu
          </h3>
          <div className="bg-emerald-500/20 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-emerald-600 dark:text-emerald-500 text-sm font-bold flex items-center gap-2">
            <span>Tổng giá trị tồn kho:</span>
            <span className="font-mono">{totalInventoryValue.toLocaleString('vi-VN')}đ</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={() => {
              setEditingItem(null);
              setNewItem({ name: '', unit: 'kg', category: categories[0] || 'Nguyên liệu', costPrice: 0, minStock: 10, trackStock: true });
              setShowAddNew(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-sm hover:bg-black/10 dark:hover:bg-white/10 transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4" /> Thêm mặt hàng
          </button>
          <button 
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-bold hover:bg-emerald-400 transition-all cursor-pointer"
          >
            <ArrowDownToLine className="w-4 h-4" /> Nhập kho
          </button>
        </div>
      </div>

      <div className="flex gap-4 border-b border-black/5 dark:border-white/5">
        {[
          { id: 'items', label: 'Danh mục hàng', icon: List },
          { id: 'audit', label: 'Kiểm kho', icon: ClipboardCheck },
          { id: 'history', label: 'Lịch sử kiểm', icon: History },
          { id: 'stock_card', label: 'Thẻ kho', icon: History }
        ].map(tab => (
          <button 
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={cn(
              "pb-4 px-2 text-sm font-bold transition-all border-b-2 flex items-center gap-2",
              activeTab === tab.id ? "border-emerald-500 text-emerald-600 dark:text-emerald-500" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'items' && renderItems()}
      {activeTab === 'audit' && renderAudit()}
      {activeTab === 'history' && renderHistory()}
      {activeTab === 'stock_card' && renderStockCard()}

      {/* Modals */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">Nhập kho hàng hóa</h3>
              <button onClick={() => setShowImport(false)} className="text-gray-500 hover:text-gray-900 dark:hover:text-white"><X className="w-6 h-6" /></button>
            </div>
            <div className="space-y-4">
              <div className="relative">
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Mặt hàng <span className="text-rose-600 dark:text-rose-500">*</span></label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input 
                    type="text" 
                    placeholder="Tìm mặt hàng để nhập..."
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 pl-10 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    onChange={(e) => {
                      const val = e.target.value.toLowerCase();
                      const found = menu.find(i => i.isInventory && (i.name.toLowerCase().includes(val) || i.code.toLowerCase().includes(val)));
                      if (found) setImportData({...importData, itemId: found.id});
                    }}
                  />
                </div>
                <select 
                  className="w-full mt-2 bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                  value={importData.itemId}
                  onChange={(e) => setImportData({...importData, itemId: e.target.value})}
                >
                  <option value="" className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">-- Hoặc chọn từ danh sách --</option>
                  {inventoryItems.map(item => (
                    <option key={item.id} value={item.id} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">{item.code} - {item.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Số lượng nhập <span className="text-rose-600 dark:text-rose-500">*</span></label>
                <input 
                  type="number" 
                  step="0.1"
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                  value={importData.quantity}
                  onChange={(e) => setImportData({...importData, quantity: Number(e.target.value)})}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Giá tiền / 1 đơn vị <span className="text-rose-600 dark:text-rose-500">*</span></label>
                <CurrencyInput className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50" value={importData.unitPrice || ''} onChange={val => setImportData({...importData, unitPrice: Number(val)})} />
              </div>
              <div className="p-4 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                <p className="text-xs text-emerald-600 dark:text-emerald-500 uppercase font-bold mb-1">Tổng tiền nhập</p>
                <p className="text-2xl font-mono font-bold text-emerald-600 dark:text-emerald-400">
                  {(importData.quantity * importData.unitPrice).toLocaleString()}đ
                </p>
              </div>
            </div>
            <div className="flex gap-3 pt-4">
              <button 
                onClick={() => setShowImport(false)}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-600 dark:text-gray-400 font-bold hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Hủy
              </button>
              <button 
                onClick={handleImport}
                className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-400 cursor-pointer"
              >
                Xác nhận nhập
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">{editingItem ? 'Chỉnh sửa mặt hàng' : 'Thêm mặt hàng mới'}</h3>
              <button onClick={() => setShowAddNew(false)} className="text-gray-500 hover:text-gray-900 dark:hover:text-white"><X className="w-6 h-6" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Tên mặt hàng <span className="text-rose-600 dark:text-rose-500">*</span></label>
                <input 
                  type="text" 
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                  value={newItem.name}
                  onChange={(e) => setNewItem({...newItem, name: e.target.value})}
                  placeholder="VD: Trân châu trắng, Sữa tươi..."
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Đơn vị <span className="text-rose-600 dark:text-rose-500">*</span></label>
                  <input 
                    type="text" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newItem.unit}
                    onChange={(e) => setNewItem({...newItem, unit: e.target.value})}
                    placeholder="kg, lít, thùng..."
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Nhóm <span className="text-rose-600 dark:text-rose-500">*</span></label>
                  <div className="flex gap-2">
                    <select 
                      className="flex-1 bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                      value={newItem.category}
                      onChange={(e) => setNewItem({...newItem, category: e.target.value})}
                    >
                      {categories.map(cat => (
                        <option key={cat} value={cat} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">{cat}</option>
                      ))}
                    </select>
                    <button 
                      onClick={() => setShowAddCat(true)}
                      className="p-3 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-emerald-600 dark:text-emerald-500 hover:bg-black/10 dark:hover:bg-white/10"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Giá vốn mặc định <span className="text-rose-600 dark:text-rose-500">*</span></label>
                  <CurrencyInput className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50" value={newItem.costPrice || ''} onChange={val => setNewItem({...newItem, costPrice: Number(val)})} />
                </div>
                <div>
                  <label className="text-xs text-gray-500 uppercase font-bold mb-1 block">Cảnh báo khi dưới <span className="text-rose-600 dark:text-rose-500">*</span></label>
                  <input 
                    type="number" 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    value={newItem.minStock}
                    onChange={(e) => setNewItem({...newItem, minStock: Number(e.target.value)})}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between p-4 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl">
                <div>
                  <p className="font-bold text-gray-900 dark:text-white text-sm">Quản lý tồn kho</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">Theo dõi số lượng và cảnh báo sắp hết hàng</p>
                </div>
                <button
                  type="button"
                  onClick={() => setNewItem({...newItem, trackStock: !newItem.trackStock})}
                  className={cn(
                    "w-12 h-6 rounded-full transition-colors relative cursor-pointer",
                    newItem.trackStock ? "bg-emerald-500" : "bg-gray-600"
                  )}
                >
                  <span className={cn(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-all",
                    newItem.trackStock ? "left-7" : "left-1"
                  )} />
                </button>
              </div>
            </div>
            <div className="flex gap-3 pt-4">
              <button 
                onClick={() => setShowAddNew(false)}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-600 dark:text-gray-400 font-bold hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Hủy
              </button>
              <button 
                onClick={handleSaveItem}
                className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-400 cursor-pointer"
              >
                {editingItem ? 'Cập nhật' : 'Xác nhận'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAuditConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white">Xác nhận kiểm kho</h3>
            <p className="text-gray-600 dark:text-gray-400">Hệ thống sẽ cập nhật số lượng tồn kho theo số lượng thực tế bạn đã nhập. Bạn có chắc chắn?</p>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowAuditConfirm(false)}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-600 dark:text-gray-400 font-bold hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Hủy
              </button>
              <button 
                onClick={handleConfirmAudit}
                className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-400 cursor-pointer"
              >
                Xác nhận
              </button>
            </div>
          </div>
        </div>
      )}

      {viewingAudit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-2xl rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6 max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white">Chi tiết kiểm kho</h3>
                <p className="text-xs text-gray-500">{format(new Date(viewingAudit.date), 'HH:mm dd/MM/yyyy')} - NV: {viewingAudit.staffName}</p>
              </div>
              <button onClick={() => setViewingAudit(null)} className="text-gray-500 hover:text-gray-900 dark:hover:text-white"><X className="w-6 h-6" /></button>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[800px] text-sm">
                <thead>
                  <tr className="text-gray-500 text-[10px] uppercase font-bold border-b border-black/5 dark:border-white/5">
                    <th className="pb-3 sticky left-0 z-10 bg-white dark:bg-[#1a1b1e]">Mặt hàng</th>
                    <th className="pb-3 text-right">Hệ thống</th>
                  <th className="pb-3 text-right">Thực tế</th>
                  <th className="pb-3 text-right">Chênh lệch</th>
                </tr>
              </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {viewingAudit.items.map((item, i) => (
                    <tr key={i} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors group">
                      <td className="py-3 text-sm text-gray-900 dark:text-white sticky left-0 z-10 bg-white dark:bg-[#1a1b1e] group-hover:bg-[#f9fafb] dark:group-hover:bg-[#25262b] shadow-[1px_0_0_0_rgba(0,0,0,0.05)] dark:shadow-[1px_0_0_0_rgba(255,255,255,0.05)]">{item.itemName}</td>
                      <td className="py-3 text-right font-mono text-gray-600 dark:text-gray-400">{item.systemStock.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                    <td className="py-3 text-right font-mono text-gray-900 dark:text-white">{item.actualStock.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                    <td className="py-3 text-right font-mono font-bold">
                      {item.discrepancy > 0 ? (
                        <span className="text-emerald-600 dark:text-emerald-500">+{item.discrepancy.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                      ) : (
                        <span className="text-rose-600 dark:text-rose-500">{item.discrepancy.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      )}

      {showAddCat && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-sm rounded-3xl p-8 border border-black/10 dark:border-white/10 shadow-2xl space-y-6">
            <h3 className="text-xl font-bold text-gray-900 dark:text-white">Thêm nhóm hàng kho</h3>
            <input 
              type="text" 
              className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 px-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
              placeholder="Tên nhóm (VD: Rau củ, Gia vị...)"
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
            />
            <div className="flex gap-3">
              <button 
                onClick={() => setShowAddCat(false)}
                className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-600 dark:text-gray-400 font-bold hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Hủy
              </button>
              <button 
                onClick={() => {
                  if (newCat) {
                    onUpdateCategories([...categories, newCat]);
                    setNewCat('');
                    setShowAddCat(false);
                  }
                }}
                className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold hover:bg-emerald-400 cursor-pointer"
              >
                Thêm nhóm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
