import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';

const STORAGE_KEY_SENT_IDS = 'fnb_sent_notification_ids';
const STORAGE_KEY_NOTIF_ENABLED = 'fnb_device_notif_enabled';

/**
 * Play pleasant chime audio alert
 */
export function playNotificationChime() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';

    // Two-tone bell chime (D5 -> A5 -> D6)
    osc1.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc1.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
    
    osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
    osc2.frequency.exponentialRampToValueAtTime(1174.66, ctx.currentTime + 0.3);

    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.6);
    osc2.stop(ctx.currentTime + 0.6);
  } catch (e) {
    // Audio context may require user interaction first
    console.debug('Chime playback error:', e);
  }
}

/**
 * Hash string to 32-bit positive integer for Capacitor LocalNotifications ID
 */
function hashStringToId(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 2147483647 || 1;
}

/**
 * Check whether device notifications are enabled in app settings
 */
export function isDeviceNotificationEnabled(): boolean {
  try {
    const val = localStorage.getItem(STORAGE_KEY_NOTIF_ENABLED);
    return val !== 'false'; // Enabled by default
  } catch {
    return true;
  }
}

/**
 * Toggle device notifications setting
 */
export function setDeviceNotificationEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY_NOTIF_ENABLED, enabled ? 'true' : 'false');
  } catch (e) {
    console.error('Save notification setting error:', e);
  }
}

/**
 * Check current notification permission status
 */
export async function checkNotificationPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  if (Capacitor.isNativePlatform()) {
    try {
      const status = await LocalNotifications.checkPermissions();
      return status.display === 'granted' ? 'granted' : status.display === 'denied' ? 'denied' : 'prompt';
    } catch {
      return 'prompt';
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    const perm = Notification.permission;
    if (perm === 'granted') return 'granted';
    if (perm === 'denied') return 'denied';
    return 'prompt';
  }

  return 'denied';
}

/**
 * Request notification permission from the OS or browser
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await LocalNotifications.requestPermissions();
      return res.display === 'granted';
    } catch (e) {
      console.warn('Capacitor notification permission request error:', e);
      return false;
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      const result = await Notification.requestPermission();
      return result === 'granted';
    } catch (e) {
      console.warn('Web notification permission request error:', e);
      return false;
    }
  }

  return false;
}

/**
 * Get IDs of notifications that have already been pushed to the phone screen
 */
function getSentNotificationIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY_SENT_IDS) || localStorage.getItem(STORAGE_KEY_SENT_IDS);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * Mark a notification ID as sent to avoid repeated alerts
 */
export function markNotificationAsSent(id: string): void {
  try {
    const current = getSentNotificationIds();
    current.add(id);
    // Keep max 200 items to avoid bloating storage
    const trimmed = Array.from(current).slice(-200);
    const serialized = JSON.stringify(trimmed);
    sessionStorage.setItem(STORAGE_KEY_SENT_IDS, serialized);
    localStorage.setItem(STORAGE_KEY_SENT_IDS, serialized);
  } catch (e) {
    console.debug('Failed to record sent notification ID:', e);
  }
}

/**
 * Check if a notification ID was already sent to the phone screen
 */
export function hasNotificationBeenSent(id: string): boolean {
  return getSentNotificationIds().has(id);
}

/**
 * Seed initial existing notification IDs without triggering alerts
 * (Prevents alert blast when user opens app for the first time)
 */
export function seedInitialNotificationIds(ids: string[]): void {
  try {
    const current = getSentNotificationIds();
    ids.forEach(id => current.add(id));
    const trimmed = Array.from(current).slice(-200);
    const serialized = JSON.stringify(trimmed);
    sessionStorage.setItem(STORAGE_KEY_SENT_IDS, serialized);
    localStorage.setItem(STORAGE_KEY_SENT_IDS, serialized);
  } catch (e) {
    console.debug('Seed notification IDs error:', e);
  }
}

export interface SendDeviceNotificationOptions {
  id: string;
  title: string;
  body: string;
  type?: 'warning' | 'error' | 'info';
  silent?: boolean;
}

/**
 * Trigger notification on the phone screen (Native OS Notification or Web Notification)
 */
export async function sendDeviceNotification({
  id,
  title,
  body,
  type = 'warning',
  silent = false
}: SendDeviceNotificationOptions): Promise<boolean> {
  // If disabled by user in settings, do not push
  if (!isDeviceNotificationEnabled()) {
    return false;
  }

  // Deduplication check
  if (hasNotificationBeenSent(id)) {
    return false;
  }

  // Mark as sent immediately
  markNotificationAsSent(id);

  let displayed = false;

  // 1. Native Capacitor (iOS & Android phone)
  if (Capacitor.isNativePlatform()) {
    try {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        const req = await LocalNotifications.requestPermissions();
        if (req.display !== 'granted') {
          return false;
        }
      }

      await LocalNotifications.schedule({
        notifications: [
          {
            id: hashStringToId(id),
            title: title,
            body: body,
            smallIcon: 'ic_launcher',
            sound: undefined, // Uses default system sound
            extra: {
              notificationId: id,
              type: type
            }
          }
        ]
      });
      displayed = true;
    } catch (e) {
      console.warn('Capacitor LocalNotification error:', e);
    }
  }

  // 2. Web Notification API (Browser / PWA installed on phone)
  if (!displayed && typeof window !== 'undefined' && 'Notification' in window) {
    try {
      if (Notification.permission === 'granted') {
        const notif = new Notification(title, {
          body: body,
          icon: '/icon.png',
          badge: '/icon.png',
          tag: id,
          requireInteraction: false
        });
        notif.onclick = () => {
          window.focus();
          notif.close();
        };
        displayed = true;
      }
    } catch (e) {
      console.warn('Web notification display error:', e);
    }
  }

  // 3. Audio Chime & Vibration
  if (!silent) {
    playNotificationChime();
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([200, 100, 200]);
      } catch {
        // Ignored if vibration is not allowed
      }
    }
  }

  return displayed;
}
