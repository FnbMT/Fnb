/**
 * Schema vai trò chuẩn dùng chung giữa UI, TypeScript và Backend API.
 * 
 * - Vai trò nhân viên quán: 'order' | 'cashier' | 'order_cashier' | 'kitchen' | 'manager'
 * - Vai trò quản trị hệ thống: 'admin' (Chủ quán) | 'superadmin' (Quản trị viên tối cao)
 */

export const STORE_STAFF_ROLES = [
  'order',
  'cashier',
  'order_cashier',
  'kitchen',
  'manager'
] as const;

export type StoreStaffRole = (typeof STORE_STAFF_ROLES)[number];

export const SYSTEM_ADMIN_ROLES = ['admin', 'superadmin'] as const;
export type SystemAdminRole = (typeof SYSTEM_ADMIN_ROLES)[number];

export const ALL_USER_ROLES = [
  ...STORE_STAFF_ROLES,
  ...SYSTEM_ADMIN_ROLES
] as const;

export type UserRole = (typeof ALL_USER_ROLES)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  order: 'Nhân viên Order',
  cashier: 'Thu ngân',
  order_cashier: 'Order & Thu ngân',
  kitchen: 'Bếp / Pha chế',
  manager: 'Quản lý',
  admin: 'Quản trị viên',
  superadmin: 'Quản trị viên tối cao'
};

export function isStoreStaffRole(role: string): role is StoreStaffRole {
  return (STORE_STAFF_ROLES as readonly string[]).includes(role);
}

export function isValidUserRole(role: string): role is UserRole {
  return (ALL_USER_ROLES as readonly string[]).includes(role);
}
