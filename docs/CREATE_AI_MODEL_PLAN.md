# Kế hoạch tính năng Create AI Model

## Mục tiêu

Cho phép người dùng tạo một AI model/cog cá nhân chỉ bằng:

- Tên model.
- Avatar.
- Prompt hệ thống mô tả tính cách, vai trò, giới hạn.
- API key của nhà cung cấp AI.

Sau khi tạo, model xuất hiện như một liên hệ/hội thoại trong Veritas. Người dùng có thể mở chat và nói chuyện với model như với một người dùng bình thường.

## Trải nghiệm người dùng

1. Người dùng bấm `Tạo mới` trong sidebar.
2. Modal có thêm lựa chọn `AI Model` bên cạnh `Cộng đồng` và `Kênh`.
3. Form AI Model gồm:
   - `Tên model`.
   - `Avatar` với upload ảnh, tái dùng `/api/uploads`.
   - `Prompt` dạng textarea.
   - `Provider` mặc định `OpenAI`, chuẩn bị mở rộng cho provider khác.
   - `API key`, nhập dạng password, có cảnh báo key được mã hóa và chỉ dùng server-side.
4. Sau khi lưu:
   - Backend tạo bản ghi model.
   - Backend tạo hoặc trả về một private conversation giữa user và model.
   - Sidebar hiển thị model như một chat riêng, có badge `AI`.
5. Khi user gửi tin trong conversation AI:
   - Tin user được lưu như hiện tại.
   - Server gọi provider AI bằng API key đã lưu mã hóa.
   - Phản hồi AI được lưu thành message mới trong cùng conversation.
   - WebSocket broadcast để UI nhận phản hồi realtime.

## Phạm vi MVP

- Mỗi AI model thuộc về đúng một owner.
- Model chỉ nói chuyện với owner ở MVP.
- Hỗ trợ text-only trước; attachment và voice để giai đoạn sau.
- API key không bao giờ gửi lại frontend sau khi lưu.
- Prompt có giới hạn độ dài, ví dụ 8.000 ký tự.
- Có nút sửa model: đổi tên, avatar, prompt, provider, thay API key.
- Có nút tắt/bật model để ngừng gọi provider khi cần.

## Thiết kế dữ liệu

Thêm bảng `veritas_ai_models`:

```sql
create table if not exists veritas_ai_models (
  id uuid primary key,
  owner_id uuid not null references veritas_users(id) on delete cascade,
  conversation_id uuid references veritas_conversations(id) on delete set null,
  name text not null,
  avatar_url text not null default '',
  provider text not null default 'openai',
  model_name text not null default 'gpt-4o-mini',
  system_prompt text not null,
  api_key_ciphertext text not null,
  api_key_hint text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists veritas_ai_models_owner_idx
  on veritas_ai_models (owner_id, created_at desc);
```

Thêm cột vào `veritas_conversations`:

```sql
alter table veritas_conversations
  add column if not exists ai_model_id uuid references veritas_ai_models(id) on delete set null;

alter table veritas_conversations
  add column if not exists is_ai boolean not null default false;
```

Memory fallback trong `server/index.js` cần thêm `aiModels: []`.

## Bảo mật API key

- Thêm biến môi trường `AI_KEY_ENCRYPTION_SECRET`.
- Dùng AES-256-GCM để mã hóa key trước khi lưu database.
- Lưu `api_key_hint` dạng `sk-...abcd` hoặc 4 ký tự cuối để người dùng nhận biết.
- Endpoint list/detail chỉ trả `api_key_hint`, không trả ciphertext.
- Log server không ghi prompt đầy đủ kèm API key, không ghi request provider raw.
- Nếu thiếu `AI_KEY_ENCRYPTION_SECRET`, backend từ chối tạo AI model trong production.

## Backend API

Thêm các endpoint sau sau `authMiddleware`:

- `GET /api/ai-models`
  - Liệt kê model của user.
- `POST /api/ai-models`
  - Body: `name`, `avatarUrl`, `systemPrompt`, `provider`, `modelName`, `apiKey`.
  - Tạo AI model và conversation private dạng `is_ai = true`.
- `PATCH /api/ai-models/:id`
  - Sửa tên, avatar, prompt, provider/model, enabled, hoặc thay API key.
- `DELETE /api/ai-models/:id`
  - Xóa model, có thể soft-delete conversation hoặc giữ lịch sử tùy quyết định UX.
- `POST /api/ai-models/:id/conversation`
  - Mở lại conversation nếu cần.

Luồng gửi tin:

- Trong `createMessage(conversationId, text, userId, body)`, sau khi lưu message user:
  - Kiểm tra conversation có `is_ai` và `ai_model_id`.
  - Nếu có, enqueue/gọi `replyFromAiModel`.
  - Trả message user trước để UI không bị treo.
  - Khi AI trả lời, lưu message assistant và broadcast `message.created`.

## Provider adapter

Tạo module backend riêng, ví dụ `server/aiProviders.js`:

- `generateAiReply({ provider, modelName, apiKey, systemPrompt, messages })`.
- MVP hỗ trợ OpenAI Responses API hoặc Chat Completions tùy SDK/HTTP hiện dùng.
- Adapter nhận lịch sử hội thoại gần nhất, ví dụ 20 tin gần đây.
- Chuẩn hóa lỗi:
  - Key sai.
  - Hết quota.
  - Provider timeout.
  - Prompt quá dài.

Nếu chưa muốn thêm SDK, có thể dùng `fetch` server-side để giảm dependency.

## Frontend

Các file chính cần sửa:

- `src/Sidebar.jsx`
  - Thêm lựa chọn `AI Model` trong creator modal.
  - Khi `newChat.kind === 'ai'`, render form tên, avatar upload, prompt, provider, API key.
  - Hiển thị badge `AI` trong chat list.
- `src/main.jsx`
  - Mở rộng `newChat` state.
  - Thêm hàm `createAiModel`.
  - Tái dùng `uploadProfileAvatar` hoặc tách helper upload chung.
  - Nếu conversation trả về từ `/api/ai-models`, thêm vào `chats` và select.
- `src/ConversationHeader.jsx`
  - Hiển thị trạng thái `AI model` và avatar model.
- `src/Inspector.jsx`
  - Với chat AI, hiển thị prompt tóm tắt, provider, trạng thái enabled.
  - Nút chỉnh sửa model nếu user là owner.
- `src/styles.css`
  - Style cho tab `AI`, textarea prompt, input API key, badge AI.

## Trạng thái loading và lỗi

- Khi đang chờ AI trả lời, hiển thị typing indicator hoặc message tạm `Đang suy nghĩ...`.
- Nếu provider lỗi, lưu một system/error message nhẹ trong UI hoặc show notice:
  - `Model chưa phản hồi được. Kiểm tra API key hoặc quota.`
- Không retry tự động quá nhiều để tránh tốn tiền API.
- Có timeout backend, ví dụ 45 giây.

## Migration từng bước

1. Thêm schema và memory fallback.
2. Thêm encrypt/decrypt API key.
3. Thêm CRUD `/api/ai-models`.
4. Tạo conversation AI và đưa vào `getConversations`.
5. Hook gửi tin để gọi provider và lưu phản hồi.
6. Thêm UI creator AI trong sidebar.
7. Thêm badge/trạng thái AI trong chat list, header, inspector.
8. Hoàn tất smoke test tạo model và mock provider response bằng `npm run smoke:ai`.

## Tiêu chí hoàn thành

- User tạo được AI model bằng tên, avatar, prompt, API key.
- Model xuất hiện trong sidebar như một hội thoại.
- User gửi tin và nhận được phản hồi AI trong cùng conversation.
- Refresh trang vẫn thấy model và lịch sử chat.
- API key không bị trả về client.
- Xóa/tắt model khiến server không gọi provider nữa.
- Memory mode vẫn chạy được khi không có database.

## Giai đoạn sau MVP

- Chia sẻ model cho người khác chat.
- Cho phép nhiều provider: OpenAI, Anthropic, Gemini, OpenRouter.
- Cấu hình temperature, max tokens, persona presets.
- Knowledge files/RAG bằng upload tài liệu.
- Tool calling an toàn: web search, calculator, calendar, task.
- Thống kê token/cost theo model.
- Moderation riêng cho prompt và phản hồi AI.
