const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

const targetStr = `        <button className="relative p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer">
          <Bell className="w-6 h-6" />
          <span className="absolute top-1 right-1 w-2 h-2 bg-rose-500 rounded-full border-2 border-[#0a0a0a]" />
        </button>`;

const replacement = `        {(currentUser?.role === 'admin' || currentUser?.role === 'manager') && (
          <div className="relative" ref={notifRef}>
            <button 
              onClick={() => setShowNotifications(!showNotifications)}
              className="relative p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
            >
              <Bell className="w-6 h-6" />
              {notifications.length > 0 && (
                <span className="absolute top-1 right-1 flex h-3 w-3 items-center justify-center rounded-full bg-rose-500 text-[8px] font-bold text-white border-2 border-white dark:border-[#0a0a0a]">
                  {notifications.length}
                </span>
              )}
            </button>

            {showNotifications && (
              <div className="absolute top-full right-0 mt-2 w-80 bg-white dark:bg-[#1a1b1e] border border-black/10 dark:border-white/10 rounded-2xl shadow-xl overflow-hidden z-50">
                <div className="p-4 border-b border-black/10 dark:border-white/10 bg-gray-50 dark:bg-white/5 flex justify-between items-center">
                  <h4 className="font-bold text-gray-900 dark:text-white">Thông báo hệ thống</h4>
                  <span className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 px-2 py-1 rounded-lg font-bold">
                    {notifications.length} mới
                  </span>
                </div>
                <div className="max-h-96 overflow-y-auto custom-scrollbar">
                  {notifications.length > 0 ? (
                    notifications.map((notif, index) => (
                      <div key={notif.id + index} className="p-4 border-b border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer">
                        <div className="flex gap-3">
                          <div className={\`w-2 h-2 mt-1.5 rounded-full shrink-0 \${notif.type === 'error' ? 'bg-rose-500' : notif.type === 'warning' ? 'bg-amber-500' : 'bg-blue-500'}\`} />
                          <div>
                            <h5 className={\`text-sm font-bold \${notif.type === 'error' ? 'text-rose-600 dark:text-rose-400' : notif.type === 'warning' ? 'text-amber-600 dark:text-amber-500' : 'text-blue-600 dark:text-blue-400'}\`}>
                              {notif.title}
                            </h5>
                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 leading-relaxed">
                              {notif.description}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-gray-500 text-sm">
                      <Bell className="w-8 h-8 mx-auto mb-3 opacity-20" />
                      Không có thông báo mới nào
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}`;

content = content.replace(targetStr, replacement);
fs.writeFileSync('src/App.tsx', content);
