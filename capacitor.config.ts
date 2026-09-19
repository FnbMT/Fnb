import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.huyfnb.app',
  appName: 'Fnb Master',
  webDir: 'dist',
  server: {
    iosScheme: 'https',
    androidScheme: 'https',
    hostname: 'localhost'
  },
  ios: {
    webContentsDebuggingEnabled: true
  }
};

export default config;
