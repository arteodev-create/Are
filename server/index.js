import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import jwt from 'jsonwebtoken';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { WebSocketServer } from 'ws';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const { Pool } = pg;
const port = Number(process.env.PORT ?? 8787);
const publicAppUrl = String(process.env.PUBLIC_APP_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const hasDatabase = Boolean(process.env.DATABASE_URL);
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
const supabaseJwks = supabaseUrl
  ? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
  : null;
const demoUserId = '00000000-0000-4000-8000-000000000001';
const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
const jwtExpire = process.env.JWT_EXPIRE ?? '24h';
const jwtRefreshExpire = process.env.JWT_REFRESH_EXPIRE ?? '30d';
const aiKeyEncryptionSecret = process.env.AI_KEY_ENCRYPTION_SECRET || jwtRefreshSecret || jwtAccessSecret || 'veritas-local-ai-key';
const defaultAiProvider = 'openrouter';
const defaultAiModelName = process.env.DEFAULT_AI_MODEL_NAME || 'poolside/laguna-xs.2:free';
const aiMockProviderEnabled = process.env.VERITAS_AI_MOCK === 'true';
const riskyWords = ['đe dọa', 'de doa', 'doxxing', 'lừa đảo', 'lua dao', 'spam', 'bạo lực', 'bao luc'];
const allowedKinds = new Set(['private', 'group', 'channel']);
const loginAttempts = new Map();
const loginAttemptLimit = 6;
const loginAttemptWindowMs = 10 * 60 * 1000;
const pendingEmailVerifications = new Map();
const pendingPasswordResets = new Map();
const capturedVerificationEmails = new Map();
const emailVerificationTtlMs = 10 * 60 * 1000;
const emailVerificationCooldownMs = 60 * 1000;
const uploadDir = path.join(process.cwd(), 'uploads');
const hasCloudinaryUrl = Boolean(String(process.env.CLOUDINARY_URL ?? '').trim());
const hasCloudinaryCredentials = Boolean(
  String(process.env.CLOUDINARY_CLOUD_NAME ?? '').trim()
  && String(process.env.CLOUDINARY_API_KEY ?? '').trim()
  && String(process.env.CLOUDINARY_API_SECRET ?? '').trim(),
);
const cloudinaryStorageEnabled = hasCloudinaryUrl || hasCloudinaryCredentials;
const cloudinaryUploadFolder = process.env.CLOUDINARY_UPLOAD_FOLDER || 'veritas/uploads';
const seedConversations = [];
const keepDemoData = process.env.VERITAS_KEEP_DEMO_DATA === 'true';
const launchDemoHandles = ['@ban', '@veritas_friend'];
const realtimePresence = new Map();
const presenceOfflineDelayMs = 1500;

fs.mkdirSync(uploadDir, { recursive: true });

if (cloudinaryStorageEnabled) {
  if (hasCloudinaryUrl) {
    try {
      const cloudinaryUrl = new URL(String(process.env.CLOUDINARY_URL).trim());
      cloudinary.config({
        cloud_name: cloudinaryUrl.hostname,
        api_key: decodeURIComponent(cloudinaryUrl.username),
        api_secret: decodeURIComponent(cloudinaryUrl.password),
        secure: true,
      });
    } catch {
      cloudinary.config({ secure: true });
    }
  } else if (hasCloudinaryCredentials) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  } else {
    cloudinary.config({ secure: true });
  }
}

function decodeUploadName(name) {
  const rawName = String(name || 'media');
  try {
    const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
    return decoded.includes('�') ? rawName : decoded;
  } catch {
    return rawName;
  }
}

const uploadStorage = cloudinaryStorageEnabled
  ? multer.memoryStorage()
  : multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, uploadDir),
    filename: (_request, file, callback) => {
      const extension = path.extname(decodeUploadName(file.originalname)).toLowerCase().slice(0, 16);
      callback(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
    },
  });

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 4,
  },
  fileFilter: (_request, file, callback) => {
    const allowed = /^(image|video|audio)\//.test(file.mimetype) || file.mimetype === 'application/pdf';
    if (!allowed) {
      const error = new Error('Chỉ hỗ trợ ảnh, video, âm thanh hoặc PDF');
      error.status = 400;
      callback(error);
      return;
    }
    callback(null, true);
  },
});

function uploadFileToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: cloudinaryUploadFolder,
        resource_type: 'auto',
        use_filename: true,
        unique_filename: true,
        overwrite: false,
        filename_override: decodeUploadName(file.originalname),
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      },
    );
    uploadStream.end(file.buffer);
  });
}

async function toUploadedAttachment(file, request) {
  if (!cloudinaryStorageEnabled) {
    const localUrl = `/uploads/${file.filename}`;
    return {
      id: crypto.randomUUID(),
      name: decodeUploadName(file.originalname),
      url: request ? absoluteUrl(request, localUrl) : localUrl,
      mimeType: file.mimetype,
      size: file.size,
    };
  }
  const result = await uploadFileToCloudinary(file);
  return {
    id: crypto.randomUUID(),
    name: decodeUploadName(file.originalname),
    url: result.secure_url || result.url,
    mimeType: file.mimetype || result.resource_type,
    size: file.size || result.bytes || 0,
  };
}

const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
    })
  : null;

const memory = {
  users: keepDemoData ? [
    {
      id: demoUserId,
      displayName: 'Bạn',
      handle: '@ban',
      passwordHash: null,
      passwordSalt: null,
      avatarUrl: '',
      bio: '',
      privacyLevel: 'balanced',
      plan: 'free',
      lastSeen: new Date().toISOString(),
    },
  ] : [],
  conversations: [],
  sessions: [],
  reports: [],
  supportRequests: [],
  aiModels: [],
  blocks: [],
  moderationEvents: [],
  joinRequests: [],
};

memory.conversations = [];

function inferErrorCode(error) {
  if (error?.errorCode) return error.errorCode;
  if (error?.code === 'LIMIT_FILE_SIZE') return 'UPLOAD_FILE_TOO_LARGE';
  if (error?.code === 'LIMIT_FILE_COUNT') return 'UPLOAD_TOO_MANY_FILES';
  if (error?.code === 'LIMIT_UNEXPECTED_FILE') return 'UPLOAD_INVALID';

  function normalizeErrorText(value) {
    return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
  }

  const message = normalizeErrorText(error?.message);
  const rules = [
    ['email hoặc mật khẩu không đúng', 'AUTH_INVALID_CREDENTIALS'],
    ['mã xác nhận không đúng', 'AUTH_INVALID_CODE'],
    ['mã xác nhận đã hết hạn', 'AUTH_CODE_EXPIRED'],
    ['vui lòng đợi 60 giây', 'AUTH_CODE_COOLDOWN'],
    ['email hoặc tên người dùng đã tồn tại', 'AUTH_ACCOUNT_EXISTS'],
    ['email và tên người dùng là bắt buộc', 'AUTH_EMAIL_USERNAME_REQUIRED'],
    ['tên hiển thị, email, tên người dùng', 'AUTH_REGISTER_REQUIRED'],
    ['email và mật khẩu mới', 'AUTH_RESET_REQUIRED'],
    ['email không tồn tại', 'AUTH_EMAIL_NOT_FOUND'],
    ['tài khoản không tồn tại', 'AUTH_ACCOUNT_NOT_FOUND'],
    ['refresh token', 'AUTH_SESSION_EXPIRED'],
    ['missing or invalid supabase access token', 'AUTH_SESSION_EXPIRED'],
    ['chưa cấu hình smtp', 'AUTH_EMAIL_NOT_CONFIGURED'],
    ['tệp quá lớn', 'UPLOAD_FILE_TOO_LARGE'],
    ['chỉ gửi tối đa 4 tệp', 'UPLOAD_TOO_MANY_FILES'],
    ['tệp đính kèm không hợp lệ', 'UPLOAD_INVALID'],
    ['tải lên không hợp lệ', 'UPLOAD_INVALID'],
    ['chưa chọn tệp', 'UPLOAD_FILE_REQUIRED'],
    ['chỉ hỗ trợ ảnh', 'UPLOAD_UNSUPPORTED_TYPE'],
    ['conversation name is required', 'CONVERSATION_NAME_REQUIRED'],
    ['hãy tìm người dùng để tạo trò chuyện riêng', 'CONVERSATION_PRIVATE_NEEDS_USER'],
    ['đường dẫn này đã được dùng', 'CONVERSATION_HANDLE_TAKEN'],
    ['thiếu kênh hoặc cộng đồng', 'CONVERSATION_JOIN_REQUIRED'],
    ['không tìm thấy kênh/cộng đồng công khai', 'CONVERSATION_PUBLIC_NOT_FOUND'],
    ['kênh/cộng đồng này đang riêng tư', 'CONVERSATION_PRIVATE'],
    ['không tìm thấy kênh/cộng đồng', 'CONVERSATION_NOT_FOUND'],
    ['chỉ có thể sửa kênh hoặc cộng đồng', 'CONVERSATION_EDIT_UNSUPPORTED'],
    ['tên phải có ít nhất 2 ký tự', 'CONVERSATION_NAME_SHORT'],
    ['bạn chưa có quyền vào hội thoại', 'CONVERSATION_FORBIDDEN'],
    ['chủ sở hữu/quản trị viên', 'CONVERSATION_ADMIN_REQUIRED'],
    ['người nhận không hợp lệ', 'USER_INVALID_RECIPIENT'],
    ['không tìm thấy người dùng', 'USER_NOT_FOUND'],
    ['không thể tạo trò chuyện với người dùng này', 'USER_PRIVATE_BLOCKED'],
    ['người dùng không còn tồn tại', 'USER_NOT_FOUND'],
    ['message is empty', 'MESSAGE_EMPTY'],
    ['tin nhắn không được rỗng', 'MESSAGE_EMPTY'],
    ['không tìm thấy tin nhắn', 'MESSAGE_NOT_FOUND'],
    ['không tìm thấy tin để trả lời', 'MESSAGE_REPLY_NOT_FOUND'],
    ['chỉ người gửi mới được sửa tin', 'MESSAGE_EDIT_FORBIDDEN'],
    ['bạn không có quyền xóa tin này', 'MESSAGE_DELETE_FORBIDDEN'],
    ['cảm xúc không hợp lệ', 'REACTION_INVALID'],
    ['không tìm thấy tệp đa phương tiện để thả cảm xúc', 'REACTION_MEDIA_NOT_FOUND'],
    ['không tìm thấy tin nhắn để báo cáo', 'REPORT_MESSAGE_NOT_FOUND'],
    ['nhập tiêu đề và nội dung hỗ trợ', 'SUPPORT_REQUIRED'],
    ['quản trị viên mới', 'ADMIN_REQUIRED'],
    ['không thể chặn người dùng này', 'BLOCK_INVALID'],
    ['tên ai phải có ít nhất 2 ký tự', 'AI_NAME_SHORT'],
    ['lời nhắc ai quá ngắn', 'AI_PROMPT_SHORT'],
    ['mô hình openrouter không hợp lệ', 'AI_MODEL_INVALID'],
    ['khóa api openrouter không hợp lệ', 'AI_KEY_INVALID'],
    ['không tìm thấy mô hình ai', 'AI_NOT_FOUND'],
    ['kiểm tra openrouter quá lâu', 'AI_CHECK_TIMEOUT'],
  ];
  const match = rules.find(([needle]) => message.includes(normalizeErrorText(needle)));
  if (match) return match[1];
  if (error?.status === 401) return 'AUTH_SESSION_EXPIRED';
  if (error?.status === 403) return 'FORBIDDEN';
  if (error?.status === 404) return 'NOT_FOUND';
  if (error?.status === 429) return 'RATE_LIMITED';
  return 'SERVER_ERROR';
}

function httpError(message, status, errorCode) {
  const error = new Error(message);
  error.status = status;
  error.errorCode = errorCode;
  return error;
}

function isUniqueViolation(error) {
  return error?.code === '23505';
}

function canUseDirectRegister() {
  return !hasDatabase && process.env.VERITAS_ALLOW_DIRECT_REGISTER === 'true';
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 32, 'sha256').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, user) {
  if (!user.password_hash && !user.passwordHash) return true;
  const salt = user.password_salt ?? user.passwordSalt;
  const expected = user.password_hash ?? user.passwordHash;
  return hashPassword(password, salt).hash === expected;
}

function normalizeHandle(handle) {
  const clean = String(handle ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@*/, '')
    .replace(/[^a-z0-9_.-]+/g, '');
  return clean ? `@${clean}` : '';
}

function normalizeKind(kind) {
  return allowedKinds.has(kind) ? kind : 'private';
}

function normalizeEmail(email) {
  const value = String(email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) ? value : '';
}

function loginAttemptKey(input) {
  return String(input?.email || input?.handle || 'unknown').trim().toLowerCase();
}

function assertCanAttemptLogin(input) {
  const key = loginAttemptKey(input);
  const item = loginAttempts.get(key);
  if (!item) return;
  if (Date.now() - item.firstAt > loginAttemptWindowMs) {
    loginAttempts.delete(key);
    return;
  }
  if (item.count >= loginAttemptLimit) {
    const error = new Error('Đăng nhập sai quá nhiều lần, thử lại sau vài phút');
    error.status = 429;
    throw error;
  }
}

function recordLoginFailure(input) {
  const key = loginAttemptKey(input);
  const current = loginAttempts.get(key);
  if (!current || Date.now() - current.firstAt > loginAttemptWindowMs) {
    loginAttempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  current.count += 1;
}

function clearLoginFailures(input) {
  loginAttempts.delete(loginAttemptKey(input));
}

function verificationKey(email) {
  return normalizeEmail(email);
}

function generateEmailCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashEmailCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function makeMailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE ?? 'true') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function normalizeLocale(value) {
  const language = String(value || '').toLowerCase();
  if (language.startsWith('ko')) return 'ko';
  return language.startsWith('en') ? 'en' : 'vi';
}

function escapeEmailHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function spacedEmailCode(code) {
  return String(code).split('').join(' ');
}

function emailCodeCellsHtml(code) {
  return String(code).slice(0, 6).split('').map((digit) => `
                    <td align="center" style="width:48px;height:56px;border:1px solid #d9dee7;border-radius:12px;background:#f8fafc;color:#0b1220;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:28px;font-weight:800;line-height:56px;">
                      ${escapeEmailHtml(digit)}
                    </td>`).join('');
}

function isEmailCaptureEnabled() {
  return !hasDatabase && process.env.VERITAS_EMAIL_CAPTURE === 'true';
}

function captureVerificationEmail(email, code, purpose, recipientName) {
  const key = `${verificationKey(email)}:${purpose}`;
  capturedVerificationEmails.set(key, {
    email: verificationKey(email),
    code,
    purpose,
    recipientName,
    sentAt: new Date().toISOString(),
  });
}

function getCapturedVerificationEmail(input) {
  if (!isEmailCaptureEnabled()) {
    throw httpError('Email capture is disabled', 404, 'NOT_FOUND');
  }
  const email = verificationKey(input?.email);
  const purpose = String(input?.purpose ?? 'register');
  const item = capturedVerificationEmails.get(`${email}:${purpose}`);
  if (!email || !item) {
    throw httpError('Captured email code not found', 404, 'NOT_FOUND');
  }
  return item;
}

function verificationEmailCopy(purpose, locale) {
  const language = normalizeLocale(locale);
  if (language === 'en') {
    return {
      subject: purpose === 'reset' ? 'Reset your Veritas password' : 'Verify your Veritas account',
      eyebrow: purpose === 'reset' ? 'Password reset' : 'Account verification',
      title: purpose === 'reset' ? 'Reset your password' : 'Verify your Veritas account',
      intro: purpose === 'reset'
        ? 'Use this verification code to finish resetting your password.'
        : 'Use this verification code to finish creating your account.',
      expires: 'The code expires in 10 minutes and can only be used once.',
      warning: "Don't share this code.",
      warningDetail: 'Veritas will never ask for it in a call, chat, or email.',
      thanks: 'Thanks,',
      team: 'The Veritas Team',
      reason: purpose === 'reset'
        ? "You're receiving this email because a password reset code was requested for your Veritas account. If this wasn't you, please ignore this email."
        : "You're receiving this email because a verification code was requested for your Veritas account. If this wasn't you, please ignore this email.",
      text: (code, name) => `Hi ${name}, your Veritas code is ${code}. The code expires in 10 minutes and can only be used once. Do not share this code.`,
    };
  }
  if (language === 'ko') {
    return {
      subject: purpose === 'reset' ? 'Veritas \ube44\ubc00\ubc88\ud638 \uc7ac\uc124\uc815' : 'Veritas \uacc4\uc815 \uc778\uc99d',
      titlePrefix: '\uc2e0\uc6d0\uc744 \ud655\uc778\ud574 \uc8fc\uc138\uc694,',
      intro: purpose === 'reset' ? 'Veritas \ube44\ubc00\ubc88\ud638 \uc7ac\uc124\uc815 \ucf54\ub4dc\uc785\ub2c8\ub2e4:' : 'Veritas \uc778\uc99d \ucf54\ub4dc\uc785\ub2c8\ub2e4:',
      expires: '\uc774 \ucf54\ub4dc\ub294 10\ubd84 \ub3d9\uc548 \uc720\ud6a8\ud558\uba70 \ud55c \ubc88\ub9cc \uc0ac\uc6a9\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4.',
      warning: '\uc774 \ucf54\ub4dc\ub97c \ub204\uad6c\uc5d0\uac8c\ub3c4 \uacf5\uc720\ud558\uc9c0 \ub9c8\uc138\uc694:',
      warningDetail: ' Veritas\ub294 \uc804\ud654\ub098 \uc774\uba54\uc77c\ub85c \uc774 \ucf54\ub4dc\ub97c \uc694\uccad\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4.',
      thanks: '\uac10\uc0ac\ud569\ub2c8\ub2e4,',
      team: 'Veritas \ud300',
      reason: purpose === 'reset'
        ? 'Veritas \uacc4\uc815\uc758 \ube44\ubc00\ubc88\ud638 \uc7ac\uc124\uc815 \ucf54\ub4dc\uac00 \uc694\uccad\ub418\uc5b4 \uc774 \uc774\uba54\uc77c\uc744 \ubcf4\ub0c8\uc2b5\ub2c8\ub2e4. \ubcf8\uc778\uc774 \uc694\uccad\ud55c \uac83\uc774 \uc544\ub2c8\ub77c\uba74 \uc774 \uc774\uba54\uc77c\uc744 \ubb34\uc2dc\ud574 \uc8fc\uc138\uc694.'
        : 'Veritas \uacc4\uc815\uc758 \uc778\uc99d \ucf54\ub4dc\uac00 \uc694\uccad\ub418\uc5b4 \uc774 \uc774\uba54\uc77c\uc744 \ubcf4\ub0c8\uc2b5\ub2c8\ub2e4. \ubcf8\uc778\uc774 \uc694\uccad\ud55c \uac83\uc774 \uc544\ub2c8\ub77c\uba74 \uc774 \uc774\uba54\uc77c\uc744 \ubb34\uc2dc\ud574 \uc8fc\uc138\uc694.',
      text: (code, name) => `\uc2e0\uc6d0\uc744 \ud655\uc778\ud574 \uc8fc\uc138\uc694, ${name}. Veritas \ucf54\ub4dc\ub294 ${code}\uc785\ub2c8\ub2e4. \uc774 \ucf54\ub4dc\ub294 10\ubd84 \ub3d9\uc548 \uc720\ud6a8\ud558\uba70 \ud55c \ubc88\ub9cc \uc0ac\uc6a9\ud560 \uc218 \uc788\uc2b5\ub2c8\ub2e4. \uc774 \ucf54\ub4dc\ub97c \ub204\uad6c\uc5d0\uac8c\ub3c4 \uacf5\uc720\ud558\uc9c0 \ub9c8\uc138\uc694.`,
    };
  }
  return {
    subject: purpose === 'reset' ? 'Đặt lại mật khẩu Veritas' : 'Xác minh tài khoản Veritas',
    eyebrow: purpose === 'reset' ? 'Đặt lại mật khẩu' : 'Xác minh tài khoản',
    title: purpose === 'reset' ? 'Đặt lại mật khẩu' : 'Xác minh tài khoản Veritas',
    intro: purpose === 'reset'
      ? 'Dùng mã xác minh này để hoàn tất việc đặt lại mật khẩu.'
      : 'Dùng mã xác minh này để hoàn tất việc tạo tài khoản.',
    expires: 'Mã này có hiệu lực trong 10 phút và chỉ dùng được một lần.',
    warning: 'Đừng chia sẻ mã này.',
    warningDetail: 'Veritas sẽ không bao giờ hỏi mã qua điện thoại, chat hoặc email.',
    thanks: 'Cảm ơn,',
    team: 'Đội ngũ Veritas',
    reason: purpose === 'reset'
      ? 'Bạn nhận được email này vì có yêu cầu đặt lại mật khẩu cho tài khoản Veritas của bạn. Nếu không phải bạn, vui lòng bỏ qua email này.'
      : 'Bạn nhận được email này vì có yêu cầu mã xác minh cho tài khoản Veritas của bạn. Nếu không phải bạn, vui lòng bỏ qua email này.',
    text: (code, name) => `Xin chào ${name}, mã Veritas của bạn là ${code}. Mã này có hiệu lực trong 10 phút và chỉ dùng được một lần. Đừng chia sẻ mã này.`,
  };
}

function verificationEmailHtml(copy, code, recipientName) {
  const safeName = escapeEmailHtml(recipientName || 'Veritas');
  const safeCode = escapeEmailHtml(code);
  const safeSpacedCode = escapeEmailHtml(spacedEmailCode(code));
  const codeCells = emailCodeCellsHtml(code);
  const title = escapeEmailHtml(copy.title || copy.subject);
  const eyebrow = escapeEmailHtml(copy.eyebrow || 'Security code');
  const greeting = copy.titlePrefix
    ? `<p style="margin:12px 0 0;color:#667085;font-size:14px;line-height:1.55;">${escapeEmailHtml(copy.titlePrefix)} <strong style="color:#101828;font-weight:800;">${safeName}</strong></p>`
    : '';
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeEmailHtml(copy.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f5f8;color:#101828;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;">
      ${escapeEmailHtml(copy.intro)} Code: ${safeCode}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:#f3f5f8;">
      <tr>
        <td align="center" style="padding:34px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;border-collapse:collapse;">
            <tr>
              <td style="padding:0 4px 18px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="width:44px;">
                      <div style="width:40px;height:40px;border-radius:12px;background:#050505;color:#ffffff;font-size:22px;font-weight:800;line-height:40px;text-align:center;">V</div>
                    </td>
                    <td style="padding-left:12px;">
                      <div style="color:#050505;font-size:18px;font-weight:800;line-height:1.2;">Veritas</div>
                      <div style="color:#667085;font-size:12px;font-weight:700;line-height:1.4;text-transform:uppercase;">${eyebrow}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="border:1px solid #e4e7ec;border-radius:18px;background:#ffffff;box-shadow:0 18px 48px rgba(16,24,40,0.08);overflow:hidden;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="padding:32px 28px 12px;text-align:center;">
                      <h1 style="margin:0;color:#050505;font-size:28px;font-weight:800;line-height:1.18;letter-spacing:0;">${title}</h1>
                      ${greeting}
                      <p style="margin:12px 0 0;color:#475467;font-size:15px;line-height:1.55;">${escapeEmailHtml(copy.intro)}</p>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:18px 20px 22px;">
                      <table role="presentation" cellspacing="8" cellpadding="0" style="border-collapse:separate;margin:0 auto;" aria-label="${safeSpacedCode}">
                        <tr>${codeCells}</tr>
                      </table>
                      <div style="margin-top:8px;color:#98a2b3;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:12px;letter-spacing:2px;">${safeSpacedCode}</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 28px 28px;">
                      <div style="border-radius:14px;background:#f8fafc;border:1px solid #edf0f4;padding:14px 16px;">
                        <p style="margin:0;color:#344054;font-size:14px;line-height:1.5;">${escapeEmailHtml(copy.expires)}</p>
                        <p style="margin:8px 0 0;color:#344054;font-size:14px;line-height:1.5;"><strong style="color:#101828;font-weight:800;">${escapeEmailHtml(copy.warning)}</strong> ${escapeEmailHtml(copy.warningDetail)}</p>
                      </div>
                      <p style="margin:22px 0 0;color:#475467;font-size:14px;line-height:1.6;">${escapeEmailHtml(copy.thanks)}<br><strong style="color:#101828;font-weight:800;">${escapeEmailHtml(copy.team)}</strong></p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 4px 12px;color:#667085;font-size:12px;line-height:1.55;text-align:center;">
                ${escapeEmailHtml(copy.reason)}
              </td>
            </tr>
            <tr>
              <td style="padding:10px 0 0;color:#98a2b3;font-size:11px;line-height:1.5;text-align:center;">
                Veritas &middot; Secure account verification
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendVerificationEmail(email, code, purpose = 'register', locale = 'vi', recipientName = '') {
  if (isEmailCaptureEnabled()) {
    captureVerificationEmail(email, code, purpose, recipientName || email);
    return;
  }
  const mailer = makeMailer();
  if (!mailer) {
    const error = new Error('Chưa cấu hình SMTP để gửi mã xác nhận email');
    error.status = 503;
    throw error;
  }
  const copy = verificationEmailCopy(purpose, locale);
  const name = recipientName || email;
  await mailer.sendMail({
    from: process.env.EMAIL_FROM || 'Veritas <noreply@example.com>',
    to: email,
    subject: copy.subject,
    text: copy.text(code, name),
    html: verificationEmailHtml(copy, code, name),
  });
}

function makeHandle(name, kind) {
  const prefix = kind === 'channel' ? '@' : kind === 'group' ? 'cong-dong-' : '@';
  const slug = String(name)
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${prefix}${slug || crypto.randomUUID().slice(0, 8)}`;
}

function normalizeConversationHandle(input, name, kind) {
  const fallback = makeHandle(name, kind);
  const raw = String(input ?? '').trim() || fallback;
  const prefix = kind === 'channel' ? '@' : '';
  const slug = raw
    .replace(/^@+/, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}${slug || fallback.replace(/^@+/, '')}`;
}

function normalizeConversationDescription(value) {
  return String(value ?? '').trim().slice(0, 180);
}

function normalizePostingPolicy(value, kind) {
  if (kind === 'channel') return 'admins';
  if (kind === 'group') return 'members';
  return value === 'admins' ? 'admins' : 'members';
}

function normalizeConversationPrivacy(value) {
  return value === 'private' ? 'private' : 'public';
}

function normalizeJoinPolicy(value) {
  return value === 'approval' || value === 'approval_required' ? 'approval' : 'open';
}

function normalizeAiProvider(value) {
  const provider = String(value ?? defaultAiProvider).trim().toLowerCase();
  return provider || defaultAiProvider;
}

function normalizeAiModelName(value) {
  return String(value ?? defaultAiModelName).trim().slice(0, 120) || defaultAiModelName;
}

function normalizeAiPrompt(value) {
  return String(value ?? '').trim().slice(0, 8000);
}

function normalizeAiPrivacy(value) {
  return value === 'public' ? 'public' : 'private';
}

function encryptionKey() {
  return crypto.createHash('sha256').update(String(aiKeyEncryptionSecret)).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptSecret(value) {
  const [ivPart, tagPart, encryptedPart] = String(value || '').split('.');
  if (!ivPart || !tagPart || !encryptedPart) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function secretHint(value) {
  const clean = String(value ?? '').trim();
  if (!clean) return '';
  return clean.length <= 8 ? 'saved' : `${clean.slice(0, 3)}...${clean.slice(-4)}`;
}

function openRouterErrorMessage(status, message = '') {
  const detail = String(message || '').trim();
  if (status === 401 || status === 403) return 'Khóa API OpenRouter không hợp lệ hoặc đã hết hạn. Hãy nhập khóa mới.';
  if (status === 402) return 'Khóa OpenRouter không đủ credit/quota để gọi mô hình này.';
  if (status === 404) return 'Mô hình OpenRouter không tồn tại hoặc khóa không có quyền dùng mô hình này.';
  if (status === 408 || status === 504) return 'OpenRouter phản hồi quá lâu. Hãy thử lại sau.';
  if (status === 429) return 'OpenRouter đang giới hạn tốc độ/quota. Hãy đợi một lát hoặc đổi khóa.';
  if (detail) return `OpenRouter báo lỗi: ${detail}`;
  return 'Không kiểm tra được khóa API/mô hình OpenRouter.';
}

function validateAiInput({ name, systemPrompt, apiKey, modelName, requireApiKey = true }) {
  if (!name || name.length < 2) {
    const error = new Error('Tên AI phải có ít nhất 2 ký tự.');
    error.status = 400;
    throw error;
  }
  if (name.length > 80) {
    const error = new Error('Tên AI tối đa 80 ký tự.');
    error.status = 400;
    throw error;
  }
  if (!systemPrompt || systemPrompt.length < 6) {
    const error = new Error('Lời nhắc AI quá ngắn. Hãy mô tả cách AI nên trả lời.');
    error.status = 400;
    throw error;
  }
  if (systemPrompt.length > 8000) {
    const error = new Error('Lời nhắc AI tối đa 8000 ký tự.');
    error.status = 400;
    throw error;
  }
  if (!modelName || !/^[a-z0-9._:/-]+$/i.test(modelName) || !modelName.includes('/')) {
    const error = new Error('Mô hình OpenRouter không hợp lệ. Ví dụ: poolside/laguna-xs.2:free');
    error.status = 400;
    throw error;
  }
  if (requireApiKey && (!apiKey || apiKey.length < 16)) {
    const error = new Error('Khóa API OpenRouter không hợp lệ. Khóa quá ngắn hoặc đang trống.');
    error.status = 400;
    throw error;
  }
}

function makeAiHandle(name) {
  const slug = String(name || 'ai-model')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return `@ai-${slug || crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}`;
}

function toAiModel(row) {
  return {
    id: row.id,
    ownerId: row.owner_id ?? row.ownerId,
    userId: row.user_id ?? row.userId,
    conversationId: row.conversation_id ?? row.conversationId,
    name: row.name,
    avatarUrl: row.avatar_url ?? row.avatarUrl ?? '',
    provider: row.provider ?? defaultAiProvider,
    modelName: row.model_name ?? row.modelName ?? defaultAiModelName,
    privacy: row.privacy ?? 'private',
    systemPrompt: row.system_prompt ?? row.systemPrompt ?? '',
    apiKeyHint: row.api_key_hint ?? row.apiKeyHint ?? '',
    enabled: row.enabled !== false,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

function tokenFromRequest(request) {
  const header = request.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? token : '';
}

function tokenFromUrl(request) {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    return url.searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

function classifyMessage(text) {
  const lower = text.toLowerCase();
  if (!text.trim()) return 'empty';
  if (riskyWords.some((word) => lower.includes(word))) return 'limited';
  if (lower.includes('nhạy cảm') || lower.includes('nhay cam') || lower.includes('cảnh báo')) return 'sensitive';
  return 'safe';
}

function normalizeAttachments(input) {
  const items = Array.isArray(input) ? input : [];
  return items
    .map((item) => ({
      id: crypto.randomUUID(),
      name: String(item?.name ?? '').trim().slice(0, 120),
      url: String(item?.url ?? '').trim().slice(0, 500),
      mimeType: String(item?.mimeType ?? item?.type ?? 'application/octet-stream').trim().slice(0, 120),
      size: Number.isFinite(Number(item?.size)) ? Number(item.size) : 0,
    }))
    .filter((item) => item.name && item.url)
    .slice(0, 4);
}

function toUser(row) {
  return {
    id: row.id,
    displayName: row.display_name ?? row.displayName,
    handle: row.handle,
    avatarUrl: row.avatar_url ?? row.avatarUrl ?? '',
    email: row.email ?? '',
    bio: row.bio ?? '',
    privacyLevel: row.privacy_level ?? row.privacyLevel ?? 'balanced',
    plan: row.plan ?? 'free',
    isExtra: (row.plan ?? row.planLevel ?? '') === 'extra' || row.isExtra === true,
    isAdmin: row.isAdmin === true || isSupportAdmin(row),
    lastSeen: row.last_seen ?? row.lastSeen ?? null,
    online: Boolean(row.is_online ?? row.isOnline ?? realtimePresence.get(row.id)?.sockets?.size),
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
  };
}

function publicUser(user) {
  const { email, latitude, longitude, ...safeUser } = toUser(user);
  return safeUser;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function absoluteUrl(request, url = '') {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const origin = `${request.protocol}://${request.get('host')}`;
  return url.startsWith('/') ? `${origin}${url}` : `${origin}/${url}`;
}

function renderVeritasSharePage({
  title,
  description,
  pageUrl,
  openUrl,
  avatarUrl = '',
  name,
  handle,
  label,
  cta,
  secondaryCta,
  verified = false,
  ogType = 'website',
}) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safePageUrl = escapeHtml(pageUrl);
  const safeAvatarUrl = escapeHtml(avatarUrl);
  const safeName = escapeHtml(name);
  const safeHandle = escapeHtml(handle);
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=112x112&margin=0&data=${encodeURIComponent(pageUrl)}`;
  const initial = escapeHtml(String(name || 'V').slice(0, 1).toUpperCase());
  const avatar = avatarUrl
    ? `<img src="${safeAvatarUrl}" alt="${safeName}">`
    : `<span>${initial}</span>`;
  const badge = verified ? '<span class="verified" aria-label="Verified account">✓</span>' : '';

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}">
  <meta property="og:type" content="${escapeHtml(ogType)}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:url" content="${safePageUrl}">
  ${avatarUrl ? `<meta property="og:image" content="${safeAvatarUrl}">` : ''}
  <meta name="twitter:card" content="${avatarUrl ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDescription}">
  ${avatarUrl ? `<meta name="twitter:image" content="${safeAvatarUrl}">` : ''}
  <style>
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:#f6f6f6;color:#111;font-family:Inter,Arial,sans-serif}
    .topbar{display:none}
    .brand{display:flex;align-items:center;gap:9px;margin:0 0 14px 6px;font-size:18px;font-weight:740;color:#111}.logo{display:grid;width:32px;height:32px;place-items:center;color:#111}.logo svg{width:32px;height:32px;display:block}
    .download{display:grid;min-height:34px;place-items:center;padding:0 18px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-size:13px;font-weight:760}
    .shell{min-height:100vh;display:grid;place-items:center;padding:32px 18px;background:#f6f6f6}
    .share-wrap{width:min(430px,100%)}
    main{display:grid;justify-items:center;gap:10px;padding:34px 28px 28px;border:1px solid #dfdfdf;border-radius:30px;background:#fff;text-align:center}
    .avatar{display:grid;width:108px;height:108px;place-items:center;overflow:hidden;border-radius:999px;background:#111;color:#fff;font-size:44px;font-weight:780}
    .avatar img{width:100%;height:100%;object-fit:cover}.name{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:8px;font-size:25px;font-weight:720;line-height:1.2}
    .verified{display:grid;width:20px;height:20px;place-items:center;border-radius:999px;background:#111;color:#fff;font-size:13px}.handle{color:#737373;font-size:15px}.label{padding:4px 10px;border:1px solid #e5e5e5;border-radius:999px;color:#525252;font-size:13px;font-weight:560;letter-spacing:0}
    p{max-width:340px;margin:10px 0 12px;color:#262626;line-height:1.5;white-space:pre-line}
    .actions{display:grid;width:100%;gap:8px}
    a{display:grid;min-height:42px;place-items:center;padding:0 18px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-weight:760}.ghost{background:#f2f2f2;color:#111}
    .download-qr{position:fixed;right:22px;bottom:22px;display:grid;width:148px;gap:9px;padding:12px;border:1px solid #dfdfdf;border-radius:22px;background:#fff;color:#111;text-align:center;text-decoration:none}
    .download-qr img{width:112px;height:112px;justify-self:center;image-rendering:pixelated}
    .download-qr strong{font-size:13px;font-weight:760;line-height:1.2}.download-qr span{color:#737373;font-size:12px;line-height:1.25}
    @media (max-width:760px){.download-qr{position:static;width:100%;margin-top:14px}.download-qr img{width:104px;height:104px}}
    @media (max-width:560px){.brand{font-size:18px}.download{padding:0 14px}.shell{padding:28px 18px}.share-wrap{width:min(390px,100%)}main{padding:30px 20px 24px;border-radius:26px}.avatar{width:96px;height:96px}.name{font-size:23px;justify-content:center}}
  </style>
</head>
<body>
  <div class="shell">
    <div class="share-wrap">
      <div class="brand">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 64 64"><path fill="currentColor" fill-rule="evenodd" d="M32 6C17.64 6 6 16.75 6 30c0 5.08 1.72 9.79 4.65 13.67L6.53 58.5l15.45-5.86A27.75 27.75 0 0 0 32 54c14.36 0 26-10.75 26-24S46.36 6 32 6Zm0 7C21.56 13 13 20.6 13 30c0 4.03 1.56 7.78 4.18 10.75l1.57 1.78-1.84 6.62 6.95-2.64 2.07.74c1.91.68 3.95 1.03 6.07 1.03 10.44 0 19-7.6 19-18.28S42.44 13 32 13Z"/></svg>
        </span>
        <span>Veritas</span>
      </div>
      <main>
        <div class="avatar">${avatar}</div>
        <div class="name">${safeName}${badge}</div>
        <div class="handle">${safeHandle}</div>
        <div class="label">${escapeHtml(label)}</div>
        <p>${safeDescription}</p>
        <div class="actions">
          <a href="${escapeHtml(openUrl)}">${escapeHtml(cta)}</a>
          <a class="ghost" href="${safePageUrl}">${escapeHtml(secondaryCta)}</a>
        </div>
      </main>
      <a class="download-qr" href="${safePageUrl}" aria-label="Mo lien ket Veritas bang QR">
        <img src="${escapeHtml(qrImageUrl)}" alt="QR Veritas profile link">
        <strong>Share this link</strong>
        <span>Scan to open this Veritas page</span>
      </a>
    </div>
  </div>
</body>
</html>`;
}

function distanceKm(first, second) {
  const lat1 = Number(first?.latitude);
  const lon1 = Number(first?.longitude);
  const lat2 = Number(second?.latitude);
  const lon2 = Number(second?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const radians = (value) => (value * Math.PI) / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isNearEnough(searcher, target) {
  return distanceKm(searcher, target) <= 50;
}

function authToProfile(authUser) {
  const metadata = authUser.user_metadata ?? {};
  const emailName = String(authUser.email ?? '').split('@')[0] || authUser.id.slice(0, 8);
  const displayName = metadata.displayName || metadata.name || emailName || 'Veritas User';
  const handle = normalizeHandle(metadata.handle || emailName || `user${authUser.id.slice(0, 8)}`);
  return {
    id: authUser.id,
    displayName,
    handle,
    email: normalizeEmail(authUser.email),
  };
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deviceLabelFromRequest(request) {
  return String(request.headers['user-agent'] ?? 'Unknown device').slice(0, 180);
}

function issueTokens(user) {
  if (!jwtAccessSecret || !jwtRefreshSecret) {
    const error = new Error('Chưa cấu hình JWT secret');
    error.status = 500;
    throw error;
  }
  const refreshId = crypto.randomUUID();
  const payload = { sub: user.id, handle: user.handle, displayName: user.displayName };
  const refreshToken = jwt.sign(payload, jwtRefreshSecret, {
    expiresIn: jwtRefreshExpire,
    issuer: 'veritas-api',
    jwtid: refreshId,
  });
  const decodedRefresh = jwt.decode(refreshToken);
  return {
    accessToken: jwt.sign(payload, jwtAccessSecret, { expiresIn: jwtExpire, issuer: 'veritas-api' }),
    refreshToken,
    refreshId,
    refreshExpiresAt: new Date(decodedRefresh.exp * 1000).toISOString(),
  };
}

function verifyLocalAccessToken(token) {
  if (!token || !jwtAccessSecret) return null;
  try {
    const payload = jwt.verify(token, jwtAccessSecret, { issuer: 'veritas-api' });
    return { id: payload.sub, displayName: payload.displayName, handle: payload.handle };
  } catch {
    return null;
  }
}

function toMessage(row, userId) {
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  const attachmentReactions = row.attachment_reactions ?? {};
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sender: row.sender_id === userId ? 'me' : 'them',
    senderId: row.sender_id,
    senderAvatarUrl: row.sender_avatar_url ?? row.avatar_url ?? '',
    senderName: row.sender_name ?? row.display_name ?? 'Người dùng',
    text: row.body,
    verdict: row.verdict,
    read: false,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
    replyTo: row.reply_to_message_id
      ? {
          id: row.reply_to_message_id,
          text: row.reply_body ?? '',
          senderName: row.reply_sender_name ?? 'Người dùng',
        }
      : null,
    reactions: row.reactions ?? {},
    myReaction: row.my_reaction ?? '',
    attachments: attachments.map((attachment) => {
      const key = String(attachment.id || attachment.url || '');
      const state = attachmentReactions[key] ?? {};
      return {
        ...attachment,
        reactions: state.reactions ?? attachment.reactions ?? {},
        myReaction: state.myReaction ?? attachment.myReaction ?? '',
      };
    }),
  };
}

function normalizeMemoryMessage(message, userId) {
  if (!message) return message;
  return {
    ...message,
    sender: message.senderId === userId ? 'me' : 'them',
  };
}

function toConversation(row) {
  return {
    id: row.id,
    peerId: row.peer_id ?? row.peerId ?? '',
    name: row.name,
    handle: row.handle,
    avatarUrl: row.avatar_url ?? row.avatarUrl ?? '',
    status: row.status,
    lastSeen: row.last_seen ?? row.lastSeen ?? null,
    online: Boolean(row.is_online ?? row.isOnline ?? realtimePresence.get(row.peer_id ?? row.peerId)?.sockets?.size),
    kind: row.kind,
    isAi: Boolean(row.is_ai ?? row.isAi),
    aiModelId: row.ai_model_id ?? row.aiModelId ?? '',
    aiPrivacy: row.ai_privacy ?? row.aiPrivacy ?? '',
    unread: Number(row.unread ?? 0),
    myRole: row.my_role ?? row.role ?? 'member',
    memberCount: Number(row.member_count ?? 0),
    lastMessage: row.last_message ?? '',
    lastMessageAt: row.last_message_at,
    description: row.description ?? '',
    postingPolicy: normalizePostingPolicy(row.posting_policy ?? row.postingPolicy, row.kind),
    privacyLevel: row.privacy_level ?? row.privacyLevel ?? 'public',
    joinPolicy: row.join_policy ?? row.joinPolicy ?? 'open',
    joinStatus: row.join_status ?? row.joinStatus ?? '',
  };
}

async function ensureStarterConversation(userId) {
  return;
}

async function cleanupLaunchDemoData() {
  if (!pool || keepDemoData) return;
  const { rows: userRows } = await pool.query(
    `select id from veritas_users where id = $1 or handle = any($2::text[])`,
    [demoUserId, launchDemoHandles],
  );
  const demoUserIds = userRows.map((row) => row.id);
  const { rows: conversationRows } = await pool.query(
    `select distinct c.id
     from veritas_conversations c
     left join veritas_participants p on p.conversation_id = c.id
     where c.handle = any($1::text[])
        or c.id = any($2::uuid[])
        or p.user_id = any($3::uuid[])`,
    [launchDemoHandles, seedConversations.map((conversation) => conversation.id), demoUserIds],
  );
  const conversationIds = conversationRows.map((row) => row.id);
  if (conversationIds.length) {
    await pool.query(`delete from veritas_conversations where id = any($1::uuid[])`, [conversationIds]);
  }
  if (demoUserIds.length) {
    await pool.query(`delete from veritas_users where id = any($1::uuid[])`, [demoUserIds]);
  }
}

async function initializeDatabase() {
  if (!pool) return;

  await pool.query(`
    create table if not exists veritas_users (
      id uuid primary key,
      display_name text not null,
      handle text unique,
      created_at timestamptz not null default now()
    );

    alter table veritas_users add column if not exists password_hash text;
    alter table veritas_users add column if not exists password_salt text;
    alter table veritas_users add column if not exists email text unique;
    alter table veritas_users add column if not exists avatar_url text not null default '';
    alter table veritas_users add column if not exists bio text not null default '';
    alter table veritas_users add column if not exists privacy_level text not null default 'balanced';
    alter table veritas_users add column if not exists plan text not null default 'free';
    alter table veritas_users add column if not exists latitude double precision;
    alter table veritas_users add column if not exists longitude double precision;
    alter table veritas_users add column if not exists last_seen timestamptz;

    create unique index if not exists veritas_users_email_unique_idx
      on veritas_users (lower(email))
      where email is not null and email <> '';

    create table if not exists veritas_conversations (
      id uuid primary key,
      name text not null,
      handle text not null,
      status text not null default 'offline',
      kind text not null check (kind in ('private', 'group', 'channel')),
      created_at timestamptz not null default now()
    );

    alter table veritas_conversations add column if not exists description text not null default '';
    alter table veritas_conversations add column if not exists posting_policy text not null default 'members';
    alter table veritas_conversations add column if not exists privacy_level text not null default 'public';
    alter table veritas_conversations add column if not exists join_policy text not null default 'open';
    alter table veritas_conversations add column if not exists is_ai boolean not null default false;
    alter table veritas_conversations add column if not exists ai_model_id uuid;
    create unique index if not exists veritas_conversations_public_handle_idx
      on veritas_conversations (lower(handle))
      where kind <> 'private';

    create table if not exists veritas_participants (
      conversation_id uuid not null references veritas_conversations(id) on delete cascade,
      user_id uuid not null references veritas_users(id) on delete cascade,
      role text not null default 'member' check (role in ('owner', 'admin', 'member')),
      created_at timestamptz not null default now(),
      primary key (conversation_id, user_id)
    );

    create table if not exists veritas_messages (
      id uuid primary key,
      conversation_id uuid not null references veritas_conversations(id) on delete cascade,
      sender_id uuid not null references veritas_users(id) on delete cascade,
      body text not null,
      verdict text not null default 'safe' check (verdict in ('safe', 'sensitive', 'limited')),
      read_state text not null default 'sent' check (read_state in ('sent', 'delivered', 'read')),
      created_at timestamptz not null default now()
    );

    alter table veritas_messages add column if not exists reply_to_message_id uuid references veritas_messages(id) on delete set null;
    alter table veritas_messages add column if not exists edited_at timestamptz;
    alter table veritas_messages add column if not exists deleted_at timestamptz;
    alter table veritas_messages add column if not exists attachments jsonb not null default '[]'::jsonb;

    create index if not exists veritas_messages_conversation_created_idx
      on veritas_messages (conversation_id, created_at);
    create index if not exists veritas_messages_conversation_created_visible_idx
      on veritas_messages (conversation_id, created_at desc)
      where deleted_at is null;

    create table if not exists veritas_sessions (
      id uuid primary key,
      user_id uuid not null references veritas_users(id) on delete cascade,
      refresh_token_hash text not null unique,
      user_agent text not null default 'Unknown device',
      created_at timestamptz not null default now(),
      last_used_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz
    );

    create index if not exists veritas_sessions_user_active_idx
      on veritas_sessions (user_id, revoked_at, expires_at);

    create table if not exists veritas_blocks (
      blocker_id uuid not null references veritas_users(id) on delete cascade,
      blocked_id uuid not null references veritas_users(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (blocker_id, blocked_id)
    );

    create table if not exists veritas_reports (
      id uuid primary key,
      reporter_id uuid not null references veritas_users(id) on delete cascade,
      target_user_id uuid references veritas_users(id) on delete set null,
      message_id uuid references veritas_messages(id) on delete set null,
      conversation_id uuid references veritas_conversations(id) on delete set null,
      reason text not null default 'other',
      status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
      created_at timestamptz not null default now()
    );

    create index if not exists veritas_reports_conversation_idx
      on veritas_reports (conversation_id, status, created_at);

    create table if not exists veritas_support_requests (
      id uuid primary key,
      user_id uuid not null references veritas_users(id) on delete cascade,
      category text not null default 'other',
      subject text not null,
      body text not null,
      contact text not null default '',
      status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists veritas_support_requests_status_idx
      on veritas_support_requests (status, created_at desc);

    create table if not exists veritas_join_requests (
      id uuid primary key,
      conversation_id uuid not null references veritas_conversations(id) on delete cascade,
      user_id uuid not null references veritas_users(id) on delete cascade,
      status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
      created_at timestamptz not null default now(),
      resolved_at timestamptz,
      resolved_by uuid references veritas_users(id) on delete set null
    );

    create unique index if not exists veritas_join_requests_pending_idx
      on veritas_join_requests (conversation_id, user_id)
      where status = 'pending';
    create index if not exists veritas_join_requests_conversation_idx
      on veritas_join_requests (conversation_id, status, created_at desc);

    create table if not exists veritas_moderation_events (
      id uuid primary key,
      actor_id uuid not null references veritas_users(id) on delete cascade,
      conversation_id uuid references veritas_conversations(id) on delete set null,
      message_id uuid references veritas_messages(id) on delete set null,
      action text not null,
      note text not null default '',
      created_at timestamptz not null default now()
    );

    create index if not exists veritas_moderation_events_conversation_idx
      on veritas_moderation_events (conversation_id, created_at);

    create table if not exists veritas_message_reads (
      message_id uuid not null references veritas_messages(id) on delete cascade,
      user_id uuid not null references veritas_users(id) on delete cascade,
      read_at timestamptz not null default now(),
      primary key (message_id, user_id)
    );

    create index if not exists veritas_message_reads_user_idx
      on veritas_message_reads (user_id, read_at);
    create index if not exists veritas_message_reads_message_user_idx
      on veritas_message_reads (message_id, user_id);

    create table if not exists veritas_message_reactions (
      message_id uuid not null references veritas_messages(id) on delete cascade,
      user_id uuid not null references veritas_users(id) on delete cascade,
      attachment_id text not null default '',
      emoji text not null,
      created_at timestamptz not null default now(),
      primary key (message_id, user_id, attachment_id)
    );

    create index if not exists veritas_message_reactions_message_idx
      on veritas_message_reactions (message_id, attachment_id);

    create table if not exists veritas_ai_models (
      id uuid primary key,
      owner_id uuid not null references veritas_users(id) on delete cascade,
      user_id uuid not null references veritas_users(id) on delete cascade,
      conversation_id uuid references veritas_conversations(id) on delete set null,
      name text not null,
      avatar_url text not null default '',
      provider text not null default 'openrouter',
      model_name text not null default 'poolside/laguna-xs.2:free',
      privacy text not null default 'private' check (privacy in ('private', 'public')),
      system_prompt text not null,
      api_key_ciphertext text not null,
      api_key_hint text not null default '',
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists veritas_ai_models_owner_idx
      on veritas_ai_models (owner_id, created_at desc);

    alter table veritas_ai_models add column if not exists privacy text not null default 'private';

    do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'veritas_conversations_ai_model_fk'
      ) then
        alter table veritas_conversations
          add constraint veritas_conversations_ai_model_fk
          foreign key (ai_model_id) references veritas_ai_models(id) on delete set null;
      end if;
    end $$;
  `);

  await pool.query(`
    alter table veritas_users drop column if exists phone;
    alter table veritas_users drop column if exists phone_verified_at;
    alter table veritas_users drop column if exists firebase_uid;
  `);

  await pool.query(
    `insert into veritas_users (id, display_name, handle)
     values ($1, 'Bạn', '@ban')
     on conflict (id) do nothing`,
    [demoUserId],
  );

  await cleanupLaunchDemoData();

  for (const conversation of keepDemoData ? seedConversations : []) {
    const peerId = conversation.id.replace('4', '5');
    await pool.query(
      `insert into veritas_users (id, display_name, handle)
       values ($1, $2, $3)
       on conflict (id) do nothing`,
      [peerId, conversation.name, conversation.handle.startsWith('@') ? conversation.handle : null],
    );
    await pool.query(
      `insert into veritas_conversations (id, name, handle, status, kind)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [conversation.id, conversation.name, conversation.handle, conversation.status, conversation.kind],
    );
    await pool.query(
      `insert into veritas_participants (conversation_id, user_id, role)
       values ($1, $2, $4), ($1, $3, 'member')
       on conflict do nothing`,
      [conversation.id, demoUserId, peerId, conversation.kind === 'private' ? 'member' : 'owner'],
    );

    const { rows } = await pool.query(
      `select count(*)::int as count from veritas_messages where conversation_id = $1`,
      [conversation.id],
    );

    if (rows[0].count === 0) {
      for (const [index, [sender, text]] of conversation.messages.entries()) {
        await pool.query(
          `insert into veritas_messages
            (id, conversation_id, sender_id, body, verdict, read_state, created_at)
           values ($1, $2, $3, $4, 'safe', 'read', now() - ($5::int * interval '1 minute'))`,
          [crypto.randomUUID(), conversation.id, sender === 'me' ? demoUserId : peerId, text, 10 - index],
        );
      }
    }
  }
}

async function syncAuthUser(profile) {
  if (!pool) {
    const existing = memory.users.find((user) => user.id === profile.id);
    if (existing) {
      Object.assign(existing, profile);
      return toUser(existing);
    }
    memory.users.push(profile);
    return profile;
  }

  const { rows: handleRows } = await pool.query(
    `select id from veritas_users where handle = $1 and id <> $2 limit 1`,
    [profile.handle, profile.id],
  );
  const handle = handleRows.length ? `${profile.handle}-${profile.id.slice(0, 6)}` : profile.handle;
  const { rows } = await pool.query(
    `insert into veritas_users (id, display_name, handle, email)
     values ($1, $2, $3, $4)
     on conflict (id) do update set
       display_name = excluded.display_name,
       handle = excluded.handle,
       email = coalesce(veritas_users.email, excluded.email)
     returning id, display_name, handle, email, avatar_url, bio, privacy_level, plan, last_seen`,
    [profile.id, profile.displayName, handle, profile.email || null],
  );
  return toUser(rows[0]);
}

async function verifySupabaseToken(token) {
  if (!token || !supabaseUrl) return null;

  if (supabaseJwks) {
    try {
      const { payload } = await jwtVerify(token, supabaseJwks, {
        issuer: `${supabaseUrl}/auth/v1`,
      });
      return {
        id: payload.sub,
        email: payload.email,
        user_metadata: payload.user_metadata ?? payload.raw_user_meta_data ?? {},
      };
    } catch {
      // Older Supabase projects may use symmetric JWT signing; validate via Auth API below.
    }
  }

  if (!supabasePublishableKey) return null;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabasePublishableKey,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) return null;
  return response.json();
}

async function verifyRealtimeUser(token) {
  const localUser = verifyLocalAccessToken(token);
  if (localUser?.id) {
    const user = await getUser(localUser.id);
    return user ?? localUser;
  }

  const authUser = await verifySupabaseToken(token);
  if (authUser?.id) return syncAuthUser(authToProfile(authUser));

  return null;
}

const PUBLIC_API_PATHS = new Set([
  '/api/health',
  '/api/auth/register',
  '/api/auth/register/request-code',
  '/api/auth/register/verify',
  '/api/auth/email-status',
  '/api/auth/password/request-code',
  '/api/auth/password/verify',
  '/api/auth/login',
  '/api/auth/refresh',
]);

async function authMiddleware(request, response, next) {
  try {
    const publicPath = PUBLIC_API_PATHS.has(request.originalUrl.split('?')[0]) || request.method === 'OPTIONS';
    if (publicPath) return next();

    const localUser = verifyLocalAccessToken(tokenFromRequest(request));
    if (localUser?.id) {
      const user = await getUser(localUser.id);
      if (user) {
        request.user = user;
        return next();
      }
    }

    const authUser = await verifySupabaseToken(tokenFromRequest(request));
    if (!authUser?.id) {
      response.status(401).json({ error: 'Missing or invalid Supabase access token', errorCode: 'AUTH_SESSION_EXPIRED' });
      return;
    }

    request.user = await syncAuthUser(authToProfile(authUser));
    next();
  } catch (error) {
    next(error);
  }
}

async function registerUser(input) {
  const displayName = String(input?.displayName ?? '').trim();
  const handle = normalizeHandle(input?.handle);
  const email = normalizeEmail(input?.email);
  const password = String(input?.password ?? '');
  if (!displayName || !handle || !email || password.length < 6) {
    throw httpError(
      'Display name, email, username, and a password of at least 6 characters are required',
      400,
      'AUTH_REGISTER_REQUIRED',
    );
  }

  const { hash, salt } = hashPassword(password);
  return registerUserWithPasswordHash({ displayName, handle, email, passwordHash: hash, passwordSalt: salt });
}

async function registerUserWithPasswordHash(input) {
  const displayName = String(input?.displayName ?? '').trim();
  const handle = normalizeHandle(input?.handle);
  const email = normalizeEmail(input?.email);
  const hash = String(input?.passwordHash ?? '');
  const salt = String(input?.passwordSalt ?? '');
  if (!displayName || !handle || !email || !hash || !salt) {
    throw httpError(
      'Display name, email, username, and a password of at least 6 characters are required',
      400,
      'AUTH_REGISTER_REQUIRED',
    );
  }

  if (!pool) {
    const exists = memory.users.find((user) => user.handle === handle || user.email === email);
    if (exists) {
      throw httpError('Email or username already exists', 409, 'AUTH_ACCOUNT_EXISTS');
    }
    const user = {
      id: crypto.randomUUID(),
      displayName,
      handle,
      email,
      passwordHash: hash,
      passwordSalt: salt,
      bio: '',
      privacyLevel: 'balanced',
      plan: 'free',
    };
    memory.users.push(user);
    return toUser(user);
  }

  const existing = await pool.query(
    'select id from veritas_users where handle = $1 or email = $2 limit 1',
    [handle, email],
  );
  if (existing.rows.length) {
    throw httpError('Email or username already exists', 409, 'AUTH_ACCOUNT_EXISTS');
  }
  try {
    const { rows } = await pool.query(
      `insert into veritas_users (id, display_name, handle, email, password_hash, password_salt)
       values ($1, $2, $3, $4, $5, $6)
       returning id, display_name, handle, email, avatar_url, bio, privacy_level, plan, last_seen`,
      [crypto.randomUUID(), displayName, handle, email, hash, salt],
    );
    return toUser(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw httpError('Email or username already exists', 409, 'AUTH_ACCOUNT_EXISTS');
    }
    throw error;
  }
}

async function ensureRegisterAvailable(input) {
  const handle = normalizeHandle(input?.handle);
  const email = normalizeEmail(input?.email);
  if (!handle || !email) {
    throw httpError('Email and username are required', 400, 'AUTH_EMAIL_USERNAME_REQUIRED');
  }

  if (!pool) {
    const exists = memory.users.find((user) => user.handle === handle || user.email === email);
    if (exists) {
      throw httpError('Email or username already exists', 409, 'AUTH_ACCOUNT_EXISTS');
    }
    return;
  }

  const existing = await pool.query(
    'select id from veritas_users where handle = $1 or email = $2 limit 1',
    [handle, email],
  );
  if (existing.rows.length) {
    throw httpError('Email or username already exists', 409, 'AUTH_ACCOUNT_EXISTS');
  }
}

async function requestRegisterCode(input) {
  const displayName = String(input?.displayName ?? '').trim();
  const handle = normalizeHandle(input?.handle);
  const email = normalizeEmail(input?.email);
  const password = String(input?.password ?? '');
  const locale = normalizeLocale(input?.locale);
  if (!displayName || !handle || !email || password.length < 6) {
    throw httpError(
      'Display name, email, username, and a password of at least 6 characters are required',
      400,
      'AUTH_REGISTER_REQUIRED',
    );
  }

  await ensureRegisterAvailable({ handle, email });

  const key = verificationKey(email);
  const current = pendingEmailVerifications.get(key);
  if (current && Date.now() - current.sentAt < emailVerificationCooldownMs) {
    throw httpError('Please wait 60 seconds before requesting another code', 429, 'AUTH_CODE_COOLDOWN');
  }

  const code = generateEmailCode();
  const passwordDigest = hashPassword(password);
  const pending = {
    codeHash: hashEmailCode(code),
    input: {
      displayName,
      handle,
      email,
      passwordHash: passwordDigest.hash,
      passwordSalt: passwordDigest.salt,
    },
    attempts: 0,
    sentAt: Date.now(),
    expiresAt: Date.now() + emailVerificationTtlMs,
  };
  await sendVerificationEmail(email, code, 'register', locale, displayName);
  pendingEmailVerifications.set(key, pending);
  return { ok: true, expiresIn: Math.floor(emailVerificationTtlMs / 1000) };
}

async function verifyRegisterCode(input) {
  const email = normalizeEmail(input?.email);
  const code = String(input?.code ?? '').replace(/\D/g, '').slice(0, 6);
  const key = verificationKey(email);
  const pending = pendingEmailVerifications.get(key);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingEmailVerifications.delete(key);
    throw httpError('Verification code expired. Please request a new code', 400, 'AUTH_CODE_EXPIRED');
  }
  if (code.length !== 6 || hashEmailCode(code) !== pending.codeHash) {
    pending.attempts += 1;
    if (pending.attempts >= 5) pendingEmailVerifications.delete(key);
    throw httpError('Verification code is incorrect', 400, 'AUTH_INVALID_CODE');
  }

  pendingEmailVerifications.delete(key);
  return registerUserWithPasswordHash(pending.input);
}

async function findPasswordUserByEmail(email) {
  if (!pool) {
    return memory.users.find((user) => user.email === email) ?? null;
  }
  const { rows } = await pool.query('select * from veritas_users where email = $1 limit 1', [email]);
  return rows[0] ?? null;
}

async function requirePasswordUserByEmail(email) {
  const user = await findPasswordUserByEmail(email);
  if (!user) {
    throw httpError('Email does not exist', 404, 'AUTH_EMAIL_NOT_FOUND');
  }
  return user;
}

async function checkAuthEmail(input) {
  const email = normalizeEmail(input?.email);
  if (!email) {
    throw httpError('Email does not exist', 404, 'AUTH_EMAIL_NOT_FOUND');
  }
  return { exists: Boolean(await findPasswordUserByEmail(email)) };
}

async function updateUserPassword(userId, password) {
  const { hash, salt } = hashPassword(password);
  return updateUserPasswordHash(userId, hash, salt);
}

async function updateUserPasswordHash(userId, hash, salt) {
  if (!pool) {
    const user = memory.users.find((item) => item.id === userId);
    if (!user) {
      const error = new Error('Tài khoản không tồn tại');
      error.status = 404;
      throw error;
    }
    user.passwordHash = hash;
    user.passwordSalt = salt;
    return toUser(user);
  }
  const { rows } = await pool.query(
    `update veritas_users
     set password_hash = $2, password_salt = $3
     where id = $1
     returning id, display_name, handle, email, avatar_url, bio, privacy_level, plan, last_seen`,
    [userId, hash, salt],
  );
  if (!rows[0]) {
    const error = new Error('Tài khoản không tồn tại');
    error.status = 404;
    throw error;
  }
  return toUser(rows[0]);
}

async function requestPasswordResetCode(input) {
  const email = normalizeEmail(input?.email);
  const password = String(input?.password ?? '');
  const locale = normalizeLocale(input?.locale);
  if (!email || password.length < 6) {
    throw httpError('Email and a new password of at least 6 characters are required', 400, 'AUTH_RESET_REQUIRED');
  }

  const user = await requirePasswordUserByEmail(email);

  const key = verificationKey(email);
  const current = pendingPasswordResets.get(key);
  if (current && Date.now() - current.sentAt < emailVerificationCooldownMs) {
    throw httpError('Please wait 60 seconds before requesting another code', 429, 'AUTH_CODE_COOLDOWN');
  }

  const code = generateEmailCode();
  const passwordDigest = hashPassword(password);
  const pending = {
    codeHash: hashEmailCode(code),
    userId: user.id,
    passwordHash: passwordDigest.hash,
    passwordSalt: passwordDigest.salt,
    attempts: 0,
    sentAt: Date.now(),
    expiresAt: Date.now() + emailVerificationTtlMs,
  };
  await sendVerificationEmail(email, code, 'reset', locale, user.displayName ?? user.display_name ?? email);
  pendingPasswordResets.set(key, pending);
  return { ok: true, expiresIn: Math.floor(emailVerificationTtlMs / 1000) };
}

async function verifyPasswordResetCode(input) {
  const email = normalizeEmail(input?.email);
  const code = String(input?.code ?? '').replace(/\D/g, '').slice(0, 6);
  const key = verificationKey(email);
  const pending = pendingPasswordResets.get(key);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingPasswordResets.delete(key);
    throw httpError('Verification code expired. Please request a new code', 400, 'AUTH_CODE_EXPIRED');
  }
  if (code.length !== 6 || hashEmailCode(code) !== pending.codeHash) {
    pending.attempts += 1;
    if (pending.attempts >= 5) pendingPasswordResets.delete(key);
    throw httpError('Verification code is incorrect', 400, 'AUTH_INVALID_CODE');
  }

  pendingPasswordResets.delete(key);
  const user = await updateUserPasswordHash(pending.userId, pending.passwordHash, pending.passwordSalt);
  await revokeAllSessions(user.id);
  return user;
}

async function loginUser(input) {
  assertCanAttemptLogin(input);
  const handle = normalizeHandle(input?.handle);
  const email = normalizeEmail(input?.email);
  const password = String(input?.password ?? '');

  if (!pool) {
    const user = memory.users.find((item) => item.handle === handle || item.email === email);
    if (!user) {
      recordLoginFailure(input);
      throw httpError('Email does not exist', 404, 'AUTH_EMAIL_NOT_FOUND');
    }
    if (!user.passwordHash || !user.passwordSalt || !verifyPassword(password, user)) {
      recordLoginFailure(input);
      throw httpError('Email or password is incorrect', 401, 'AUTH_INVALID_CREDENTIALS');
    }
    clearLoginFailures(input);
    return toUser(user);
  }

  const { rows } = await pool.query('select * from veritas_users where handle = $1 or email = $2', [handle, email]);
  const user = rows[0];
  if (!user) {
    recordLoginFailure(input);
    throw httpError('Email does not exist', 404, 'AUTH_EMAIL_NOT_FOUND');
  }
  if (!user.password_hash || !user.password_salt || !verifyPassword(password, user)) {
    recordLoginFailure(input);
    throw httpError('Email or password is incorrect', 401, 'AUTH_INVALID_CREDENTIALS');
  }
  clearLoginFailures(input);
  return toUser(user);
}
async function createAuthSession(user, request) {
  const tokens = issueTokens(user);
  const session = {
    id: tokens.refreshId,
    userId: user.id,
    refreshTokenHash: hashToken(tokens.refreshToken),
    userAgent: deviceLabelFromRequest(request),
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    expiresAt: tokens.refreshExpiresAt,
    revokedAt: null,
  };

  if (!pool) {
    memory.sessions.push(session);
    return {
      user,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionId: session.id,
    };
  }

  await pool.query(
    `insert into veritas_sessions (id, user_id, refresh_token_hash, user_agent, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [session.id, user.id, session.refreshTokenHash, session.userAgent, session.expiresAt],
  );

  return {
    user,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    sessionId: session.id,
  };
}

async function verifyRefreshSession(refreshToken) {
  let payload;
  try {
    payload = jwt.verify(refreshToken ?? '', jwtRefreshSecret, { issuer: 'veritas-api' });
  } catch (error) {
    error.status = 401;
    throw error;
  }
  const tokenHash = hashToken(refreshToken);

  if (!pool) {
    const session = memory.sessions.find(
      (item) =>
        item.id === payload.jti &&
        item.userId === payload.sub &&
        item.refreshTokenHash === tokenHash &&
        !item.revokedAt &&
        new Date(item.expiresAt) > new Date(),
    );
    if (!session) {
      const error = new Error('Refresh token đã bị thu hồi hoặc hết hạn');
      error.status = 401;
      throw error;
    }
    session.lastUsedAt = new Date().toISOString();
    return { payload, session };
  }

  const { rows } = await pool.query(
    `update veritas_sessions
     set last_used_at = now()
     where id = $1
       and user_id = $2
       and refresh_token_hash = $3
       and revoked_at is null
       and expires_at > now()
     returning id, user_id, user_agent, created_at, last_used_at, expires_at, revoked_at`,
    [payload.jti, payload.sub, tokenHash],
  );

  if (!rows[0]) {
    const error = new Error('Refresh token đã bị thu hồi hoặc hết hạn');
    error.status = 401;
    throw error;
  }
  return { payload, session: rows[0] };
}

async function revokeSession(sessionId, userId) {
  if (!sessionId) return { ok: true };
  if (!pool) {
    const session = memory.sessions.find((item) => item.id === sessionId && item.userId === userId);
    if (session) session.revokedAt = new Date().toISOString();
    return { ok: true };
  }
  await pool.query(`update veritas_sessions set revoked_at = now() where id = $1 and user_id = $2`, [sessionId, userId]);
  return { ok: true };
}

async function revokeRefreshToken(refreshToken) {
  const { payload } = await verifyRefreshSession(refreshToken);
  await revokeSession(payload.jti, payload.sub);
  return { ok: true };
}

async function revokeAllSessions(userId) {
  if (!pool) {
    for (const session of memory.sessions.filter((item) => item.userId === userId && !item.revokedAt)) {
      session.revokedAt = new Date().toISOString();
    }
    return { ok: true };
  }
  await pool.query(`update veritas_sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);
  return { ok: true };
}

async function listSessions(userId) {
  if (!pool) {
    return memory.sessions
      .filter((session) => session.userId === userId && !session.revokedAt && new Date(session.expiresAt) > new Date())
      .map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
      }));
  }
  const { rows } = await pool.query(
    `select id, user_agent, created_at, last_used_at, expires_at
     from veritas_sessions
     where user_id = $1 and revoked_at is null and expires_at > now()
     order by last_used_at desc`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  }));
}

async function getUser(userId) {
  if (!pool) {
    const user = memory.users.find((item) => item.id === userId);
    return user ? toUser(user) : null;
  }
  const { rows } = await pool.query(
    `select id, display_name, handle, email, avatar_url, bio, privacy_level, plan, last_seen from veritas_users where id = $1`,
    [userId],
  );
  return rows[0] ? toUser(rows[0]) : null;
}

async function updateProfile(userId, input) {
  const displayName = String(input?.displayName ?? '').trim();
  const handle = normalizeHandle(input?.handle);
  const avatarUrl = String(input?.avatarUrl ?? '').trim().slice(0, 500);
  const bio = String(input?.bio ?? '').trim().slice(0, 180);
  const privacyLevel = ['low', 'balanced', 'strict'].includes(input?.privacyLevel) ? input.privacyLevel : 'balanced';
  if (!displayName || !handle) {
    const error = new Error('Tên hiển thị và đường dẫn là bắt buộc');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const user = memory.users.find((item) => item.id === userId);
    if (!user) {
      const error = new Error('Người dùng không còn tồn tại');
      error.status = 404;
      throw error;
    }
    Object.assign(user, { displayName, handle, avatarUrl, bio, privacyLevel });
    return toUser(user);
  }

  try {
    const { rows } = await pool.query(
      `update veritas_users
       set display_name = $1, handle = $2, avatar_url = $3, bio = $4, privacy_level = $5
       where id = $6
       returning id, display_name, handle, email, avatar_url, bio, privacy_level, plan, last_seen`,
      [displayName, handle, avatarUrl, bio, privacyLevel, userId],
    );
    return toUser(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      error.status = 409;
      error.message = 'Đường dẫn đã tồn tại';
    }
    throw error;
  }
}

async function updateUserPlan(userId, plan) {
  const nextPlan = plan === 'extra' ? 'extra' : 'free';

  if (!pool) {
    const user = memory.users.find((item) => item.id === userId) ?? memory.users[0];
    Object.assign(user, { plan: nextPlan });
    return toUser(user);
  }

  const { rows } = await pool.query(
    `update veritas_users
     set plan = $1
     where id = $2
     returning id, display_name, handle, email, avatar_url, bio, privacy_level, plan, last_seen`,
    [nextPlan, userId],
  );
  return toUser(rows[0]);
}

async function touchPresence(userId) {
  const now = new Date().toISOString();
  if (!pool) {
    const user = memory.users.find((item) => item.id === userId);
    if (user) user.lastSeen = now;
    return { ok: true, lastSeen: now };
  }
  await pool.query(`update veritas_users set last_seen = now() where id = $1`, [userId]);
  return { ok: true, lastSeen: now };
}

async function getParticipantRole(conversationId, userId) {
  if (!pool) {
    const conversation = memory.conversations.find((item) => item.id === conversationId);
    return conversation?.participants?.find((participant) => participant.id === userId || participant.userId === userId)?.role ?? null;
  }
  const { rows } = await pool.query(
    `select p.role, c.kind
     from veritas_conversations c
     left join veritas_participants p on p.conversation_id = c.id and p.user_id = $2
     where c.id = $1`,
    [conversationId, userId],
  );
  if (!rows[0]) return null;
  return rows[0].role ?? null;
}

async function requireConversationAccess(conversationId, userId) {
  const role = await getParticipantRole(conversationId, userId);
  if (!role) {
    const error = new Error('Bạn chưa có quyền vào hội thoại này');
    error.status = 403;
    throw error;
  }
  return role;
}

async function requireManager(conversationId, userId) {
  const role = await getParticipantRole(conversationId, userId);
  if (!['owner', 'admin'].includes(role)) {
    const error = new Error('Chỉ chủ sở hữu/quản trị viên mới được thực hiện thao tác này');
    error.status = 403;
    throw error;
  }
  return role;
}

async function getConversations(userId) {
  await ensureStarterConversation(userId);

  if (!pool) {
    return memory.conversations
      .filter((conversation) => conversation.participants.some((participant) => participant.id === userId || participant.userId === userId))
      .filter((conversation) => conversation.kind !== 'private' || conversation.participants.some((participant) => participant.id !== userId && participant.userId !== userId))
      .filter((conversation) => conversation.kind !== 'private' || conversation.isAi || (conversation.messages ?? []).length > 0)
      .map((conversation) => {
        const peerParticipant = conversation.participants.find((participant) => participant.id !== userId && participant.userId !== userId);
        const peer = memory.users.find((user) => user.id === peerParticipant?.id || user.id === peerParticipant?.userId) ?? peerParticipant;
        return {
          id: conversation.id,
          peerId: conversation.kind === 'private' ? (peer?.id ?? '') : '',
          name: conversation.kind === 'private' ? (peer?.displayName ?? conversation.name) : conversation.name,
          handle: conversation.kind === 'private' ? (peer?.handle ?? conversation.handle) : conversation.handle,
          avatarUrl: conversation.kind === 'private' ? (peer?.avatarUrl ?? '') : (conversation.avatarUrl ?? ''),
          status: conversation.kind === 'private' && realtimePresence.get(peer?.id)?.sockets?.size ? 'online' : conversation.status,
          lastSeen: peer?.lastSeen ?? null,
          online: Boolean(conversation.kind === 'private' && realtimePresence.get(peer?.id)?.sockets?.size),
          kind: conversation.kind,
          isAi: Boolean(conversation.isAi),
          aiModelId: conversation.aiModelId ?? '',
          unread: conversation.unread,
          myRole: conversation.participants.find((participant) => participant.id === userId || participant.userId === userId)?.role ?? 'member',
          memberCount: conversation.participants.length,
          lastMessage: conversation.messages.at(-1)?.text ?? '',
          lastMessageAt: conversation.messages.at(-1)?.createdAt,
          description: conversation.description ?? '',
          postingPolicy: normalizePostingPolicy(conversation.postingPolicy, conversation.kind),
          privacyLevel: conversation.privacyLevel ?? 'public',
          joinPolicy: conversation.joinPolicy ?? 'open',
        };
      });
  }

  const { rows } = await pool.query(
    `
    select
      c.id,
      case when c.kind = 'private' then peer.id end as peer_id,
      coalesce(case when c.kind = 'private' then peer.display_name end, c.name) as name,
      coalesce(case when c.kind = 'private' then peer.handle end, c.handle) as handle,
      case
        when c.kind = 'private' and peer.last_seen > now() - interval '90 seconds' then 'online'
        when c.kind = 'private' then 'offline'
        else c.status
      end as status,
      c.kind,
      c.is_ai,
      c.ai_model_id,
      ai_model.privacy as ai_privacy,
      c.description,
      c.posting_policy,
      c.privacy_level,
      c.join_policy,
      c.created_at,
      coalesce(p.role, 'member') as my_role,
      coalesce(member_counts.member_count, 1) as member_count,
      case when c.kind = 'private' then peer.avatar_url else '' end as avatar_url,
      case when c.kind = 'private' then peer.last_seen end as last_seen,
      last_message.body as last_message,
      last_message.created_at as last_message_at,
      coalesce(unread_counts.unread, 0) as unread
    from veritas_conversations c
    join veritas_participants p on p.conversation_id = c.id and p.user_id = $1
    left join lateral (
      select u.id, u.display_name, u.handle, u.avatar_url, u.last_seen
      from veritas_participants pp
      join veritas_users u on u.id = pp.user_id
      where pp.conversation_id = c.id
        and pp.user_id <> $1
        and c.kind = 'private'
      order by u.display_name
      limit 1
    ) peer on true
    left join lateral (
      select count(*)::int as member_count
      from veritas_participants mp
      where mp.conversation_id = c.id
    ) member_counts on true
    left join lateral (
      select m.body, m.created_at
      from veritas_messages m
      where m.conversation_id = c.id
        and m.deleted_at is null
        and (m.verdict <> 'limited' or m.sender_id = $1)
      order by m.created_at desc
      limit 1
    ) last_message on true
    left join lateral (
      select count(*)::int as unread
      from veritas_messages m
      left join veritas_message_reads r on r.message_id = m.id and r.user_id = $1
      where m.conversation_id = c.id
        and m.sender_id <> $1
        and m.deleted_at is null
        and m.verdict <> 'limited'
        and r.message_id is null
    ) unread_counts on true
    left join veritas_ai_models ai_model on ai_model.id = c.ai_model_id
    where c.kind <> 'private'
      or c.is_ai = true
      or (peer.id is not null and last_message.created_at is not null)
    order by last_message.created_at desc nulls last, c.created_at desc
  `,
    [userId],
  );
  return rows.map(toConversation);
}

async function getMessages(conversationId, userId, options = {}) {
  await requireConversationAccess(conversationId, userId);
  if (!pool) {
    const messages = memory.conversations.find((conversation) => conversation.id === conversationId)?.messages ?? [];
    const limit = Math.min(100, Math.max(1, Number(options.limit || 50)));
    if (!options.before) return messages.slice(-limit).map((message) => normalizeMemoryMessage(message, userId));
    const beforeTime = Date.parse(options.before);
    return messages
      .filter((message) => Date.parse(message.createdAt) < beforeTime)
      .slice(-limit)
      .map((message) => normalizeMemoryMessage(message, userId));
  }

  const limit = Math.min(100, Math.max(1, Number(options.limit || 50)));
  const beforeDate = options.before ? new Date(options.before) : null;
  const beforeValid = beforeDate && !Number.isNaN(beforeDate.getTime());
  const queryParams = beforeValid ? [conversationId, userId, beforeDate.toISOString(), limit] : [conversationId, userId, limit];
  const beforeClause = beforeValid ? 'and m.created_at < $3' : '';
  const limitParam = beforeValid ? '$4' : '$3';

  const baseQuery = `with page as (
     select m.*
     from veritas_messages m
     where m.conversation_id = $1
       and m.deleted_at is null
       and (m.verdict <> 'limited' or m.sender_id = $2)
       and (m.sender_id = $2 or not exists (
         select 1 from veritas_blocks b
         where b.blocker_id = $2 and b.blocked_id = m.sender_id
       ))
       ${beforeClause}
     order by m.created_at desc
     limit ${limitParam}
   )
   select page.*, u.display_name as sender_name, u.avatar_url as sender_avatar_url,
     rm.body as reply_body,
     ru.display_name as reply_sender_name
   from page
   join veritas_users u on u.id = page.sender_id
   left join veritas_messages rm on rm.id = page.reply_to_message_id
   left join veritas_users ru on ru.id = rm.sender_id
   order by page.created_at asc`;

  const { rows } = await pool.query(baseQuery, queryParams);
  const readableIds = options.markRead ? rows.filter((row) => row.sender_id !== userId).map((row) => row.id) : [];
  if (readableIds.length) {
    await pool.query(
      `insert into veritas_message_reads (message_id, user_id)
       select unnest($1::uuid[]), $2
       on conflict (message_id, user_id) do nothing`,
      [readableIds, userId],
    );
  }

  return hydrateMessageReactions(rows.map((row) => toMessage(row, userId)), userId);
}

async function getMessageByIdForUser(messageId, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `select m.*, u.display_name as sender_name, u.avatar_url as sender_avatar_url,
       rm.body as reply_body,
       ru.display_name as reply_sender_name
     from veritas_messages m
     join veritas_users u on u.id = m.sender_id
     left join veritas_messages rm on rm.id = m.reply_to_message_id
     left join veritas_users ru on ru.id = rm.sender_id
     where m.id = $1
       and m.deleted_at is null
       and (m.verdict <> 'limited' or m.sender_id = $2)
       and (m.sender_id = $2 or not exists (
         select 1 from veritas_blocks b
         where b.blocker_id = $2 and b.blocked_id = m.sender_id
       ))
     limit 1`,
    [messageId, userId],
  );
  const [message] = await hydrateMessageReactions(rows.map((row) => toMessage(row, userId)), userId);
  return message ?? null;
}

async function hydrateMessageReactions(messages, userId) {
  if (!pool || !messages.length) return messages;
  const messageIds = messages.map((message) => message.id);
  const [{ rows: countRows }, { rows: mineRows }] = await Promise.all([
    pool.query(
      `select message_id, attachment_id, emoji, count(*)::int as count
       from veritas_message_reactions
       where message_id = any($1::uuid[])
       group by message_id, attachment_id, emoji`,
      [messageIds],
    ),
    pool.query(
      `select message_id, attachment_id, emoji
       from veritas_message_reactions
       where message_id = any($1::uuid[]) and user_id = $2`,
      [messageIds, userId],
    ),
  ]);

  const state = new Map();
  function key(messageId, attachmentId = '') {
    return `${messageId}::${attachmentId}`;
  }
  for (const row of countRows) {
    const itemKey = key(row.message_id, row.attachment_id ?? '');
    const current = state.get(itemKey) ?? { reactions: {}, myReaction: '' };
    current.reactions[row.emoji] = Number(row.count);
    state.set(itemKey, current);
  }
  for (const row of mineRows) {
    const itemKey = key(row.message_id, row.attachment_id ?? '');
    const current = state.get(itemKey) ?? { reactions: {}, myReaction: '' };
    current.myReaction = row.emoji;
    state.set(itemKey, current);
  }

  return messages.map((message) => {
    const messageState = state.get(key(message.id)) ?? { reactions: {}, myReaction: '' };
    return {
      ...message,
      reactions: messageState.reactions,
      myReaction: messageState.myReaction,
      attachments: (message.attachments ?? []).map((attachment) => {
        const attachmentId = String(attachment.id || attachment.url || '');
        const attachmentState = state.get(key(message.id, attachmentId)) ?? { reactions: {}, myReaction: '' };
        return {
          ...attachment,
          reactions: attachmentState.reactions,
          myReaction: attachmentState.myReaction,
        };
      }),
    };
  });
}

async function searchMessages(query, userId, conversationId = '') {
  const q = query.trim();
  if (!q) return [];
  if (!pool) {
    return memory.conversations
      .filter((conversation) => conversation.participants.some((participant) => participant.id === userId || participant.userId === userId))
      .filter((conversation) => !conversationId || conversation.id === conversationId)
      .flatMap((conversation) =>
        conversation.messages
          .filter((message) => message.text.toLowerCase().includes(q.toLowerCase()))
          .map((message) => ({ ...message, conversationName: conversation.name, conversationKind: conversation.kind })),
      );
  }

  const queryParams = conversationId ? [`%${q}%`, userId, conversationId] : [`%${q}%`, userId];
  const conversationClause = conversationId ? 'and c.id = $3' : '';
  const { rows } = await pool.query(
    `select m.*, u.display_name as sender_name, c.name as conversation_name, c.kind as conversation_kind
     from veritas_messages m
     join veritas_users u on u.id = m.sender_id
     join veritas_conversations c on c.id = m.conversation_id
     left join veritas_participants p on p.conversation_id = c.id and p.user_id = $2
     where m.body ilike $1
       ${conversationClause}
       and m.deleted_at is null
       and p.user_id is not null
       and (m.verdict <> 'limited' or m.sender_id = $2)
       and (m.sender_id = $2 or not exists (
         select 1 from veritas_blocks b
         where b.blocker_id = $2 and b.blocked_id = m.sender_id
       ))
     order by m.created_at desc
     limit 30`,
    queryParams,
  );

  return rows.map((row) => ({
    ...toMessage(row, userId),
    conversationName: row.conversation_name,
    conversationKind: row.conversation_kind,
  }));
}

async function searchUsers(query, userId) {
  const q = query.trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  const exactHandle = normalizeHandle(q);

  if (!pool) {
    const users = memory.users
      .filter((user) => user.id !== userId)
      .filter((user) => {
        const privacyLevel = user.privacyLevel ?? 'balanced';
        if (privacyLevel === 'strict') return false;
        return [user.displayName, user.handle].some((value) => String(value ?? '').toLowerCase().includes(qLower));
      })
      .slice(0, 12)
      .map((user) => ({ ...publicUser(user), type: 'user' }));
    const conversations = memory.conversations
      .filter((conversation) => ['group', 'channel'].includes(conversation.kind))
      .filter((conversation) => (conversation.privacyLevel ?? 'public') === 'public')
      .filter((conversation) => [conversation.name, conversation.handle, conversation.description].some((value) => String(value ?? '').toLowerCase().includes(qLower)))
      .slice(0, 8)
      .map((conversation) => ({
        ...toConversation(conversation),
        type: 'conversation',
        isJoined: conversation.participants.some((participant) => (participant.id ?? participant.userId) === userId),
        joinStatus: memory.joinRequests.some((request) => request.conversationId === conversation.id && request.userId === userId && request.status === 'pending') ? 'pending' : '',
      }));
    return [...users, ...conversations].slice(0, 16);
  }

  const [{ rows: userRows }, { rows: conversationRows }] = await Promise.all([
    pool.query(
    `select id, display_name, handle, avatar_url, bio, privacy_level, plan, last_seen
     from veritas_users u
     where u.id <> $2
       and not exists (
         select 1 from veritas_blocks b
         where (b.blocker_id = $2 and b.blocked_id = u.id)
            or (b.blocker_id = u.id and b.blocked_id = $2)
       )
       and u.privacy_level <> 'strict'
       and (u.display_name ilike $1 or u.handle ilike $1)
     order by case when u.handle = $3 then 0 else 1 end, u.display_name
     limit 12`,
    [`%${q}%`, userId, exactHandle],
    ),
    pool.query(
      `select c.id, c.name, c.handle, c.status, c.kind, c.description, c.posting_policy, c.privacy_level, c.join_policy, c.created_at,
              coalesce(member_counts.member_count, 1) as member_count,
              case when mine.user_id is null then false else true end as is_joined,
              coalesce(mine.role, 'member') as my_role,
              join_request.status as join_status
       from veritas_conversations c
       left join lateral (
         select count(*)::int as member_count
         from veritas_participants p
         where p.conversation_id = c.id
       ) member_counts on true
       left join veritas_participants mine on mine.conversation_id = c.id and mine.user_id = $2
       left join lateral (
         select status
         from veritas_join_requests jr
         where jr.conversation_id = c.id
           and jr.user_id = $2
           and jr.status = 'pending'
         order by jr.created_at desc
         limit 1
       ) join_request on true
       where c.kind in ('group', 'channel')
         and c.privacy_level = 'public'
         and (c.name ilike $1 or c.handle ilike $1 or c.description ilike $1)
       order by case when c.handle = $3 or c.handle = $4 then 0 else 1 end, c.created_at desc
       limit 8`,
      [`%${q}%`, userId, exactHandle, qLower.replace(/^@/, '')],
    ),
  ]);
  return [
    ...userRows.map((user) => ({ ...publicUser(user), type: 'user' })),
    ...conversationRows.map((conversation) => ({ ...toConversation(conversation), type: 'conversation', isJoined: Boolean(conversation.is_joined) })),
  ];
}

async function getPublicUserByHandle(handleInput) {
  const handle = normalizeHandle(handleInput);
  if (!handle) return null;

  if (!pool) {
    const user = memory.users.find((item) => item.handle === handle);
    if (!user || (user.privacyLevel ?? 'balanced') === 'strict') return null;
    return publicUser(user);
  }

  const { rows } = await pool.query(
    `select id, display_name, handle, avatar_url, bio, privacy_level, plan, last_seen
     from veritas_users
     where handle = $1
       and privacy_level <> 'strict'
     limit 1`,
    [handle],
  );
  return rows[0] ? publicUser(rows[0]) : null;
}

async function getPublicConversationByHandle(handleInput) {
  const normalized = normalizeHandle(handleInput);
  const rawHandle = String(handleInput ?? '').trim().toLowerCase();
  const handles = Array.from(new Set([normalized, rawHandle, rawHandle.replace(/^@/, '')].filter(Boolean)));
  if (!handles.length) return null;

  if (!pool) {
    const conversation = memory.conversations.find((item) =>
      item.kind !== 'private'
      && (item.privacyLevel ?? 'public') === 'public'
      && handles.includes(String(item.handle ?? '').toLowerCase()),
    );
    return conversation ? toConversation(conversation) : null;
  }

  const { rows } = await pool.query(
    `select c.id, c.name, c.handle, c.status, c.kind, c.description, c.posting_policy, c.privacy_level, c.join_policy, c.created_at,
       coalesce(member_counts.member_count, 1) as member_count
     from veritas_conversations c
     left join lateral (
       select count(*)::int as member_count
       from veritas_participants p
       where p.conversation_id = c.id
     ) member_counts on true
     where c.handle = $1
       and c.kind <> 'private'
       and c.privacy_level = 'public'
     limit 1`,
    [handles[0]],
  );
  if (rows[0]) return toConversation(rows[0]);

  if (handles.length === 1) return null;
  const fallback = await pool.query(
    `select c.id, c.name, c.handle, c.status, c.kind, c.description, c.posting_policy, c.privacy_level, c.join_policy, c.created_at,
       coalesce(member_counts.member_count, 1) as member_count
     from veritas_conversations c
     left join lateral (
       select count(*)::int as member_count
       from veritas_participants p
       where p.conversation_id = c.id
     ) member_counts on true
     where c.handle = any($1::text[])
       and c.kind <> 'private'
       and c.privacy_level = 'public'
     limit 1`,
    [handles],
  );
  return fallback.rows[0] ? toConversation(fallback.rows[0]) : null;
}

async function createPrivateConversation(targetUserId, userId) {
  if (!targetUserId || targetUserId === userId) {
    const error = new Error('Người nhận không hợp lệ');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const target = memory.users.find((user) => user.id === targetUserId);
    if (!target) {
      const error = new Error('Không tìm thấy người dùng');
      error.status = 404;
      throw error;
    }
    const existing = memory.conversations.find((conversation) =>
      conversation.kind === 'private'
      && conversation.participants.some((participant) => participant.id === userId || participant.userId === userId)
      && conversation.participants.some((participant) => participant.id === targetUserId || participant.userId === targetUserId),
    );
    if (existing) {
      return {
        id: existing.id,
        name: target.displayName,
        handle: target.handle,
        avatarUrl: target.avatarUrl ?? '',
        status: existing.status,
        kind: 'private',
        unread: existing.unread,
        myRole: 'owner',
        memberCount: existing.participants.length,
        lastMessage: existing.messages.at(-1)?.text ?? '',
        lastMessageAt: existing.messages.at(-1)?.createdAt,
      };
    }
    const conversation = {
      id: crypto.randomUUID(),
      name: target.displayName,
      handle: target.handle,
      avatarUrl: target.avatarUrl ?? '',
      status: 'online',
      kind: 'private',
      unread: 0,
      myRole: 'owner',
      memberCount: 2,
      lastMessage: '',
      lastMessageAt: null,
      messages: [],
      participants: [{ id: userId, role: 'owner' }, { id: targetUserId, role: 'member' }],
    };
    memory.conversations.unshift(conversation);
    return conversation;
  }

  const { rows: targetRows } = await pool.query(
    `select id, display_name, handle, avatar_url from veritas_users where id = $1`,
    [targetUserId],
  );
  const target = targetRows[0];
  if (!target) {
    const error = new Error('Không tìm thấy người dùng');
    error.status = 404;
    throw error;
  }
  const { rows: blockedRows } = await pool.query(
    `select 1 from veritas_blocks
     where (blocker_id = $1 and blocked_id = $2)
        or (blocker_id = $2 and blocked_id = $1)
     limit 1`,
    [userId, targetUserId],
  );
  if (blockedRows.length) {
    const error = new Error('Không thể tạo trò chuyện với người dùng này');
    error.status = 403;
    throw error;
  }

  const { rows: existingRows } = await pool.query(
    `select c.*
     from veritas_conversations c
     join veritas_participants p1 on p1.conversation_id = c.id and p1.user_id = $1
     join veritas_participants p2 on p2.conversation_id = c.id and p2.user_id = $2
     where c.kind = 'private'
     limit 1`,
    [userId, targetUserId],
  );
  if (existingRows[0]) {
    return {
      ...toConversation({ ...existingRows[0], my_role: 'owner', member_count: 2, avatar_url: target.avatar_url }),
      name: target.display_name,
      handle: target.handle,
    };
  }

  const conversationId = crypto.randomUUID();
  await pool.query(
    `insert into veritas_conversations (id, name, handle, status, kind)
     values ($1, $2, $3, 'online', 'private')`,
    [conversationId, target.display_name, target.handle],
  );
  await pool.query(
    `insert into veritas_participants (conversation_id, user_id, role)
     values ($1, $2, 'owner'), ($1, $3, 'member')`,
    [conversationId, userId, targetUserId],
  );
  return {
    id: conversationId,
    name: target.display_name,
    handle: target.handle,
    avatarUrl: target.avatar_url ?? '',
    status: 'online',
    kind: 'private',
    unread: 0,
    myRole: 'owner',
    memberCount: 2,
    lastMessage: '',
    lastMessageAt: null,
  };
}

async function deletePrivateDraftConversation(conversationId, userId) {
  if (!conversationId) return { deleted: false };

  if (!pool) {
    const index = memory.conversations.findIndex((conversation) =>
      conversation.id === conversationId
        && conversation.kind === 'private'
        && !conversation.isAi
        && (conversation.messages ?? []).length === 0
        && (conversation.participants ?? []).some((participant) => (participant.id ?? participant.userId) === userId),
    );
    if (index < 0) return { deleted: false };
    memory.conversations.splice(index, 1);
    return { deleted: true, conversationId };
  }

  const { rows } = await pool.query(
    `delete from veritas_conversations c
     where c.id = $1
       and c.kind = 'private'
       and c.is_ai = false
       and exists (
         select 1 from veritas_participants p
         where p.conversation_id = c.id and p.user_id = $2
       )
       and not exists (
         select 1 from veritas_messages m
         where m.conversation_id = c.id
       )
     returning c.id`,
    [conversationId, userId],
  );
  return { deleted: Boolean(rows[0]), conversationId };
}

async function createConversation(input, userId) {
  const name = String(input?.name ?? '').trim();
  const kind = normalizeKind(input?.kind);
  if (!name) {
    const error = new Error('Tên hội thoại là bắt buộc');
    error.status = 400;
    throw error;
  }
  if (kind === 'private') {
    const error = new Error('Hãy tìm người dùng để tạo trò chuyện riêng.');
    error.status = 400;
    throw error;
  }
  const handle = normalizeConversationHandle(input?.handle, name, kind);
  const description = normalizeConversationDescription(input?.description);
  const postingPolicy = normalizePostingPolicy(input?.postingPolicy, kind);
  const privacyLevel = normalizeConversationPrivacy(input?.privacyLevel);
  const joinPolicy = normalizeJoinPolicy(input?.joinPolicy);

  const conversation = {
    id: crypto.randomUUID(),
    name,
    handle,
    status: description || '',
    kind,
    unread: 0,
    myRole: 'owner',
    memberCount: 1,
    lastMessage: '',
    lastMessageAt: null,
    messages: [],
    description,
    postingPolicy,
    privacyLevel,
    joinPolicy,
  };

  if (!pool) {
    const exists = memory.conversations.some((item) => item.kind !== 'private' && String(item.handle).toLowerCase() === handle.toLowerCase());
    if (exists) {
      const error = new Error('Đường dẫn này đã được dùng.');
      error.status = 409;
      throw error;
    }
    memory.conversations.unshift({ ...conversation, participants: [{ id: userId, role: 'owner' }], messages: [] });
    return conversation;
  }

  try {
    await pool.query(
      `insert into veritas_conversations (id, name, handle, status, kind, description, posting_policy, privacy_level, join_policy)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        conversation.id,
        conversation.name,
        conversation.handle,
        conversation.status,
        conversation.kind,
        conversation.description,
        conversation.postingPolicy,
        conversation.privacyLevel,
        conversation.joinPolicy,
      ],
    );
  } catch (error) {
    if (error.code === '23505') {
      error.status = 409;
      error.message = 'Đường dẫn này đã được dùng.';
    }
    throw error;
  }
  await pool.query(
    `insert into veritas_participants (conversation_id, user_id, role)
     values ($1, $2, 'owner') on conflict do nothing`,
    [conversation.id, userId],
  );
  return conversation;
}

async function joinConversation(input, userId) {
  const id = String(input?.conversationId ?? input?.id ?? '').trim();
  const handle = String(input?.handle ?? '').trim().toLowerCase();
  const handleCandidates = Array.from(new Set([
    normalizeHandle(handle),
    handle,
    handle.replace(/^@/, ''),
    handle.startsWith('@') ? handle : `@${handle}`,
  ].filter(Boolean)));

  if (!id && !handleCandidates.length) {
    const error = new Error('Thiếu kênh hoặc cộng đồng để tham gia.');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const conversation = memory.conversations.find((item) =>
      ['group', 'channel'].includes(item.kind)
      && (item.id === id || handleCandidates.includes(String(item.handle ?? '').toLowerCase())),
    );
    if (!conversation) {
      const error = new Error('Không tìm thấy kênh/cộng đồng công khai.');
      error.status = 404;
      throw error;
    }
    if ((conversation.privacyLevel ?? 'public') !== 'public') {
      const error = new Error('Kênh/cộng đồng này đang riêng tư.');
      error.status = 403;
      throw error;
    }
    const existingRole = conversation.participants.find((participant) => (participant.id ?? participant.userId) === userId)?.role;
    if (!existingRole && normalizeJoinPolicy(conversation.joinPolicy) === 'approval') {
      const existingRequest = memory.joinRequests.find((request) =>
        request.conversationId === conversation.id && request.userId === userId && request.status === 'pending',
      );
      if (!existingRequest) {
        memory.joinRequests.unshift({
          id: crypto.randomUUID(),
          conversationId: conversation.id,
          userId,
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
      }
      return {
        ...toConversation(conversation),
        myRole: '',
        memberCount: conversation.participants.length,
        joinStatus: 'pending',
      };
    }
    if (!existingRole) {
      conversation.participants.push({ id: userId, role: 'member' });
    }
    return {
      ...toConversation(conversation),
      myRole: conversation.participants.find((participant) => (participant.id ?? participant.userId) === userId)?.role ?? 'member',
      memberCount: conversation.participants.length,
    };
  }

  const params = id ? [id] : [handleCandidates];
  const whereClause = id ? 'c.id = $1' : 'c.handle = any($1::text[])';
  const { rows } = await pool.query(
    `select c.id, c.name, c.handle, c.status, c.kind, c.description, c.posting_policy, c.privacy_level, c.join_policy, c.created_at,
            coalesce(member_counts.member_count, 0) as member_count,
            mine.role as my_role,
            join_request.status as join_status
     from veritas_conversations c
     left join lateral (
       select count(*)::int as member_count
       from veritas_participants p
       where p.conversation_id = c.id
     ) member_counts on true
     left join veritas_participants mine on mine.conversation_id = c.id and mine.user_id = $2
     left join lateral (
       select status
       from veritas_join_requests jr
       where jr.conversation_id = c.id
         and jr.user_id = $2
         and jr.status = 'pending'
       order by jr.created_at desc
       limit 1
     ) join_request on true
     where ${whereClause}
       and c.kind in ('group', 'channel')
     limit 1`,
    [...params, userId],
  );
  const conversation = rows[0];
  if (!conversation) {
    const error = new Error('Không tìm thấy kênh/cộng đồng công khai.');
    error.status = 404;
    throw error;
  }
  if (conversation.privacy_level !== 'public') {
    const error = new Error('Kênh/cộng đồng này đang riêng tư.');
    error.status = 403;
    throw error;
  }

  if (!conversation.my_role && normalizeJoinPolicy(conversation.join_policy) === 'approval') {
    await pool.query(
      `insert into veritas_join_requests (id, conversation_id, user_id, status)
       values ($1, $2, $3, 'pending')
       on conflict (conversation_id, user_id) where status = 'pending' do nothing`,
      [crypto.randomUUID(), conversation.id, userId],
    );
    return {
      ...toConversation({
        ...conversation,
        my_role: '',
        join_status: 'pending',
      }),
      unread: 0,
    };
  }

  if (!conversation.my_role) {
    await pool.query(
      `insert into veritas_participants (conversation_id, user_id, role)
       values ($1, $2, 'member') on conflict do nothing`,
      [conversation.id, userId],
    );
  }

  return {
    ...toConversation({
      ...conversation,
      my_role: conversation.my_role ?? 'member',
      member_count: Number(conversation.member_count ?? 0) + (conversation.my_role ? 0 : 1),
    }),
    unread: 0,
  };
}

async function updateConversation(conversationId, input, actorId) {
  const role = await requireManager(conversationId, actorId);
  const current = !pool
    ? memory.conversations.find((conversation) => conversation.id === conversationId)
    : (await pool.query(`select * from veritas_conversations where id = $1`, [conversationId])).rows[0];

  if (!current) {
    const error = new Error('Không tìm thấy kênh/cộng đồng.');
    error.status = 404;
    throw error;
  }
  if (!['group', 'channel'].includes(current.kind)) {
    const error = new Error('Chỉ có thể sửa kênh hoặc cộng đồng.');
    error.status = 400;
    throw error;
  }

  const kind = current.kind;
  const name = String(input?.name ?? current.name ?? '').trim().slice(0, 80);
  if (name.length < 2) {
    const error = new Error('Tên phải có ít nhất 2 ký tự.');
    error.status = 400;
    throw error;
  }
  const handle = normalizeConversationHandle(input?.handle ?? current.handle, name, kind);
  const description = normalizeConversationDescription(input?.description ?? current.description);
  const postingPolicy = normalizePostingPolicy(input?.postingPolicy ?? current.posting_policy ?? current.postingPolicy, kind);
  const privacyLevel = normalizeConversationPrivacy(input?.privacyLevel ?? current.privacy_level ?? current.privacyLevel);
  const joinPolicy = normalizeJoinPolicy(input?.joinPolicy ?? current.join_policy ?? current.joinPolicy);
  const status = description || '';

  if (!pool) {
    const exists = memory.conversations.some((item) =>
      item.id !== conversationId
      && item.kind !== 'private'
      && String(item.handle ?? '').toLowerCase() === handle.toLowerCase(),
    );
    if (exists) {
      const error = new Error('Đường dẫn này đã được dùng.');
      error.status = 409;
      throw error;
    }
    Object.assign(current, { name, handle, description, postingPolicy, privacyLevel, joinPolicy, status });
    return {
      ...toConversation(current),
      myRole: role,
      memberCount: current.participants?.length ?? 1,
    };
  }

  try {
    const { rows } = await pool.query(
      `update veritas_conversations
       set name = $1,
           handle = $2,
           description = $3,
           posting_policy = $4,
           privacy_level = $5,
           join_policy = $6,
           status = $7
       where id = $8
       returning id, name, handle, status, kind, description, posting_policy, privacy_level, join_policy, created_at`,
      [name, handle, description, postingPolicy, privacyLevel, joinPolicy, status, conversationId],
    );
    await pool.query(
      `insert into veritas_moderation_events (id, actor_id, conversation_id, action, note)
       values ($1, $2, $3, 'update_conversation', 'conversation settings updated')`,
      [crypto.randomUUID(), actorId, conversationId],
    );
    const { rows: countRows } = await pool.query(
      `select count(*)::int as member_count from veritas_participants where conversation_id = $1`,
      [conversationId],
    );
    return toConversation({ ...rows[0], my_role: role, member_count: countRows[0]?.member_count ?? 1 });
  } catch (error) {
    if (error.code === '23505') {
      error.status = 409;
      error.message = 'Đường dẫn này đã được dùng.';
    }
    throw error;
  }
}

async function listAiModels(userId) {
  if (!pool) {
    return memory.aiModels.filter((model) => model.ownerId === userId).map(toAiModel);
  }
  const { rows } = await pool.query(
    `select id, owner_id, user_id, conversation_id, name, avatar_url, provider, model_name, privacy,
       system_prompt, api_key_hint, enabled, created_at, updated_at
     from veritas_ai_models
     where owner_id = $1
     order by created_at desc`,
    [userId],
  );
  return rows.map(toAiModel);
}

async function getAiModelForConversation(conversationId, ownerId) {
  if (!pool) {
    const conversation = memory.conversations.find((item) => item.id === conversationId && item.isAi);
    if (!conversation) return null;
    return memory.aiModels.find((model) => model.id === conversation.aiModelId && model.ownerId === ownerId) ?? null;
  }
  const { rows } = await pool.query(
    `select m.*
     from veritas_ai_models m
     join veritas_conversations c on c.ai_model_id = m.id
     where c.id = $1 and m.owner_id = $2 and c.is_ai = true
     limit 1`,
    [conversationId, ownerId],
  );
  return rows[0] ?? null;
}

async function createAiModel(input, ownerId) {
  const name = String(input?.name ?? '').trim().slice(0, 80);
  const systemPrompt = normalizeAiPrompt(input?.systemPrompt ?? input?.prompt);
  const apiKey = String(input?.apiKey ?? '').trim();
  const provider = normalizeAiProvider(input?.provider);
  const modelName = normalizeAiModelName(input?.modelName);
  const privacy = normalizeAiPrivacy(input?.privacy);
  const avatarUrl = String(input?.avatarUrl ?? '').trim().slice(0, 500);
  validateAiInput({ name, systemPrompt, apiKey, modelName, requireApiKey: true });
  await validateOpenRouterModel({ apiKey, modelName, systemPrompt });

  const aiUserId = crypto.randomUUID();
  const modelId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const handle = makeAiHandle(name);
  const model = {
    id: modelId,
    ownerId,
    userId: aiUserId,
    conversationId,
    name,
    avatarUrl,
    provider,
    modelName,
    privacy,
    systemPrompt,
    apiKeyCiphertext: encryptSecret(apiKey),
    apiKeyHint: secretHint(apiKey),
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const conversation = {
    id: conversationId,
    peerId: aiUserId,
    name,
    handle,
    avatarUrl,
    status: '',
    kind: 'private',
    isAi: true,
    aiModelId: modelId,
    aiPrivacy: privacy,
    unread: 0,
    myRole: 'owner',
    memberCount: 2,
    lastMessage: '',
    lastMessageAt: null,
    messages: [],
    participants: [{ id: ownerId, role: 'owner' }, { id: aiUserId, role: 'member' }],
  };

  if (!pool) {
    memory.users.push({
      id: aiUserId,
      displayName: name,
      handle,
      avatarUrl,
      bio: systemPrompt.slice(0, 180),
      privacyLevel: 'balanced',
      plan: 'free',
      lastSeen: new Date().toISOString(),
      isAi: true,
    });
    memory.aiModels.unshift(model);
    memory.conversations.unshift(conversation);
    return { model: toAiModel(model), conversation };
  }

  await pool.query('begin');
  try {
    await pool.query(
      `insert into veritas_users (id, display_name, handle, avatar_url, bio)
       values ($1, $2, $3, $4, $5)`,
      [aiUserId, name, handle, avatarUrl, systemPrompt.slice(0, 180)],
    );
    await pool.query(
      `insert into veritas_conversations (id, name, handle, status, kind, is_ai)
       values ($1, $2, $3, '', 'private', true)`,
      [conversationId, name, handle],
    );
    await pool.query(
      `insert into veritas_participants (conversation_id, user_id, role)
       values ($1, $2, 'owner'), ($1, $3, 'member')`,
      [conversationId, ownerId, aiUserId],
    );
    await pool.query(
      `insert into veritas_ai_models
        (id, owner_id, user_id, conversation_id, name, avatar_url, provider, model_name,
         privacy, system_prompt, api_key_ciphertext, api_key_hint)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [modelId, ownerId, aiUserId, conversationId, name, avatarUrl, provider, modelName, privacy, systemPrompt, model.apiKeyCiphertext, model.apiKeyHint],
    );
    await pool.query(
      `update veritas_conversations set ai_model_id = $1 where id = $2`,
      [modelId, conversationId],
    );
    await pool.query('commit');
  } catch (error) {
    await pool.query('rollback');
    throw error;
  }
  return { model: toAiModel(model), conversation };
}

async function updateAiModel(modelId, input, ownerId) {
  const name = Object.prototype.hasOwnProperty.call(input ?? {}, 'name')
    ? String(input?.name ?? '').trim().slice(0, 80)
    : null;
  const systemPrompt = Object.prototype.hasOwnProperty.call(input ?? {}, 'systemPrompt') || Object.prototype.hasOwnProperty.call(input ?? {}, 'prompt')
    ? normalizeAiPrompt(input?.systemPrompt ?? input?.prompt)
    : null;
  const provider = Object.prototype.hasOwnProperty.call(input ?? {}, 'provider') ? normalizeAiProvider(input?.provider) : null;
  const modelName = Object.prototype.hasOwnProperty.call(input ?? {}, 'modelName') ? normalizeAiModelName(input?.modelName) : null;
  const privacy = Object.prototype.hasOwnProperty.call(input ?? {}, 'privacy') ? normalizeAiPrivacy(input?.privacy) : null;
  const avatarUrl = Object.prototype.hasOwnProperty.call(input ?? {}, 'avatarUrl') ? String(input?.avatarUrl ?? '').trim().slice(0, 500) : null;
  const enabled = Object.prototype.hasOwnProperty.call(input ?? {}, 'enabled') ? input?.enabled !== false : null;
  const apiKey = String(input?.apiKey ?? '').trim();
  if (name !== null && name.length < 2) {
    const error = new Error('Tên AI phải có ít nhất 2 ký tự.');
    error.status = 400;
    throw error;
  }
  if (systemPrompt !== null && systemPrompt.length < 6) {
    const error = new Error('Lời nhắc AI quá ngắn. Hãy mô tả cách AI nên trả lời.');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const model = memory.aiModels.find((item) => item.id === modelId && item.ownerId === ownerId);
    if (!model) {
      const error = new Error('Không tìm thấy mô hình AI');
      error.status = 404;
      throw error;
    }
    if (name !== null) model.name = name;
    if (systemPrompt !== null) model.systemPrompt = systemPrompt;
    if (provider !== null) model.provider = provider;
    if (modelName !== null) model.modelName = modelName;
    if (privacy !== null) model.privacy = privacy;
    if (avatarUrl !== null) model.avatarUrl = avatarUrl;
    if (enabled !== null) model.enabled = enabled;
    if (apiKey) {
      model.apiKeyCiphertext = encryptSecret(apiKey);
      model.apiKeyHint = secretHint(apiKey);
    }
    model.updatedAt = new Date().toISOString();
    const user = memory.users.find((item) => item.id === model.userId);
    if (user) {
      if (name !== null) user.displayName = name;
      if (avatarUrl !== null) user.avatarUrl = avatarUrl;
      if (systemPrompt !== null) user.bio = systemPrompt.slice(0, 180);
    }
    const conversation = memory.conversations.find((item) => item.id === model.conversationId);
    if (conversation) {
      if (name !== null) conversation.name = name;
      if (avatarUrl !== null) conversation.avatarUrl = avatarUrl;
      if (privacy !== null) conversation.aiPrivacy = privacy;
    }
    return { model: toAiModel(model), conversation: conversation ? toConversation(conversation) : null };
  }

  const { rows: existingRows } = await pool.query(
    `select * from veritas_ai_models where id = $1 and owner_id = $2 limit 1`,
    [modelId, ownerId],
  );
  const existing = existingRows[0];
  if (!existing) {
    const error = new Error('Không tìm thấy mô hình AI');
    error.status = 404;
    throw error;
  }

  const next = {
    name: name ?? existing.name,
    avatarUrl: avatarUrl ?? existing.avatar_url,
    provider: provider ?? existing.provider,
    modelName: modelName ?? existing.model_name,
    privacy: privacy ?? existing.privacy ?? 'private',
    systemPrompt: systemPrompt ?? existing.system_prompt,
    apiKeyCiphertext: apiKey ? encryptSecret(apiKey) : existing.api_key_ciphertext,
    apiKeyHint: apiKey ? secretHint(apiKey) : existing.api_key_hint,
    enabled: enabled ?? existing.enabled,
  };
  validateAiInput({
    name: next.name,
    systemPrompt: next.systemPrompt,
    apiKey: apiKey || decryptSecret(existing.api_key_ciphertext),
    modelName: next.modelName,
    requireApiKey: true,
  });
  if (apiKey || modelName !== null || systemPrompt !== null) {
    await validateOpenRouterModel({
      apiKey: apiKey || decryptSecret(existing.api_key_ciphertext),
      modelName: next.modelName,
      systemPrompt: next.systemPrompt,
    });
  }

  await pool.query('begin');
  try {
    const { rows } = await pool.query(
      `update veritas_ai_models
       set name = $1, avatar_url = $2, provider = $3, model_name = $4, privacy = $5,
           system_prompt = $6, api_key_ciphertext = $7, api_key_hint = $8,
           enabled = $9, updated_at = now()
       where id = $10 and owner_id = $11
       returning id, owner_id, user_id, conversation_id, name, avatar_url, provider, model_name,
         privacy, system_prompt, api_key_hint, enabled, created_at, updated_at`,
      [next.name, next.avatarUrl, next.provider, next.modelName, next.privacy, next.systemPrompt, next.apiKeyCiphertext, next.apiKeyHint, next.enabled, modelId, ownerId],
    );
    await pool.query(
      `update veritas_users
       set display_name = $1, avatar_url = $2, bio = $3
       where id = $4`,
      [next.name, next.avatarUrl, next.systemPrompt.slice(0, 180), existing.user_id],
    );
    await pool.query(
      `update veritas_conversations
       set name = $1
       where id = $2`,
      [next.name, existing.conversation_id],
    );
    await pool.query('commit');
    const conversation = await getConversations(ownerId).then((items) => items.find((item) => item.id === existing.conversation_id) ?? null);
    return { model: toAiModel(rows[0]), conversation };
  } catch (error) {
    await pool.query('rollback');
    throw error;
  }
}

async function deleteAiModel(modelId, ownerId) {
  if (!pool) {
    const model = memory.aiModels.find((item) => item.id === modelId && item.ownerId === ownerId);
    if (!model) {
      const error = new Error('Không tìm thấy mô hình AI');
      error.status = 404;
      throw error;
    }
    memory.aiModels = memory.aiModels.filter((item) => item.id !== modelId);
    memory.conversations = memory.conversations.filter((item) => item.id !== model.conversationId);
    memory.users = memory.users.filter((item) => item.id !== model.userId);
    return { ok: true, conversationId: model.conversationId, modelId };
  }
  const { rows } = await pool.query(
    `select id, user_id, conversation_id from veritas_ai_models where id = $1 and owner_id = $2 limit 1`,
    [modelId, ownerId],
  );
  const model = rows[0];
  if (!model) {
    const error = new Error('Không tìm thấy mô hình AI');
    error.status = 404;
    throw error;
  }
  await pool.query('begin');
  try {
    await pool.query(`delete from veritas_conversations where id = $1`, [model.conversation_id]);
    await pool.query(`delete from veritas_users where id = $1`, [model.user_id]);
    await pool.query('commit');
  } catch (error) {
    await pool.query('rollback');
    throw error;
  }
  return { ok: true, conversationId: model.conversation_id, modelId };
}

async function generateOpenRouterReply({ apiKey, modelName, systemPrompt, messages }) {
  if (aiMockProviderEnabled) {
    const latestUserMessage = [...messages].reverse().find((message) => message.senderId !== message.aiUserId);
    return `Mock AI reply: ${latestUserMessage?.text || 'OK'}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': publicAppUrl,
        'X-Title': 'Veritas',
      },
      body: JSON.stringify({
        model: modelName || defaultAiModelName,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((message) => ({
            role: message.senderId === message.aiUserId ? 'assistant' : 'user',
            content: message.text || '',
          })),
        ],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(openRouterErrorMessage(response.status, data?.error?.message || data?.message));
      error.status = response.status;
      throw error;
    }
    return String(data?.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function validateOpenRouterModel({ apiKey, modelName, systemPrompt }) {
  if (aiMockProviderEnabled) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': publicAppUrl,
        'X-Title': 'Veritas',
      },
      body: JSON.stringify({
        model: modelName || defaultAiModelName,
        messages: [
          { role: 'system', content: systemPrompt || 'You are a concise assistant.' },
          { role: 'user', content: 'Reply with OK.' },
        ],
        max_tokens: 8,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(openRouterErrorMessage(response.status, data?.error?.message || data?.message));
      error.status = response.status;
      throw error;
    }
    const content = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!content && !data?.choices?.length) {
      const error = new Error('Khóa/mô hình OpenRouter hợp lệ nhưng không trả nội dung kiểm tra. Hãy thử mô hình khác.');
      error.status = 400;
      throw error;
    }
    return true;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Kiểm tra OpenRouter quá lâu. Hãy thử lại hoặc đổi mô hình.');
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function insertAiMessage(conversationId, aiUserId, text) {
  if (!pool) {
    const conversation = memory.conversations.find((item) => item.id === conversationId);
    const user = memory.users.find((item) => item.id === aiUserId);
    const message = {
      id: crypto.randomUUID(),
      conversationId,
      sender: 'them',
      senderId: aiUserId,
      senderName: user?.displayName || 'Mô hình AI',
      senderAvatarUrl: user?.avatarUrl || '',
      text,
      attachments: [],
      verdict: 'safe',
      read: false,
      createdAt: new Date().toISOString(),
      replyTo: null,
    };
    conversation?.messages.push(message);
    return message;
  }
  const { rows } = await pool.query(
    `insert into veritas_messages (id, conversation_id, sender_id, body, verdict, read_state)
     values ($1, $2, $3, $4, 'safe', 'sent')
     returning *`,
    [crypto.randomUUID(), conversationId, aiUserId, text],
  );
  return getMessageByIdForUser(rows[0].id, aiUserId).then((message) => message ?? toMessage(rows[0], ''));
}

async function replyFromAiModel(conversationId, ownerId) {
  const model = await getAiModelForConversation(conversationId, ownerId);
  if (!model || model.enabled === false) return;
  const aiUserId = model.user_id ?? model.userId;
  const apiKey = decryptSecret(model.api_key_ciphertext ?? model.apiKeyCiphertext);
  if (!apiKey) return;
  const history = await getMessages(conversationId, ownerId, { limit: 20 });
  const messages = history
    .filter((message) => message.text && message.verdict !== 'limited')
    .map((message) => ({ ...message, aiUserId }));
  let replyText = '';
  try {
    replyText = await generateOpenRouterReply({
      apiKey,
      modelName: model.model_name ?? model.modelName,
      systemPrompt: model.system_prompt ?? model.systemPrompt,
      messages,
    });
  } catch (error) {
    replyText = `AI tam dung: ${error.message}`;
  }
  if (!replyText) replyText = 'Mô hình chưa có phản hồi.';
  const message = await insertAiMessage(conversationId, aiUserId, replyText.slice(0, 12000));
  broadcast({
    type: 'message.created',
    message,
    participantIds: await getConversationParticipantIds(conversationId),
  });
}

async function createMessage(conversationId, body, userId, input = {}) {
  const role = await requireConversationAccess(conversationId, userId);
  if (role === 'reader') {
    const error = new Error('Kênh công khai chỉ cho chủ sở hữu/quản trị viên đăng tin');
    error.status = 403;
    throw error;
  }
  const conversationPolicy = pool
    ? (await pool.query(`select kind, posting_policy from veritas_conversations where id = $1`, [conversationId])).rows[0]
    : memory.conversations.find((conversation) => conversation.id === conversationId);
  if (conversationPolicy && normalizePostingPolicy(conversationPolicy.posting_policy ?? conversationPolicy.postingPolicy, conversationPolicy.kind) === 'admins' && !['owner', 'admin'].includes(role)) {
    const error = new Error('Kênh chỉ cho chủ sở hữu/quản trị viên đăng tin');
    error.status = 403;
    throw error;
  }
  if (pool) {
    const { rows: blockedRows } = await pool.query(
      `select 1
       from veritas_conversations c
       join veritas_participants p on p.conversation_id = c.id and p.user_id <> $2
       join veritas_blocks b on b.blocker_id = p.user_id and b.blocked_id = $2
       where c.id = $1 and c.kind = 'private'
       limit 1`,
      [conversationId, userId],
    );
    if (blockedRows.length) {
      const error = new Error('Người nhận đã chặn bạn');
      error.status = 403;
      throw error;
    }
  }
  const attachments = normalizeAttachments(input?.attachments);
  const verdict = classifyMessage(body);
  if (verdict === 'empty' && attachments.length === 0) {
    const error = new Error('Tin nhắn không được rỗng');
    error.status = 400;
    throw error;
  }
  const replyToMessageId = input?.replyToMessageId || null;
  if (replyToMessageId && pool) {
    const { rows: replyRows } = await pool.query(
      `select id from veritas_messages where id = $1 and conversation_id = $2 and deleted_at is null`,
      [replyToMessageId, conversationId],
    );
    if (!replyRows[0]) {
      const error = new Error('Không tìm thấy tin để trả lời');
      error.status = 404;
      throw error;
    }
  }

  if (!pool) {
    const conversation = memory.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      const error = new Error('Không tìm thấy hội thoại');
      error.status = 404;
      throw error;
    }
    const user = memory.users.find((item) => item.id === userId) ?? memory.users[0];
    const message = {
      id: crypto.randomUUID(),
      conversationId,
      sender: 'me',
      senderId: user.id,
      senderName: user.displayName,
      text: body.trim(),
      attachments,
      verdict,
      read: verdict !== 'limited',
      createdAt: new Date().toISOString(),
      replyTo: null,
    };
    conversation.messages.push(message);
    return message;
  }

  const { rows } = await pool.query(
    `insert into veritas_messages
      (id, conversation_id, sender_id, body, verdict, read_state, reply_to_message_id, attachments)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     returning *`,
    [
      crypto.randomUUID(),
      conversationId,
      userId,
      body.trim() || (attachments.length ? 'Đã gửi tệp đính kèm' : ''),
      verdict === 'empty' ? 'safe' : verdict,
      verdict === 'limited' ? 'sent' : 'read',
      replyToMessageId,
      JSON.stringify(attachments),
    ],
  );
  await pool.query(
    `insert into veritas_message_reads (message_id, user_id)
     values ($1, $2)
     on conflict do nothing`,
    [rows[0].id, userId],
  );
  const [message] = await getMessages(conversationId, userId).then((messages) => messages.filter((item) => item.id === rows[0].id));
  return message ?? toMessage(rows[0], userId);
}

async function getParticipants(conversationId) {
  if (!pool) {
    return memory.conversations.find((conversation) => conversation.id === conversationId)?.participants ?? [];
  }
  const { rows } = await pool.query(
    `select u.id, u.display_name, u.handle, u.avatar_url, u.bio, u.privacy_level, u.plan, u.last_seen, p.role
     from veritas_participants p
     join veritas_users u on u.id = p.user_id
     where p.conversation_id = $1
     order by case p.role when 'owner' then 1 when 'admin' then 2 else 3 end, u.display_name`,
    [conversationId],
  );
  return rows.map((row) => ({ ...toUser(row), role: row.role }));
}

async function listJoinRequests(conversationId, actorId) {
  await requireManager(conversationId, actorId);
  if (!pool) {
    return memory.joinRequests
      .filter((request) => request.conversationId === conversationId && request.status === 'pending')
      .map((request) => {
        const user = memory.users.find((item) => item.id === request.userId);
        return {
          ...request,
          user: user ? publicUser(user) : { id: request.userId, displayName: 'User', handle: '' },
        };
      });
  }

  const { rows } = await pool.query(
    `select jr.id, jr.conversation_id, jr.user_id, jr.status, jr.created_at,
            u.display_name, u.handle, u.avatar_url, u.bio, u.privacy_level, u.plan, u.last_seen
     from veritas_join_requests jr
     join veritas_users u on u.id = jr.user_id
     where jr.conversation_id = $1
       and jr.status = 'pending'
     order by jr.created_at asc
     limit 50`,
    [conversationId],
  );
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    user: publicUser(row),
  }));
}

async function resolveJoinRequest(conversationId, requestId, action, actorId) {
  await requireManager(conversationId, actorId);
  const nextStatus = action === 'approve' ? 'approved' : 'declined';

  if (!pool) {
    const request = memory.joinRequests.find((item) =>
      item.id === requestId && item.conversationId === conversationId && item.status === 'pending',
    );
    if (!request) {
      const error = new Error('Không tìm thấy yêu cầu tham gia');
      error.status = 404;
      throw error;
    }
    request.status = nextStatus;
    request.resolvedAt = new Date().toISOString();
    request.resolvedBy = actorId;
    const conversation = memory.conversations.find((item) => item.id === conversationId);
    if (nextStatus === 'approved' && conversation && !conversation.participants.some((participant) => (participant.id ?? participant.userId) === request.userId)) {
      conversation.participants.push({ id: request.userId, role: 'member' });
    }
    memory.moderationEvents.unshift({
      id: crypto.randomUUID(),
      actorId,
      conversationId,
      action: nextStatus === 'approved' ? 'approve_join_request' : 'decline_join_request',
      createdAt: new Date().toISOString(),
    });
    return { ok: true, conversationId, userId: request.userId, action };
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `update veritas_join_requests
       set status = $1, resolved_at = now(), resolved_by = $2
       where id = $3
         and conversation_id = $4
         and status = 'pending'
       returning user_id`,
      [nextStatus, actorId, requestId, conversationId],
    );
    const request = rows[0];
    if (!request) {
      const error = new Error('Không tìm thấy yêu cầu tham gia');
      error.status = 404;
      throw error;
    }
    if (nextStatus === 'approved') {
      await client.query(
        `insert into veritas_participants (conversation_id, user_id, role)
         values ($1, $2, 'member')
         on conflict (conversation_id, user_id) do nothing`,
        [conversationId, request.user_id],
      );
    }
    const eventId = crypto.randomUUID();
    await client.query(
      `insert into veritas_moderation_events (id, actor_id, conversation_id, action, note)
       values ($1, $2, $3, $4, $5)`,
      [
        eventId,
        actorId,
        conversationId,
        nextStatus === 'approved' ? 'approve_join_request' : 'decline_join_request',
        nextStatus === 'approved' ? 'approved join request' : 'declined join request',
      ],
    );
    await client.query('commit');
    return { ok: true, conversationId, userId: request.user_id, action, eventId };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function getConversationParticipantIds(conversationId) {
  if (!pool) {
    const conversation = memory.conversations.find((item) => item.id === conversationId);
    return (conversation?.participants ?? []).map((participant) => participant.id ?? participant.userId).filter(Boolean);
  }
  const { rows } = await pool.query(
    `select user_id from veritas_participants where conversation_id = $1`,
    [conversationId],
  );
  return rows.map((row) => row.user_id);
}

async function getUserRealtimeAudienceIds(userId) {
  if (!pool) {
    const ids = new Set([userId]);
    for (const conversation of memory.conversations) {
      if (!(conversation.participants ?? []).some((participant) => (participant.id ?? participant.userId) === userId)) continue;
      for (const participant of conversation.participants ?? []) ids.add(participant.id ?? participant.userId);
    }
    return [...ids].filter(Boolean);
  }
  const { rows } = await pool.query(
    `select distinct p2.user_id
     from veritas_participants p1
     join veritas_participants p2 on p2.conversation_id = p1.conversation_id
     where p1.user_id = $1`,
    [userId],
  );
  return [...new Set([userId, ...rows.map((row) => row.user_id)])];
}

async function inviteParticipant(conversationId, input, actorId) {
  await requireManager(conversationId, actorId);
  const handle = normalizeHandle(input?.handle);
  const role = input?.role === 'admin' ? 'admin' : 'member';
  if (!handle) {
    const error = new Error('Đường dẫn là bắt buộc');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const user = memory.users.find((item) => item.handle === handle);
    if (!user) {
      const error = new Error('Không tìm thấy người dùng');
      error.status = 404;
      throw error;
    }
    const conversation = memory.conversations.find((item) => item.id === conversationId);
    conversation.participants.push({ ...toUser(user), role });
    return { ...toUser(user), role };
  }

  const { rows } = await pool.query(`select id, display_name, handle from veritas_users where handle = $1`, [handle]);
  const user = rows[0];
  if (!user) {
    const error = new Error('Không tìm thấy người dùng');
    error.status = 404;
    throw error;
  }
  await pool.query(
    `insert into veritas_participants (conversation_id, user_id, role)
     values ($1, $2, $3)
     on conflict (conversation_id, user_id) do update set role = excluded.role`,
    [conversationId, user.id, role],
  );
  return { ...toUser(user), role };
}

async function getModerationQueue(userId) {
  if (!pool) {
    return memory.conversations.flatMap((conversation) =>
      conversation.messages
        .filter((message) => message.verdict !== 'safe')
        .map((message) => ({ ...message, conversationName: conversation.name })),
    );
  }

  const { rows } = await pool.query(
    `select m.*, u.display_name as sender_name, c.name as conversation_name
     from veritas_messages m
     join veritas_users u on u.id = m.sender_id
     join veritas_conversations c on c.id = m.conversation_id
     join veritas_participants p on p.conversation_id = c.id and p.user_id = $1
     where m.verdict in ('limited', 'sensitive') and p.role in ('owner', 'admin')
     order by m.created_at desc
     limit 30`,
    [userId],
  );
  return rows.map((row) => ({ ...toMessage(row, userId), conversationName: row.conversation_name }));
}

async function resolveModeration(messageId, action, actorId) {
  if (!pool) {
    let resolvedMessage = null;
    const eventId = crypto.randomUUID();
    for (const conversation of memory.conversations) {
      const message = conversation.messages.find((item) => item.id === messageId);
      if (!message) continue;
      message.verdict = action === 'approve' ? 'safe' : 'limited';
      message.read = action === 'approve';
      resolvedMessage = { ...message, conversationId: conversation.id, conversationName: conversation.name };
      break;
    }
    memory.moderationEvents.unshift({ id: eventId, actorId, messageId, action, conversationId: resolvedMessage?.conversationId, createdAt: new Date().toISOString() });
    return { ok: true, action, eventId, conversationId: resolvedMessage?.conversationId, message: resolvedMessage };
  }
  const { rows } = await pool.query(`select conversation_id from veritas_messages where id = $1`, [messageId]);
  if (!rows[0]) {
    const error = new Error('Không tìm thấy tin nhắn');
    error.status = 404;
    throw error;
  }
  await requireManager(rows[0].conversation_id, actorId);
  const verdict = action === 'approve' ? 'safe' : 'limited';
  const readState = action === 'approve' ? 'read' : 'sent';
  const { rows: updatedRows } = await pool.query(
    `update veritas_messages set verdict = $1, read_state = $2 where id = $3 returning *`,
    [verdict, readState, messageId],
  );
  const eventId = crypto.randomUUID();
  await pool.query(
    `insert into veritas_moderation_events (id, actor_id, conversation_id, message_id, action, note)
     values ($1, $2, $3, $4, $5, $6)`,
    [eventId, actorId, rows[0].conversation_id, messageId, action, action === 'approve' ? 'approved limited message' : 'kept limited message'],
  );
  const { rows: messageRows } = await pool.query(
    `select m.*, u.display_name as sender_name, u.avatar_url as sender_avatar_url
     from veritas_messages m
     join veritas_users u on u.id = m.sender_id
     where m.id = $1`,
    [messageId],
  );
  return {
    ok: true,
    action,
    eventId,
    conversationId: rows[0].conversation_id,
    message: messageRows[0] ? toMessage(messageRows[0], actorId) : toMessage(updatedRows[0], actorId),
  };
}

async function canManageMessage(conversationId, userId) {
  const role = await getParticipantRole(conversationId, userId);
  return ['owner', 'admin'].includes(role);
}

async function updateMessage(messageId, input, actorId) {
  const text = String(input?.text ?? '').trim();
  if (!text) {
    const error = new Error('Tin nhắn không được rỗng');
    error.status = 400;
    throw error;
  }
  if (!pool) return { ok: true };
  const { rows } = await pool.query(`select * from veritas_messages where id = $1 and deleted_at is null`, [messageId]);
  const message = rows[0];
  if (!message) {
    const error = new Error('Không tìm thấy tin nhắn');
    error.status = 404;
    throw error;
  }
  await requireConversationAccess(message.conversation_id, actorId);
  if (message.sender_id !== actorId) {
    const error = new Error('Chỉ người gửi mới được sửa tin');
    error.status = 403;
    throw error;
  }
  const verdict = classifyMessage(text);
  if (verdict === 'empty') {
    const error = new Error('Tin nhắn không được rỗng');
    error.status = 400;
    throw error;
  }
  const { rows: updatedRows } = await pool.query(
    `update veritas_messages
     set body = $1, verdict = $2, read_state = $3, edited_at = now()
     where id = $4
     returning *`,
    [text, verdict === 'empty' ? 'safe' : verdict, verdict === 'limited' ? 'sent' : 'read', messageId],
  );
  await pool.query(
    `insert into veritas_moderation_events (id, actor_id, conversation_id, message_id, action, note)
     values ($1, $2, $3, $4, 'edit_message', 'message edited')`,
    [crypto.randomUUID(), actorId, message.conversation_id, messageId],
  );
  const updated = await getMessageByIdForUser(messageId, actorId);
  return updated ?? toMessage(updatedRows[0], actorId);
}

async function deleteMessage(messageId, actorId) {
  if (!pool) return { ok: true };
  const { rows } = await pool.query(`select * from veritas_messages where id = $1 and deleted_at is null`, [messageId]);
  const message = rows[0];
  if (!message) {
    const error = new Error('Không tìm thấy tin nhắn');
    error.status = 404;
    throw error;
  }
  await requireConversationAccess(message.conversation_id, actorId);
  const manager = await canManageMessage(message.conversation_id, actorId);
  if (message.sender_id !== actorId && !manager) {
    const error = new Error('Bạn không có quyền xóa tin này');
    error.status = 403;
    throw error;
  }
  await pool.query(
    `insert into veritas_moderation_events (id, actor_id, conversation_id, message_id, action, note)
     values ($1, $2, $3, $4, 'delete_message', $5)`,
    [crypto.randomUUID(), actorId, message.conversation_id, messageId, manager && message.sender_id !== actorId ? 'deleted by manager' : 'deleted by sender'],
  );
  await pool.query(`delete from veritas_messages where id = $1`, [messageId]);
  return { ok: true, conversationId: message.conversation_id, messageId };
}

function toggleReactionState(target, emoji) {
  const reactions = { ...(target.reactions ?? {}) };
  const previous = target.myReaction ?? '';
  if (previous) {
    reactions[previous] = Math.max(0, Number(reactions[previous] ?? 1) - 1);
    if (!reactions[previous]) delete reactions[previous];
  }
  if (previous === emoji) return { reactions, myReaction: '' };
  reactions[emoji] = Number(reactions[emoji] ?? 0) + 1;
  return { reactions, myReaction: emoji };
}

async function setMessageReaction(messageId, actorId, input = {}) {
  const emoji = String(input.emoji ?? '').trim();
  const attachmentId = String(input.attachmentId ?? '').trim();
  if (!emoji || emoji.length > 16) {
    const error = new Error('Cảm xúc không hợp lệ');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    for (const conversation of memory.conversations) {
      const message = conversation.messages.find((item) => item.id === messageId);
      if (!message) continue;
      await requireConversationAccess(conversation.id, actorId);
      if (!attachmentId) {
        Object.assign(message, toggleReactionState(message, emoji));
        return message;
      }
      const attachment = (message.attachments ?? []).find((item) => String(item.id || item.url || '') === attachmentId);
      if (!attachment) {
        const error = new Error('Không tìm thấy tệp đa phương tiện để thả cảm xúc');
        error.status = 404;
        throw error;
      }
      Object.assign(attachment, toggleReactionState(attachment, emoji));
      return message;
    }
    const error = new Error('Không tìm thấy tin nhắn');
    error.status = 404;
    throw error;
  }

  const { rows } = await pool.query(
    `select id, conversation_id, attachments from veritas_messages where id = $1 and deleted_at is null`,
    [messageId],
  );
  const message = rows[0];
  if (!message) {
    const error = new Error('Không tìm thấy tin nhắn');
    error.status = 404;
    throw error;
  }
  await requireConversationAccess(message.conversation_id, actorId);

  if (attachmentId) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const exists = attachments.some((attachment) => String(attachment.id || attachment.url || '') === attachmentId);
    if (!exists) {
      const error = new Error('Không tìm thấy tệp đa phương tiện để thả cảm xúc');
      error.status = 404;
      throw error;
    }
  }

  const { rows: existingRows } = await pool.query(
    `select emoji from veritas_message_reactions
     where message_id = $1 and user_id = $2 and attachment_id = $3`,
    [messageId, actorId, attachmentId],
  );
  if (existingRows[0]?.emoji === emoji) {
    await pool.query(
      `delete from veritas_message_reactions
       where message_id = $1 and user_id = $2 and attachment_id = $3`,
      [messageId, actorId, attachmentId],
    );
  } else {
    await pool.query(
      `insert into veritas_message_reactions (message_id, user_id, attachment_id, emoji)
       values ($1, $2, $3, $4)
       on conflict (message_id, user_id, attachment_id)
       do update set emoji = excluded.emoji, created_at = now()`,
      [messageId, actorId, attachmentId, emoji],
    );
  }

  const updated = await getMessageByIdForUser(messageId, actorId);
  return updated ?? toMessage(message, actorId);
}

async function createReport(input, reporterId) {
  const messageId = input?.messageId || null;
  const targetUserId = input?.targetUserId || null;
  const reason = String(input?.reason ?? 'other').trim().slice(0, 120) || 'other';
  let conversationId = input?.conversationId || null;

  if (messageId && pool) {
    const { rows } = await pool.query(`select conversation_id, sender_id from veritas_messages where id = $1`, [messageId]);
    if (!rows[0]) {
      const error = new Error('Không tìm thấy tin nhắn để báo cáo');
      error.status = 404;
      throw error;
    }
    conversationId = rows[0].conversation_id;
    await requireConversationAccess(conversationId, reporterId);
  } else if (conversationId) {
    await requireConversationAccess(conversationId, reporterId);
  }

  if (!pool) {
    const report = { id: crypto.randomUUID(), reporterId, targetUserId, messageId, conversationId, reason, status: 'open', createdAt: new Date().toISOString() };
    memory.reports.unshift(report);
    return report;
  }

  const { rows } = await pool.query(
    `insert into veritas_reports (id, reporter_id, target_user_id, message_id, conversation_id, reason)
     values ($1, $2, $3, $4, $5, $6)
     returning id, reporter_id, target_user_id, message_id, conversation_id, reason, status, created_at`,
    [crypto.randomUUID(), reporterId, targetUserId, messageId, conversationId, reason],
  );
  return {
    id: rows[0].id,
    reporterId: rows[0].reporter_id,
    targetUserId: rows[0].target_user_id,
    messageId: rows[0].message_id,
    conversationId: rows[0].conversation_id,
    reason: rows[0].reason,
    status: rows[0].status,
    createdAt: rows[0].created_at,
  };
}

function normalizeSupportText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function isSupportAdmin(user) {
  const configured = String(process.env.SUPPORT_ADMIN_HANDLES ?? '@admin,@veritas_admin')
    .split(',')
    .map((item) => normalizeHandle(item))
    .filter(Boolean);
  return configured.includes(normalizeHandle(user?.handle));
}

async function createSupportRequest(input, userId) {
  const category = normalizeSupportText(input?.category || 'other', 40) || 'other';
  const subject = normalizeSupportText(input?.subject, 120);
  const body = normalizeSupportText(input?.body, 1800);
  const contact = normalizeSupportText(input?.contact, 120);

  if (!subject || !body) {
    const error = new Error('Nhập tiêu đề và nội dung hỗ trợ');
    error.status = 400;
    throw error;
  }

  if (!pool) {
    const request = {
      id: crypto.randomUUID(),
      userId,
      category,
      subject,
      body,
      contact,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    memory.supportRequests.unshift(request);
    return request;
  }

  const { rows } = await pool.query(
    `insert into veritas_support_requests (id, user_id, category, subject, body, contact)
     values ($1, $2, $3, $4, $5, $6)
     returning id, user_id, category, subject, body, contact, status, created_at, updated_at`,
    [crypto.randomUUID(), userId, category, subject, body, contact],
  );
  return {
    id: rows[0].id,
    userId: rows[0].user_id,
    category: rows[0].category,
    subject: rows[0].subject,
    body: rows[0].body,
    contact: rows[0].contact,
    status: rows[0].status,
    createdAt: rows[0].created_at,
    updatedAt: rows[0].updated_at,
  };
}

async function listSupportRequests(user) {
  if (!isSupportAdmin(user)) {
    const error = new Error('Chỉ tài khoản quản trị viên mới xem được đơn hỗ trợ');
    error.status = 403;
    throw error;
  }
  if (!pool) return memory.supportRequests.slice(0, 50);
  const { rows } = await pool.query(
    `select s.id, s.user_id, s.category, s.subject, s.body, s.contact, s.status, s.created_at, s.updated_at,
            u.display_name, u.handle
     from veritas_support_requests s
     join veritas_users u on u.id = s.user_id
     order by s.created_at desc
     limit 50`,
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    category: row.category,
    subject: row.subject,
    body: row.body,
    contact: row.contact,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: {
      id: row.user_id,
      displayName: row.display_name,
      handle: row.handle,
    },
  }));
}

async function cleanupLaunchTestData(user) {
  if (!isSupportAdmin(user)) {
    const error = new Error('Chỉ quản trị viên mới được dọn dữ liệu thử nghiệm');
    error.status = 403;
    throw error;
  }

  if (!pool) {
    const testUsers = memory.users.filter((item) =>
      /^@launch_[ab]_\d+$/i.test(item.handle ?? '') || /^veritas\.[ab]\.\d+@test\.local$/i.test(item.email ?? ''),
    );
    const testUserIds = new Set(testUsers.map((item) => item.id));
    const beforeConversations = memory.conversations.length;
    memory.conversations = memory.conversations.filter(
      (conversation) => !conversation.participants.some((participant) => testUserIds.has(participant.id || participant.userId)),
    );
    memory.users = memory.users.filter((item) => !testUserIds.has(item.id));
    memory.sessions = memory.sessions.filter((item) => !testUserIds.has(item.userId));
    return {
      ok: true,
      usersDeleted: testUsers.length,
      conversationsDeleted: beforeConversations - memory.conversations.length,
    };
  }

  const { rows: userRows } = await pool.query(
    `select id from veritas_users
     where handle ~ '^@launch_[ab]_[0-9]+$'
        or email ~ '^veritas\\.[ab]\\.[0-9]+@test\\.local$'`,
  );
  const userIds = userRows.map((row) => row.id);
  if (!userIds.length) return { ok: true, usersDeleted: 0, conversationsDeleted: 0 };

  const { rows: conversationRows } = await pool.query(
    `select distinct conversation_id as id
     from veritas_participants
     where user_id = any($1::uuid[])`,
    [userIds],
  );
  const conversationIds = conversationRows.map((row) => row.id);
  if (conversationIds.length) {
    await pool.query(`delete from veritas_conversations where id = any($1::uuid[])`, [conversationIds]);
  }
  await pool.query(`delete from veritas_users where id = any($1::uuid[])`, [userIds]);
  return {
    ok: true,
    usersDeleted: userIds.length,
    conversationsDeleted: conversationIds.length,
  };
}

async function blockUser(blockerId, blockedId) {
  if (!blockedId || blockedId === blockerId) {
    const error = new Error('Không thể chặn người dùng này');
    error.status = 400;
    throw error;
  }
  if (!pool) {
    if (!memory.blocks.some((item) => item.blockerId === blockerId && item.blockedId === blockedId)) {
      memory.blocks.push({ blockerId, blockedId, createdAt: new Date().toISOString() });
    }
    return { ok: true };
  }
  await pool.query(
    `insert into veritas_blocks (blocker_id, blocked_id)
     values ($1, $2)
     on conflict do nothing`,
    [blockerId, blockedId],
  );
  return { ok: true };
}

async function unblockUser(blockerId, blockedId) {
  if (!pool) {
    memory.blocks = memory.blocks.filter((item) => !(item.blockerId === blockerId && item.blockedId === blockedId));
    return { ok: true };
  }
  await pool.query(`delete from veritas_blocks where blocker_id = $1 and blocked_id = $2`, [blockerId, blockedId]);
  return { ok: true };
}

async function listBlocks(userId) {
  if (!pool) {
    return memory.blocks
      .filter((item) => item.blockerId === userId)
      .map((item) => ({ ...item, user: toUser(memory.users.find((user) => user.id === item.blockedId) ?? { id: item.blockedId, displayName: 'User', handle: '@user' }) }));
  }
  const { rows } = await pool.query(
    `select b.blocked_id, b.created_at, u.display_name, u.handle
     from veritas_blocks b
     join veritas_users u on u.id = b.blocked_id
     where b.blocker_id = $1
     order by b.created_at desc`,
    [userId],
  );
  return rows.map((row) => ({
    blockedId: row.blocked_id,
    createdAt: row.created_at,
    user: toUser({ id: row.blocked_id, display_name: row.display_name, handle: row.handle }),
  }));
}

async function listModerationAudit(userId) {
  if (!pool) return memory.moderationEvents.slice(0, 20);
  const { rows } = await pool.query(
    `select e.*, u.display_name as actor_name, c.name as conversation_name
     from veritas_moderation_events e
     join veritas_users u on u.id = e.actor_id
     join veritas_participants p on p.conversation_id = e.conversation_id and p.user_id = $1
     left join veritas_conversations c on c.id = e.conversation_id
     where p.role in ('owner', 'admin')
     order by e.created_at desc
     limit 30`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    actorName: row.actor_name,
    conversationName: row.conversation_name,
    messageId: row.message_id,
    action: row.action,
    note: row.note,
    createdAt: row.created_at,
  }));
}

const app = express();
app.use((_request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  next();
});
app.options('*', (_request, response) => response.sendStatus(204));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir));

app.get('/api/health', async (_request, response) => {
  try {
    if (pool) await pool.query('select 1');
    response.json({
      ok: true,
      database: pool ? 'supabase-postgres' : 'memory',
      auth: jwtAccessSecret && jwtRefreshSecret ? 'jwt-ready' : 'jwt-missing',
    });
  } catch (error) {
    response.status(503).json({ ok: false, database: 'error', message: error.message });
  }
});

app.get('/api/readiness', async (_request, response) => {
  const checks = {
    database: false,
    jwtAccess: Boolean(jwtAccessSecret),
    jwtRefresh: Boolean(jwtRefreshSecret),
  };
  try {
    if (pool) {
      await pool.query('select 1');
      checks.database = true;
    } else {
      checks.database = true;
    }
  } catch {
    checks.database = false;
  }
  const ok = Object.values(checks).every(Boolean);
  response.status(ok ? 200 : 503).json({ ok, checks });
});

app.post('/api/auth/register', async (request, response, next) => {
  try {
    if (!canUseDirectRegister(request.body)) {
      throw httpError('Email verification is required to create an account', 403, 'AUTH_VERIFICATION_REQUIRED');
    }
    const user = await registerUser(request.body);
    response.status(201).json(await createAuthSession(user, request));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register/request-code', async (request, response, next) => {
  try {
    response.json(await requestRegisterCode(request.body));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register/verify', async (request, response, next) => {
  try {
    const user = await verifyRegisterCode(request.body);
    response.status(201).json(await createAuthSession(user, request));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/email-status', async (request, response, next) => {
  try {
    response.json(await checkAuthEmail(request.body));
  } catch (error) {
    next(error);
  }
});

app.post('/api/dev/email-code', async (request, response, next) => {
  try {
    response.json(getCapturedVerificationEmail(request.body));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/password/request-code', async (request, response, next) => {
  try {
    response.json(await requestPasswordResetCode(request.body));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/password/verify', async (request, response, next) => {
  try {
    const user = await verifyPasswordResetCode(request.body);
    response.json(await createAuthSession(user, request));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const user = await loginUser(request.body);
    response.json(await createAuthSession(user, request));
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/refresh', async (request, response, next) => {
  try {
    const { payload } = await verifyRefreshSession(request.body?.refreshToken);
    const user = await getUser(payload.sub);
    if (!user) {
      const error = new Error('Người dùng không còn tồn tại');
      error.status = 401;
      throw error;
    }
    await revokeSession(payload.jti, payload.sub);
    response.json(await createAuthSession(user, request));
  } catch (error) {
    error.status = 401;
    next(error);
  }
});

app.post('/api/auth/logout', async (request, response, next) => {
  try {
    response.json(await revokeRefreshToken(request.body?.refreshToken));
  } catch (error) {
    next(error);
  }
});

app.get(['/u/:handle', '/@:handle'], async (request, response, next) => {
  try {
    const user = await getPublicUserByHandle(request.params.handle);
    if (!user) {
      response.status(404).send('<!doctype html><meta charset="utf-8"><title>Veritas</title><h1>Contact not found</h1>');
      return;
    }

    const displayName = user.displayName || user.handle;
    const handle = user.handle || '';
    const title = `${displayName} on Veritas`;
    const description = user.bio || `Open a Veritas conversation with ${displayName}.`;
    const avatarUrl = absoluteUrl(request, user.avatarUrl);
    const pageUrl = absoluteUrl(request, request.originalUrl);
    const openUrl = `${publicAppUrl}/?contact=${encodeURIComponent(handle.replace(/^@/, ''))}`;
    response.type('html').send(renderVeritasSharePage({
      title,
      description,
      pageUrl,
      openUrl,
      avatarUrl,
      name: displayName,
      handle,
      label: 'Liên hệ Veritas',
      cta: 'Message on Veritas',
      secondaryCta: 'Share this contact',
      verified: user.isExtra,
      ogType: 'profile',
    }));
  } catch (error) {
    next(error);
  }
});

app.get('/c/:handle', async (request, response, next) => {
  try {
    const conversation = await getPublicConversationByHandle(request.params.handle);
    if (!conversation) {
      response.status(404).send('<!doctype html><meta charset="utf-8"><title>Veritas</title><h1>Community not found</h1>');
      return;
    }

    const title = `${conversation.name} on Veritas`;
    const typeLabel = conversation.kind === 'channel' ? 'channel' : 'community';
    const audienceLabel = conversation.kind === 'channel'
      ? `follower${conversation.memberCount === 1 ? '' : 's'}`
      : `member${conversation.memberCount === 1 ? '' : 's'}`;
    const description = conversation.description || `${conversation.kind === 'channel' ? 'Follow' : 'Join'} ${conversation.name}, a Veritas ${typeLabel} with ${conversation.memberCount || 1} ${audienceLabel}.`;
    const pageUrl = absoluteUrl(request, request.originalUrl);
    const openUrl = `${publicAppUrl}/?chat=${encodeURIComponent(conversation.handle)}`;

    response.type('html').send(renderVeritasSharePage({
      title,
      description,
      pageUrl,
      openUrl,
      name: conversation.name,
      handle: conversation.handle,
      label: conversation.kind === 'channel' ? 'Kênh Veritas' : 'Cộng đồng Veritas',
      cta: conversation.kind === 'channel' ? 'Follow channel' : 'Join community',
      secondaryCta: conversation.kind === 'channel' ? 'Share this channel' : 'Share this community',
      ogType: 'website',
    }));
  } catch (error) {
    next(error);
  }
});

app.use('/api', authMiddleware);

app.post('/api/uploads', (request, response, next) => {
  upload.array('file', 4)(request, response, async (error) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        const messages = {
          LIMIT_FILE_SIZE: 'File qua lon. Gioi han moi file la 25 MB.',
          LIMIT_FILE_COUNT: 'Chỉ gửi tối đa 4 tệp một lần.',
          LIMIT_UNEXPECTED_FILE: 'Tệp đính kèm không hợp lệ.',
        };
        response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
          error: messages[error.code] ?? 'Tải lên không hợp lệ.',
          errorCode: inferErrorCode(error),
        });
        return;
      }
      next(error);
      return;
    }
    const files = request.files ?? [];
    if (!files.length) {
      response.status(400).json({ error: 'Chưa chọn tệp để tải lên', errorCode: 'UPLOAD_FILE_REQUIRED' });
      return;
    }
    try {
      const attachments = await Promise.all(files.map((file) => toUploadedAttachment(file, request)));
      response.status(201).json(attachments);
    } catch (uploadError) {
      next(uploadError);
    }
  });
});

app.get('/api/me', async (request, response, next) => {
  try {
    response.json(request.user);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/me', async (request, response, next) => {
  try {
    const user = await updateProfile(request.user.id, request.body);
    broadcast({ type: 'user.updated', user, actorId: request.user.id, participantIds: await getUserRealtimeAudienceIds(request.user.id) });
    response.json(user);
  } catch (error) {
    next(error);
  }
});

app.post('/api/me/plan', async (request, response, next) => {
  try {
    const user = await updateUserPlan(request.user.id, request.body?.plan);
    broadcast({ type: 'user.updated', user, actorId: request.user.id, participantIds: await getUserRealtimeAudienceIds(request.user.id) });
    response.json(user);
  } catch (error) {
    next(error);
  }
});

app.post('/api/presence', async (request, response, next) => {
  try {
    const result = await touchPresence(request.user.id);
    await broadcastPresence(request.user, true);
    response.json({ ...result, online: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/sessions', async (request, response, next) => {
  try {
    response.json(await listSessions(request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions/revoke-all', async (request, response, next) => {
  try {
    response.json(await revokeAllSessions(request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions/:id/revoke', async (request, response, next) => {
  try {
    response.json(await revokeSession(request.params.id, request.user.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/blocks', async (request, response, next) => {
  try {
    response.json(await listBlocks(request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/blocks', async (request, response, next) => {
  try {
    response.status(201).json(await blockUser(request.user.id, request.body?.blockedId));
  } catch (error) {
    next(error);
  }
});

app.post('/api/blocks/:id/unblock', async (request, response, next) => {
  try {
    response.json(await unblockUser(request.user.id, request.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/ai-models', async (request, response, next) => {
  try {
    response.json(await listAiModels(request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/ai-models', async (request, response, next) => {
  try {
    const result = await createAiModel(request.body, request.user.id);
    broadcast({
      type: 'conversation.created',
      conversationId: result.conversation.id,
      participantIds: await getConversationParticipantIds(result.conversation.id),
      creatorId: request.user.id,
    });
    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/ai-models/:id', async (request, response, next) => {
  try {
    const result = await updateAiModel(request.params.id, request.body, request.user.id);
    if (result.conversation) {
      broadcast({
        type: 'conversation.updated',
        conversation: result.conversation,
        conversationId: result.conversation.id,
        participantIds: await getConversationParticipantIds(result.conversation.id),
      });
    }
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/ai-models/:id', async (request, response, next) => {
  try {
    const result = await deleteAiModel(request.params.id, request.user.id);
    broadcast({
      type: 'conversation.deleted',
      conversationId: result.conversationId,
      participantIds: [request.user.id],
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/reports', async (request, response, next) => {
  try {
    response.status(201).json(await createReport(request.body, request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/support-requests', async (request, response, next) => {
  try {
    response.status(201).json(await createSupportRequest(request.body, request.user.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/support-requests', async (request, response, next) => {
  try {
    response.json(await listSupportRequests(request.user));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/launch-test-data', async (request, response, next) => {
  try {
    response.json(await cleanupLaunchTestData(request.user));
  } catch (error) {
    next(error);
  }
});

app.get('/api/moderation/audit', async (request, response, next) => {
  try {
    response.json(await listModerationAudit(request.user.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations', async (request, response, next) => {
  try {
    response.json(await getConversations(request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations', async (request, response, next) => {
  try {
    const conversation = await createConversation(request.body, request.user.id);
    broadcast({
      type: 'conversation.created',
      conversationId: conversation.id,
      participantIds: await getConversationParticipantIds(conversation.id),
      creatorId: request.user.id,
    });
    response.status(201).json(conversation);
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/private', async (request, response, next) => {
  try {
    const conversation = await createPrivateConversation(String(request.body?.userId ?? ''), request.user.id);
    broadcast({
      type: 'conversation.created',
      conversationId: conversation.id,
      participantIds: await getConversationParticipantIds(conversation.id),
      creatorId: request.user.id,
    });
    response.status(201).json(conversation);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/conversations/:id/draft', async (request, response, next) => {
  try {
    response.json(await deletePrivateDraftConversation(request.params.id, request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/join', async (request, response, next) => {
  try {
    const conversation = await joinConversation(request.body, request.user.id);
    if (conversation.joinStatus === 'pending') {
      broadcast({
        type: 'join_request.created',
        conversationId: conversation.id,
        participantIds: await getConversationParticipantIds(conversation.id),
        userId: request.user.id,
      });
    } else {
      broadcast({
        type: 'participant.added',
        conversationId: conversation.id,
        participantIds: await getConversationParticipantIds(conversation.id),
        userId: request.user.id,
      });
    }
    response.json(conversation);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/conversations/:id', async (request, response, next) => {
  try {
    const conversation = await updateConversation(request.params.id, request.body, request.user.id);
    broadcast({
      type: 'conversation.updated',
      conversation,
      conversationId: conversation.id,
      participantIds: await getConversationParticipantIds(conversation.id),
    });
    response.json(conversation);
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations/:id/messages', async (request, response, next) => {
  try {
    response.json(await getMessages(request.params.id, request.user.id, {
      markRead: request.query.read === '1',
      before: request.query.before,
      limit: request.query.limit,
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/messages', async (request, response, next) => {
  try {
    const message = await createMessage(request.params.id, request.body?.text ?? '', request.user.id, request.body);
    if (message.verdict !== 'limited') {
      broadcast({
        type: 'message.created',
        message,
        participantIds: await getConversationParticipantIds(request.params.id),
      });
    }
    response.status(201).json(message);
    if (message.verdict !== 'limited') {
      replyFromAiModel(request.params.id, request.user.id).catch((error) => {
        console.error('AI reply failed:', error.message);
      });
    }
  } catch (error) {
    next(error);
  }
});

app.patch('/api/messages/:id', async (request, response, next) => {
  try {
    const message = await updateMessage(request.params.id, request.body, request.user.id);
    if (message.verdict !== 'limited') {
      broadcast({
        type: 'message.updated',
        message,
        participantIds: await getConversationParticipantIds(message.conversationId),
      });
    }
    response.json(message);
  } catch (error) {
    next(error);
  }
});

app.put('/api/messages/:id/reaction', async (request, response, next) => {
  try {
    const message = await setMessageReaction(request.params.id, request.user.id, request.body);
    broadcast({
      type: 'message.updated',
      message,
      participantIds: await getConversationParticipantIds(message.conversationId),
    });
    response.json(message);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/messages/:id', async (request, response, next) => {
  try {
    const result = await deleteMessage(request.params.id, request.user.id);
    broadcast({
      type: 'message.deleted',
      conversationId: result.conversationId,
      messageId: result.messageId,
      participantIds: await getConversationParticipantIds(result.conversationId),
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations/:id/participants', async (request, response, next) => {
  try {
    await requireConversationAccess(request.params.id, request.user.id);
    response.json(await getParticipants(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations/:id/join-requests', async (request, response, next) => {
  try {
    response.json(await listJoinRequests(request.params.id, request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/join-requests/:requestId/resolve', async (request, response, next) => {
  try {
    const result = await resolveJoinRequest(request.params.id, request.params.requestId, request.body?.action, request.user.id);
    broadcast({
      type: 'join_request.resolved',
      conversationId: request.params.id,
      participantIds: [...new Set([...(await getConversationParticipantIds(request.params.id)), result.userId])],
      userId: result.userId,
      action: result.action,
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:id/participants', async (request, response, next) => {
  try {
    const participant = await inviteParticipant(request.params.id, request.body, request.user.id);
    broadcast({
      type: 'participant.added',
      conversationId: request.params.id,
      participant,
      participantIds: await getConversationParticipantIds(request.params.id),
    });
    response.status(201).json(participant);
  } catch (error) {
    next(error);
  }
});

app.get('/api/messages/search', async (request, response, next) => {
  try {
    response.json(await searchMessages(String(request.query.q ?? ''), request.user.id, String(request.query.conversationId ?? '')));
  } catch (error) {
    next(error);
  }
});

app.get('/api/users/search', async (request, response, next) => {
  try {
    response.json(await searchUsers(String(request.query.q ?? ''), request.user.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/moderation/queue', async (request, response, next) => {
  try {
    response.json(await getModerationQueue(request.user.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/moderation/:messageId/resolve', async (request, response, next) => {
  try {
    const result = await resolveModeration(request.params.messageId, request.body?.action, request.user.id);
    const conversationId = result.message?.conversationId || result.conversationId;
    if (conversationId) {
      broadcast({
        type: 'moderation.resolved',
        messageId: request.params.messageId,
        conversationId,
        action: result.action,
        eventId: result.eventId,
        actorName: request.user.displayName,
        participantIds: await getConversationParticipantIds(conversationId),
      });
    }
    if (result.action === 'approve' && result.message?.conversationId) {
      broadcast({
        type: 'message.created',
        message: result.message,
        participantIds: await getConversationParticipantIds(result.message.conversationId),
      });
    }
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  response.status(error.status ?? 500).json({
    error: error.message ?? 'Lỗi máy chủ',
    errorCode: inferErrorCode(error),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(payload) {
  const participantIds = Array.isArray(payload.participantIds) ? new Set(payload.participantIds) : null;
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (participantIds && !participantIds.has(client.user?.id)) continue;
    try {
      const message = payload.message?.senderId
        ? {
            ...payload.message,
            sender: payload.message.senderId === client.user?.id ? 'me' : 'them',
          }
        : payload.message;
      const data = JSON.stringify(message === payload.message ? payload : { ...payload, message });
      client.send(data);
    } catch {
      client.close();
    }
  }
}

async function broadcastPresence(user, online) {
  if (!user?.id) return;
  const audienceIds = await getUserRealtimeAudienceIds(user.id);
  const lastSeen = new Date().toISOString();
  broadcast({
    type: 'presence.updated',
    user: publicUser({ ...user, lastSeen, last_seen: lastSeen, isOnline: online }),
    online,
    lastSeen,
    participantIds: audienceIds,
  });
}

async function markRealtimeOnline(socket, user) {
  let entry = realtimePresence.get(user.id);
  if (!entry) {
    entry = { sockets: new Set(), offlineTimer: null };
    realtimePresence.set(user.id, entry);
  }
  const wasOnline = entry.sockets.size > 0;
  entry.sockets.add(socket);
  if (entry.offlineTimer) {
    clearTimeout(entry.offlineTimer);
    entry.offlineTimer = null;
  }
  await touchPresence(user.id);
  if (!wasOnline) await broadcastPresence(user, true);
}

function markRealtimeOffline(socket, user) {
  const entry = realtimePresence.get(user.id);
  if (!entry) return;
  entry.sockets.delete(socket);
  if (entry.sockets.size > 0) return;
  if (entry.offlineTimer) clearTimeout(entry.offlineTimer);
  entry.offlineTimer = setTimeout(async () => {
    const latest = realtimePresence.get(user.id);
    if (!latest || latest.sockets.size > 0) return;
    realtimePresence.delete(user.id);
    await touchPresence(user.id);
    await broadcastPresence(user, false);
  }, presenceOfflineDelayMs);
}

wss.on('connection', async (socket, request) => {
  let user = null;
  try {
    user = await verifyRealtimeUser(tokenFromUrl(request));
  } catch {
    user = null;
  }
  if (!user?.id) {
    socket.close(1008, 'Unauthorized');
    return;
  }

  socket.user = user;
  await markRealtimeOnline(socket, user);
  socket.send(JSON.stringify({ type: 'connection.ready', userId: user.id }));
  socket.on('message', async (data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (payload.type === 'presence.ping') {
        await touchPresence(user.id);
        return;
      }
      if (payload.type === 'typing' && payload.conversationId) {
        const participantIds = await getConversationParticipantIds(payload.conversationId);
        if (!participantIds.includes(user.id)) return;
        broadcast({
          type: 'typing',
          conversationId: payload.conversationId,
          user: {
            id: user.id,
            displayName: user.displayName,
            handle: user.handle,
            avatarUrl: user.avatarUrl ?? '',
            plan: user.plan ?? 'free',
            isExtra: user.isExtra === true,
          },
          participantIds,
          at: new Date().toISOString(),
        });
      }
      if (payload.type === 'typing.stop' && payload.conversationId) {
        const participantIds = await getConversationParticipantIds(payload.conversationId);
        if (!participantIds.includes(user.id)) return;
        broadcast({
          type: 'typing.stop',
          conversationId: payload.conversationId,
          user: {
            id: user.id,
            displayName: user.displayName,
            handle: user.handle,
          },
          participantIds,
          at: new Date().toISOString(),
        });
      }
    } catch {
      // Ignore malformed realtime hints; API routes remain the source of truth.
    }
  });
  socket.on('close', () => markRealtimeOffline(socket, user));
});

export async function startVeritasServer(options = {}) {
  const listenPort = Number(options.port ?? port);
  await initializeDatabase();
  return new Promise((resolve, reject) => {
    function handleError(error) {
      reject(error);
    }
    server.once('error', handleError);
    server.listen(listenPort, () => {
      server.off('error', handleError);
      console.log(`Veritas API listening on http://localhost:${listenPort}`);
      resolve({ server, wss, port: listenPort });
    });
  });
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) {
  startVeritasServer().catch((error) => {
    console.error('Failed to start Veritas API:', error);
    process.exit(1);
  });
}
