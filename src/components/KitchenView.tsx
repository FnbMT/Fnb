import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  ChefHat, 
  Clock, 
  CheckCircle2, 
  Play, 
  RotateCcw, 
  Printer, 
  Volume2, 
  VolumeX, 
  Layers, 
  Flame, 
  BellRing, 
  CheckCheck,
  Search,
  Filter,
  Utensils,
  Power
} from 'lucide-react';
import { Table, OrderSession, OrderItem, User } from '../types';

interface KitchenViewProps {
  tables: Table[];
  onUpdateTableOrders: (tableId: string, updatedOrders: OrderSession[]) => Promise<void>;
  onPrint?: (data: any) => void;
  currentUser?: User | null;
  kitchenEnabled?: boolean;
  onToggleKitchenEnabled?: (enabled: boolean) => void;
}

// Kitchen-specific live timer that shows urgency colors
const KitchenTimer = ({ startTime }: { startTime: string | undefined }) => {
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [display, setDisplay] = useState('--:--');

  useEffect(() => {
    if (!startTime) return;
    const updateTime = () => {
      const start = new Date(startTime).getTime();
      const now = Date.now();
      const diffSec = Math.max(0, Math.floor((now - start) / 1000));
      const mins = Math.floor(diffSec / 60);
      const secs = diffSec % 60;
      setElapsedMinutes(mins);
      setDisplay(`${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  // Color-coded urgency
  let badgeColor = "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  if (elapsedMinutes >= 20) {
    badgeColor = "bg-rose-500/20 text-rose-600 dark:text-rose-400 border-rose-500/40 animate-pulse font-bold";
  } else if (elapsedMinutes >= 10) {
    badgeColor = "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 font-semibold";
  }

  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border ${badgeColor}`}>
      <Clock className="w-3.5 h-3.5" />
      <span>{display}</span>
    </span>
  );
};

// Play pleasant dual-chime audio notification when new orders arrive
function playKitchenNotificationSound() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;
    
    // First tone (D5: 587.33Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.4);

    // Second tone (A5: 880Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.15);
    gain2.gain.setValueAtTime(0.3, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.7);
  } catch (e) {
    console.warn('Audio notification error:', e);
  }
}

export const KitchenView: React.FC<KitchenViewProps> = ({
  tables,
  onUpdateTableOrders,
  onPrint,
  currentUser,
  kitchenEnabled = true,
  onToggleKitchenEnabled
}) => {
  const [viewMode, setViewMode] = useState<'tickets' | 'aggregate'>('tickets');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'cooking' | 'ready' | 'completed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    return localStorage.getItem('kitchen_sound_enabled') !== 'false';
  });

  // Track known order IDs to sound alarm on new incoming orders
  const knownOrderIdsRef = useRef<Set<string>>(new Set());
  const isFirstRender = useRef(true);

  // Extract all active orders from tables with their parent table info
  const allKitchenOrders = useMemo(() => {
    const list: {
      table: Table;
      order: OrderSession;
      orderIndex: number;
    }[] = [];

    tables.forEach(table => {
      // Include tables that have active orders
      const orders = (table.orders || []).filter(o => o.status !== 'paid');
      orders.forEach((order, idx) => {
        list.push({
          table,
          order,
          orderIndex: idx + 1
        });
      });
    });

    // Sort by order creation time (oldest first - FIFO)
    return list.sort((a, b) => {
      const timeA = new Date(a.order.startTime).getTime() || 0;
      const timeB = new Date(b.order.startTime).getTime() || 0;
      return timeA - timeB;
    });
  }, [tables]);

  // Audio trigger on newly arrived pending orders
  useEffect(() => {
    const currentPendingIds = new Set(
      allKitchenOrders
        .filter(item => item.order.status === 'pending')
        .map(item => item.order.id)
    );

    if (isFirstRender.current) {
      isFirstRender.current = false;
      knownOrderIdsRef.current = currentPendingIds;
      return;
    }

    // Check if there are brand new pending orders
    let hasNewPending = false;
    currentPendingIds.forEach(id => {
      if (!knownOrderIdsRef.current.has(id)) {
        hasNewPending = true;
      }
    });

    if (hasNewPending && soundEnabled) {
      playKitchenNotificationSound();
    }

    knownOrderIdsRef.current = currentPendingIds;
  }, [allKitchenOrders, soundEnabled]);

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem('kitchen_sound_enabled', String(next));
    if (next) {
      playKitchenNotificationSound();
    }
  };

  // Counts for header badges
  const pendingCount = allKitchenOrders.filter(x => x.order.status === 'pending').length;
  const cookingCount = allKitchenOrders.filter(x => x.order.status === 'cooking').length;
  const readyCount = allKitchenOrders.filter(x => x.order.status === 'ready').length;
  const completedCount = allKitchenOrders.filter(x => x.order.status === 'completed').length;

  // Filtered orders list
  const filteredOrders = useMemo(() => {
    return allKitchenOrders.filter(item => {
      // Status filter
      if (statusFilter === 'all') {
        // By default show active orders (pending, cooking, ready) in "all"
        if (item.order.status === 'completed') return false;
      } else if (item.order.status !== statusFilter) {
        return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTable = item.table.name.toLowerCase().includes(q);
        const matchesItem = item.order.items.some(i => i.name.toLowerCase().includes(q));
        const matchesNote = item.order.note?.toLowerCase().includes(q) || item.table.note?.toLowerCase().includes(q);
        if (!matchesTable && !matchesItem && !matchesNote) return false;
      }

      return true;
    });
  }, [allKitchenOrders, statusFilter, searchQuery]);

  // Aggregated dishes summary (how many of each dish across all pending/cooking tables)
  const aggregatedDishes = useMemo(() => {
    const map = new Map<string, {
      name: string;
      totalQuantity: number;
      pendingQuantity: number;
      cookingQuantity: number;
      addOnsSummary: string[];
      notes: string[];
      tables: { tableName: string; quantity: number; orderStatus: string }[];
    }>();

    allKitchenOrders
      .filter(x => x.order.status === 'pending' || x.order.status === 'cooking')
      .forEach(({ table, order }) => {
        order.items.forEach(item => {
          if (item.isCompleted) return; // Skip completed items

          const addOnKey = (item.selectedAddOns || []).map(a => a.name).sort().join(', ');
          const key = `${item.id}-${item.name}-${addOnKey}`;

          if (!map.has(key)) {
            map.set(key, {
              name: item.name,
              totalQuantity: 0,
              pendingQuantity: 0,
              cookingQuantity: 0,
              addOnsSummary: (item.selectedAddOns || []).map(a => a.name),
              notes: [],
              tables: []
            });
          }

          const entry = map.get(key)!;
          entry.totalQuantity += item.quantity;
          if (order.status === 'pending') {
            entry.pendingQuantity += item.quantity;
          } else {
            entry.cookingQuantity += item.quantity;
          }

          if (item.note && !entry.notes.includes(item.note)) {
            entry.notes.push(item.note);
          }

          entry.tables.push({
            tableName: table.name,
            quantity: item.quantity,
            orderStatus: order.status
          });
        });
      });

    return Array.from(map.values()).sort((a, b) => b.totalQuantity - a.totalQuantity);
  }, [allKitchenOrders]);

  // Handler: Update Order Status (Pending -> Cooking -> Ready -> Completed)
  const handleUpdateOrderStatus = async (
    table: Table,
    orderId: string,
    newStatus: 'pending' | 'cooking' | 'ready' | 'completed'
  ) => {
    const updatedOrders = (table.orders || []).map(o => {
      if (o.id === orderId) {
        // If marked as ready or completed, also mark all items as completed
        const items = (newStatus === 'ready' || newStatus === 'completed')
          ? o.items.map(i => ({ ...i, isCompleted: true }))
          : (newStatus === 'pending' ? o.items.map(i => ({ ...i, isCompleted: false })) : o.items);

        return {
          ...o,
          status: newStatus,
          items
        };
      }
      return o;
    });

    await onUpdateTableOrders(table.id, updatedOrders);
  };

  // Handler: Toggle single item completion
  const handleToggleItemCompleted = async (
    table: Table,
    orderId: string,
    itemIndex: number
  ) => {
    const updatedOrders = (table.orders || []).map(o => {
      if (o.id === orderId) {
        const newItems = [...o.items];
        const currentItem = newItems[itemIndex];
        newItems[itemIndex] = {
          ...currentItem,
          isCompleted: !currentItem.isCompleted
        };

        // If all items are completed, promote order to 'ready'
        const allDone = newItems.every(i => i.isCompleted);
        let newStatus = o.status;
        if (allDone && o.status !== 'completed') {
          newStatus = 'ready';
        } else if (!allDone && o.status === 'ready') {
          newStatus = 'cooking';
        }

        return {
          ...o,
          items: newItems,
          status: newStatus
        };
      }
      return o;
    });

    await onUpdateTableOrders(table.id, updatedOrders);
  };

  // Handler: Re-print Kitchen Ticket
  const handlePrintKitchenTicket = (table: Table, order: OrderSession) => {
    if (!onPrint) {
      alert('Chức năng in chưa được thiết lập');
      return;
    }
    onPrint({
      type: 'kitchen',
      tableName: table.name,
      items: order.items,
      staffName: currentUser?.name || 'Nhà bếp',
      note: table.note || order.note
    });
  };

  return (
    <div className="flex flex-col h-full bg-gray-50/50 dark:bg-[#121316] text-gray-900 dark:text-white">
      {/* Top Controls Header */}
      <div className="p-4 md:p-6 border-b border-black/10 dark:border-white/10 bg-white dark:bg-[#151619] shrink-0 space-y-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center font-bold">
              <ChefHat className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                Màn hình Nhà Bếp (KDS)
                {pendingCount > 0 && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500 text-white animate-pulse">
                    {pendingCount} đơn mới
                  </span>
                )}
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Điều phối, nhận đơn và báo xong món theo thời gian thực
              </p>
            </div>
          </div>

          {/* Quick Metrics & Mode Toggles */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Master Kitchen Switch */}
            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 shadow-xs">
              <div className="flex flex-col text-right">
                <span className="text-xs font-bold text-gray-900 dark:text-white leading-tight">
                  {kitchenEnabled ? 'Chức năng bếp: BẬT' : 'Chức năng bếp: TẮT'}
                </span>
                <span className="text-[10px] text-gray-500 leading-tight">
                  {kitchenEnabled ? 'Hiện trạng thái bàn' : 'Đã ẩn trên phòng bàn'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={kitchenEnabled}
                onClick={() => onToggleKitchenEnabled?.(!kitchenEnabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
                  kitchenEnabled ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
                title={kitchenEnabled ? "Bấm để tắt chức năng bếp và ẩn các trạng thái trên sơ đồ bàn" : "Bấm để bật chức năng bếp"}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                    kitchenEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {kitchenEnabled && (
              <>
                {/* View Mode Switcher */}
                <div className="p-1 bg-black/5 dark:bg-white/5 rounded-xl flex items-center gap-1 border border-black/5 dark:border-white/5">
                  <button
                    onClick={() => setViewMode('tickets')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      viewMode === 'tickets'
                        ? 'bg-white dark:bg-[#202227] text-gray-900 dark:text-white shadow-sm'
                        : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    <span>Theo bàn ({allKitchenOrders.filter(x => x.order.status !== 'completed').length})</span>
                  </button>
                  <button
                    onClick={() => setViewMode('aggregate')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      viewMode === 'aggregate'
                        ? 'bg-white dark:bg-[#202227] text-gray-900 dark:text-white shadow-sm'
                        : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'
                    }`}
                  >
                    <Utensils className="w-3.5 h-3.5" />
                    <span>Tổng hợp món ({aggregatedDishes.reduce((sum, d) => sum + d.totalQuantity, 0)})</span>
                  </button>
                </div>

                {/* Sound Notification Toggle */}
                <button
                  onClick={toggleSound}
                  title={soundEnabled ? "Tắt âm thanh chuông báo đơn" : "Bật âm thanh chuông báo đơn"}
                  className={`p-2 rounded-xl border transition-all cursor-pointer flex items-center gap-1.5 text-xs font-semibold ${
                    soundEnabled 
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400' 
                      : 'bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-gray-400'
                  }`}
                >
                  {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                  <span className="hidden sm:inline">{soundEnabled ? 'Chuông: Bật' : 'Chuông: Tắt'}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Filter Bar & Search - Only when kitchen is enabled */}
        {kitchenEnabled && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {/* Status Filter Tabs */}
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { id: 'all', label: 'Đang làm', count: pendingCount + cookingCount + readyCount },
                { id: 'pending', label: 'Chờ nấu', count: pendingCount, color: 'text-amber-600 dark:text-amber-400' },
                { id: 'cooking', label: 'Đang nấu', count: cookingCount, color: 'text-sky-600 dark:text-sky-400' },
                { id: 'ready', label: 'Bếp đã xong', count: readyCount, color: 'text-emerald-600 dark:text-emerald-400' },
                { id: 'completed', label: 'Đã trả món', count: completedCount, color: 'text-gray-500' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setStatusFilter(tab.id as any)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 cursor-pointer ${
                    statusFilter === tab.id
                      ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900 shadow-sm'
                      : 'bg-black/5 dark:bg-white/5 text-gray-600 dark:text-gray-400 hover:bg-black/10 dark:hover:bg-white/10'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                    statusFilter === tab.id 
                      ? 'bg-white/20 text-white dark:bg-black/20 dark:text-gray-900' 
                      : 'bg-black/10 dark:bg-white/10 text-gray-600 dark:text-gray-400'
                  }`}>
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>

            {/* Search Box */}
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Tìm theo bàn, món, ghi chú..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-xs text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
              />
            </div>
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {!kitchenEnabled ? (
          <div className="h-full min-h-[420px] flex flex-col items-center justify-center text-center max-w-lg mx-auto p-6 space-y-4">
            <div className="w-20 h-20 rounded-3xl bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shadow-inner border border-amber-500/20">
              <ChefHat className="w-10 h-10 opacity-80" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                Chức năng Nhà Bếp (KDS) đang TẮT
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                Nhiều nhà hàng không cần sử dụng chức năng này. Khi tắt, toàn bộ quy trình làm món và các huy hiệu trạng thái (Chờ bếp, Đang nấu, Bếp đã xong...) trên sơ đồ phòng bàn được ẩn hoàn toàn để giao diện gọn gàng và không gây rối mắt cho nhân viên.
              </p>
            </div>
            <button
              onClick={() => onToggleKitchenEnabled?.(true)}
              className="px-6 py-3 rounded-xl bg-emerald-500 text-white text-sm font-bold shadow-lg shadow-emerald-500/25 hover:bg-emerald-600 transition-all flex items-center gap-2 cursor-pointer"
            >
              <Power className="w-4 h-4" /> Bật lại chức năng nhà bếp
            </button>
          </div>
        ) : (
          <>
            {/* VIEW 1: TICKETS / PER-TABLE ORDERS */}
            {viewMode === 'tickets' && (
          <>
            {filteredOrders.length === 0 ? (
              <div className="h-96 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 space-y-3">
                <div className="w-16 h-16 rounded-full bg-black/5 dark:bg-white/5 flex items-center justify-center">
                  <ChefHat className="w-8 h-8 opacity-40" />
                </div>
                <p className="text-base font-medium">Hiện không có đơn hàng nào cần chế biến</p>
                <p className="text-xs text-gray-400">
                  {statusFilter !== 'all' ? `Không tìm thấy đơn nào ở trạng thái "${statusFilter}"` : 'Các đơn gọi món từ phục vụ sẽ lập tức xuất hiện tại đây'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5">
                {filteredOrders.map(({ table, order, orderIndex }) => {
                  const isPending = order.status === 'pending';
                  const isCooking = order.status === 'cooking';
                  const isReady = order.status === 'ready';
                  const isCompleted = order.status === 'completed';

                  // Border & background accents based on status
                  let cardHeaderClass = "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300";
                  let statusBadgeText = "Chờ chế biến";
                  let statusBadgeClass = "bg-amber-500 text-white";

                  if (isCooking) {
                    cardHeaderClass = "bg-sky-500/10 border-sky-500/30 text-sky-700 dark:text-sky-300";
                    statusBadgeText = "Đang nấu";
                    statusBadgeClass = "bg-sky-500 text-white";
                  } else if (isReady) {
                    cardHeaderClass = "bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-300";
                    statusBadgeText = "Bếp đã xong!";
                    statusBadgeClass = "bg-emerald-500 text-white font-bold animate-pulse";
                  } else if (isCompleted) {
                    cardHeaderClass = "bg-gray-500/10 border-gray-500/20 text-gray-500";
                    statusBadgeText = "Đã ra món";
                    statusBadgeClass = "bg-gray-500 text-white";
                  }

                  const allItemsDone = order.items.every(i => i.isCompleted);

                  return (
                    <div 
                      key={`${table.id}-${order.id}`}
                      className={`bg-white dark:bg-[#18191d] border rounded-2xl flex flex-col overflow-hidden shadow-sm transition-all duration-200 ${
                        isReady 
                          ? 'border-emerald-500/50 shadow-emerald-500/10 shadow-md' 
                          : isPending 
                          ? 'border-amber-500/40 shadow-amber-500/5' 
                          : 'border-black/10 dark:border-white/10'
                      }`}
                    >
                      {/* Card Header */}
                      <div className={`p-3.5 border-b flex justify-between items-start gap-2 ${cardHeaderClass}`}>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-lg font-bold tracking-tight text-gray-900 dark:text-white">
                              {table.name}
                            </h3>
                            <span className="text-[11px] font-semibold text-gray-500 bg-black/5 dark:bg-white/10 px-2 py-0.5 rounded-md">
                              Đơn #{orderIndex}
                            </span>
                          </div>

                          {/* Table transfer / merge notes */}
                          {table.note && (
                            <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400 italic mt-0.5">
                              {table.note}
                            </p>
                          )}
                          
                          {/* Order specific note */}
                          {order.note && order.note !== table.note && (
                            <p className="text-[11px] font-medium text-blue-600 dark:text-blue-400 italic mt-0.5">
                              "{order.note}"
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <KitchenTimer startTime={order.startTime} />
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${statusBadgeClass}`}>
                            {statusBadgeText}
                          </span>
                        </div>
                      </div>

                      {/* Items List */}
                      <div className="flex-1 p-3.5 space-y-2.5 overflow-y-auto max-h-[320px]">
                        {order.items.map((item, itemIdx) => {
                          const isDone = item.isCompleted || isReady || isCompleted;

                          return (
                            <div 
                              key={`${item.id}-${itemIdx}`}
                              onClick={() => handleToggleItemCompleted(table, order.id, itemIdx)}
                              className={`p-2.5 rounded-xl border flex items-start justify-between gap-3 transition-all cursor-pointer group select-none ${
                                isDone 
                                  ? 'bg-black/5 dark:bg-white/5 border-transparent opacity-60 line-through' 
                                  : 'bg-black/[0.02] dark:bg-white/[0.02] border-black/5 dark:border-white/5 hover:border-amber-500/30'
                              }`}
                            >
                              <div className="flex items-start gap-2.5 flex-1 min-w-0">
                                {/* Quantity pill */}
                                <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                                  isDone 
                                    ? 'bg-black/10 dark:bg-white/10 text-gray-400' 
                                    : 'bg-amber-500 text-white shadow-xs'
                                }`}>
                                  x{item.quantity}
                                </span>

                                <div className="flex-1 min-w-0">
                                  <p className={`text-sm font-bold text-gray-900 dark:text-white leading-tight ${isDone ? 'line-through text-gray-400' : ''}`}>
                                    {item.name}
                                  </p>

                                  {/* Add-ons / Toppings */}
                                  {item.selectedAddOns && item.selectedAddOns.length > 0 && (
                                    <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium mt-0.5">
                                      {item.selectedAddOns.map(a => `+ ${a.name}`).join(', ')}
                                    </div>
                                  )}

                                  {/* Item Note */}
                                  {item.note && (
                                    <div className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded-md font-semibold mt-1 w-fit border border-amber-500/20">
                                      "{item.note}"
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Tick icon */}
                              <button 
                                type="button"
                                className={`shrink-0 p-1 rounded-lg transition-colors cursor-pointer ${
                                  isDone 
                                    ? 'text-emerald-500' 
                                    : 'text-gray-300 dark:text-gray-600 group-hover:text-emerald-500'
                                }`}
                                title={isDone ? "Đã xong món này" : "Bấm để hoàn thành món"}
                              >
                                <CheckCircle2 className="w-5 h-5" />
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      {/* Card Action Footer */}
                      <div className="p-3 border-t border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] flex items-center gap-2">
                        {/* Print Kitchen Ticket */}
                        <button
                          type="button"
                          onClick={() => handlePrintKitchenTicket(table, order)}
                          title="In lại phiếu bếp"
                          className="p-2 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300 transition-all cursor-pointer"
                        >
                          <Printer className="w-4 h-4" />
                        </button>

                        {/* State Transitions */}
                        {isPending && (
                          <button
                            type="button"
                            onClick={() => handleUpdateOrderStatus(table, order.id, 'cooking')}
                            className="flex-1 py-2 px-3 bg-sky-500 hover:bg-sky-600 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                          >
                            <Flame className="w-3.5 h-3.5" />
                            <span>Bắt đầu nấu</span>
                          </button>
                        )}

                        {isCooking && (
                          <button
                            type="button"
                            onClick={() => handleUpdateOrderStatus(table, order.id, 'ready')}
                            className="flex-1 py-2 px-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                          >
                            <CheckCheck className="w-4 h-4" />
                            <span>Xong - Ra món</span>
                          </button>
                        )}

                        {isReady && (
                          <button
                            type="button"
                            onClick={() => handleUpdateOrderStatus(table, order.id, 'completed')}
                            className="flex-1 py-2 px-3 bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
                          >
                            <CheckCheck className="w-4 h-4" />
                            <span>Đã phục vụ</span>
                          </button>
                        )}

                        {/* Rollback / Reset button if needed */}
                        {(isCooking || isReady || isCompleted) && (
                          <button
                            type="button"
                            onClick={() => handleUpdateOrderStatus(table, order.id, 'pending')}
                            title="Chuyển lại trạng thái Chờ làm"
                            className="p-2 rounded-xl text-gray-400 hover:text-amber-500 hover:bg-black/5 dark:hover:bg-white/5 transition-all cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* VIEW 2: AGGREGATE DISHES SUMMARY (Gom món chế biến) */}
        {viewMode === 'aggregate' && (
          <div className="space-y-4 max-w-5xl mx-auto">
            <div className="bg-white dark:bg-[#18191d] border border-black/10 dark:border-white/10 rounded-2xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-bold text-gray-900 dark:text-white">
                    Bảng tổng hợp món cần chế biến
                  </h2>
                  <p className="text-xs text-gray-500">
                    Gom tất cả các món đang chờ và đang nấu của toàn quán để bếp xào nấu theo mẻ
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-xs text-gray-500">Tổng số lượng:</span>
                  <p className="text-lg font-bold text-amber-600 dark:text-amber-400">
                    {aggregatedDishes.reduce((sum, d) => sum + d.totalQuantity, 0)} phần
                  </p>
                </div>
              </div>

              {aggregatedDishes.length === 0 ? (
                <div className="py-12 text-center text-gray-400">
                  <ChefHat className="w-12 h-12 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">Không có món nào đang chờ chế biến</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {aggregatedDishes.map((dish, idx) => (
                    <div 
                      key={idx}
                      className="p-4 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-black/5 dark:border-white/5 flex flex-col justify-between gap-3 hover:border-amber-500/30 transition-all"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="w-8 h-8 rounded-lg bg-amber-500 text-white font-bold text-sm flex items-center justify-center shadow-xs">
                              x{dish.totalQuantity}
                            </span>
                            <h3 className="font-bold text-base text-gray-900 dark:text-white">
                              {dish.name}
                            </h3>
                          </div>

                          {/* Add-ons */}
                          {dish.addOnsSummary.length > 0 && (
                            <div className="text-xs text-emerald-600 dark:text-emerald-400 font-medium ml-10 mt-1">
                              {dish.addOnsSummary.map(a => `+ ${a}`).join(', ')}
                            </div>
                          )}

                          {/* Notes */}
                          {dish.notes.length > 0 && (
                            <div className="flex flex-wrap gap-1 ml-10 mt-1.5">
                              {dish.notes.map((note, nIdx) => (
                                <span key={nIdx} className="text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded border border-amber-500/20 italic font-medium">
                                  "{note}"
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="text-right shrink-0">
                          {dish.pendingQuantity > 0 && (
                            <span className="block text-[10px] text-amber-600 dark:text-amber-400 font-semibold">
                              Chờ nấu: {dish.pendingQuantity}
                            </span>
                          )}
                          {dish.cookingQuantity > 0 && (
                            <span className="block text-[10px] text-sky-600 dark:text-sky-400 font-semibold">
                              Đang nấu: {dish.cookingQuantity}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Tables listing */}
                      <div className="pt-2.5 border-t border-black/5 dark:border-white/5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                        <span className="font-medium text-[11px] text-gray-400">Các bàn gọi:</span>
                        {dish.tables.map((t, tIdx) => (
                          <span 
                            key={tIdx}
                            className={`px-2 py-0.5 rounded-md font-semibold text-[11px] border ${
                              t.orderStatus === 'pending'
                                ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20'
                                : 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20'
                            }`}
                          >
                            {t.tableName} (x{t.quantity})
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </>
    )}
  </div>
</div>
  );
};
