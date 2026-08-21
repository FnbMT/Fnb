import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Store, Settings, LogOut, Package as PackageIcon, Edit2, CheckCircle2, XCircle, Search, Trash2, QrCode, Download, Brush as Broom } from 'lucide-react';
import { db } from '../lib/firebase';
import { CurrencyInput } from './CurrencyInput';
import { collection, getDocs, getDoc, updateDoc, doc, deleteDoc, setDoc, query, where } from 'firebase/firestore';

interface StorePackagePricing {
  durationMonths: number;
  price: number;
}

interface StorePackage {
  id: string;
  name: string;
  trialDays: number;
  price: number;
  durationMonths?: number;
  pricing?: StorePackagePricing[];
  features: {
    maxUsers: number;
    invoiceHistory: 'daily' | 'all';
    financialReports: boolean;
    taxReport?: boolean;
  };
}

interface StoreTenant {
  id: string;
  name: string;
  code: string;
  phone?: string;
  subscription?: {
    status: 'trial' | 'active' | 'expired' | 'blocked';
    trialEndDate?: string;
    validUntil?: string;
    packageId?: string;
  };
  createdAt: string;
  stats?: {
    employeeCount: number;
    activeEmployees7Days: number;
    adminActive: boolean;
  };
}

export const SuperAdminView = ({ onLogout }: { onLogout: () => void }) => {
  const [activeTab, setActiveTab] = useState<'stores' | 'packages' | 'settings'>('stores');
  const [stores, setStores] = useState<StoreTenant[]>([]);
  const [packages, setPackages] = useState<StorePackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeFilter, setStoreFilter] = useState<'all' | 'trial' | 'active' | 'expired' | 'inactive_admin'>('all');
  const [systemConfig, setSystemConfig] = useState<any>({});
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  
  // Package editing state
  const [editingPackage, setEditingPackage] = useState<StorePackage | null>(null);
  const [editingTrialDays, setEditingTrialDays] = useState<number | ''>('');

  // Store editing state
  const [editingStore, setEditingStore] = useState<StoreTenant | null>(null);
  const [editingStoreAdmin, setEditingStoreAdmin] = useState<any>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Load config
      const configDoc = await getDoc(doc(db, 'system', 'config'));
      if (configDoc.exists()) {
        setSystemConfig(configDoc.data());
      } else {
        const initialConfig = { bankCode: 'MB', bankAccountNumber: '', bankAccountName: '' };
        await setDoc(doc(db, 'system', 'config'), initialConfig);
        setSystemConfig(initialConfig);
      }

      // Load Stores
      const storeSnapshot = await getDocs(collection(db, 'stores'));
      const storesData = storeSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as StoreTenant));
      
      // Load all users to calculate stats
      const userSnapshot = await getDocs(collection(db, 'users'));
      const users = userSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));
      
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      const storesWithStats = await Promise.all(storesData.map(async (store) => {
        // Auto-check for expiration
        if (store.subscription) {
          let newStatus = store.subscription.status;
          let shouldUpdate = false;

          if (store.subscription.status === 'trial' && store.subscription.trialEndDate) {
            if (now > new Date(store.subscription.trialEndDate)) {
              newStatus = 'expired';
              shouldUpdate = true;
            }
          } else if (store.subscription.status === 'active' && store.subscription.validUntil) {
            if (now > new Date(store.subscription.validUntil)) {
              newStatus = 'expired';
              shouldUpdate = true;
            }
          }

          if (shouldUpdate) {
            store.subscription.status = newStatus;
            try {
              await updateDoc(doc(db, 'stores', store.id), { 'subscription.status': newStatus });
            } catch (e) {
              console.error('Auto-update expired status failed:', e);
            }
          }
        }

        const storeUsers = users.filter(u => u.storeId === store.id);
        const adminUser = storeUsers.find(u => u.role === 'admin');
        const regularEmployees = storeUsers.filter(u => u.role !== 'admin');
        
        const activeEmployees7Days = regularEmployees.filter(u => {
          if (!u.lastLogin) return false;
          const loginDate = new Date(u.lastLogin);
          return loginDate >= sevenDaysAgo;
        }).length;
        
        let adminActive = false;
        if (adminUser && adminUser.lastLogin) {
          const adminLogin = new Date(adminUser.lastLogin);
          if (adminLogin >= sevenDaysAgo) {
            adminActive = true;
          }
        }
        
        return {
          ...store,
          stats: {
            employeeCount: regularEmployees.length,
            activeEmployees7Days,
            adminActive
          }
        };
      }));
      
      storesWithStats.sort((a, b) => (b.stats?.activeEmployees7Days || 0) - (a.stats?.activeEmployees7Days || 0));
      
      setStores(storesWithStats);

      // Load Packages (or default if none)
      const pkgsSnapshot = await getDocs(collection(db, 'packages'));
      if (pkgsSnapshot.empty) {
        const defaultPackages: StorePackage[] = [
          {
            id: 'trial',
            name: 'Gói Dùng Thử',
            trialDays: 14,
            price: 0,
            pricing: [],
            features: { maxUsers: 999, invoiceHistory: 'all', financialReports: true, taxReport: true }
          },
          {
            id: 'basic',
            name: 'Gói Cơ Bản',
            trialDays: 14,
            price: 199000,
            pricing: [{ durationMonths: 1, price: 199000 }, { durationMonths: 12, price: 2000000 }, { durationMonths: 24, price: 3000000 }],
            features: { maxUsers: 5, invoiceHistory: 'daily', financialReports: false, taxReport: false }
          },
          {
            id: 'pro',
            name: 'Gói Nâng Cao',
            trialDays: 14,
            price: 499000,
            pricing: [{ durationMonths: 1, price: 499000 }, { durationMonths: 12, price: 5000000 }, { durationMonths: 24, price: 9000000 }],
            features: { maxUsers: 20, invoiceHistory: 'all', financialReports: true, taxReport: true }
          }
        ];
        // Create defaults
        for (const pkg of defaultPackages) {
          await setDoc(doc(db, 'packages', pkg.id), pkg);
        }
        setPackages(defaultPackages);
        setEditingTrialDays(defaultPackages.find(p => p.id === 'trial')?.trialDays || 14);
      } else {
        const loadedPackages = pkgsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as StorePackage));
        setPackages(loadedPackages);
        setEditingTrialDays(loadedPackages.find(p => p.id === 'trial')?.trialDays || 14);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStoreStatus = async (storeId: string, status: 'active' | 'blocked') => {
    try {
      await updateDoc(doc(db, 'stores', storeId), {
        'subscription.status': status
      });
      fetchData();
    } catch (e) {
      console.error(e);
      alert('Có lỗi xảy ra');
    }
  };

  const handleEditStore = async (store: StoreTenant) => {
    setEditingStore(store);
    try {
      const usersRef = collection(db, 'users');
      const q = query(usersRef, where('storeId', '==', store.id), where('role', '==', 'admin'));
      const userSnapshot = await getDocs(q);
      if (!userSnapshot.empty) {
        setEditingStoreAdmin({ id: userSnapshot.docs[0].id, ...userSnapshot.docs[0].data() });
      } else {
        setEditingStoreAdmin(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingStore) return;
    try {
      await updateDoc(doc(db, 'stores', editingStore.id), {
        name: editingStore.name,
        code: editingStore.code,
        phone: editingStore.phone,
        subscription: editingStore.subscription
      });
      if (editingStoreAdmin) {
        await updateDoc(doc(db, 'users', editingStoreAdmin.id), {
          username: editingStoreAdmin.username,
          password: editingStoreAdmin.password
        });
      }
      setEditingStore(null);
      fetchData();
    } catch (error) {
      console.error(error);
      alert('Lỗi lưu thông tin');
    }
  };

  const handleDeleteStore = async (storeId: string) => {
    if (!confirm('Bạn có chắc chắn muốn xóa dữ liệu cửa hàng này? Hành động này không thể hoàn tác!')) return;
    try {
      const collectionsToDelete = [
        'users', 'menu', 'tables', 'table_groups', 'invoices', 
        'inventory_logs', 'inventory_audits', 'stock_card', 'customers', 
        'cash_transactions', 'settings', 'attendance_records', 'payroll_records', 'shifts'
      ];

      for (const colName of collectionsToDelete) {
        const q = query(collection(db, colName), where('storeId', '==', storeId));
        const snapshot = await getDocs(q);
        const deletePromises = snapshot.docs.map(document => deleteDoc(doc(db, colName, document.id)));
        await Promise.all(deletePromises);
      }

      await deleteDoc(doc(db, 'stores', storeId));
      fetchData();
      alert('Đã xóa toàn bộ dữ liệu cửa hàng thành công.');
    } catch (e) {
      console.error(e);
      alert('Lỗi khi xóa dữ liệu cửa hàng.');
    }
  };


  const handleExportData = async () => {
    if (!confirm('Bạn có muốn tải toàn bộ dữ liệu hệ thống xuống không?')) return;
    
    try {
      const collectionsToExport = [
        'stores', 'users', 'menu', 'tables', 'table_groups', 'invoices', 
        'inventory_logs', 'inventory_audits', 'stock_card', 'customers', 
        'cash_transactions', 'settings', 'attendance_records', 'payroll_records', 'shifts', 'packages'
      ];

      const allData: Record<string, any[]> = {};
      
      for (const colName of collectionsToExport) {
        const querySnapshot = await getDocs(collection(db, colName));
        allData[colName] = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      }

      const jsonString = JSON.stringify(allData, null, 2);
      const blob = new Blob([jsonString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `backup_fnb_master_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert('Lỗi khi tải dữ liệu xuống.');
    }
  };

  const handleCleanupSystem = async () => {
    if (!confirm('Bạn có chắc chắn muốn dọn dẹp hệ thống? Việc này sẽ xóa toàn bộ các dữ liệu rác (không thuộc về cửa hàng nào hợp lệ).')) return;
    
    try {
      const storesSnapshot = await getDocs(collection(db, 'stores'));
      const validStoreIds = storesSnapshot.docs.map(doc => doc.id);
      
      const collectionsToClean = [
        'menu', 'tables', 'table_groups', 'invoices', 
        'inventory_logs', 'inventory_audits', 'stock_card', 'customers', 
        'cash_transactions', 'settings', 'attendance_records', 'payroll_records', 'shifts'
      ];
      
      let deletedCount = 0;
      
      for (const colName of collectionsToClean) {
        const querySnapshot = await getDocs(collection(db, colName));
        const deletePromises = [];
        
        for (const document of querySnapshot.docs) {
          const data = document.data();
          if (!data.storeId || !validStoreIds.includes(data.storeId)) {
            deletePromises.push(deleteDoc(doc(db, colName, document.id)));
          }
        }
        await Promise.all(deletePromises);
        deletedCount += deletePromises.length;
      }
      
      // Clean users separately to avoid deleting superadmin
      const usersSnapshot = await getDocs(collection(db, 'users'));
      const userDeletePromises = [];
      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        if (userData.role !== 'superadmin' && (!userData.storeId || !validStoreIds.includes(userData.storeId))) {
          userDeletePromises.push(deleteDoc(doc(db, 'users', userDoc.id)));
        }
      }
      await Promise.all(userDeletePromises);
      deletedCount += userDeletePromises.length;
      
      alert(`Đã dọn dẹp hệ thống thành công. Xóa ${deletedCount} bản ghi rác.`);
      fetchData();
    } catch (e) {
      console.error(e);
      alert('Lỗi khi dọn dẹp hệ thống.');
    }
  };

  const handleSavePackage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPackage) return;
    try {
      if (editingPackage.id.startsWith('new-')) {
        const newId = Math.random().toString(36).substr(2, 9);
        await setDoc(doc(db, 'packages', newId), { ...editingPackage, id: newId });
      } else {
        await updateDoc(doc(db, 'packages', editingPackage.id), editingPackage as any);
      }
      setEditingPackage(null);
      fetchData();
    } catch (error) {
      console.error(error);
      alert('Lỗi lưu gói');
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingConfig(true);
    try {
      await updateDoc(doc(db, 'system', 'config'), systemConfig);
      alert('Đã lưu cấu hình thanh toán thành công!');
    } catch (error) {
      console.error(error);
      alert('Lỗi lưu cấu hình');
    } finally {
      setIsSavingConfig(false);
    }
  };

  const filteredStores = stores.filter(store => {
    if (storeFilter === 'all') return true;
    if (storeFilter === 'inactive_admin') return !store.stats?.adminActive;
    if (storeFilter === 'expired') return store.subscription?.status === 'expired';
    return store.subscription?.status === storeFilter;
  });

  const totalStores = stores.length;
  const trialStores = stores.filter(s => s.subscription?.status === 'trial').length;
  const activeStores = stores.filter(s => s.subscription?.status === 'active').length;
  const expiredStores = stores.filter(s => s.subscription?.status === 'expired').length;
  const inactiveAdminStores = stores.filter(s => !s.stats?.adminActive).length;

  return (
    <div className="flex flex-col md:flex-row h-screen bg-gray-50 dark:bg-[#0a0a0a] text-gray-900 dark:text-white overflow-hidden">
      {/* Topbar/Sidebar */}
      <div className="w-full md:w-64 bg-white dark:bg-[#151619] border-b md:border-b-0 md:border-r border-black/10 dark:border-white/10 flex flex-col flex-shrink-0 z-10">
        <div className="p-4 md:p-6 pt-[max(env(safe-area-inset-top),16px)] md:pt-6 border-b border-black/10 dark:border-white/10 flex justify-between items-center bg-white dark:bg-[#151619]">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tighter text-emerald-600 dark:text-emerald-500 leading-none">SUPER ADMIN</h1>
            <p className="text-[10px] md:text-xs text-gray-500 mt-1">Quản lý tổng hệ thống</p>
          </div>
          <button 
            onClick={onLogout} 
            className="md:hidden flex items-center gap-1.5 px-3 py-2 text-rose-600 dark:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 active:bg-rose-500/30 rounded-xl transition-all font-bold text-xs min-h-[38px] cursor-pointer"
            title="Đăng xuất"
          >
            <LogOut className="w-4 h-4" />
            <span>Đăng xuất</span>
          </button>
        </div>
        <nav className="flex-none md:flex-1 p-2 md:p-4 flex flex-row md:flex-col gap-2 overflow-x-auto custom-scrollbar no-scrollbar">
          <button 
            onClick={() => setActiveTab('stores')}
            className={`flex-shrink-0 md:w-full flex items-center gap-2 md:gap-3 px-3.5 md:px-4 py-2.5 md:py-3 rounded-xl transition-all text-xs md:text-base whitespace-nowrap cursor-pointer ${activeTab === 'stores' ? 'bg-emerald-500 text-white font-bold shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'}`}
          >
            <Store className="w-4 h-4 md:w-5 md:h-5" /> Quản lý cửa hàng
          </button>
          <button 
            onClick={() => setActiveTab('packages')}
            className={`flex-shrink-0 md:w-full flex items-center gap-2 md:gap-3 px-3.5 md:px-4 py-2.5 md:py-3 rounded-xl transition-all text-xs md:text-base whitespace-nowrap cursor-pointer ${activeTab === 'packages' ? 'bg-emerald-500 text-white font-bold shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'}`}
          >
            <PackageIcon className="w-4 h-4 md:w-5 md:h-5" /> Cấu hình gói dịch vụ
          </button>
          <button 
            onClick={() => setActiveTab('settings')}
            className={`flex-shrink-0 md:w-full flex items-center gap-2 md:gap-3 px-3.5 md:px-4 py-2.5 md:py-3 rounded-xl transition-all text-xs md:text-base whitespace-nowrap cursor-pointer ${activeTab === 'settings' ? 'bg-emerald-500 text-white font-bold shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'}`}
          >
            <Settings className="w-4 h-4 md:w-5 md:h-5" /> Cấu hình thanh toán
          </button>
        </nav>
        <div className="hidden md:block p-4 border-t border-black/10 dark:border-white/10">
          <button onClick={onLogout} className="w-full flex items-center gap-3 px-4 py-3 text-rose-600 dark:text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all cursor-pointer font-medium">
            <LogOut className="w-5 h-5" /> Đăng xuất
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-4 md:p-8 pb-[max(env(safe-area-inset-bottom),24px)]">
        {activeTab === 'stores' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <h2 className="text-xl md:text-2xl font-bold">Danh sách Cửa Hàng</h2>
              <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                <button onClick={handleExportData} className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3.5 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-xl text-xs md:text-sm font-semibold transition-colors cursor-pointer shadow-sm">
                  <Download className="w-4 h-4" /> <span>Tải dữ liệu</span>
                </button>
                <button onClick={handleCleanupSystem} className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3.5 py-2.5 bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white rounded-xl text-xs md:text-sm font-semibold transition-colors cursor-pointer shadow-sm">
                  <Broom className="w-4 h-4" /> <span>Dọn dẹp hệ thống</span>
                </button>
              </div>
            </div>
            
            {/* Dashboard Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 md:gap-4 mb-4 md:mb-6">
              <div onClick={() => setStoreFilter('all')} className={`bg-black/5 dark:bg-white/5 border ${storeFilter === 'all' ? 'border-emerald-500 shadow-md ring-1 ring-emerald-500' : 'border-black/10 dark:border-white/10'} rounded-xl md:rounded-2xl p-3 md:p-4 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 transition-all`}>
                <h3 className="text-gray-600 dark:text-gray-400 text-xs md:text-sm font-medium mb-1">Tổng cửa hàng</h3>
                <p className="text-xl md:text-3xl font-bold text-gray-900 dark:text-white">{totalStores}</p>
              </div>
              <div onClick={() => setStoreFilter('trial')} className={`bg-amber-500/10 border ${storeFilter === 'trial' ? 'border-amber-500 shadow-md ring-1 ring-amber-500' : 'border-amber-500/20'} rounded-xl md:rounded-2xl p-3 md:p-4 cursor-pointer hover:bg-amber-500/20 transition-all`}>
                <h3 className="text-amber-600 dark:text-amber-500/80 text-xs md:text-sm font-medium mb-1">Dùng thử</h3>
                <p className="text-xl md:text-3xl font-bold text-amber-600 dark:text-amber-500">{trialStores}</p>
              </div>
              <div onClick={() => setStoreFilter('active')} className={`bg-emerald-500/10 border ${storeFilter === 'active' ? 'border-emerald-500 shadow-md ring-1 ring-emerald-500' : 'border-emerald-500/20'} rounded-xl md:rounded-2xl p-3 md:p-4 cursor-pointer hover:bg-emerald-500/20 transition-all`}>
                <h3 className="text-emerald-600 dark:text-emerald-500/80 text-xs md:text-sm font-medium mb-1">Đã kích hoạt</h3>
                <p className="text-xl md:text-3xl font-bold text-emerald-600 dark:text-emerald-500">{activeStores}</p>
              </div>
              <div onClick={() => setStoreFilter('expired')} className={`bg-rose-500/10 border ${storeFilter === 'expired' ? 'border-rose-500 shadow-md ring-1 ring-rose-500' : 'border-rose-500/20'} rounded-xl md:rounded-2xl p-3 md:p-4 cursor-pointer hover:bg-rose-500/20 transition-all`}>
                <h3 className="text-rose-600 dark:text-rose-500/80 text-xs md:text-sm font-medium mb-1">Hết hạn</h3>
                <p className="text-xl md:text-3xl font-bold text-rose-600 dark:text-rose-500">{expiredStores}</p>
              </div>
              <div onClick={() => setStoreFilter('inactive_admin')} className={`bg-purple-500/10 border ${storeFilter === 'inactive_admin' ? 'border-purple-500 shadow-md ring-1 ring-purple-500' : 'border-purple-500/20'} rounded-xl md:rounded-2xl p-3 md:p-4 cursor-pointer hover:bg-purple-500/20 transition-all col-span-2 sm:col-span-1`}>
                <h3 className="text-purple-600 dark:text-purple-500/80 text-xs md:text-sm font-medium mb-1">Admin không HĐ</h3>
                <p className="text-xl md:text-3xl font-bold text-purple-600 dark:text-purple-500">{inactiveAdminStores}</p>
              </div>
            </div>

            {/* Mobile Store Cards List (Visible on mobile screens) */}
            <div className="block md:hidden space-y-3">
              {filteredStores.map(store => {
                const currentPackage = packages.find(p => p.id === store.subscription?.packageId);
                return (
                  <div key={store.id} className="bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-2xl p-4 shadow-sm space-y-3">
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <h4 className="font-bold text-base text-gray-900 dark:text-white leading-tight">{store.name}</h4>
                        <p className="text-xs text-gray-500 mt-0.5">Mã: <span className="font-mono font-medium text-gray-700 dark:text-gray-300">{store.code}</span> {store.phone ? `• ${store.phone}` : ''}</p>
                      </div>
                      <div className="text-right shrink-0">
                        {store.subscription?.status === 'trial' ? (
                          <span className="inline-block bg-amber-500/10 text-amber-600 dark:text-amber-500 px-2 py-0.5 rounded-full text-[11px] font-bold border border-amber-500/20">Dùng thử</span>
                        ) : store.subscription?.status === 'active' ? (
                          <span className="inline-block bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 px-2 py-0.5 rounded-full text-[11px] font-bold border border-emerald-500/20">Đã kích hoạt</span>
                        ) : store.subscription?.status === 'blocked' ? (
                          <span className="inline-block bg-rose-500/10 text-rose-600 dark:text-rose-500 px-2 py-0.5 rounded-full text-[11px] font-bold border border-rose-500/20">Bị khóa</span>
                        ) : (
                          <span className="inline-block bg-gray-500/10 text-gray-500 px-2 py-0.5 rounded-full text-[11px] font-bold border border-gray-500/20">Hết hạn</span>
                        )}
                        {store.subscription?.validUntil ? (
                          <div className="text-[10px] text-gray-500 mt-0.5">Hạn: {new Date(store.subscription.validUntil).toLocaleDateString('vi-VN')}</div>
                        ) : store.subscription?.trialEndDate ? (
                          <div className="text-[10px] text-gray-500 mt-0.5">Hạn: {new Date(store.subscription.trialEndDate).toLocaleDateString('vi-VN')}</div>
                        ) : null}
                      </div>
                    </div>

                    <div className="bg-black/5 dark:bg-white/5 rounded-xl p-3 text-xs space-y-1.5">
                      <div className="flex justify-between items-center">
                        <span className="text-gray-500">Gói dịch vụ:</span>
                        <span className="font-semibold text-gray-900 dark:text-white">
                          {currentPackage ? currentPackage.name : (store.subscription?.status === 'trial' ? 'Gói Dùng Thử' : 'Chưa có')}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-gray-500">Nhân viên:</span>
                        <span className="font-medium text-gray-900 dark:text-white">
                          Đăng nhập: <strong className="text-emerald-600 dark:text-emerald-500">{store.stats?.activeEmployees7Days || 0}</strong>/{store.stats?.employeeCount || 0}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-gray-500">Trạng thái Admin:</span>
                        {store.stats?.adminActive ? (
                          <span className="text-emerald-600 dark:text-emerald-500 font-medium">Đang hoạt động</span>
                        ) : (
                          <span className="text-rose-600 dark:text-rose-500 font-medium">Không hoạt động</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-black/5 dark:border-white/5">
                      <button 
                        onClick={() => handleEditStore(store)} 
                        className="flex items-center gap-1 px-3 py-1.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg text-xs font-semibold hover:bg-blue-500/20 active:bg-blue-500/30 transition-all cursor-pointer"
                      >
                        <Edit2 className="w-3.5 h-3.5" /> Sửa
                      </button>
                      {store.subscription?.status !== 'blocked' ? (
                        <button 
                          onClick={() => handleUpdateStoreStatus(store.id, 'blocked')} 
                          className="flex items-center gap-1 px-3 py-1.5 bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-lg text-xs font-semibold hover:bg-rose-500/20 active:bg-rose-500/30 transition-all cursor-pointer"
                        >
                          <XCircle className="w-3.5 h-3.5" /> Khóa
                        </button>
                      ) : (
                        <button 
                          onClick={() => handleUpdateStoreStatus(store.id, 'active')} 
                          className="flex items-center gap-1 px-3 py-1.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-lg text-xs font-semibold hover:bg-emerald-500/20 active:bg-emerald-500/30 transition-all cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> Mở khóa
                        </button>
                      )}
                      <button 
                        onClick={() => handleDeleteStore(store.id)} 
                        className="p-1.5 bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-lg text-xs hover:bg-rose-500/20 active:bg-rose-500/30 transition-all cursor-pointer"
                        title="Xóa cửa hàng"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop Table View (Hidden on mobile screens) */}
            <div className="hidden md:block bg-white dark:bg-[#151619] rounded-2xl border border-black/10 dark:border-white/10 overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead className="bg-black/5 dark:bg-white/5">
                  <tr>
                    <th className="p-4 font-medium text-gray-600 dark:text-gray-400">Cửa hàng</th>
                    <th className="p-4 font-medium text-gray-600 dark:text-gray-400">Gói dịch vụ</th>
                    <th className="p-4 font-medium text-gray-600 dark:text-gray-400">Trạng thái gói</th>
                    <th className="p-4 font-medium text-gray-600 dark:text-gray-400">Hoạt động (7 ngày)</th>
                    <th className="p-4 font-medium text-gray-600 dark:text-gray-400 text-right">Hành động</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5 dark:divide-white/5">
                  {filteredStores.map(store => {
                    const currentPackage = packages.find(p => p.id === store.subscription?.packageId);
                    return (
                    <tr key={store.id} className="hover:bg-black/5 dark:hover:bg-white/5">
                      <td className="p-4">
                        <p className="font-bold">{store.name}</p>
                        <p className="text-xs text-gray-500">Mã: {store.code} {store.phone ? `• ${store.phone}` : ''}</p>
                      </td>
                      <td className="p-4">
                        <span className="font-medium text-gray-900 dark:text-white">
                          {currentPackage ? currentPackage.name : (store.subscription?.status === 'trial' ? 'Gói Dùng Thử' : 'Chưa có')}
                        </span>
                      </td>
                      <td className="p-4">
                        {store.subscription?.status === 'trial' ? (
                          <span className="bg-amber-500/10 text-amber-600 dark:text-amber-500 px-2 py-1 rounded-full text-xs font-bold border border-amber-500/20">Dùng thử</span>
                        ) : store.subscription?.status === 'active' ? (
                          <span className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 px-2 py-1 rounded-full text-xs font-bold border border-emerald-500/20">Đã kích hoạt</span>
                        ) : store.subscription?.status === 'blocked' ? (
                          <span className="bg-rose-500/10 text-rose-600 dark:text-rose-500 px-2 py-1 rounded-full text-xs font-bold border border-rose-500/20">Bị khóa</span>
                        ) : (
                          <span className="bg-gray-500/10 text-gray-500 px-2 py-1 rounded-full text-xs font-bold border border-gray-500/20">Hết hạn</span>
                        )}
                        {store.subscription?.validUntil ? (
                          <div className="text-[10px] text-gray-500 mt-1">Hạn: {new Date(store.subscription.validUntil).toLocaleDateString('vi-VN')}</div>
                        ) : store.subscription?.trialEndDate ? (
                          <div className="text-[10px] text-gray-500 mt-1">Hạn: {new Date(store.subscription.trialEndDate).toLocaleDateString('vi-VN')}</div>
                        ) : null}
                      </td>
                      <td className="p-4">
                        <div className="flex flex-col gap-1 text-xs">
                          <span className="text-gray-600 dark:text-gray-400">Nhân viên: <span className="text-gray-900 dark:text-white font-bold">{store.stats?.employeeCount || 0}</span></span>
                          <span className="text-gray-600 dark:text-gray-400">Đăng nhập: <span className="text-emerald-600 dark:text-emerald-500 font-bold">{store.stats?.activeEmployees7Days || 0}</span> / {store.stats?.employeeCount || 0}</span>
                          <span className="text-gray-600 dark:text-gray-400">Admin: {store.stats?.adminActive ? <span className="text-emerald-600 dark:text-emerald-500">Đang hoạt động</span> : <span className="text-rose-600 dark:text-rose-500">Không hoạt động</span>}</span>
                        </div>
                      </td>
                      <td className="p-4 text-right space-x-2">
                        <button onClick={() => handleEditStore(store)} className="p-2 text-blue-600 dark:text-blue-500 hover:bg-blue-500/10 rounded-lg" title="Chỉnh sửa">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        {store.subscription?.status !== 'blocked' ? (
                          <button onClick={() => handleUpdateStoreStatus(store.id, 'blocked')} className="p-2 text-rose-600 dark:text-rose-500 hover:bg-rose-500/10 rounded-lg" title="Khóa">
                            <XCircle className="w-4 h-4" />
                          </button>
                        ) : (
                          <button onClick={() => handleUpdateStoreStatus(store.id, 'active')} className="p-2 text-emerald-600 dark:text-emerald-500 hover:bg-emerald-500/10 rounded-lg" title="Mở khóa">
                            <CheckCircle2 className="w-4 h-4" />
                          </button>
                        )}
                        <button onClick={() => handleDeleteStore(store.id)} className="p-2 text-rose-600 dark:text-rose-500 hover:bg-rose-500/10 rounded-lg">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'packages' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <h2 className="text-xl md:text-2xl font-bold">Cấu hình gói dịch vụ</h2>
              <button 
                onClick={() => setEditingPackage({
                  id: 'new-' + Date.now(),
                  name: '', trialDays: 14, price: 0, pricing: [{durationMonths: 12, price: 2000000}],
                  features: { maxUsers: 5, invoiceHistory: 'daily', financialReports: false, taxReport: false }
                })}
                className="w-full sm:w-auto bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white px-4 py-2.5 font-bold rounded-xl text-sm transition-all cursor-pointer text-center"
              >
                + Thêm Gói Mới
              </button>
            </div>
            
            <div className="bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-2xl p-4 md:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex-1">
                <h3 className="font-bold text-base md:text-lg">Cài đặt chung</h3>
                <p className="text-xs md:text-sm text-gray-500 mt-0.5">Cấu hình số ngày dùng thử cho các cửa hàng mới đăng ký.</p>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                <input 
                  type="number" 
                  className="w-20 md:w-24 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-3 py-2 text-center font-bold text-sm md:text-base"
                  value={editingTrialDays}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') setEditingTrialDays('');
                    else setEditingTrialDays(parseInt(val) || 0);
                  }}
                />
                <span className="text-xs md:text-sm font-bold text-gray-600 dark:text-gray-400">Ngày</span>
                <button 
                  onClick={async () => {
                    if (editingTrialDays === '') return;
                    const newDays = Number(editingTrialDays);
                    try {
                      let trialPkg = packages.find(p => p.id === 'trial');
                      if (trialPkg) {
                        setPackages(packages.map(p => p.id === 'trial' ? { ...p, trialDays: newDays } : p));
                      } else {
                        // Create default if missing
                        trialPkg = {
                          id: 'trial',
                          name: 'Gói Dùng Thử',
                          trialDays: newDays,
                          price: 0,
                          pricing: [],
                          features: { maxUsers: 999, invoiceHistory: 'all', financialReports: true, taxReport: true }
                        };
                        setPackages([trialPkg, ...packages]);
                      }
                      await setDoc(doc(db, 'packages', 'trial'), trialPkg ? { ...trialPkg, trialDays: newDays } : { trialDays: newDays }, { merge: true });
                      alert('Cập nhật số ngày dùng thử thành công!');
                    } catch (err) {
                      console.error(err);
                      alert('Có lỗi xảy ra khi cập nhật!');
                    }
                  }}
                  className="bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 text-white px-4 py-2 rounded-xl font-bold text-xs md:text-sm transition-colors cursor-pointer"
                >
                  Lưu
                </button>
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
              {packages.filter(pkg => pkg.id !== 'trial').map(pkg => (
                <div key={pkg.id} className="bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-2xl p-6 relative">
                  <button onClick={() => setEditingPackage(pkg)} className="absolute top-4 right-4 text-blue-600 dark:text-blue-500 hover:bg-blue-500/10 p-2 rounded-lg">
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <h3 className="text-xl font-bold text-emerald-600 dark:text-emerald-500">{pkg.name}</h3>
                  <div className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400">
                    <p>Giá: <span className="text-gray-900 dark:text-white font-bold">{((pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing[0].price : pkg.price) || 0).toLocaleString()}đ</span> / {(pkg.pricing && pkg.pricing.length > 0 ? pkg.pricing[0].durationMonths : pkg.durationMonths) || 1} tháng</p>
                    <div className="pt-2">
                      <p className="font-bold text-gray-900 dark:text-white mb-1">Chức năng:</p>
                      <ul className="space-y-1">
                        <li className="flex items-center gap-2"><CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-500" /> Tối đa {pkg.features?.maxUsers || 0} nhân viên</li>
                        <li className="flex items-center gap-2"><CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-500" /> Xem hóa đơn: {pkg.features?.invoiceHistory === 'all' ? 'Tất cả (ngày, tháng, năm)' : 'Chỉ xem trong ngày'}</li>
                        <li className="flex items-center gap-2"><CheckCircle2 className={`w-3 h-3 ${pkg.features?.financialReports ? 'text-emerald-600 dark:text-emerald-500' : 'text-gray-600'}`} /> Báo cáo tài chính</li>
                      </ul>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Package Editor Modal */}
      {editingPackage && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-lg rounded-2xl border border-black/10 dark:border-white/10 p-6 overflow-y-auto max-h-[90vh]">
            <h3 className="text-xl font-bold mb-6">{editingPackage.id.startsWith('new-') ? 'Thêm Gói Mới' : 'Sửa Gói'}</h3>
            <form onSubmit={handleSavePackage} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Tên gói</label>
                <input type="text" className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" value={editingPackage.name} onChange={e => setEditingPackage({...editingPackage, name: e.target.value})} required />
              </div>
              {editingPackage.id !== 'trial' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-bold text-gray-900 dark:text-white">Các lựa chọn giá & thời gian</label>
                    <button 
                      type="button" 
                      onClick={() => setEditingPackage({
                        ...editingPackage,
                        pricing: [...(editingPackage.pricing || []), { durationMonths: 12, price: 2000000 }]
                      })}
                      className="text-sm bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 px-3 py-1.5 rounded-lg flex items-center gap-1"
                    >
                      + Thêm giá
                    </button>
                  </div>
                  
                  {(!editingPackage.pricing || editingPackage.pricing.length === 0) && (
                    <div className="text-sm text-gray-500 italic text-center py-2">Chưa có lựa chọn giá nào. Bấm "+ Thêm giá" để thêm.</div>
                  )}

                  {(editingPackage.pricing || []).map((p, index) => (
                    <div key={index} className="flex gap-3 items-start">
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">Thời gian (Tháng)</label>
                        <input 
                          type="number" 
                          className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" 
                          value={p.durationMonths} 
                          onChange={e => {
                            const newPricing = [...(editingPackage.pricing || [])];
                            newPricing[index].durationMonths = parseInt(e.target.value);
                            setEditingPackage({...editingPackage, pricing: newPricing});
                          }} 
                          required 
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs text-gray-500 mb-1">Giá tiền (VNĐ)</label>
                        <CurrencyInput 
                          className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" 
                          value={p.price || ''} 
                          onChange={val => {
                            const newPricing = [...(editingPackage.pricing || [])];
                            newPricing[index].price = Number(val);
                            setEditingPackage({...editingPackage, pricing: newPricing});
                          }} 
                          required 
                        />
                      </div>
                      <button 
                        type="button" 
                        onClick={() => {
                          const newPricing = [...(editingPackage.pricing || [])];
                          newPricing.splice(index, 1);
                          setEditingPackage({...editingPackage, pricing: newPricing});
                        }}
                        className="mt-6 p-2 text-rose-500 hover:bg-rose-500/10 rounded-xl"
                      >
                        <XCircle className="w-5 h-5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              
              <div className="pt-4 border-t border-black/10 dark:border-white/10">
                <label className="block text-sm font-bold text-gray-900 dark:text-white mb-3">Tùy chọn chức năng (Tích để kích hoạt)</label>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Số lượng nhân viên tối đa</label>
                    <input type="number" className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" value={editingPackage.features?.maxUsers || 0} onChange={e => setEditingPackage({
                      ...editingPackage,
                      features: { ...editingPackage.features, maxUsers: parseInt(e.target.value) || 0 }
                    })} required />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Xem hóa đơn bán hàng</label>
                    <select className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" value={editingPackage.features?.invoiceHistory || 'daily'} onChange={e => setEditingPackage({
                      ...editingPackage,
                      features: { ...editingPackage.features, invoiceHistory: e.target.value as any }
                    })}>
                      <option value="daily">Xem theo ngày</option>
                      <option value="all">Xem tất cả (ngày, tháng, năm)</option>
                    </select>
                  </div>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" className="w-5 h-5 accent-emerald-500" checked={editingPackage.features?.financialReports || false} onChange={e => setEditingPackage({
                      ...editingPackage,
                      features: { ...editingPackage.features, financialReports: e.target.checked }
                    })} />
                    <span className="text-sm">Xem báo cáo tài chính</span>
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" className="w-5 h-5 accent-emerald-500" checked={editingPackage.features?.taxReport || false} onChange={e => setEditingPackage({
                      ...editingPackage,
                      features: { ...editingPackage.features, taxReport: e.target.checked }
                    })} />
                    <span className="text-sm">Báo cáo thuế</span>
                  </label>
                </div>
              </div>
              
              <div className="flex gap-4 pt-6">
                <button type="button" onClick={() => setEditingPackage(null)} className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-900 dark:text-white font-bold">Hủy</button>
                <button type="submit" className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold">Lưu lại</button>
              </div>
            </form>
          </div>
        </div>
      )}

        {activeTab === 'settings' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">Cấu hình thanh toán SePay</h2>
            </div>
            
            <form onSubmit={handleSaveConfig} className="bg-white dark:bg-[#151619] border border-black/10 dark:border-white/10 rounded-2xl p-6 space-y-6 max-w-2xl">
              <div>
                <label className="text-sm text-gray-500 uppercase font-bold mb-1 block">Ngân Hàng Nhận Tiền</label>
                <input 
                  type="text" 
                  list="superadmin-bank-list"
                  value={systemConfig.bankCode || ''}
                  onChange={e => setSystemConfig({...systemConfig, bankCode: e.target.value})}
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-emerald-500"
                  placeholder="Bấm để chọn ngân hàng hoặc nhập mã"
                  required
                />
                <datalist id="superadmin-bank-list">
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
                  <option value="LPB">LPBank</option>
                  <option value="COOPBANK">Co-opBank (Ngân hàng Hợp tác xã)</option>
                  <option value="BAB">Bac A Bank</option>
                  <option value="BVB">BVBank</option>
                  <option value="NAB">Nam A Bank</option>
                </datalist>

              </div>

              <div>
                <label className="text-sm text-gray-500 uppercase font-bold mb-1 block">Số Tài Khoản</label>
                <input 
                  type="text" 
                  value={systemConfig.bankAccountNumber || ''}
                  onChange={e => setSystemConfig({...systemConfig, bankAccountNumber: e.target.value})}
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-emerald-500 font-mono text-lg tracking-wider"
                  placeholder="Nhập số tài khoản"
                  required
                />
              </div>

              <div>
                <label className="text-sm text-gray-500 uppercase font-bold mb-1 block">Tên Chủ Tài Khoản</label>
                <input 
                  type="text" 
                  value={systemConfig.bankAccountName || ''}
                  onChange={e => setSystemConfig({...systemConfig, bankAccountName: e.target.value.toUpperCase()})}
                  className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-emerald-500 uppercase"
                  placeholder="NGUYEN VAN A"
                  required
                />
                <p className="text-xs text-gray-500 mt-2">Viết HOA không dấu. Thông tin này sẽ được dùng để tạo mã QR cho các cửa hàng khi họ gia hạn.</p>
              </div>

              <div className="pt-4 border-t border-black/10 dark:border-white/10">
                <button 
                  type="submit" 
                  disabled={isSavingConfig}
                  className="w-full py-4 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded-2xl flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                >
                  {isSavingConfig ? 'Đang lưu...' : 'Lưu Cấu Hình'}
                </button>
              </div>
            </form>
          </div>
        )}
      {/* Store Editor Modal */}
      {editingStore && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-lg rounded-2xl border border-black/10 dark:border-white/10 p-6 overflow-y-auto max-h-[90vh]">
            <h3 className="text-xl font-bold mb-6">Chỉnh sửa Cửa hàng</h3>
            <form onSubmit={handleSaveStore} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Tên cửa hàng</label>
                <input type="text" className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" value={editingStore.name || ''} onChange={e => setEditingStore({...editingStore, name: e.target.value})} required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Mã cửa hàng</label>
                  <input type="text" className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" value={editingStore.code || ''} onChange={e => setEditingStore({...editingStore, code: e.target.value})} required />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Số điện thoại Admin</label>
                  <input type="text" className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" value={editingStore.phone || ''} onChange={e => setEditingStore({...editingStore, phone: e.target.value})} />
                </div>
              </div>

              {editingStoreAdmin && (
                <div className="bg-black/5 dark:bg-white/5 p-4 rounded-xl border border-black/10 dark:border-white/10 space-y-3">
                  <h4 className="font-bold text-emerald-600 dark:text-emerald-500 mb-2">Tài khoản Quản trị</h4>
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Tên đăng nhập</label>
                    <input type="text" className="w-full bg-black/50 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" value={editingStoreAdmin.username || ''} onChange={e => setEditingStoreAdmin({...editingStoreAdmin, username: e.target.value})} required />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Mật khẩu</label>
                    <input type="text" className="w-full bg-black/50 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" value={editingStoreAdmin.password || ''} onChange={e => setEditingStoreAdmin({...editingStoreAdmin, password: e.target.value})} required />
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-black/10 dark:border-white/10 space-y-4">
                <h4 className="font-bold text-emerald-600 dark:text-emerald-500">Cấu hình Gói dịch vụ</h4>
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Trạng thái gói</label>
                  <select 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 text-gray-900 dark:text-white"
                    value={editingStore.subscription?.status || 'trial'}
                    onChange={e => setEditingStore({
                      ...editingStore, 
                      subscription: { ...editingStore.subscription, status: e.target.value as any }
                    })}
                  >
                    <option value="trial">Dùng thử (Trial)</option>
                    <option value="active">Đã kích hoạt (Active)</option>
                    <option value="expired">Hết hạn (Expired)</option>
                    <option value="blocked">Bị khóa (Blocked)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Gói dịch vụ (Package ID)</label>
                  <select 
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 text-gray-900 dark:text-white"
                    value={editingStore.subscription?.packageId || ''}
                    onChange={e => setEditingStore({
                      ...editingStore, 
                      subscription: { ...editingStore.subscription, packageId: e.target.value }
                    })}
                  >
                    <option value="">Chưa chọn</option>
                    {packages.map(pkg => (
                      <option key={pkg.id} value={pkg.id}>{pkg.name}</option>
                    ))}
                  </select>
                </div>

                {editingStore.subscription?.status === 'trial' ? (
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Ngày hết hạn dùng thử</label>
                    <input 
                      type="datetime-local" 
                      className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 text-gray-900 dark:text-white" 
                      value={editingStore.subscription?.trialEndDate ? new Date(editingStore.subscription.trialEndDate).toISOString().slice(0, 16) : ''} 
                      onChange={e => setEditingStore({
                        ...editingStore, 
                        subscription: { ...editingStore.subscription, trialEndDate: new Date(e.target.value).toISOString() }
                      })} 
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Ngày hết hạn gói (Valid Until)</label>
                    <input 
                      type="datetime-local" 
                      className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2 text-gray-900 dark:text-white" 
                      value={editingStore.subscription?.validUntil ? new Date(editingStore.subscription.validUntil).toISOString().slice(0, 16) : ''} 
                      onChange={e => setEditingStore({
                        ...editingStore, 
                        subscription: { ...editingStore.subscription, validUntil: new Date(e.target.value).toISOString() }
                      })} 
                    />
                  </div>
                )}
              </div>
              
              <div className="flex gap-4 pt-6">
                <button type="button" onClick={() => setEditingStore(null)} className="flex-1 py-3 rounded-xl border border-black/10 dark:border-white/10 text-gray-900 dark:text-white font-bold">Hủy</button>
                <button type="submit" className="flex-1 py-3 rounded-xl bg-emerald-500 text-white font-bold">Lưu lại</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
