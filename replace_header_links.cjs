const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

content = content.replace(
  /<Header view=\{view\} currentUser=\{currentUser\} packages=\{packages\} onShowUpgrade=\{\(\) => setShowUpgradeModal\(true\)\} menu=\{menu\} shifts=\{shifts\} \/>/,
  '<Header view={view} setView={handleSetView} currentUser={currentUser} packages={packages} onShowUpgrade={() => setShowUpgradeModal(true)} menu={menu} shifts={shifts} />'
);

const headerSigSearch = `const Header = ({ 
  view, 
  currentUser, 
  packages, 
  onShowUpgrade,
  menu = [],
  shifts = []
}: { 
  view: ViewType; 
  currentUser: User | null; 
  packages: any[]; 
  onShowUpgrade: () => void;
  menu?: MenuItem[];
  shifts?: Shift[];
}) => {`;

const headerSigReplacement = `const Header = ({ 
  view, 
  setView,
  currentUser, 
  packages, 
  onShowUpgrade,
  menu = [],
  shifts = []
}: { 
  view: ViewType; 
  setView: (view: ViewType) => void;
  currentUser: User | null; 
  packages: any[]; 
  onShowUpgrade: () => void;
  menu?: MenuItem[];
  shifts?: Shift[];
}) => {`;

content = content.replace(headerSigSearch, headerSigReplacement);

const notifArraySearch = `const notifications: { id: string, title: string, description: string, type: 'warning' | 'error' | 'info' }[] = [];`;
const notifArrayReplacement = `const notifications: { id: string, title: string, description: string, type: 'warning' | 'error' | 'info', action?: () => void }[] = [];`;

content = content.replace(notifArraySearch, notifArrayReplacement);

const notifLogicSearch = `
    if (currentUser.store?.subscription?.validUntil) {
      const daysLeft = Math.ceil((new Date(currentUser.store.subscription.validUntil).getTime() - new Date().getTime()) / (1000 * 3600 * 24));
      if (daysLeft >= 0 && daysLeft <= 7) {
        notifications.push({
          id: 'sub-expiring',
          title: 'Gói cước sắp hết hạn',
          description: \`Gói cước của bạn sẽ hết hạn sau \${daysLeft} ngày. Vui lòng gia hạn.\`,
          type: 'warning'
        });
      }
    } else if (currentUser.store?.subscription?.status === 'trial' && currentUser.store?.subscription?.trialEndDate) {
      const daysLeft = Math.ceil((new Date(currentUser.store.subscription.trialEndDate).getTime() - new Date().getTime()) / (1000 * 3600 * 24));
      if (daysLeft >= 0 && daysLeft <= 7) {
        notifications.push({
          id: 'trial-expiring',
          title: 'Dùng thử sắp hết hạn',
          description: \`Gói dùng thử sẽ hết hạn sau \${daysLeft} ngày.\`,
          type: 'warning'
        });
      }
    }

    const lowStockItems = menu.filter(item => (item.type === 'goods' || item.isInventory) && item.stock <= 5);
    if (lowStockItems.length > 0) {
      const itemNames = lowStockItems.slice(0, 3).map(i => i.name).join(', ');
      const moreText = lowStockItems.length > 3 ? \` và \${lowStockItems.length - 3} mục khác\` : '';
      notifications.push({
        id: 'low-stock',
        title: 'Hàng hóa sắp hết tồn kho',
        description: \`Các mặt hàng sắp hết: \${itemNames}\${moreText}.\`,
        type: 'error'
      });
    }

    const discrepancyShifts = shifts.filter(s => s.discrepancy !== undefined && s.discrepancy !== 0 && !s.discrepancyProcessed);
    if (discrepancyShifts.length > 0) {
      const totalDiscrepancy = discrepancyShifts.reduce((sum, s) => sum + (s.discrepancy || 0), 0);
      notifications.push({
        id: 'shift-discrepancy',
        title: 'Chênh lệch ca làm việc',
        description: \`Có \${discrepancyShifts.length} ca làm việc chưa xử lý chênh lệch (Tổng: \${totalDiscrepancy.toLocaleString('vi-VN')}đ).\`,
        type: 'error'
      });
    }
`;

const notifLogicReplacement = `
    if (currentUser.store?.subscription?.validUntil) {
      const daysLeft = Math.ceil((new Date(currentUser.store.subscription.validUntil).getTime() - new Date().getTime()) / (1000 * 3600 * 24));
      if (daysLeft >= 0 && daysLeft <= 7) {
        notifications.push({
          id: 'sub-expiring',
          title: 'Gói cước sắp hết hạn',
          description: \`Gói cước của bạn sẽ hết hạn sau \${daysLeft} ngày. Vui lòng gia hạn.\`,
          type: 'warning',
          action: () => { setShowNotifications(false); onShowUpgrade(); }
        });
      }
    } else if (currentUser.store?.subscription?.status === 'trial' && currentUser.store?.subscription?.trialEndDate) {
      const daysLeft = Math.ceil((new Date(currentUser.store.subscription.trialEndDate).getTime() - new Date().getTime()) / (1000 * 3600 * 24));
      if (daysLeft >= 0 && daysLeft <= 7) {
        notifications.push({
          id: 'trial-expiring',
          title: 'Dùng thử sắp hết hạn',
          description: \`Gói dùng thử sẽ hết hạn sau \${daysLeft} ngày.\`,
          type: 'warning',
          action: () => { setShowNotifications(false); onShowUpgrade(); }
        });
      }
    }

    const lowStockItems = menu.filter(item => (item.type === 'goods' || item.isInventory) && item.stock <= 5);
    if (lowStockItems.length > 0) {
      const itemNames = lowStockItems.slice(0, 3).map(i => i.name).join(', ');
      const moreText = lowStockItems.length > 3 ? \` và \${lowStockItems.length - 3} mục khác\` : '';
      notifications.push({
        id: 'low-stock',
        title: 'Hàng hóa sắp hết tồn kho',
        description: \`Các mặt hàng sắp hết: \${itemNames}\${moreText}.\`,
        type: 'error',
        action: () => { setShowNotifications(false); setView('inventory'); }
      });
    }

    const discrepancyShifts = shifts.filter(s => s.discrepancy !== undefined && s.discrepancy !== 0 && !s.discrepancyProcessed);
    if (discrepancyShifts.length > 0) {
      const totalDiscrepancy = discrepancyShifts.reduce((sum, s) => sum + (s.discrepancy || 0), 0);
      notifications.push({
        id: 'shift-discrepancy',
        title: 'Chênh lệch ca làm việc',
        description: \`Có \${discrepancyShifts.length} ca làm việc chưa xử lý chênh lệch (Tổng: \${totalDiscrepancy.toLocaleString('vi-VN')}đ).\`,
        type: 'error',
        action: () => { setShowNotifications(false); setView('shifts'); }
      });
    }
`;

content = content.replace(notifLogicSearch, notifLogicReplacement);

const notifRenderSearch = `                      <div key={notif.id + index} className="p-4 border-b border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer">`;
const notifRenderReplacement = `                      <div key={notif.id + index} onClick={notif.action} className="p-4 border-b border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer">`;

content = content.replace(notifRenderSearch, notifRenderReplacement);

fs.writeFileSync('src/App.tsx', content);
