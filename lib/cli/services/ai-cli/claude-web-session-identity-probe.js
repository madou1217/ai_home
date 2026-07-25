'use strict';

const CLAUDE_BOOTSTRAP_URL = 'https://claude.ai/api/bootstrap';
const MAX_INPUT_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 5000;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  const email = normalizeString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function isSafeCookieValue(value) {
  const normalized = normalizeString(value);
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > 8192) return false;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    const valid = code === 0x21
      || (code >= 0x23 && code <= 0x2b)
      || (code >= 0x2d && code <= 0x3a)
      || (code >= 0x3c && code <= 0x5b)
      || (code >= 0x5d && code <= 0x7e);
    if (!valid) return false;
  }
  return true;
}

function normalizeProbeInput(input) {
  const sessionKey = normalizeString(input && input.sessionKey);
  const lastActiveOrg = normalizeString(input && input.lastActiveOrg);
  if (!sessionKey.startsWith('sk-ant-sid')
    || !isSafeCookieValue(sessionKey)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lastActiveOrg)) {
    return null;
  }
  return { sessionKey, lastActiveOrg };
}

function readBootstrapIdentity(payload) {
  const account = payload && payload.account;
  const accountUuid = normalizeString(account && account.uuid);
  const emailAddress = normalizeEmail(account && account.email_address);
  if (!accountUuid || !emailAddress) return null;
  const memberships = Array.isArray(account.memberships) ? account.memberships : [];
  const organizationUuids = Array.from(new Set(memberships
    .map((membership) => normalizeString(
      membership
      && membership.organization
      && membership.organization.uuid
    ))
    .filter(Boolean)));
  return { accountUuid, emailAddress, organizationUuids };
}

async function probeClaudeWebSessionIdentity(input, options = {}) {
  const cookies = normalizeProbeInput(input);
  if (!cookies) return { status: 'unavailable' };
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { status: 'unavailable' };

  let response;
  try {
    response = await fetchImpl(CLAUDE_BOOTSTRAP_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: `sessionKey=${cookies.sessionKey}; lastActiveOrg=${cookies.lastActiveOrg}`
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (_error) {
    return { status: 'unavailable' };
  }
  if (response.status === 401 || response.status === 403) {
    return { status: 'rejected' };
  }
  if (!response.ok) return { status: 'unavailable' };

  try {
    const identity = readBootstrapIdentity(await response.json());
    return identity ? { status: 'ok', ...identity } : { status: 'unavailable' };
  } catch (_error) {
    return { status: 'unavailable' };
  }
}

async function readStdin() {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_INPUT_BYTES) throw new Error('probe_input_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function main() {
  let inputBuffer = null;
  try {
    inputBuffer = await readStdin();
    const input = JSON.parse(inputBuffer.toString('utf8'));
    const result = await probeClaudeWebSessionIdentity(input);
    process.stdout.write(JSON.stringify(result));
  } catch (_error) {
    process.stdout.write(JSON.stringify({ status: 'unavailable' }));
  } finally {
    if (inputBuffer) inputBuffer.fill(0);
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  probeClaudeWebSessionIdentity
};
