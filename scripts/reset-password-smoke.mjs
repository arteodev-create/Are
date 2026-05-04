import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.RESET_PASSWORD_SMOKE_PORT || 8794);
const apiUrl = `http://localhost:${port}`;
const stamp = Date.now();
const account = {
  email: `veritas.reset.${stamp}@test.local`,
  displayName: `Reset User ${stamp}`,
  handle: `reset_${stamp}`,
  password: 'VeritasReset123!',
  nextPassword: 'VeritasReset456!',
};

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

async function capturedCode(email, purpose) {
  const captured = await json('/api/dev/email-code', {
    method: 'POST',
    body: JSON.stringify({ email, purpose }),
  });
  assert(/^\d{6}$/.test(captured.code), `Captured ${purpose} code is invalid`);
  return captured.code;
}

async function runResetPasswordChecks() {
  const directRegister = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `direct.${account.email}`,
      displayName: 'Direct Register Blocked',
      handle: `direct_${stamp}`,
      password: account.password,
    }),
  });
  assert(directRegister.response.status === 403, 'Direct register was not blocked');
  assert(directRegister.data.errorCode === 'AUTH_VERIFICATION_REQUIRED', 'Direct register used the wrong error code');

  await json('/api/auth/register/request-code', {
    method: 'POST',
    body: JSON.stringify({
      email: account.email,
      displayName: account.displayName,
      handle: account.handle,
      password: account.password,
      locale: 'vi',
    }),
  });

  const registerCode = await capturedCode(account.email, 'register');
  const created = await json('/api/auth/register/verify', {
    method: 'POST',
    body: JSON.stringify({ email: account.email, code: registerCode }),
  });
  assert(created.user?.email === account.email, 'Register verify did not create the expected account');

  const duplicate = await request('/api/auth/register/request-code', {
    method: 'POST',
    body: JSON.stringify({
      email: account.email,
      displayName: `${account.displayName} Duplicate`,
      handle: `${account.handle}_dup`,
      password: account.password,
      locale: 'vi',
    }),
  });
  assert(duplicate.response.status === 409, 'Duplicate email registration was not blocked');
  assert(duplicate.data.errorCode === 'AUTH_ACCOUNT_EXISTS', 'Duplicate email used the wrong error code');

  const emailStatus = await json('/api/auth/email-status', {
    method: 'POST',
    body: JSON.stringify({ email: account.email.toUpperCase() }),
  });
  assert(emailStatus.exists === true, 'Email status did not find the created account');

  await json('/api/auth/password/request-code', {
    method: 'POST',
    body: JSON.stringify({
      email: account.email,
      password: account.nextPassword,
      locale: 'vi',
    }),
  });

  const resetCode = await capturedCode(account.email, 'reset');
  const reset = await json('/api/auth/password/verify', {
    method: 'POST',
    body: JSON.stringify({ email: account.email, code: resetCode }),
  });
  assert(reset.user?.email === account.email, 'Reset verify did not return the expected account');
  assert(reset.accessToken && reset.refreshToken, 'Reset verify did not create a new session');

  const oldLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  assert(oldLogin.response.status === 401, 'Old password still works after reset');
  assert(oldLogin.data.errorCode === 'AUTH_INVALID_CREDENTIALS', 'Old password returned the wrong error code');

  const newLogin = await json('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: account.email, password: account.nextPassword }),
  });
  assert(newLogin.user?.email === account.email, 'New password login did not return the expected account');

  const missingReset = await request('/api/auth/password/request-code', {
    method: 'POST',
    body: JSON.stringify({ email: `missing.${stamp}@test.local`, password: account.nextPassword }),
  });
  assert(missingReset.response.status === 404, 'Missing email reset was not blocked');
  assert(missingReset.data.errorCode === 'AUTH_EMAIL_NOT_FOUND', 'Missing email reset used the wrong error code');

  return {
    email: account.email,
    userId: created.user.id,
    resetSessionId: reset.sessionId,
    checks: {
      registerCode: 'ok',
      duplicateEmail: 'ok',
      directRegisterBlocked: 'ok',
      emailStatus: 'ok',
      resetCode: 'ok',
      oldPasswordRejected: 'ok',
      newPasswordAccepted: 'ok',
      missingEmailRejected: 'ok',
    },
  };
}

async function main() {
  const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'veritas-reset-password-'));
  const server = spawn(process.execPath, [path.resolve('server/index.js')], {
    cwd: tempCwd,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'reset-password-smoke-access-secret',
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'reset-password-smoke-refresh-secret',
      DATABASE_URL: '',
      SUPABASE_URL: '',
      SUPABASE_PUBLISHABLE_KEY: '',
      VITE_SUPABASE_ANON_KEY: '',
      VERITAS_EMAIL_CAPTURE: 'true',
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
    const checks = await runResetPasswordChecks();
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
  console.error(`Reset password smoke failed: ${error.message}`);
  process.exit(1);
});
