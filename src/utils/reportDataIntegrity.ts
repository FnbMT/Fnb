import { DailyStats } from '../types';
export function isReconciledDailyStat(stat: DailyStats | undefined | null): boolean { return Boolean(stat && (stat.coverageStatus === 'reconciled' || stat.coverageStatus === 'zero_activity')); }
export function isCashPayment(paymentMethod?: string): boolean { return paymentMethod === 'cash' || !paymentMethod; }
