#!/usr/bin/env node
'use strict';

// Runs an isolated WebUI and PTY. Results are frame intervals, not device FPS.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { handleWebUiTerminalRequest, openWebUiTerminalSession } = require('../lib/server/webui-terminal-routes');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'web', 'dist');
const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const HELP = `Usage: node scripts/web-terminal-resize-benchmark.js --browser <chromium> [--runs 3] [--tmpdir <directory>] [--software] [--no-sandbox] [--continuous-output] [--compare-styles | --compare-blur]

Uses a loopback-only fixture server and a temporary full-screen PTY; it does not connect to the running aih server.
Build the WebUI first. Reports synthetic drag frame intervals and browser layout work; results vary with hardware and load.
--continuous-output adds a live PTY update every 50ms and verifies output advances while dragging.
--compare-styles alternates the xterm style-write optimization off/on; --compare-blur alternates
the temporary backdrop blur suppression off/on. In either mode --runs specifies before/after pairs.`;

function parseArgs(args) {
  const options = { browser: '', runs: 3, tmpdir: '', software: false, noSandbox: false, continuousOutput: false, compareStyles: false, compareBlur: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--browser' || arg === '--runs' || arg === '--tmpdir') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--browser') options.browser = value;
      else if (arg === '--runs') options.runs = Number(value);
      else options.tmpdir = value;
    }
    else if (arg === '--software') options.software = true;
    else if (arg === '--no-sandbox') options.noSandbox = true;
    else if (arg === '--continuous-output') options.continuousOutput = true;
    else if (arg === '--compare-styles') options.compareStyles = true;
    else if (arg === '--compare-blur') options.compareBlur = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help && !options.browser) throw new Error('--browser is required');
  if (options.compareStyles && options.compareBlur) throw new Error('choose one comparison mode');
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) throw new Error('--runs must be an integer from 1 to 10');
  return options;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function createFixtureServer() {
  let lastResize = null;
  let resizeCount = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/__benchmark/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lastResize, resizeCount }));
        return;
      }
      if (url.pathname.startsWith('/v0/webui/terminal/')) {
        await handleWebUiTerminalRequest({
          req, res, url, method: req.method, pathname: url.pathname,
          readRequestBody: async (stream, { maxBytes } = {}) => {
            const chunks = [];
            let size = 0;
            for await (const chunk of stream) {
              size += chunk.length;
              if (maxBytes && size > maxBytes) throw new Error('fixture_body_too_large');
              chunks.push(chunk);
            }
            const body = Buffer.concat(chunks);
            if (url.pathname.endsWith('/resize')) {
              lastResize = JSON.parse(body.toString('utf8'));
              resizeCount += 1;
            }
            return body;
          },
          writeJson: (response, status, body) => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(body));
          },
        });
        return;
      }
      if (url.pathname.startsWith('/v0/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/ui\/?/, '');
      let target = path.resolve(DIST, relative);
      if (target !== DIST && !target.startsWith(`${DIST}${path.sep}`)) {
        res.writeHead(403); res.end(); return;
      }
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(DIST, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
      fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(error.message || error));
    }
  });
  return server;
}

async function waitForBrowser(profile, child) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 900; i += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('browser exited before debugging endpoint became available');
    try {
      const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch (_error) { /* browser still starting */ }
    await delay(100);
  }
  throw new Error('browser debugging endpoint timed out');
}

async function openCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  let closed = false;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  };
  socket.onclose = () => {
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('browser connection closed')); }
    pending.clear();
  };
  return {
    isClosed() { return closed || socket.readyState !== WebSocket.OPEN; },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (closed || socket.readyState !== WebSocket.OPEN) { reject(new Error('browser connection closed')); return; }
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`browser command timed out: ${method}`)); }, 180000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

function summarizeSamples(values) {
  const samples = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!samples.length) return { samples: 0, p50: null, p95: null, max: null };
  const round = (value) => Number(value.toFixed(2));
  return { samples: samples.length, p50: round(samples[Math.floor(samples.length * 0.5)]), p95: round(samples[Math.floor(samples.length * 0.95)]), max: round(samples[samples.length - 1]) };
}

async function waitForPointerGrid(cdp, width, height, afterResize) {
  return evaluate(cdp, `(async () => {
    for(let i=0;i<80;i++){
      await new Promise(resolve=>setTimeout(resolve,50));
      const p=document.querySelector('[aria-label="Web Terminal"]'),r=p.getBoundingClientRect();
      const status=await (await fetch('/__benchmark/status')).json();
      const match=p.querySelector('.xterm-rows')?.textContent.match(/BENCH_TUI ([0-9]+)x([0-9]+)/);
      const root=p.querySelector('.xterm')?.getBoundingClientRect(),screen=p.querySelector('.xterm-screen')?.getBoundingClientRect();
      if(!match||!root||!screen||!status.lastResize)continue;
      const rows=Number(match[1]),cols=Number(match[2]);
      const unusedHeight=root.height-screen.height,unusedWidth=root.width-screen.width-14;
      if(Math.abs(r.width-${width})<=2&&Math.abs(r.height-${height})<=2&&status.resizeCount>${afterResize}&&rows===status.lastResize.rows&&cols===status.lastResize.cols&&unusedHeight>=-1&&unusedHeight<screen.height/rows+1&&unusedWidth>=-1&&unusedWidth<screen.width/cols+1)return {resizeCount:status.resizeCount};
    }return null;
  })()`);
}

// Drive a time-based mouse drag over CDP. DOM inline dimensions are read in
// the frame callback, avoiding a layout read that would distort the workload.
async function measureRealPointerDrag(cdp, continuousOutput) {
  const start = await evaluate(cdp, `(async () => {
    const panel=document.querySelector('[aria-label="Web Terminal"]');
    const handle=panel.querySelector('.global-web-terminal-resize-se');
    const r=panel.getBoundingClientRect(),h=handle.getBoundingClientRect();
    const x=h.left+h.width/2,y=h.top+h.height/2;
    if(document.elementFromPoint(x,y)!==handle)throw new Error('south-east handle cannot be hit');
    const sequence=()=>Number(panel.querySelector('.xterm-rows')?.textContent.match(/LIVE #([0-9]+)/)?.[1] || 0);
    const monitor={x,y,width:r.width,height:r.height,events:0,lags:[],frames:[],earlyFrames:[],firstInputAt:null,lastInput:null,frame:null,previous:null,initialLive:sequence(),sequence};
    monitor.onMove=(event)=>{if(event.buttons===1){monitor.events++;if(monitor.firstInputAt===null)monitor.firstInputAt=performance.now();monitor.lastInput={x:event.clientX,y:event.clientY};}};
    const tick=(now)=>{
      if(monitor.previous!==null){
        const interval=now-monitor.previous;monitor.frames.push(interval);
        if(monitor.firstInputAt!==null && now>=monitor.firstInputAt && now-monitor.firstInputAt<300)monitor.earlyFrames.push(interval);
      }
      monitor.previous=now;
      if(monitor.lastInput){
        const width=parseFloat(panel.style.width),height=parseFloat(panel.style.height);
        if(Number.isFinite(width)&&Number.isFinite(height)){
          const dx=monitor.width+monitor.lastInput.x-monitor.x-width;
          const dy=monitor.height+monitor.lastInput.y-monitor.y-height;
          monitor.lags.push(Math.hypot(dx,dy));
        }
      }
      monitor.frame=requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove',monitor.onMove,true);
    monitor.frame=requestAnimationFrame(tick);window.__terminalPointerMonitor=monitor;
    const status=await (await fetch('/__benchmark/status')).json();
    return {x,y,width:r.width,height:r.height,resizeCount:status.resizeCount};
  })()`);
  const dispatchTimes = [];
  const distanceX = 230, distanceY = 160;
  let sent = 0;
  let skipped = 0;
  let elapsed = 0;
  let pointerX = start.x, pointerY = start.y;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointerX, y: pointerY });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pointerX, y: pointerY, button: 'left', buttons: 1, clickCount: 1 });
  let measured;
  try {
    const began = performance.now();
    let nextSend = began;
    let sendError = null;
    const pending = new Set();
    while (elapsed < 1500) {
      const now = performance.now();
      if (now < nextSend) {
        await delay(Math.max(1, nextSend - now));
        elapsed = performance.now() - began;
        continue;
      }
      nextSend = Math.max(nextSend + 16, now);
      const progress = Math.min(1, elapsed / 1500);
      pointerX = start.x + distanceX * progress;
      pointerY = start.y + distanceY * progress;
      if (pending.size >= 4) {
        skipped += 1;
      } else {
        const sendStart = performance.now();
        let request;
        request = cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointerX, y: pointerY, button: 'left', buttons: 1 })
          .then(() => { dispatchTimes.push(performance.now() - sendStart); }, (error) => { sendError ||= error; })
          .finally(() => pending.delete(request));
        pending.add(request);
        sent += 1;
      }
      elapsed = performance.now() - began;
    }
    await Promise.all(pending);
    if (sendError) throw sendError;
    pointerX = start.x + distanceX;
    pointerY = start.y + distanceY;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointerX, y: pointerY, button: 'left', buttons: 1 });
    await delay(80);
    measured = await evaluate(cdp, `(() => {
      const m=window.__terminalPointerMonitor;cancelAnimationFrame(m.frame);
      window.removeEventListener('pointermove',m.onMove,true);delete window.__terminalPointerMonitor;
      return {events:m.events,lags:m.lags,frames:m.frames,earlyFrames:m.earlyFrames,initialLive:m.initialLive,finalLive:m.sequence()};
    })()`);
  } finally {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointerX, y: pointerY, button: 'left', buttons: 0, clickCount: 1 });
    if (!measured) await evaluate(cdp, `(() => {const m=window.__terminalPointerMonitor;if(m){cancelAnimationFrame(m.frame);window.removeEventListener('pointermove',m.onMove,true);delete window.__terminalPointerMonitor;}})()`).catch(() => {});
  }
  if (!measured.events || !measured.lags.length) throw new Error('real pointer drag produced no measurable frames');
  if (continuousOutput && (!measured.initialLive || measured.finalLive <= measured.initialLive)) throw new Error('live terminal output did not advance during the real pointer drag');
  const final = await waitForPointerGrid(cdp, start.width + distanceX, start.height + distanceY, start.resizeCount);
  if (!final) throw new Error('real pointer drag did not converge');
  // Restore the original size for the remaining directional checks.
  const restoredHandle = await evaluate(cdp, `(() => {const r=document.querySelector('.global-web-terminal-resize-se').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...restoredHandle });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...restoredHandle, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: restoredHandle.x - distanceX, y: restoredHandle.y - distanceY, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: restoredHandle.x - distanceX, y: restoredHandle.y - distanceY, button: 'left', buttons: 0, clickCount: 1 });
  const restored = await waitForPointerGrid(cdp, start.width, start.height, final.resizeCount);
  if (!restored) throw new Error('real pointer drag did not restore the terminal grid');
  return { durationMs: Number(elapsed.toFixed(2)), sentEvents: sent, skippedEvents: skipped, receivedEvents: measured.events, liveSequenceAdvance: continuousOutput ? measured.finalLive - measured.initialLive : null, pointerLagPx: summarizeSamples(measured.lags), frameIntervalMs: summarizeSamples(measured.frames), earlyFrameIntervalMs: summarizeSamples(measured.earlyFrames), protocolDispatchMs: summarizeSamples(dispatchTimes) };
}

// Chromium input exercises actual hit testing and pointer delivery, not just
// synthetic DOM dispatch. Check the window while held as well as after release.
async function verifyRealPointerHandles(cdp) {
  const edges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
  for (const edge of edges) {
    const dx = edge.includes('w') ? -35 : edge.includes('e') ? 35 : 0;
    const dy = edge.includes('n') ? -28 : edge.includes('s') ? 28 : 0;
    for (const direction of [1, -1]) {
      const start = await evaluate(cdp, `(async () => {
        const p=document.querySelector('[aria-label="Web Terminal"]');
        const h=p.querySelector('.global-web-terminal-resize-${edge}');
        const r=p.getBoundingClientRect(),hr=h.getBoundingClientRect();
        const x=hr.left+hr.width/2,y=hr.top+hr.height/2;
        const status=await (await fetch('/__benchmark/status')).json();
        return {x,y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,resizeCount:status.resizeCount,hit:document.elementFromPoint(x,y)===h};
      })()`);
      if (!start.hit) throw new Error(`resize handle ${edge} cannot be hit by the pointer`);
      const x = start.x + dx * direction;
      const y = start.y + dy * direction;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 });
      try {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        await delay(100);
        const current = await evaluate(cdp, `(() => {const r=document.querySelector('[aria-label="Web Terminal"]').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()`);
        const close = (actual, expected) => Math.abs(actual - expected) <= 2;
        if (!close(current.left, start.left + (edge.includes('w') ? dx * direction : 0))
          || !close(current.right, start.right + (edge.includes('e') ? dx * direction : 0))
          || !close(current.top, start.top + (edge.includes('n') ? dy * direction : 0))
          || !close(current.bottom, start.bottom + (edge.includes('s') ? dy * direction : 0))) {
          throw new Error(`resize handle ${edge} did not follow the pointer while held`);
        }
      } finally {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      }
      const converged = await evaluate(cdp, `(async () => {
        for(let i=0;i<80;i++){
          await new Promise(resolve=>setTimeout(resolve,50));
          const status=await (await fetch('/__benchmark/status')).json();
          const match=document.querySelector('.xterm-rows')?.textContent.match(/BENCH_TUI ([0-9]+)x([0-9]+)/);
          if(status.resizeCount>${start.resizeCount}&&match&&status.lastResize&&Number(match[1])===status.lastResize.rows&&Number(match[2])===status.lastResize.cols)return true;
        }
        return false;
      })()`);
      if (!converged) throw new Error(`PTY did not converge after pointer resize ${edge}`);
    }
  }
  return { edges, drags: edges.length * 2 };
}

function metricDelta(before, after) {
  const names = ['LayoutCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'];
  return Object.fromEntries(after.filter((item) => names.includes(item.name)).map((item) => [
    item.name, Number((item.value - (before.find((entry) => entry.name === item.name)?.value || 0)).toFixed(4))
  ]));
}

function signalBrowser(browser, name) {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  if (process.platform !== 'win32' && browser.pid) {
    try { process.kill(-browser.pid, name); return; } catch (_error) { /* already gone or no process group */ }
  }
  browser.kill(name);
}

async function stopBrowser(browser) {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  const exited = new Promise((resolve) => browser.once('exit', resolve));
  signalBrowser(browser, 'SIGTERM');
  await withTimeout(exited, 3000);
  if (browser.exitCode === null && browser.signalCode === null) {
    signalBrowser(browser, 'SIGKILL');
    await withTimeout(exited, 3000);
  }
}

async function run(options) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('WebUI build missing: run npm run build first');
  fs.accessSync(options.browser, fs.constants.X_OK);
  const temp = fs.mkdtempSync(path.join(options.tmpdir || os.tmpdir(), 'aih-terminal-benchmark-'));
  let aliasDir = '';
  let browserTemp = temp;
  if (process.platform !== 'win32') {
    try {
      // Chromium's Unix-domain singleton socket has a short path limit.
      aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-wt-'));
      browserTemp = path.join(aliasDir, 't');
      fs.symlinkSync(temp, browserTemp, 'dir');
    } catch (_error) {
      if (aliasDir) {
        try { fs.rmSync(aliasDir, { recursive: true, force: true }); aliasDir = ''; } catch (_cleanupError) { /* retry during cleanup */ }
      }
      browserTemp = temp;
    }
  }
  const profile = path.join(temp, 'browser');
  const key = `benchmark-${crypto.randomBytes(16).toString('hex')}`;
  const server = createFixtureServer();
  let browser;
  let cdp;
  let terminal;
  let interrupted = false;
  const interrupt = (code) => { interrupted = true; process.exitCode = code; signalBrowser(browser, 'SIGTERM'); server.closeAllConnections(); };
  const onSigint = () => interrupt(130);
  const onSigterm = () => interrupt(143);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (interrupted) throw new Error('benchmark interrupted');
    terminal = openWebUiTerminalSession({ sessionKey: key, cwd: temp, file: process.execPath, args: [path.join(__dirname, 'fixtures', 'web-terminal-resize-tui.js'), ...(options.continuousOutput ? ['--continuous-output'] : [])] });
    if (!terminal.ok) throw new Error(`fixture terminal failed: ${terminal.error}`);
    const args = ['--headless', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`];
    if (options.software) args.push('--disable-gpu');
    if (options.noSandbox) args.push('--no-sandbox');
    args.push('about:blank');
    let browserError = '';
    browser = spawn(options.browser, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: browserTemp }, detached: process.platform !== 'win32' });
    browser.stderr.on('data', (chunk) => { browserError = (browserError + chunk.toString()).slice(0, 6000); });
    try {
      await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject); });
      if (interrupted) throw new Error('benchmark interrupted');
      cdp = await openCdp(await waitForBrowser(profile, browser));
    } catch (error) {
      throw new Error(`${error.message}: ${browserError.slice(0, 1800)}`);
    }
    await cdp.send('Page.enable');
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const seed = { version: 1, servers: { local: { tabs: [{ id: 'bench', sessionKey: key, label: 'Benchmark', cwd: temp, serverId: 'local', kind: 'shell' }], activeTabId: 'bench', minimized: false, layout: 'tabs', position: { x: 100, y: 100, width: 700, height: 400 } } } };
    const script = `localStorage.setItem('aih:control-plane-profiles:v1',JSON.stringify([{id:'local',name:'Fixture',endpoint:location.origin,managementKey:'fixture',state:'ready'}]));localStorage.setItem('aih:active-control-plane-profile:v1','local');localStorage.setItem('aih:web-terminal-global:v1',${JSON.stringify(JSON.stringify(seed))});`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/ui/` });
    let ready = false;
    for (let i = 0; i < 900 && !interrupted; i += 1) {
      if (cdp.isClosed()) throw new Error(`browser connection closed: ${browserError.slice(0, 1800)}`);
      try { ready = await evaluate(cdp, `!!document.querySelector('[aria-label="Web Terminal"] .xterm-rows') && document.querySelector('.xterm-rows').textContent.includes('BENCH_TUI') && document.querySelector('.xterm-rows').textContent.includes('汉字') && (${options.continuousOutput ? "document.querySelector('.xterm-rows').textContent.includes('LIVE #')" : 'true'})`); } catch (error) {
        if (cdp.isClosed()) throw new Error(`${error.message}: ${browserError.slice(0, 1800)}`);
      }
      if (ready) break;
      await delay(100);
    }
    if (interrupted) throw new Error('benchmark interrupted');
    if (!ready) {
      const details = await evaluate(cdp, `(() => ({
        panel: document.querySelector('[aria-label="Web Terminal"]')?.innerText.slice(0, 400),
        page: document.body?.innerText.slice(0, 400)
      }))()`).catch(() => null);
      throw new Error(`benchmark terminal did not become ready: ${JSON.stringify(details)}`);
    }
    // The invisible xterm textarea follows the terminal cursor. Place it over
    // each handle so hit-testing catches stacking regressions deterministically.
    const overlappingInputChecks = await evaluate(cdp, `(() => {
      const panel=document.querySelector('[aria-label="Web Terminal"]');
      const textarea=panel.querySelector('.xterm-helper-textarea');
      if(!textarea || !textarea.offsetParent)throw new Error('terminal input not ready for hit testing');
      const original=textarea.style.cssText, parent=textarea.offsetParent.getBoundingClientRect();
      const edges=['n','ne','e','se','s','sw','w','nw'];
      try {
        for(const edge of edges){
          const handle=panel.querySelector('.global-web-terminal-resize-'+edge),rect=handle.getBoundingClientRect();
          const x=rect.left+rect.width/2,y=rect.top+rect.height/2;
          Object.assign(textarea.style,{left:(x-parent.left-10)+'px',top:(y-parent.top-10)+'px',width:'20px',height:'20px'});
          const input=textarea.getBoundingClientRect();
          if(x<input.left||x>input.right||y<input.top||y>input.bottom)throw new Error('could not position terminal input over '+edge);
          const hit=document.elementFromPoint(x,y);
          if(hit!==handle)throw new Error('resize handle '+edge+' obscured by '+(hit?.className||hit?.tagName||'nothing'));
        }
      } finally { textarea.style.cssText=original; }
      return {edges};
    })()`);
    const setup = await evaluate(cdp, `(() => {
      const styles=[...document.querySelectorAll('.xterm-screen > style')];
      window.__benchStyles=styles.map(el=>({el,descriptor:Object.getOwnPropertyDescriptor(el,'textContent')}));
      window.__benchMutations=0;
      window.__benchObserver=new MutationObserver(records=>{window.__benchMutations+=records.length});
      for(const el of styles)window.__benchObserver.observe(el,{childList:true,subtree:true,characterData:true});
      return {styles:styles.length,optimized:window.__benchStyles.filter(item=>!!item.descriptor?.set).length};
    })()`);
    if (options.compareStyles && !setup.optimized) throw new Error('xterm style-write optimization is not present in the WebUI build');
    if (options.compareBlur) {
      const effects = await evaluate(cdp, `(() => {
        const panel=document.querySelector('[aria-label="Web Terminal"]');
        const handle=panel.querySelector('.global-web-terminal-resize-se');
        const rect=panel.getBoundingClientRect();
        const opts={bubbles:true,cancelable:true,button:0,buttons:1,pointerId:42,pointerType:'mouse',isPrimary:true,clientX:rect.right,clientY:rect.bottom};
        const value=()=>getComputedStyle(document.documentElement).getPropertyValue('--hud-panel-blur').trim();
        const before=value();
        handle.dispatchEvent(new PointerEvent('pointerdown',opts));
        const during=value();
        window.dispatchEvent(new PointerEvent('pointercancel',opts));
        return {before,during,after:value(),classAfter:document.documentElement.classList.contains('aih-terminal-resizing')};
      })()`);
      if (effects.before === 'none' || effects.during !== 'none' || effects.after !== effects.before || effects.classAfter) {
        throw new Error(`background blur did not restore after cancellation: ${JSON.stringify(effects)}`);
      }
    }
    await evaluate(cdp, `window.__benchRun=async(mode,comparison,continuous)=>{
      if(comparison==='styles' && mode!==null)for(const {el,descriptor} of window.__benchStyles){if(!descriptor)continue;if(mode)Object.defineProperty(el,'textContent',descriptor);else delete el.textContent;}
      if(comparison==='blur'){
        if(!window.__benchBlurOverride){window.__benchBlurOverride=document.createElement('style');document.head.appendChild(window.__benchBlurOverride);}
        window.__benchBlurOverride.textContent=mode===false?'html.aih-terminal-resizing { --hud-panel-blur: blur(10px) !important; }':'';
      }
      window.__benchMutations=0;
      const panel=document.querySelector('[aria-label="Web Terminal"]'), handle=panel.querySelector('.global-web-terminal-resize-se');
      const opts={bubbles:true,cancelable:true,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true};
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const checkHeader=(cols)=>{
        const row=panel.querySelector('.xterm-rows > div'), content=row?.textContent || '';
        if(!/^BENCH_TUI [0-9]+x[0-9]+ revision=[0-9]+ *$/.test(content.slice(0, cols)))throw new Error('terminal header contains stale or missing visible text');
        // xterm keeps alternate-buffer cells beyond the grid after shrinking.
        // They must stay outside the clipped row even when fonts have loaded.
        const right=row.getBoundingClientRect().right, walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
        let node, offset=0;
        while((node=walker.nextNode())){
          const text=node.textContent || '';
          for(let i=Math.max(0,cols-offset);i<text.length;i++){
            if(text[i]===' ')continue;
            const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);
            if(range.getBoundingClientRect().left<right-1)throw new Error('offscreen terminal cells are visible after resizing');
          }
          offset+=text.length;
        }
      };
      await sleep(300);
      const before=panel.getBoundingClientRect(), x=before.right, y=before.bottom;
      const initial=await (await fetch('/__benchmark/status')).json();
      const liveSequence=()=>Number(panel.querySelector('.xterm-rows')?.textContent.match(/LIVE #([0-9]+)/)?.[1] || 0);
      const initialLive=liveSequence();
      const downStart=performance.now();
      handle.dispatchEvent(new PointerEvent('pointerdown',{...opts,clientX:x,clientY:y}));
      const pointerDownMs=performance.now()-downStart;
      const blurDuring=comparison==='blur'?getComputedStyle(document.documentElement).getPropertyValue('--hud-panel-blur').trim():null;
      if(comparison==='blur' && (!document.documentElement.classList.contains('aih-terminal-resizing') || (mode && blurDuring!=='none') || (!mode && blurDuring==='none')))throw new Error('background blur comparison did not take effect');
      // Use elapsed time rather than a fixed number of frames: a slower page
      // must not receive a longer drag and more PTY redraws than a faster one.
      const frames=[];const dragStart=performance.now();let previous=dragStart, progress=0;
      while(progress<1){
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const now=performance.now();frames.push(now-previous);previous=now;
        progress=Math.min(1,(now-dragStart)/1500);
        for(let j=0;j<4;j++)document.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:x+230*progress,clientY:y+160*progress}));
      }
      const dragDurationMs=performance.now()-dragStart;
      const finalLive=liveSequence();
      if(continuous && (!initialLive || finalLive<=initialLive))throw new Error('live terminal output did not advance during the drag');
      document.dispatchEvent(new PointerEvent('pointerup',{...opts,buttons:0,clientX:x+230,clientY:y+160}));
      if(comparison==='blur' && document.documentElement.classList.contains('aih-terminal-resizing'))throw new Error('background blur was not restored after release');
      let status, match, lastCount=-1, stableSince=performance.now();
      for(let i=0;i<80;i++){
        await sleep(50);status=await (await fetch('/__benchmark/status')).json();
        if(status.resizeCount!==lastCount){lastCount=status.resizeCount;stableSince=performance.now();}
        const rows=panel.querySelector('.xterm-rows');match=rows?.textContent.match(/BENCH_TUI ([0-9]+)x([0-9]+)/);
        if(status.resizeCount>initial.resizeCount&&performance.now()-stableSince>=200&&match&&status.lastResize&&Number(match[1])===status.lastResize.rows&&Number(match[2])===status.lastResize.cols)break;
      }
      const after=panel.getBoundingClientRect();
      if(Math.abs(after.width-before.width-230)>2||Math.abs(after.height-before.height-160)>2)throw new Error('resize did not follow the pointer');
      if(status.resizeCount<=initial.resizeCount||performance.now()-stableSince<200||!match||!status.lastResize||Number(match[1])!==status.lastResize.rows||Number(match[2])!==status.lastResize.cols)throw new Error('PTY did not converge to the final grid size');
      if(!panel.querySelector('.xterm-rows')?.textContent.includes('汉字'))throw new Error('wide terminal characters did not render');
      checkHeader(Number(match[2]));
      const styleMutations=window.__benchMutations;
      handle.dispatchEvent(new PointerEvent('pointerdown',{...opts,clientX:after.right,clientY:after.bottom}));
      document.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:x,clientY:y}));
      document.dispatchEvent(new PointerEvent('pointerup',{...opts,buttons:0,clientX:x,clientY:y}));
      let restoredStatus, restoredGrid, restoredLastCount=-1, restoredStableSince=performance.now();
      for(let i=0;i<80;i++){
        await sleep(50);restoredStatus=await (await fetch('/__benchmark/status')).json();
        if(restoredStatus.resizeCount!==restoredLastCount){restoredLastCount=restoredStatus.resizeCount;restoredStableSince=performance.now();}
        restoredGrid=panel.querySelector('.xterm-rows')?.textContent.match(/BENCH_TUI ([0-9]+)x([0-9]+)/);
        if(restoredStatus.resizeCount>status.resizeCount&&performance.now()-restoredStableSince>=200&&restoredGrid&&restoredStatus.lastResize&&Number(restoredGrid[1])===restoredStatus.lastResize.rows&&Number(restoredGrid[2])===restoredStatus.lastResize.cols)break;
      }
      const restored=panel.getBoundingClientRect();
      if(Math.abs(restored.width-before.width)>2||Math.abs(restored.height-before.height)>2)throw new Error('window size did not restore');
      if(restoredStatus.resizeCount<=status.resizeCount||performance.now()-restoredStableSince<200||!restoredGrid||!restoredStatus.lastResize||Number(restoredGrid[1])!==restoredStatus.lastResize.rows||Number(restoredGrid[2])!==restoredStatus.lastResize.cols)throw new Error('PTY did not converge after shrinking: '+JSON.stringify({restoredGrid,status,restoredStatus}));
      checkHeader(Number(restoredGrid[2]));
      if(frames.length<3)throw new Error('too few animation frames to measure the drag');
      const firstFrameMs=frames.shift();frames.sort((a,b)=>a-b);
      return {comparison,optimization:mode,styleOptimization:comparison==='styles'?mode:null,blurDuring,pointerDownMs,firstFrameMs,dragDurationMs,liveSequenceAdvance:continuous?finalLive-initialLive:null,frameIntervalMs:{p50:frames[Math.floor(frames.length*.5)],p95:frames[Math.floor(frames.length*.95)],max:frames[frames.length-1],over33ms:frames.filter(value=>value>33).length,samples:frames.length},styleMutations,resizeRequests:status.resizeCount-initial.resizeCount,finalGrid:{rows:Number(match[1]),cols:Number(match[2])}};
    }`);
    await evaluate(cdp, `window.__benchRun(null, null, ${Boolean(options.continuousOutput)})`); // Warm fonts, terminal and browser caches.
    const comparison = options.compareStyles ? 'styles' : options.compareBlur ? 'blur' : null;
    const modes = comparison
      ? Array.from({ length: options.runs }, (_unused, index) => index % 2 ? [true, false] : [false, true]).flat()
      : Array(options.runs).fill(null);
    const results = [];
    for (const mode of modes) {
      const before = (await cdp.send('Performance.getMetrics')).metrics;
      const result = await evaluate(cdp, `window.__benchRun(${JSON.stringify(mode)}, ${JSON.stringify(comparison)}, ${Boolean(options.continuousOutput)})`);
      const after = (await cdp.send('Performance.getMetrics')).metrics;
      results.push({ ...result, browserWork: metricDelta(before, after) });
    }
    // Verify all eight handles, including the opposite-edge anchor and the
    // final PTY grid. The timed benchmark above measures the south-east handle.
    const handleChecks = await evaluate(cdp, `(async () => {
      const panel=document.querySelector('[aria-label="Web Terminal"]');
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const opts={bubbles:true,cancelable:true,button:0,buttons:1,pointerId:13,pointerType:'mouse',isPrimary:true};
      const edges=['n','ne','e','se','s','sw','w','nw'];
      const drag=async(edge,dx,dy)=>{
        const before=panel.getBoundingClientRect();
        const x=edge.includes('w')?before.left:edge.includes('e')?before.right:before.left+before.width/2;
        const y=edge.includes('n')?before.top:edge.includes('s')?before.bottom:before.top+before.height/2;
        const handle=panel.querySelector('.global-web-terminal-resize-'+edge);
        const initial=await (await fetch('/__benchmark/status')).json();
        handle.dispatchEvent(new PointerEvent('pointerdown',{...opts,clientX:x,clientY:y}));
        document.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:x+dx,clientY:y+dy}));
        document.dispatchEvent(new PointerEvent('pointerup',{...opts,buttons:0,clientX:x+dx,clientY:y+dy}));
        const after=panel.getBoundingClientRect(),near=(a,b)=>Math.abs(a-b)<=2;
        if(!near(after.left,before.left+(edge.includes('w')?dx:0))||!near(after.right,before.right+(edge.includes('e')?dx:0))||!near(after.top,before.top+(edge.includes('n')?dy:0))||!near(after.bottom,before.bottom+(edge.includes('s')?dy:0)))throw new Error('incorrect window geometry for '+edge);
        let status,match;
        for(let i=0;i<80;i++){
          await sleep(50);status=await (await fetch('/__benchmark/status')).json();
          match=panel.querySelector('.xterm-rows')?.textContent.match(/BENCH_TUI ([0-9]+)x([0-9]+)/);
          if(status.resizeCount>initial.resizeCount&&match&&status.lastResize&&Number(match[1])===status.lastResize.rows&&Number(match[2])===status.lastResize.cols)break;
        }
        if(!match||status.resizeCount<=initial.resizeCount||!status.lastResize||Number(match[1])!==status.lastResize.rows||Number(match[2])!==status.lastResize.cols)throw new Error('PTY did not converge for '+edge);
      };
      for(const edge of edges){
        const dx=edge.includes('w')?-35:edge.includes('e')?35:0;
        const dy=edge.includes('n')?-28:edge.includes('s')?28:0;
        await drag(edge,dx,dy);await drag(edge,-dx,-dy);
      }
      return {edges,drags:edges.length*2};
    })()`);
    const realPointerDrag = await measureRealPointerDrag(cdp, options.continuousOutput);
    const pointerChecks = await verifyRealPointerHandles(cdp);
    // FitAddon must size the screen to the unpadded content area. Sweeping
    // through more than one cell height catches clipped bottom rows that a
    // single final grid/PTY comparison cannot see.
    const gridBounds = await evaluate(cdp, `(async () => {
      const panel = document.querySelector('[aria-label="Web Terminal"]');
      const root = panel.querySelector('.xterm');
      const screen = root.querySelector('.xterm-screen');
      const originalHeight = panel.style.height;
      const originalWidth = panel.style.width;
      const bounds = panel.getBoundingClientRect();
      const startHeight = bounds.height, startWidth = bounds.width;
      let worstOverflow = -Infinity;
      let worstRightOverflow = -Infinity;
      try {
        for (let offset = 0; offset < 20; offset++) {
          panel.style.height = (startHeight + offset) + 'px';
          panel.style.width = (startWidth + offset) + 'px';
          await new Promise(resolve => setTimeout(resolve, 180));
          let rootBox, screenBox, rows, overflow, unused, rowHeight;
          for (let attempt = 0; attempt < 10; attempt++) {
            rootBox = root.getBoundingClientRect();
            screenBox = screen.getBoundingClientRect();
            rows = screen.querySelector('.xterm-rows')?.children.length || 0;
            overflow = screenBox.bottom - rootBox.bottom;
            unused = rootBox.bottom - screenBox.bottom;
            rowHeight = screenBox.height / rows;
            if (rows && rootBox.height && screenBox.height && overflow <= 1 && unused < rowHeight + 1 && screenBox.right - rootBox.right <= 1) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!rows || !rootBox.height || !screenBox.height) throw new Error('terminal grid has no visible size');
          worstOverflow = Math.max(worstOverflow, overflow);
          worstRightOverflow = Math.max(worstRightOverflow, screenBox.right - rootBox.right);
          if (overflow > 1 || unused >= rowHeight + 1) throw new Error('terminal grid does not fit its visible area at height ' + (startHeight + offset) + ': overflow=' + overflow + ', unused=' + unused);
          if (screenBox.right - rootBox.right > 1) throw new Error('terminal grid exceeds its visible width');
        }
      } finally {
        panel.style.height = originalHeight;
        panel.style.width = originalWidth;
      }
      return { sizesChecked: 20, worstBottomOverflowPx: Number(worstOverflow.toFixed(2)), worstRightOverflowPx: Number(worstRightOverflow.toFixed(2)) };
    })()`);
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync('/dev/shm/aih-terminal-pacing-visual.png',Buffer.from(shot.data,'base64'));
    const indexHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, 'index.html'))).digest('hex');
    return { browser: await cdp.send('Browser.getVersion'), viewport: { width: 1440, height: 900 }, forcedSoftware: options.software, continuousOutput: options.continuousOutput, buildIndexSha256: indexHash, terminalDurable: terminal.durable, styleAdapter: setup, results, overlappingInputChecks, handleChecks, realPointerDrag, pointerChecks, gridBounds };
  } finally {
    if (cdp && !cdp.isClosed()) {
      await withTimeout(cdp.send('Browser.close').catch(() => {}), 2000);
    }
    cdp?.close();
    await stopBrowser(browser);
    if (terminal?.ok) {
      let closed = false;
      await handleWebUiTerminalRequest({ method: 'POST', pathname: '/v0/webui/terminal/close', res: {},
        readRequestBody: async () => Buffer.from(JSON.stringify({ termId: terminal.termId, sessionKey: key })), writeJson: (_res, _status, body) => { closed = body.ok === true; } });
      if (!closed) console.error('fixture terminal could not be closed');
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (aliasDir) {
      try { fs.rmSync(aliasDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { console.error(`fixture alias cleanup: ${error.message}`); }
    }
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { console.error(`fixture cleanup: ${error.message}`); }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else run(options).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
      console.error(process.exitCode === 130 || process.exitCode === 143 ? 'benchmark interrupted' : `benchmark failed: ${error.message}`);
      if (!process.exitCode) process.exitCode = 1;
    });
  } catch (error) {
    console.error(`${error.message}\n${HELP}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, metricDelta, summarizeSamples, run };
