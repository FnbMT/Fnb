import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import loginHandler from "./api/login";
import revealPasswordHandler from "./api/reveal-password";
import sepayWebhookHandler from "./api/sepay-webhook";
import saveUserHandler from "./api/save-user";
import changePasswordHandler from "./api/change-password";
import deleteUserHandler from "./api/delete-user";
import deleteStoreHandler from "./api/delete-store";
import registerStoreHandler from "./api/register-store";
import resetPasswordHandler from "./api/reset-password";
import migrateStoreHandler from "./api/migrate-store";
import { hasAdminCredential, getAdminStatus } from "./api/_firebaseAdmin";

export interface ServerReadiness {
  ready: boolean;
  status: 'ok' | 'degraded' | 'unready';
  timestamp: string;
  uptime: number;
  checks: {
    encryptionKey: { ready: boolean; message: string };
    jwtSecret: { ready: boolean; message: string };
    superadminAuth: { ready: boolean; configured: boolean; message: string };
    firebaseAdmin: { ready: boolean; hasServiceAccount: boolean; isInitialized: boolean; message: string };
  };
  missingRequired: string[];
  warnings: string[];
}

export function checkServerReadiness(): ServerReadiness {
  const missingRequired: string[] = [];
  const warnings: string[] = [];

  // 1. Kiểm tra khóa ký & mã hóa
  const hasEncKey = Boolean(process.env.DATA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY);
  const hasJwtSec = Boolean(process.env.JWT_SECRET || process.env.ENCRYPTION_KEY);

  if (!hasEncKey) {
    missingRequired.push("DATA_ENCRYPTION_KEY");
  }
  if (!hasJwtSec) {
    missingRequired.push("JWT_SECRET");
  }

  // 2. Kiểm tra mật khẩu SuperAdmin
  const superPass = process.env.SUPERADMIN_PASSWORD;
  const hasSuperPass = Boolean(superPass && superPass.trim().length > 0);
  if (!hasSuperPass) {
    warnings.push("SUPERADMIN_PASSWORD chưa thiết lập; endpoint SuperAdmin bị vô hiệu hóa.");
  }

  // 3. Kiểm tra Firebase Admin SDK
  const adminStatus = getAdminStatus();
  const isProduction = process.env.NODE_ENV === 'production';
  const requireAdmin = isProduction || process.env.REQUIRE_ADMIN_AUTH === 'true';

  if (!adminStatus.hasCredential) {
    if (requireAdmin) {
      missingRequired.push("Firebase Admin Service Account (FIREBASE_SERVICE_ACCOUNT hoặc FIREBASE_CLIENT_EMAIL & FIREBASE_PRIVATE_KEY)");
    } else {
      warnings.push("Firebase Admin Service Account chưa cung cấp; hệ thống đang dùng client bridge (chỉ dùng cho dev/preview).");
    }
  } else if (!adminStatus.isInitialized) {
    missingRequired.push("Firebase Admin Service Account (chứng chỉ không hợp lệ hoặc lỗi khởi tạo)");
  }

  const isReady = missingRequired.length === 0 && (!requireAdmin || (adminStatus.hasCredential && adminStatus.isInitialized));

  return {
    ready: isReady,
    status: isReady ? (warnings.length > 0 ? "degraded" : "ok") : "unready",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    checks: {
      encryptionKey: {
        ready: hasEncKey,
        message: hasEncKey ? "Khóa mã hóa đã nạp" : "Thiếu DATA_ENCRYPTION_KEY"
      },
      jwtSecret: {
        ready: hasJwtSec,
        message: hasJwtSec ? "Khóa ký JWT đã nạp" : "Thiếu JWT_SECRET"
      },
      superadminAuth: {
        ready: true,
        configured: hasSuperPass,
        message: hasSuperPass ? "SuperAdmin password đã cấu hình" : "SuperAdmin password chưa cấu hình"
      },
      firebaseAdmin: {
        ready: Boolean(adminStatus.hasCredential && adminStatus.isInitialized),
        hasServiceAccount: adminStatus.hasCredential,
        isInitialized: adminStatus.isInitialized,
        message: adminStatus.hasCredential
          ? (adminStatus.isInitialized ? "Firebase Admin SDK sẵn sàng" : "Firebase Admin SDK lỗi khởi tạo")
          : (requireAdmin ? "Thiếu Service Account bắt buộc trong production" : "Đang dùng Firebase client bridge (dev mode)")
      }
    },
    missingRequired,
    warnings
  };
}

export function validateServerConfig() {
  console.log("--------------------------------------------------");
  console.log("[Server Startup] Đang kiểm tra cấu hình bảo mật...");

  const readiness = checkServerReadiness();
  if (readiness.checks.encryptionKey.ready && readiness.checks.jwtSecret.ready) {
    console.log("✅ [Security Config] Khóa mã hóa & chữ ký số đã được nạp thành công.");
  } else {
    console.warn("⚠️ [Security Warning] Thiếu cấu hình ENCRYPTION_KEY / JWT_SECRET. Session token và mã hóa yêu cầu cấu hình biến môi trường này.");
  }

  if (readiness.checks.superadminAuth.configured) {
    console.log("✅ [Security Config] Mật khẩu quản trị tối cao (SuperAdmin) đã được bảo vệ qua biến môi trường.");
  } else {
    console.warn("⚠️ [Security Warning] Biến SUPERADMIN_PASSWORD chưa được thiết lập. Endpoint đăng nhập SuperAdmin sẽ từ chối truy cập và KHÔNG dùng mật khẩu mặc định.");
  }

  const adminStatus = getAdminStatus();
  if (adminStatus.hasCredential) {
    if (adminStatus.isInitialized) {
      console.log("✅ [Firebase Admin] Firebase Admin SDK đã được khởi tạo bằng Service Account chứng chỉ hợp lệ.");
    } else {
      console.error("❌ [Firebase Admin] Cấu hình Service Account không hợp lệ hoặc không thể khởi tạo Admin SDK.");
    }
  } else {
    console.warn("ℹ️ [Firebase Admin] Service Account chưa được cung cấp qua FIREBASE_SERVICE_ACCOUNT hoặc FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY. Hệ thống đang dùng cơ chế bridge kết nối Firebase.");
  }
  console.log("--------------------------------------------------");
}

export async function createApp(): Promise<express.Application> {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health & Readiness check endpoints for Cloud Run, Kubernetes & monitoring
  app.get('/health', (_req, res) => {
    const readiness = checkServerReadiness();
    if (!readiness.ready) {
      return res.status(503).send(`UNREADY: Missing ${readiness.missingRequired.join(', ')}`);
    }
    return res.status(200).send('OK');
  });

  app.get('/_health', (_req, res) => {
    const readiness = checkServerReadiness();
    if (!readiness.ready) {
      return res.status(503).send(`UNREADY: Missing ${readiness.missingRequired.join(', ')}`);
    }
    return res.status(200).send('OK');
  });

  app.get('/api/health', (_req, res) => {
    const readiness = checkServerReadiness();
    const httpStatus = readiness.ready ? 200 : 503;
    return res.status(httpStatus).json({
      port: Number(process.env.PORT) || 3000,
      ...readiness
    });
  });

  app.get('/api/ready', (_req, res) => {
    const readiness = checkServerReadiness();
    const httpStatus = readiness.ready ? 200 : 503;
    return res.status(httpStatus).json(readiness);
  });

  // Backend API Endpoints
  app.post('/api/login', (req, res) => loginHandler(req, res));
  app.post('/api/reveal-password', (req, res) => revealPasswordHandler(req, res));
  app.post('/api/reset-password', (req, res) => resetPasswordHandler(req, res));
  app.post('/api/sepay-webhook', (req, res) => sepayWebhookHandler(req, res));
  app.post('/api/sepay/webhook', (req, res) => sepayWebhookHandler(req, res));

  // Quản lý người dùng, đổi mật khẩu và đăng ký quán bảo mật
  app.post('/api/save-user', (req, res) => saveUserHandler(req, res));
  app.post('/api/change-password', (req, res) => changePasswordHandler(req, res));
  app.post('/api/delete-user', (req, res) => deleteUserHandler(req, res));
  app.post('/api/delete-store', (req, res) => deleteStoreHandler(req, res));
  app.post('/api/register-store', (req, res) => registerStoreHandler(req, res));
  app.post('/api/migrate-store', (req, res) => migrateStoreHandler(req, res));

  const distPath = path.join(process.cwd(), 'dist');
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));
  const isDev = process.env.VITE_DEV === 'true' && process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE;

  if (isDev || !hasDist) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return app;
}

export async function createAndStartServer() {
  validateServerConfig();

  const PORT = Number(process.env.PORT) || 3000;
  const app = await createApp();
  const isDev = process.env.VITE_DEV === 'true' && process.env.NODE_ENV !== 'production' && !process.env.K_SERVICE;

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT} (mode: ${isDev ? 'development' : 'production'})`);
  });

  return server;
}
