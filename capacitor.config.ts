import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.huyfnb.app',
  appName: 'Fnb Master',
  webDir: 'dist',
  server: {
    iosScheme: 'https',
    androidScheme: 'https',
    hostname: 'localhost',
    cleartext: true
  },
  ios: {
    webContentsDebuggingEnabled: true
  },
  android: {
    allowMixedContent: true
  }
};

export default config;
