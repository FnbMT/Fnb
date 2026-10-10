import { StorePackage, StorePackageFeatures, User } from '../types';

export interface PackageTabDefinition {
  id: 'kitchen' | 'inventory' | 'customers' | 'reports' | 'tax_report' | 'summary' | 'attendance';
  label: string;
  description: string;
}

export const APP_PACKAGE_TABS: PackageTabDefinition[] = [
  { 
    id: 'kitchen', 
    label: 'Nhà bếp', 
    description: 'Điều phối món chế biến, nhận món từ thu ngân/bồi bàn và báo hoàn thành' 
  },
  { 
    id: 'inventory', 
    label: 'Kho hàng', 
    description: 'Quản lý nguyên liệu, định lượng món ăn, nhập - xuất kho và kiểm kê' 
  },
  { 
    id: 'customers', 
    label: 'Khách hàng', 
    description: 'Quản lý hồ sơ khách hàng, phân nhóm và tích lũy điểm thưởng' 
  },
  { 
    id: 'reports', 
    label: 'Báo cáo doanh thu', 
    description: 'Báo cáo doanh thu bán hàng theo ca, theo ngày, phương thức thanh toán' 
  },
  { 
    id: 'tax_report', 
    label: 'Báo cáo bán hàng', 
    description: 'Báo cáo hóa đơn chi tiết bán lẻ, xuất báo cáo doanh số' 
  },
  { 
    id: 'summary', 
    label: 'Tổng kết', 
    description: 'Tổng kết doanh thu, đối soát tiền mặt & chuyển khoản, sổ quỹ thu chi' 
  },
  {
    id: 'attendance',
    label: 'Chấm công nhân viên',
    description: 'Mở khóa chức năng chấm công QR & định vị vị trí GPS cho nhân viên'
  }
];

export const isTabAllowedInPackage = (
  tabId: string,
  pkg?: StorePackage | null
): boolean => {
  if (!pkg || !pkg.features) return true;
  const feat = pkg.features;

  if (tabId === 'kitchen') {
    return feat.kitchen !== undefined ? !!feat.kitchen : true;
  }
  if (tabId === 'inventory') {
    return feat.inventory !== undefined ? !!feat.inventory : true;
  }
  if (tabId === 'customers') {
    return feat.customers !== undefined ? !!feat.customers : true;
  }
  if (tabId === 'reports') {
    if (feat.reports !== undefined) return !!feat.reports;
    if (feat.financialReports !== undefined) return !!feat.financialReports;
    return true;
  }
  if (tabId === 'tax_report') {
    if (feat.tax_report !== undefined) return !!feat.tax_report;
    if (feat.taxReport !== undefined) return !!feat.taxReport;
    return true;
  }
  if (tabId === 'summary') {
    return feat.summary !== undefined ? !!feat.summary : true;
  }
  if (tabId === 'attendance') {
    if (feat.attendance !== undefined) return !!feat.attendance;
    if (pkg?.id === 'basic') return false;
    return true;
  }

  return true;
};

export const checkStoreTabPermission = (
  tabId: string,
  currentUser: User | null,
  packagesList: StorePackage[] = []
): boolean => {
  // Always allowed base operational views
  if (['tables', 'menu_mgmt', 'shifts', 'settings', 'user_mgmt', 'my_payroll'].includes(tabId)) {
    return true;
  }

  // Super Admin always has full access
  if ((currentUser as any)?.role === 'superadmin' || currentUser?.username === 'superadmin') {
    return true;
  }

  const store = currentUser?.store;
  const packageId = store?.subscription?.packageId || 'trial';
  
  // Locate package
  let currentPkg = packagesList.find(p => p.id === packageId);
  if (!currentPkg && (packageId === 'trial' || store?.subscription?.status === 'trial')) {
    currentPkg = packagesList.find(p => p.id === 'trial');
  }

  return isTabAllowedInPackage(tabId, currentPkg);
};

export const isStoreAttendanceAllowed = (
  currentUser: User | null,
  packagesList: StorePackage[] = []
): boolean => {
  return checkStoreTabPermission('attendance', currentUser, packagesList);
};
