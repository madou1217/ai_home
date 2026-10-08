'use strict';

// Real child process + filesystem transcript through the production native
// runner. The child is a fixture, not the vendor engine or a real inference.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnNativeSessionStream, runNativeSessionPrompt } = require('../lib/server/native-session-chat');
const { credential } = require('./helpers/codebuddy-credential');
const { adoptCodebuddyCredential } = require('../lib/account/codebuddy-credential-sync');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { readSessionMessages } = require('../lib/sessions/session-reader');
const { codebuddyCredentialPaths } = require('../lib/account/codebuddy-credential-source');

const CONFIG_DIRS = Object.freeze({
  codebuddy: '.codebuddy',
  codebuddycn: '.codebuddy-cn',
  workbuddy: '.workbuddy-ai',
  workbuddycn: '.workbuddy'
});

function createNativeFixture(t, provider) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-pipeline-'));
  const aiHomeDir = path.join(home, '.ai_home'), projectPath = path.join(home, 'project');
  fs.mkdirSync(projectPath);
  const previous = process.env.REAL_HOME; process.env.REAL_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.REAL_HOME; else process.env.REAL_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const account = adoptCodebuddyCredential(fs, aiHomeDir, provider, credential(provider));
  const runtime = resolveAccountRuntimeDir(aiHomeDir, provider, account.accountRef);
  let desktopAuth;
  if (provider.startsWith('workbuddy')) {
    const value = credential(provider);
    value.auth.accessToken = { $wbEncrypted: 1, envelope: 'vendor-managed-ciphertext' };
    desktopAuth = codebuddyCredentialPaths(runtime, provider)[0];
    fs.mkdirSync(path.dirname(desktopAuth), { recursive: true });
    fs.writeFileSync(desktopAuth, JSON.stringify(value));
  }
  const config = CONFIG_DIRS[provider];
  const projects = path.join(home, config, 'projects'); fs.mkdirSync(projects, { recursive: true });
  const fixture = path.join(home, 'native-fixture.cjs');
  fs.writeFileSync(fixture, `
const fs=require('node:fs'),path=require('node:path');
if(process.stdout.isTTY) throw new Error('structured native output requires pipes');
const args=process.argv.slice(2), id=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
if(!/^[a-f0-9-]{36}$/.test(id)) throw new Error('missing exact session id');
if(process.env.HOME===${JSON.stringify(home)}) throw new Error('not account isolated');
if(${provider.startsWith('workbuddy')} && process.env.CODEBUDDY_CONFIG_DIR!==process.env.WORKBUDDY_CONFIG_DIR) throw new Error('config mismatch');
const dir=path.join(process.env.CODEBUDDY_CONFIG_DIR,'projects','fixture-project'); fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,id+'.jsonl'), text=args.at(-1);
if(args.includes('--resume')&&!fs.existsSync(file)) throw new Error('resume lost original transcript');
const events=[{id:'title',type:'ai-title',sessionId:id,cwd:process.cwd(),aiTitle:'Fixture'},
 {id:Date.now()+'u',type:'message',role:'user',timestamp:Date.now(),content:[{type:'input_text',text}]}];
fs.appendFileSync(file,events.map(e=>JSON.stringify(e)).join('\\n')+'\\n');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
const answer=()=>{
 fs.appendFileSync(file,JSON.stringify({id:Date.now()+'a',type:'message',role:'assistant',timestamp:Date.now(),content:[{type:'output_text',text:'ANSWER:'+text}]})+'\\n');
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ANSWER:'+text}]}}));
 console.log(JSON.stringify({type:'result',result:'ANSWER:'+text,session_id:id}));
};
if(text==='delayed'){
 fs.appendFileSync(file,JSON.stringify({id:'thinking',type:'reasoning',timestamp:Date.now(),rawContent:[{type:'reasoning_text',text:'still thinking'}]})+'\\n');
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'still thinking'}]}}));
 setTimeout(answer,750);
}else answer();
`);
  const events = [];
  const options = { provider, accountRef: account.accountRef, aiHomeDir, projectPath,
    env: { ...process.env, HOME: home, AIH_HOST_HOME: home, REAL_HOME: home },
    getProfileDir: () => runtime,
    resolveNativeCliLaunch: () => ({ command: process.execPath, prefixArgs: [fixture] }),
    ensureSessionStoreLinks: (_provider, _ref, scope) => {
      assert.equal(scope.sessionLinksOnly, true, 'native launch only reconciles declared family session links');
      const target = path.join(scope.projectionRoot, config, 'projects'); fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.symlinkSync(projects, target); return { migrated: 0, linked: 1, unresolved: [] };
    }, onEvent: event => events.push(event)
  };
  return { options, events, desktopAuth };
}

for (const provider of Object.keys(CONFIG_DIRS)) test(`${provider} production runner creates a readable thread and resumes the exact native ID`, { timeout: 20000 }, async t => {
  const { options, events, desktopAuth } = createNativeFixture(t, provider);
  const desktopBefore = desktopAuth && fs.readFileSync(desktopAuth, 'utf8');
  const run = (prompt, sessionId) => spawnNativeSessionStream({
    ...options, prompt, sessionId, interactiveCli: false, completeOnTranscriptUpdate: false
  });
  const first = await run('first').done;
  assert.equal(first.content, 'ANSWER:first'); assert.match(first.sessionId, /^[a-f0-9-]{36}$/);
  const second = await run('second', first.sessionId).done;
  assert.equal(second.sessionId, first.sessionId); assert.match(second.content, /ANSWER:second/);
  const messages = readSessionMessages(provider, { sessionId: first.sessionId });
  assert.ok(messages.some(message => JSON.stringify(message).includes('ANSWER:first')));
  assert.ok(messages.some(message => JSON.stringify(message).includes('ANSWER:second')));
  assert.ok(events.some(event => event.type === 'delta'));
  if (desktopAuth) assert.equal(fs.readFileSync(desktopAuth, 'utf8'), desktopBefore, 'CLI must preserve the desktop encrypted credential');
});

for (const provider of Object.keys(CONFIG_DIRS)) {
  test(`${provider} non-stream resume waits for the answer after reasoning is persisted`, { timeout: 20000 }, async t => {
    const { options, events } = createNativeFixture(t, provider);
    const first = await runNativeSessionPrompt({ ...options, prompt: 'first' });
    const second = await runNativeSessionPrompt({ ...options, sessionId: first.sessionId, prompt: 'delayed' });

    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.content, 'ANSWER:delayed');
    assert.ok(events.some(event => event.type === 'thinking' && event.thinking === 'still thinking'));
    const messages = readSessionMessages(provider, { sessionId: second.sessionId });
    assert.match(messages.at(-1).content, /still thinking[\s\S]*ANSWER:delayed/);
  });
}
