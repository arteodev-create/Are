# Veritas

Veritas là ứng dụng nhắn tin realtime với hồ sơ cá nhân, tin nhắn riêng, cộng đồng, kênh phát tin, chia sẻ profile, AI assistant riêng và upload tệp thật qua Cloudinary.

## Tính năng chính

- Frontend Vite + React, backend Node.js + Express, realtime WebSocket.
- Đăng ký, đăng nhập, refresh token rotation, quản lý phiên đăng nhập và thu hồi phiên.
- PostgreSQL/Supabase khi có `DATABASE_URL`; fallback memory cho dev/smoke test.
- Chat riêng, cộng đồng và kênh công khai.
- Phân quyền `owner`, `admin`, `member`; hàng đợi duyệt tham gia cho cộng đồng/kênh cần phê duyệt.
- Kênh và cộng đồng được tách rõ:
  - Kênh dùng cho phát tin, người theo dõi chỉ đọc, owner/admin đăng bài.
  - Cộng đồng dùng cho thảo luận, mọi thành viên đã tham gia có thể nhắn.
- Sidebar chia riêng Channels, Communities, Direct Messages và AI.
- Profile cá nhân có avatar, handle, bio, privacy và nút chia sẻ profile.
- Trang share web cho profile, kênh và cộng đồng, có CTA mở app và QR.
- Reply, edit, soft delete, read receipts, unread count, typing indicator và presence.
- Upload ảnh, video, audio, PDF; dùng Cloudinary khi có `CLOUDINARY_URL`, fallback local `/uploads` khi dev không cấu hình cloud.
- AI model cá nhân qua OpenRouter, khóa API được mã hóa server-side và có smoke test mock provider.
- PWA shell với manifest, icon và service worker cache cơ bản.
- Electron desktop và Capacitor Android scripts đã có trong `package.json`.

## Cấu hình

Tạo `.env.local` từ `.env.example`, sau đó điền secret thật. Không commit `.env.local`.

```bash
PORT=8787
DATABASE_URL=postgresql://USER:PASSWORD@HOST:6543/postgres?pgbouncer=true&connection_limit=10&schema=public
SUPABASE_URL=https://PROJECT_ID.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
JWT_ACCESS_SECRET=CHANGE_ME
JWT_REFRESH_SECRET=CHANGE_ME
VITE_API_URL=http://localhost:8787
VITE_WS_URL=ws://localhost:8787
CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
CLOUDINARY_UPLOAD_FOLDER=veritas/uploads
PUBLIC_APP_URL=http://localhost:5173
AI_KEY_ENCRYPTION_SECRET=CHANGE_ME
DEFAULT_AI_MODEL_NAME=poolside/laguna-xs.2:free
```

Ghi chú production:

- `CLOUDINARY_URL` bật storage thật cho attachment và avatar upload.
- `PUBLIC_APP_URL` phải là URL web app thật để link share mở đúng app.
- `AI_KEY_ENCRYPTION_SECRET` nên cố định và đủ mạnh trước khi tạo AI model thật.
- SMTP/Firebase trong `.env.example` phục vụ email/phone auth theo cấu hình dự án.
- Notification hiện là browser notification trong app; web push nền cần bổ sung VAPID hoặc provider push nếu muốn gửi khi app đóng.

## Chạy local

```bash
npm install
npm run dev:full
```

Web app:

```text
http://localhost:5173
```

API health:

```text
http://localhost:8787/api/health
```

## Kiểm tra

```bash
npm run build
npm run smoke
npm run smoke:join-policy
npm run smoke:ai
npm audit --omit=dev
```

`smoke:ai` dùng `VERITAS_AI_MOCK=true` trong server tạm, nên không gọi OpenRouter thật. Upload Cloudinary có thể kiểm tra bằng `/api/uploads` khi `.env.local` đã có `CLOUDINARY_URL`.

## Đóng gói

```bash
npm run desktop:pack
npm run mobile:sync
npm run mobile:apk
```

Android build cần Android SDK/Gradle local. Desktop build cần môi trường Windows phù hợp với Electron Builder.
