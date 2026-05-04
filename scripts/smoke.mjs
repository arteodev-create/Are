import { WebSocket } from 'ws';

const apiUrl = process.env.SMOKE_API_URL || 'http://localhost:8787';
const wsUrl = process.env.SMOKE_WS_URL || apiUrl.replace(/^http/, 'ws');
const password = process.env.SMOKE_PASSWORD || 'VeritasSmoke123!';
const accounts = {
  a: {
    email: process.env.SMOKE_A_EMAIL || 'veritas.smoke.a@test.local',
    displayName: 'Smoke Test A',
    handle: 'smoke_a',
    password,
  },
  b: {
    email: process.env.SMOKE_B_EMAIL || 'veritas.smoke.b@test.local',
    displayName: 'Smoke Test B',
    handle: 'smoke_b',
    password,
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
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

async function json(path, options = {}) {
  const { response, data } = await request(path, options);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} ${response.status}: ${data.error || response.statusText}`);
  }
  return data;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function registerOrLogin(account) {
  const register = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(account),
  });
  if (register.response.ok) return register.data;
  if (register.response.status !== 409) {
    throw new Error(`Register ${account.email} failed: ${register.data.error || register.response.statusText}`);
  }
  return json('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
}

function connectRealtime(token, label) {
  const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`${label} realtime connect timeout`));
    }, 5000);
    function onMessage(raw) {
      const event = JSON.parse(raw.toString());
      if (event.type !== 'connection.ready') return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(socket);
    }
    socket.once('error', reject);
    socket.once('open', () => {
      socket.on('message', onMessage);
    });
  });
}

function waitFor(socket, predicate, label, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timeout waiting for ${label}`));
    }, timeout);
    function onMessage(raw) {
      const event = JSON.parse(raw.toString());
      if (!predicate(event)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(event);
    }
    socket.on('message', onMessage);
  });
}

async function main() {
  const health = await json('/api/health');
  const readiness = await json('/api/readiness');
  assert(health.ok !== false, 'API health is not OK');
  assert(readiness.ok === true, 'API readiness is not OK');

  const a = await registerOrLogin(accounts.a);
  const b = await registerOrLogin(accounts.b);
  assert(a.accessToken && a.refreshToken && a.user?.id, 'Account A auth payload is invalid');
  assert(b.accessToken && b.refreshToken && b.user?.id, 'Account B auth payload is invalid');

  const refreshedA = await json('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: a.refreshToken }),
  });
  assert(refreshedA.accessToken && refreshedA.refreshToken, 'Refresh token flow failed');
  const aToken = refreshedA.accessToken;
  const bToken = b.accessToken;

  const wsA = await connectRealtime(aToken, 'A');
  const wsB = await connectRealtime(bToken, 'B');

  const conversation = await json('/api/conversations/private', {
    method: 'POST',
    headers: auth(aToken),
    body: JSON.stringify({ userId: b.user.id }),
  });
  assert(conversation.id && conversation.kind === 'private', 'Private conversation was not created');

  const textA = `smoke A->B ${Date.now()}`;
  const bIncoming = waitFor(
    wsB,
    (event) => event.type === 'message.created' && event.message?.conversationId === conversation.id && event.message?.text === textA,
    'B incoming message',
  );
  const messageA = await json(`/api/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: auth(aToken),
    body: JSON.stringify({ text: textA }),
  });
  assert(messageA.text === textA, 'A message create response is wrong');
  await bIncoming;

  const bChatsAfterA = await json('/api/conversations', { headers: auth(bToken) });
  const bChatAfterA = bChatsAfterA.find((chat) => chat.id === conversation.id);
  assert(bChatsAfterA[0]?.id === conversation.id, 'B chat list did not sort new chat to top');
  assert(Number(bChatAfterA?.unread) >= 1, 'B unread did not increase after A message');

  const bMessages = await json(`/api/conversations/${conversation.id}/messages?read=1`, { headers: auth(bToken) });
  assert(bMessages.some((message) => message.id === messageA.id), 'B could not load A message');
  const bChatsAfterRead = await json('/api/conversations', { headers: auth(bToken) });
  const bChatAfterRead = bChatsAfterRead.find((chat) => chat.id === conversation.id);
  assert(Number(bChatAfterRead?.unread) === 0, 'B unread did not reset after reading');

  const textB = `smoke B->A ${Date.now()}`;
  const aIncoming = waitFor(
    wsA,
    (event) => event.type === 'message.created' && event.message?.conversationId === conversation.id && event.message?.text === textB,
    'A incoming message',
  );
  const messageB = await json(`/api/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: auth(bToken),
    body: JSON.stringify({ text: textB }),
  });
  assert(messageB.text === textB, 'B message create response is wrong');
  await aIncoming;

  const aChatsAfterB = await json('/api/conversations', { headers: auth(aToken) });
  const aChatAfterB = aChatsAfterB.find((chat) => chat.id === conversation.id);
  assert(aChatsAfterB[0]?.id === conversation.id, 'A chat list did not sort reply to top');
  assert(Number(aChatAfterB?.unread) >= 1, 'A unread did not increase after B reply');
  assert(aChatAfterB?.lastMessage === textB, 'A last message is stale');

  const sessions = await json('/api/sessions', { headers: auth(aToken) });
  assert(Array.isArray(sessions) && sessions.length >= 1, 'Session list is empty');

  wsA.close();
  wsB.close();

  console.log(JSON.stringify({
    ok: true,
    api: apiUrl,
    conversationId: conversation.id,
    accounts: {
      a: { email: accounts.a.email, handle: a.user.handle },
      b: { email: accounts.b.email, handle: b.user.handle },
    },
    checks: {
      health: 'ok',
      readiness: 'ok',
      auth: 'ok',
      refresh: 'ok',
      realtime: 'ok',
      unread: 'ok',
      sort: 'ok',
      sessions: sessions.length,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(`Smoke failed: ${error.message}`);
  process.exit(1);
});
