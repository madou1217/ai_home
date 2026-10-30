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
const HELP = `Usage: node scripts/web-terminal-resize-benchmark.js --browser <chromium> [--runs 3] [--tmpdir <directory>] [--software] [--no-sandbox] [--compare-styles]

Uses a loopback-only fixture server and a temporary full-screen PTY; it does not connect to the running aih server.
Build the WebUI first. Reports synthetic drag frame intervals and browser layout work; results vary with hardware and load.
--compare-styles alternates the xterm style-write optimization off/on to compare the same page and workload;
in that mode --runs specifies the number of before/after pairs.`;

function parseArgs(args) {
  const options = { browser: '', runs: 3, tmpdir: '', software: false, noSandbox: false, compareStyles: false, help: false };
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
    else if (arg === '--compare-styles') options.compareStyles = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.help && !options.browser) throw new Error('--browser is required');
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
  for (let i = 0; i < 150; i += 1) {
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
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`browser command timed out: ${method}`)); }, 60000);
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
    terminal = openWebUiTerminalSession({ sessionKey: key, cwd: temp, file: process.execPath, args: [path.join(__dirname, 'fixtures', 'web-terminal-resize-tui.js')] });
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
    for (let i = 0; i < 150 && !interrupted; i += 1) {
      if (cdp.isClosed()) throw new Error(`browser connection closed: ${browserError.slice(0, 1800)}`);
      try { ready = await evaluate(cdp, "!!document.querySelector('[aria-label=\"Web Terminal\"] .xterm-rows') && document.querySelector('.xterm-rows').textContent.includes('BENCH_TUI') && document.querySelector('.xterm-rows').textContent.includes('汉字')"); } catch (error) {
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
    const setup = await evaluate(cdp, `(() => {
      const styles=[...document.querySelectorAll('.xterm-screen > style')];
      window.__benchStyles=styles.map(el=>({el,descriptor:Object.getOwnPropertyDescriptor(el,'textContent')}));
      window.__benchMutations=0;
      window.__benchObserver=new MutationObserver(records=>{window.__benchMutations+=records.length});
      for(const el of styles)window.__benchObserver.observe(el,{childList:true,subtree:true,characterData:true});
      return {styles:styles.length,optimized:window.__benchStyles.filter(item=>!!item.descriptor?.set).length};
    })()`);
    if (options.compareStyles && !setup.optimized) throw new Error('xterm style-write optimization is not present in the WebUI build');
    await evaluate(cdp, `window.__benchRun=async(mode)=>{
      if(mode!==null)for(const {el,descriptor} of window.__benchStyles){if(!descriptor)continue;if(mode)Object.defineProperty(el,'textContent',descriptor);else delete el.textContent;}
      window.__benchMutations=0;
      const panel=document.querySelector('[aria-label="Web Terminal"]'), handle=panel.querySelector('.global-web-terminal-resize-se');
      const opts={bubbles:true,cancelable:true,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true};
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      await sleep(300);
      const before=panel.getBoundingClientRect(), x=before.right, y=before.bottom;
      const initial=await (await fetch('/__benchmark/status')).json();
      handle.dispatchEvent(new PointerEvent('pointerdown',{...opts,clientX:x,clientY:y}));
      const frames=[];let previous=performance.now();
      for(let i=1;i<=90;i++){await new Promise(resolve=>requestAnimationFrame(resolve));const now=performance.now();frames.push(now-previous);previous=now;for(let j=0;j<4;j++)document.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:x+230*(i+j/4)/90,clientY:y+160*(i+j/4)/90}));}
      document.dispatchEvent(new PointerEvent('pointerup',{...opts,buttons:0,clientX:x+230,clientY:y+160}));
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
      const styleMutations=window.__benchMutations;
      handle.dispatchEvent(new PointerEvent('pointerdown',{...opts,clientX:after.right,clientY:after.bottom}));
      document.dispatchEvent(new PointerEvent('pointermove',{...opts,clientX:x,clientY:y}));
      document.dispatchEvent(new PointerEvent('pointerup',{...opts,buttons:0,clientX:x,clientY:y}));
      await sleep(400);
      const restored=panel.getBoundingClientRect();
      if(Math.abs(restored.width-before.width)>2||Math.abs(restored.height-before.height)>2)throw new Error('window size did not restore');
      frames.shift();frames.sort((a,b)=>a-b);
      return {styleOptimization:mode,frameIntervalMs:{p50:frames[Math.floor(frames.length*.5)],p95:frames[Math.floor(frames.length*.95)],max:frames[frames.length-1],over33ms:frames.filter(value=>value>33).length,samples:frames.length},styleMutations,resizeRequests:status.resizeCount-initial.resizeCount,finalGrid:{rows:Number(match[1]),cols:Number(match[2])}};
    }`);
    await evaluate(cdp, 'window.__benchRun(null)'); // Warm fonts, terminal and browser caches.
    const modes = options.compareStyles
      ? Array.from({ length: options.runs }, (_unused, index) => index % 2 ? [true, false] : [false, true]).flat()
      : Array(options.runs).fill(null);
    const results = [];
    for (const mode of modes) {
      const before = (await cdp.send('Performance.getMetrics')).metrics;
      const result = await evaluate(cdp, `window.__benchRun(${JSON.stringify(mode)})`);
      const after = (await cdp.send('Performance.getMetrics')).metrics;
      results.push({ ...result, browserWork: metricDelta(before, after) });
    }
    const indexHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, 'index.html'))).digest('hex');
    return { browser: await cdp.send('Browser.getVersion'), viewport: { width: 1440, height: 900 }, forcedSoftware: options.software, buildIndexSha256: indexHash, terminalDurable: terminal.durable, styleAdapter: setup, results };
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

module.exports = { parseArgs, metricDelta, run };
