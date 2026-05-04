import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.JOIN_POLICY_SMOKE_PORT || 8790);
const apiUrl = `http://localhost:${port}`;
const password = process.env.SMOKE_PASSWORD || 'VeritasJoin123!';
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

async function register(label) {
  return json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `veritas.join.${label}.${stamp}@test.local`,
      displayName: `Join ${label} ${stamp}`,
      handle: `join_${label}_${stamp}`,
      password,
    }),
  });
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

async function runJoinPolicyChecks() {
  const owner = await register('owner');
  const member = await register('member');

  const approval = await json('/api/conversations', {
    method: 'POST',
    headers: auth(owner.accessToken),
    body: JSON.stringify({
      kind: 'group',
      name: `Approval Community ${stamp}`,
      handle: `approval-${stamp}`,
      privacyLevel: 'public',
      joinPolicy: 'approval',
    }),
  });
  assert(approval.joinPolicy === 'approval', 'Approval community did not persist joinPolicy');

  const joinPending = await json('/api/conversations/join', {
    method: 'POST',
    headers: auth(member.accessToken),
    body: JSON.stringify({ conversationId: approval.id }),
  });
  assert(joinPending.joinStatus === 'pending', 'Approval join did not return pending');

  const blockedMessages = await request(`/api/conversations/${approval.id}/messages`, {
    headers: auth(member.accessToken),
  });
  assert(blockedMessages.response.status === 403, 'Pending member should not read messages before approval');

  const requests = await json(`/api/conversations/${approval.id}/join-requests`, {
    headers: auth(owner.accessToken),
  });
  assert(requests.length === 1, 'Owner did not see pending join request');
  assert(requests[0].userId === member.user.id, 'Pending request user mismatch');

  await json(`/api/conversations/${approval.id}/join-requests/${requests[0].id}/resolve`, {
    method: 'POST',
    headers: auth(owner.accessToken),
    body: JSON.stringify({ action: 'approve' }),
  });

  const memberMessages = await json(`/api/conversations/${approval.id}/messages`, {
    headers: auth(member.accessToken),
  });
  assert(Array.isArray(memberMessages), 'Approved member cannot read messages');

  const open = await json('/api/conversations', {
    method: 'POST',
    headers: auth(owner.accessToken),
    body: JSON.stringify({
      kind: 'channel',
      name: `Open Channel ${stamp}`,
      handle: `@open-${stamp}`,
      privacyLevel: 'public',
      joinPolicy: 'open',
    }),
  });
  assert(open.joinPolicy === 'open', 'Open channel did not persist joinPolicy');

  const joinOpen = await json('/api/conversations/join', {
    method: 'POST',
    headers: auth(member.accessToken),
    body: JSON.stringify({ conversationId: open.id }),
  });
  assert(joinOpen.joinStatus !== 'pending', 'Open channel incorrectly returned pending');
  assert(joinOpen.myRole === 'member', 'Open channel did not add member');

  return {
    approval: {
      conversationId: approval.id,
      pendingRequestsBeforeApproval: requests.length,
    },
    open: {
      conversationId: open.id,
      role: joinOpen.myRole,
    },
  };
}

async function main() {
  const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'veritas-join-policy-'));
  const server = spawn(process.execPath, [path.resolve('server/index.js')], {
    cwd: tempCwd,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'join-policy-smoke-access-secret',
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'join-policy-smoke-refresh-secret',
      DATABASE_URL: '',
      SUPABASE_URL: '',
      SUPABASE_PUBLISHABLE_KEY: '',
      VITE_SUPABASE_ANON_KEY: '',
      VERITAS_ALLOW_DIRECT_REGISTER: 'true',
      VERITAS_KEEP_DEMO_DATA: 'false',
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
    const checks = await runJoinPolicyChecks();
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
  console.error(`Join policy smoke failed: ${error.message}`);
  process.exit(1);
});
