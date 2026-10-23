import express from "express";
import cors from "cors";
import path from "path";
import { createServer as createViteServer } from "vite";
import loginHandler from "./api/login";
import revealPasswordHandler from "./api/reveal-password";
import sepayWebhookHandler from "./api/sepay-webhook";
import saveUserHandler from "./api/save-user";
import changePasswordHandler from "./api/change-password";
import deleteUserHandler from "./api/delete-user";
import registerStoreHandler from "./api/register-store";
import resetPasswordHandler from "./api/reset-password";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Backend API Endpoints (cùng chung logic với Vercel Serverless Functions)
app.post('/api/login', (req, res) => loginHandler(req, res));
app.post('/api/reveal-password', (req, res) => revealPasswordHandler(req, res));
app.post('/api/reset-password', (req, res) => resetPasswordHandler(req, res));
app.post('/api/sepay-webhook', (req, res) => sepayWebhookHandler(req, res));
// Alias tương thích ngược cho endpoint cũ
app.post('/api/sepay/webhook', (req, res) => sepayWebhookHandler(req, res));

// Quản lý người dùng, đổi mật khẩu và đăng ký quán bảo mật
app.post('/api/save-user', (req, res) => saveUserHandler(req, res));
app.post('/api/change-password', (req, res) => changePasswordHandler(req, res));
app.post('/api/delete-user', (req, res) => deleteUserHandler(req, res));
app.post('/api/register-store', (req, res) => registerStoreHandler(req, res));

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
