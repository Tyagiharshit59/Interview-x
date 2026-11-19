import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';

const isProd = process.env.NODE_ENV === 'production';
let secret = process.env.JWT_SECRET;
if (!secret) {
  if (isProd) throw new Error('JWT_SECRET must be set in production');
  secret = 'dev-only-secret-' + crypto.createHash('sha256').update(process.cwd()).digest('hex');
}

export const config = {
  isProd,
  port: Number(process.env.PORT || 4000),
  appUrl: process.env.APP_URL || 'http://localhost:5173',
  jwtSecret: secret,
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), '../storage/app.db'),
  storageDir: process.env.STORAGE_DIR || path.resolve(process.cwd(), '../storage'),
  smtp: process.env.SMTP_HOST
    ? { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : null,
  mailFrom: process.env.MAIL_FROM || 'no-reply@intervuex.local',
  // Code execution: 'judge0' (recommended) | 'dev-local' (NEVER production) | 'disabled'
  runner: {
    mode: (process.env.CODE_RUNNER || 'disabled') as 'judge0' | 'dev-local' | 'disabled',
    judge0Url: process.env.JUDGE0_URL || '',
    judge0Key: process.env.JUDGE0_API_KEY || '',
  },
  // Optional OpenAI-compatible provider. Without it, a rule-based assistant is used (clearly labelled).
  ai: {
    baseUrl: process.env.AI_BASE_URL || '',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  // ICE servers returned to browsers. Add TURN for production reliability.
  iceServers: JSON.parse(process.env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]'),
  superAdminEmail: process.env.SUPER_ADMIN_EMAIL || 'admin@intervuex.local',
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || '',
  homeState: process.env.PLATFORM_STATE || 'Karnataka', // for CGST/SGST vs IGST
};
