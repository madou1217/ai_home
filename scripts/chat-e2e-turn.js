'use strict';
// 临时 e2e 辅助：创建 chat 会话 -> 上传附件 -> 提交 turn -> 轮询直到终态。
// 用法: node scripts/chat-e2e-turn.js <provider> <accountRef> <model> <prompt> <file1> [file2...]
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:9527';
const MGMT = fs.readFileSync('/tmp/aih-mgmt-key.txt', 'utf8').trim();
const [, , provider, accountRef, model, prompt, ...files] = process.argv;

function mimeFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (['mp4', 'm4v', 'mov', 'webm'].includes(ext)) return `video/${ext === 'mov' ? 'quicktime' : ext}`;
  if (['png'].includes(ext)) return 'image/png';
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  return 'text/plain';
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { Authorization: `Bearer ${MGMT}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  const created = await api('POST', '/v0/webui/chat/sessions', {
    provider, executionAccountRef: accountRef,
    policy: { workspaceMode: 'chat', approvalMode: 'confirm' }
  });
  const sid = created.json.session && created.json.session.sessionId;
  if (!sid) throw new Error('create failed: ' + JSON.stringify(created.json).slice(0, 200));
  console.log('session:', sid);

  let attachmentIds = [];
  if (files.length) {
    const uploaded = await api('POST', `/v0/webui/chat/sessions/${sid}/attachments`, {
      attachments: files.map((file) => {
        const mime = mimeFor(file);
        return {
          name: path.basename(file), mimeType: mime,
          dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
        };
      })
    });
    attachmentIds = (uploaded.json.attachments || []).map((a) => a.attachmentId);
    console.log('attachments:', uploaded.json.ok ? attachmentIds.join(', ') : JSON.stringify(uploaded.json).slice(0, 300));
  }

  const submitted = await api('POST', `/v0/webui/chat/sessions/${sid}/commands`, {
    commandId: `cmd-e2e-${Date.now()}`, type: 'turn.submit',
    payload: { content: prompt, attachmentIds, model }
  });
  console.log('submit:', submitted.status, submitted.json.ok);

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.HOME + '/.ai_home/app-state.db', { readOnly: true });
  const deadline = Date.now() + 300000;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const row = db.prepare("SELECT type FROM chat_runtime_events WHERE session_id=? ORDER BY seq DESC LIMIT 1").get(sid);
    if (row && row.type !== last) { console.log('state:', row.type); last = row.type; }
    if (row && (row.type === 'turn.completed' || row.type === 'turn.failed')) break;
  }
  const timeline = await api('GET', `/v0/webui/chat/sessions/${sid}/timeline?limit=30`);
  for (const item of timeline.json.timeline.items) {
    if (item.kind === 'message' && item.detail && item.detail.role === 'assistant') {
      console.log('=== assistant ===');
      console.log(String(item.content || '').slice(0, 1600));
    }
    if (item.kind === 'error') console.log('=== error ===', JSON.stringify(item).slice(0, 300));
  }
}

main().catch((error) => { console.error('E2E FAILED', error); process.exit(1); });
