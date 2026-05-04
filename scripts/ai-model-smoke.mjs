import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.AI_MODEL_SMOKE_PORT || 8792);
const apiUrl = `http://localhost:${port}`;
const password = process.env.SMOKE_PASSWORD || 'VeritasAi123!';
const stamp = Date.now();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(apiPath, options = {}) {
  const response = await fetch(`${apiUrl}${apiPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { response, data };
}

async function json(apiPath, options = {}) {
  const { response, data } = await request(apiPath, options);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${apiPath} ${response.status}: ${data.error || response.statusText}`);
  }
  return data;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function waitForHealth(timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await json('/api/health');
      if (health.ok !== false) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`Server did not become healthy on ${apiUrl}`);
}

async function waitForAiReply(conversationId, token, prompt, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const messages = await json(`/api/conversations/${conversationId}/messages?read=1`, {
      headers: auth(token),
    });
    const reply = messages.find((message) => message.text === `Mock AI reply: ${prompt}`);
    if (reply) return reply;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('AI model did not write the expected mock reply');
}

async function runAiModelChecks() {
  const owner = await json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `veritas.ai.${stamp}@test.local`,
      displayName: `AI Owner ${stamp}`,
      handle: `ai_owner_${stamp}`,
      password,
    }),
  });

  const created = await json('/api/ai-models', {
    method: 'POST',
    headers: auth(owner.accessToken),
    body: JSON.stringify({
      name: `Smoke AI ${stamp}`,
      modelName: 'mock/provider-free',
      apiKey: `mock-openrouter-key-${stamp}`,
      systemPrompt: 'Answer briefly for automated smoke checks.',
      privacy: 'private',
    }),
  });
  assert(created.model?.id, 'AI model create response is missing model id');
  assert(created.conversation?.id, 'AI model create response is missing conversation id');
  assert(created.model.apiKeyHint && !created.model.apiKeyHint.includes(String(stamp)), 'AI API key hint leaked too much of the key');

  const models = await json('/api/ai-models', { headers: auth(owner.accessToken) });
  assert(models.some((model) => model.id === created.model.id), 'Created AI model is not listed');

  const prompt = `smoke prompt ${stamp}`;
  const userMessage = await json(`/api/conversations/${created.conversation.id}/messages`, {
    method: 'POST',
    headers: auth(owner.accessToken),
    body: JSON.stringify({ text: prompt }),
  });
  assert(userMessage.text === prompt, 'User message to AI was not created');

  const aiReply = await waitForAiReply(created.conversation.id, owner.accessToken, prompt);
  assert(aiReply.senderId !== owner.user.id, 'AI reply was written as the owner');

  return {
    modelId: created.model.id,
    conversationId: created.conversation.id,
    reply: aiReply.text,
  };
}

async function main() {
  const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'veritas-ai-model-'));
  const server = spawn(process.execPath, [path.resolve('server/index.js')], {
    cwd: tempCwd,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'ai-model-smoke-access-secret',
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'ai-model-smoke-refresh-secret',
      DATABASE_URL: '',
      SUPABASE_URL: '',
      SUPABASE_PUBLISHABLE_KEY: '',
      VITE_SUPABASE_ANON_KEY: '',
      VERITAS_ALLOW_DIRECT_REGISTER: 'true',
      VERITAS_KEEP_DEMO_DATA: 'false',
      VERITAS_AI_MOCK: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  server.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth();
    const checks = await runAiModelChecks();
    console.log(JSON.stringify({ ok: true, api: apiUrl, checks }, null, 2));
  } catch (error) {
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    throw error;
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('close', resolve));
    await fs.rm(tempCwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`AI model smoke failed: ${error.message}`);
  process.exit(1);
});
