import * as fs from 'fs';
let code = fs.readFileSync('src/components/SuperAdminView.tsx', 'utf-8');

const tabContent = `
        {activeTab === 'app_updates' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-2xl font-bold">Cập nhật Ứng dụng Android</h2>
            </div>
            
            <div className="bg-white dark:bg-[#1a1b1e] rounded-2xl p-6 border border-black/10 dark:border-white/10 max-w-2xl">
              <form onSubmit={handleApkUpload} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Phiên bản (Ví dụ: 1.1.0) *</label>
                  <input type="text" value={apkVersion} onChange={(e) => setApkVersion(e.target.value)} required className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Ghi chú bản cập nhật</label>
                  <textarea value={apkReleaseNotes} onChange={(e) => setApkReleaseNotes(e.target.value)} rows={4} className="w-full bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-2" placeholder="- Sửa lỗi\\n- Thêm tính năng mới..." />
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="apkMandatory" checked={apkIsMandatory} onChange={(e) => setApkIsMandatory(e.target.checked)} className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-500" />
                  <label htmlFor="apkMandatory" className="text-sm">Bắt buộc cập nhật (Khách hàng không thể bấm Bỏ qua)</label>
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">Tệp cài đặt APK (Tối đa 50MB)</label>
                  <input type="file" accept=".apk" onChange={(e) => setApkFile(e.target.files?.[0] || null)} className="w-full text-sm" />
                  {currentApkInfo?.apkUrl && !apkFile && (
                    <p className="text-xs text-emerald-600 mt-1">Đã có tệp APK trên hệ thống.</p>
                  )}
                  {apkUploadProgress > 0 && apkUploadProgress < 100 && (
                    <div className="mt-2 w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
                      <div className="bg-emerald-600 h-2.5 rounded-full" style={{ width: \`\${apkUploadProgress}%\` }}></div>
                    </div>
                  )}
                </div>
                
                <button type="submit" disabled={apkUploadProgress > 0 && apkUploadProgress < 100} className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-3 rounded-xl transition-colors mt-4 flex items-center justify-center gap-2">
                  <UploadCloud className="w-5 h-5" /> Lưu bản cập nhật
                </button>
              </form>
            </div>
          </div>
        )}
`;

code = code.replace(
  "</button>\n          <button \n            onClick={() => setActiveTab('settings')}",
  "</button>\n          <button \n            onClick={() => setActiveTab('app_updates')}\n            className={`flex-shrink-0 md:w-full flex items-center gap-2 md:gap-3 px-3.5 md:px-4 py-2.5 md:py-3 rounded-xl transition-all text-xs md:text-base whitespace-nowrap cursor-pointer ${activeTab === 'app_updates' ? 'bg-emerald-500 text-white font-bold shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'}`}\n          >\n            <Smartphone className=\"w-4 h-4 md:w-5 md:h-5\" /> Ứng dụng Android\n          </button>\n          <button \n            onClick={() => setActiveTab('settings')}"
);

code = code.replace(
  "        {activeTab === 'settings' && (",
  tabContent + "\n        {activeTab === 'settings' && ("
);

fs.writeFileSync('src/components/SuperAdminView.tsx', code);
