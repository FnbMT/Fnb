import React, { useState } from 'react';
import { Users, Search, Plus, Star, Phone, History, X, Save, Percent } from 'lucide-react';
import { Customer, CustomerType, User } from '../types';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';

export const CustomerView = ({ 
  customers, 
  customerTypes,
  onAddCustomer,
  onUpdateCustomerTypes,
  currentUser
}: { 
  customers: Customer[],
  customerTypes: CustomerType[],
  onAddCustomer: (customer: Customer) => void,
  onUpdateCustomerTypes: (types: CustomerType[]) => void,
  currentUser: User | null
}) => {
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showTypeModal, setShowTypeModal] = useState(false);
  
  const [newCustomer, setNewCustomer] = useState<{name: string, phone: string, typeId: string}>({
    name: '', phone: '', typeId: customerTypes[0]?.id || ''
  });
  
  const [newType, setNewType] = useState<{name: string, discountPercent: number}>({
    name: '', discountPercent: 0
  });

  const filtered = customers.filter(c => 
    c.name.toLowerCase().includes(search.toLowerCase()) || 
    c.phone.includes(search)
  );

  const handleAddCustomerSubmit = () => {
    if (!newCustomer.name || !newCustomer.phone) {
      alert('Vui lòng nhập tên và số điện thoại');
      return;
    }
    const type = customerTypes.find(t => t.id === newCustomer.typeId);
    
    onAddCustomer({
      id: Math.random().toString(36).substr(2, 9),
      name: newCustomer.name,
      phone: newCustomer.phone,
      typeId: newCustomer.typeId,
      level: type ? type.name : 'Normal',
      points: 0,
      lastVisit: new Date().toISOString()
    });
    setShowAddModal(false);
    setNewCustomer({ name: '', phone: '', typeId: customerTypes[0]?.id || '' });
  };

  const handleAddTypeSubmit = () => {
    if (!newType.name) {
      alert('Vui lòng nhập tên loại khách hàng');
      return;
    }
    const newTypes = [
      ...customerTypes,
      {
        id: Math.random().toString(36).substr(2, 9),
        name: newType.name,
        discountPercent: newType.discountPercent
      }
    ];
    onUpdateCustomerTypes(newTypes);
    setShowTypeModal(false);
    setNewCustomer(prev => ({ ...prev, typeId: newTypes[newTypes.length - 1].id }));
    setNewType({ name: '', discountPercent: 0 });
  };

  return (
    <div className="p-8 space-y-6 h-full overflow-y-auto">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Users className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
          Quản lý Khách hàng (CRM)
        </h3>
        <button 
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-bold hover:bg-emerald-400 transition-all cursor-pointer"
        >
          <Plus className="w-4 h-4" /> Thêm khách hàng
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input 
          type="text" 
          placeholder="Tìm theo tên hoặc số điện thoại..."
          className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl py-3 pl-10 pr-4 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.map(customer => {
          const cType = customerTypes.find(t => t.id === customer.typeId) || { name: customer.level, discountPercent: 0 };
          return (
          <div key={customer.id} className="bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-2xl p-6 space-y-4 hover:border-emerald-500/30 transition-all">
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-500 font-bold text-xl">
                  {customer.name.charAt(0)}
                </div>
                <div>
                  <h4 className="font-bold text-gray-900 dark:text-white">{customer.name}</h4>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Phone className="w-3 h-3" /> {customer.phone}
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className="px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-blue-500/20 text-blue-600 dark:text-blue-500">
                  {cType.name}
                </div>
                {cType.discountPercent > 0 && (
                  <span className="text-[10px] text-emerald-600 dark:text-emerald-500 font-bold">- {cType.discountPercent}%</span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-black/5 dark:border-white/5">
              <div>
                <p className="text-xs text-gray-500 uppercase">Điểm tích lũy</p>
                <p className="text-lg font-bold text-emerald-600 dark:text-emerald-500 flex items-center gap-1">
                  <Star className="w-4 h-4 fill-emerald-500" /> {customer.points}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500 uppercase">Lần cuối ghé</p>
                <p className="text-sm text-gray-900 dark:text-white flex items-center gap-1">
                  <History className="w-4 h-4 text-gray-600 dark:text-gray-400" /> 
                  {customer.lastVisit ? new Date(customer.lastVisit).toLocaleDateString('vi-VN') : 'Mới'}
                </p>
              </div>
            </div>

            <button className="w-full py-2 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-xl text-sm font-medium transition-all cursor-pointer">
              Xem lịch sử mua hàng
            </button>
          </div>
        )})}
      </div>

      {/* Add Customer Modal */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white dark:bg-[#1a1b1e] rounded-3xl p-6 w-full max-w-md border border-black/10 dark:border-white/10 shadow-2xl space-y-6"
            >
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white">Thêm khách hàng</h3>
                <button onClick={() => setShowAddModal(false)} className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors">
                  <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Tên khách hàng</label>
                  <input
                    type="text"
                    value={newCustomer.name}
                    onChange={(e) => setNewCustomer({...newCustomer, name: e.target.value})}
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    placeholder="VD: Nguyễn Văn A"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Số điện thoại</label>
                  <input
                    type="tel"
                    value={newCustomer.phone}
                    onChange={(e) => setNewCustomer({...newCustomer, phone: e.target.value})}
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    placeholder="VD: 0912345678"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Loại khách hàng</label>
                  <div className="flex gap-2">
                    <select
                      value={newCustomer.typeId}
                      onChange={(e) => setNewCustomer({...newCustomer, typeId: e.target.value})}
                      className="flex-1 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50 appearance-none"
                    >
                      {customerTypes.map(t => (
                        <option key={t.id} value={t.id} className="bg-white dark:bg-[#1a1b1e] text-gray-900 dark:text-white">
                          {t.name} {t.discountPercent > 0 ? `(Giảm ${t.discountPercent}%)` : ''}
                        </option>
                      ))}
                    </select>
                    <button 
                      onClick={() => setShowTypeModal(true)}
                      className="px-4 py-3 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl text-gray-900 dark:text-white hover:bg-black/10 dark:hover:bg-white/10 transition-all cursor-pointer"
                      title="Thêm loại khách hàng"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              </div>

              <button
                onClick={handleAddCustomerSubmit}
                className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <Save className="w-5 h-5" />
                Lưu khách hàng
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add Customer Type Modal */}
      <AnimatePresence>
        {showTypeModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white dark:bg-[#1a1b1e] rounded-3xl p-6 w-full max-w-sm border border-black/10 dark:border-white/10 shadow-2xl space-y-6"
            >
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white">Thêm loại khách hàng</h3>
                <button onClick={() => setShowTypeModal(false)} className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors cursor-pointer">
                  <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Tên loại khách</label>
                  <input
                    type="text"
                    value={newType.name}
                    onChange={(e) => setNewType({...newType, name: e.target.value})}
                    className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    placeholder="VD: VIP, Vàng, Bạc..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">Ưu đãi giảm giá (%)</label>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={newType.discountPercent}
                      onChange={(e) => setNewType({...newType, discountPercent: Number(e.target.value)})}
                      className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl pl-4 pr-10 py-3 text-gray-900 dark:text-white focus:outline-none focus:border-emerald-500/50"
                    />
                    <Percent className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 dark:text-gray-400" />
                  </div>
                </div>
              </div>

              <button
                onClick={handleAddTypeSubmit}
                className="w-full py-3 bg-blue-500 hover:bg-blue-400 text-gray-900 dark:text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <Plus className="w-5 h-5" />
                Thêm loại
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
