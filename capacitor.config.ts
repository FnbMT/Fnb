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
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    }
  }
};

export default config;
