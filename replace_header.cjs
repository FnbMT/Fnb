const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

const targetStr = `const Header = ({ view, currentUser, packages, onShowUpgrade }: { view: ViewType, currentUser: User | null, packages: any[], onShowUpgrade: () => void }) => {
  const [showPackageInfo, setShowPackageInfo] = React.useState(false);`;

const replacement = `const Header = ({ 
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
}) => {
  const [showPackageInfo, setShowPackageInfo] = React.useState(false);
  const [showNotifications, setShowNotifications] = React.useState(false);
  const notifRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const notifications: { id: string, title: string, description: string, type: 'warning' | 'error' | 'info' }[] = [];
  
  if (currentUser?.role === 'admin' || currentUser?.role === 'manager') {
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
  }`;

content = content.replace(targetStr, replacement);
fs.writeFileSync('src/App.tsx', content);
