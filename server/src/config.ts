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
  isTest: process.env.NODE_ENV === 'test',
  // MongoDB. Set MONGODB_URI to your Atlas (or any replica-set) connection string. Without it, development/test use an embedded mongod.
  // Tests NEVER use MONGODB_URI (which may point at production): only TEST_MONGODB_URI, else an embedded throwaway mongod.
  mongo: { uri: (process.env.NODE_ENV === 'test' ? process.env.TEST_MONGODB_URI : process.env.MONGODB_URI) || '', dbName: process.env.MONGODB_DB || 'intervuex', devPort: Number(process.env.MONGO_DEV_PORT || (process.env.NODE_ENV === 'test' ? 0 : 27117)) },
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
  // Optional speech-to-text via an OpenAI-compatible /audio/transcriptions endpoint (e.g. OpenAI, Groq, self-hosted faster-whisper server).
  stt: {
    baseUrl: process.env.STT_BASE_URL || '',
    apiKey: process.env.STT_API_KEY || '',
    model: process.env.STT_MODEL || 'whisper-1',
    maxBytes: Number(process.env.STT_MAX_MB || 25) * 1048576,
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
