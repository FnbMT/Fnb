import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { cn } from '../lib/utils';

export const VoidReasonModal = ({
  isOpen,
  onClose,
  onSubmit,
  itemName,
  oldQuantity,
  newQuantity,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  itemName: string;
  oldQuantity: number;
  newQuantity: number;
}) => {
  const [reason, setReason] = useState('');
  const presetReasons = ['Khách đổi ý', 'Hết nguyên liệu', 'Order nhầm', 'Chờ quá lâu', 'Món lỗi'];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-[#1a1b1e] w-full max-w-md rounded-3xl p-6 border border-black/10 dark:border-white/10 shadow-2xl space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-xl font-bold text-gray-900 dark:text-white text-rose-500">Lý do hủy/giảm món</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900 dark:hover:text-white">
            <X className="w-6 h-6" />
          </button>
        </div>
        
        <div className="p-3 bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-xl text-sm border border-rose-500/20">
          <p>Món: <span className="font-bold">{itemName}</span></p>
          <p>Số lượng: <span className="font-bold line-through">{oldQuantity}</span> ➜ <span className="font-bold">{newQuantity}</span></p>
        </div>

        <div className="space-y-2">
          <label className="text-sm text-gray-600 dark:text-gray-400 font-bold">Lý do thay đổi</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl p-3 text-gray-900 dark:text-white focus:outline-none focus:border-rose-500 min-h-[80px]"
            placeholder="Nhập lý do chi tiết..."
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs text-gray-500 font-bold uppercase">Lý do mẫu</label>
          <div className="flex flex-wrap gap-2">
            {presetReasons.map(r => (
              <button
                key={r}
                onClick={() => setReason(r)}
                className="px-3 py-1.5 bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 rounded-lg text-sm text-gray-700 dark:text-gray-300 transition-colors border border-black/10 dark:border-white/10"
              >
                <Plus className="w-3 h-3 inline-block mr-1" />
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-4 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl font-bold bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-gray-900 dark:text-white"
          >
            Hủy bỏ
          </button>
          <button
            onClick={() => {
              if (!reason.trim()) {
                alert("Vui lòng nhập hoặc chọn lý do!");
                return;
              }
              onSubmit(reason);
            }}
            className="flex-1 py-3 rounded-xl font-bold bg-rose-500 hover:bg-rose-600 text-white shadow-lg"
          >
            Xác nhận
          </button>
        </div>
      </div>
    </div>
  );
};
