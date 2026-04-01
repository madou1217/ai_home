'use strict';

function renderProxyStatusPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AIH Proxy Status</title>
  <style>
    :root {
      --bg0: #f6f4ec;
      --bg1: #fffdf7;
      --ink: #23221f;
      --muted: #6c6961;
      --line: #d8d3c6;
      --accent: #1f6f78;
      --accent-soft: #e2f2f0;
      --ok: #237a57;
      --warn: #9a6f0a;
      --err: #a63b32;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(1200px 400px at -10% -10%, #efe7d7 0%, rgba(239,231,215,0) 70%),
        radial-gradient(1100px 450px at 110% -10%, #dbe8ea 0%, rgba(219,232,234,0) 70%),
        var(--bg0);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 20px 14px 32px; }
    .head { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:12px; }
    h1 { margin:0; font-size:22px; letter-spacing:0.3px; }
    .sub { color: var(--muted); font-size: 12px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px; margin-bottom:10px; }
    .card {
      background: var(--bg1);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 4px 14px rgba(31, 33, 35, 0.04);
    }
    .card h2 { margin:0 0 8px 0; font-size:13px; color: var(--accent); }
    .kv { display:grid; grid-template-columns: 1fr auto; row-gap: 6px; column-gap: 10px; font-size:12px; }
    .kv .k { color: var(--muted); }
    .kv .v { font-weight:600; }
    .pill {
      display:inline-flex;
      align-items:center;
      border-radius:999px;
      border:1px solid var(--line);
      background:#fff;
      padding:1px 8px;
      font-size:11px;
      margin: 0 5px 5px 0;
      white-space:nowrap;
    }
    .pill.ok { border-color:#b9d8cb; color:var(--ok); background:#f2faf6; }
    .pill.warn { border-color:#e6d4ae; color:var(--warn); background:#fff9eb; }
    .pill.err { border-color:#e4bbb6; color:var(--err); background:#fff3f1; }
    table { width:100%; border-collapse: collapse; font-size:12px; }
    th, td { border-bottom:1px solid var(--line); padding:6px 4px; text-align:left; vertical-align:top; }
    th { color: var(--muted); font-weight:600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .muted { color: var(--muted); }
    .section { margin-top: 10px; }
    .section h3 { margin:0 0 6px 0; font-size:13px; color: var(--accent); }
    details { margin-top:8px; }
    summary { cursor:pointer; color: var(--muted); font-size:12px; }
    pre {
      margin: 8px 0 0 0;
      padding: 8px;
      border:1px solid var(--line);
      border-radius:8px;
      background:#fff;
      white-space:pre-wrap;
      word-break:break-word;
      font-size:11px;
      line-height:1.45;
      max-height: 260px;
      overflow:auto;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>AIH Proxy Live Status</h1>
      <div class="sub">Auto refresh every 2s</div>
    </div>
    <div class="grid">
      <div class="card">
        <h2>Overview</h2>
        <div class="kv" id="overview">loading...</div>
      </div>
      <div class="card">
        <h2>Traffic</h2>
        <div class="kv" id="traffic">loading...</div>
      </div>
      <div class="card">
        <h2>Providers</h2>
        <div id="providerPills">loading...</div>
      </div>
      <div class="card">
        <h2>Models</h2>
        <div id="modelPills">loading...</div>
      </div>
    </div>

    <div class="card section">
      <h3>Provider Details</h3>
      <table id="providerTable"></table>
    </div>

    <div class="card section">
      <h3>Accounts (first 20)</h3>
      <table id="accountTable"></table>
    </div>

    <div class="card section">
      <h3>Recent Errors</h3>
      <div id="errorList" class="muted">None</div>
    </div>

    <div class="card section">
      <h3>Raw Payloads</h3>
      <details>
        <summary>/status</summary>
        <pre id="statusRaw">loading...</pre>
      </details>
      <details>
        <summary>/metrics</summary>
        <pre id="metricsRaw">loading...</pre>
      </details>
      <details>
        <summary>/accounts</summary>
        <pre id="accountsRaw">loading...</pre>
      </details>
      <details>
        <summary>/models</summary>
        <pre id="modelsRaw">loading...</pre>
      </details>
    </div>
  </div>
  <script>
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    function fmtTs(ts) {
      const n = Number(ts || 0);
      if (!n) return '-';
      return new Date(n).toLocaleString();
    }
    function pct(n) {
      const x = Number(n || 0) * 100;
      return x.toFixed(1) + '%';
    }
    function kvHtml(rows) {
      return rows.map(([k, v]) => '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>').join('');
    }
    async function loadJson(path) {
      const r = await fetch(path);
      return await r.json();
    }
    async function tick() {
      try {
        const [status, metrics, accounts, models] = await Promise.all([
          loadJson('/v0/management/status'),
          loadJson('/v0/management/metrics'),
          loadJson('/v0/management/accounts'),
          loadJson('/v0/management/models')
        ]);

        document.getElementById('overview').innerHTML = kvHtml([
          ['Backend', status.backend || '-'],
          ['Provider mode', status.providerMode || '-'],
          ['Strategy', status.strategy || '-'],
          ['Uptime', String(status.uptimeSec || 0) + 's'],
          ['Accounts', String(status.activeAccounts || 0) + '/' + String(status.totalAccounts || 0)],
          ['Cooldown', String(status.cooldownAccounts || 0)]
        ]);
        document.getElementById('traffic').innerHTML = kvHtml([
          ['Requests', metrics.totalRequests || 0],
          ['Success', metrics.totalSuccess || 0],
          ['Failures', metrics.totalFailures || 0],
          ['Timeouts', metrics.totalTimeouts || 0],
          ['Success rate', pct(metrics.successRate)],
          ['Timeout rate', pct(metrics.timeoutRate)]
        ]);

        const providerRows = ['codex', 'gemini', 'claude'].map((name) => {
          const pStatus = (status.providers && status.providers[name]) || {};
          const qStatus = (status.queue && status.queue[name]) || {};
          const pCount = (metrics.providerCounts && metrics.providerCounts[name]) || 0;
          const pSucc = (metrics.providerSuccess && metrics.providerSuccess[name]) || 0;
          const pFail = (metrics.providerFailures && metrics.providerFailures[name]) || 0;
          return {
            name,
            total: pStatus.total || 0,
            active: pStatus.active || 0,
            queued: qStatus.queued || 0,
            running: qStatus.running || 0,
            req: pCount,
            succ: pSucc,
            fail: pFail
          };
        });
        document.getElementById('providerPills').innerHTML = providerRows.map((p) => {
          const cls = p.fail > p.succ ? 'err' : (p.req > 0 ? 'ok' : 'warn');
          return '<span class="pill ' + cls + '">' + esc(p.name) + ' req=' + esc(p.req) + ' ok=' + esc(p.succ) + ' fail=' + esc(p.fail) + '</span>';
        }).join('') || '<span class="muted">No provider traffic yet</span>';
        document.getElementById('providerTable').innerHTML =
          '<thead><tr><th>provider</th><th>active/total</th><th>running</th><th>queued</th><th>req</th><th>ok</th><th>fail</th></tr></thead><tbody>' +
          providerRows.map((p) => '<tr><td class="mono">' + esc(p.name) + '</td><td>' + esc(p.active) + '/' + esc(p.total) + '</td><td>' + esc(p.running) + '</td><td>' + esc(p.queued) + '</td><td>' + esc(p.req) + '</td><td>' + esc(p.succ) + '</td><td>' + esc(p.fail) + '</td></tr>').join('') +
          '</tbody>';

        const modelList = Array.isArray(models.models) ? models.models : [];
        const showModels = modelList.slice(0, 60);
        const omitted = Math.max(0, modelList.length - showModels.length);
        document.getElementById('modelPills').innerHTML = (showModels.map((m) => '<span class="pill">' + esc(m) + '</span>').join('') || '<span class="muted">No model discovered yet</span>')
          + (omitted > 0 ? '<div class="muted">... ' + omitted + ' more</div>' : '');

        const list = Array.isArray(accounts.accounts) ? accounts.accounts.slice(0, 20) : [];
        document.getElementById('accountTable').innerHTML =
          '<thead><tr><th>id</th><th>provider</th><th>email</th><th>cooldown</th><th>ok/fail</th><th>last error</th></tr></thead><tbody>' +
          list.map((a) => {
            const cd = Number(a.cooldownUntil || 0);
            const cooldown = cd > Date.now() ? fmtTs(cd) : '-';
            return '<tr><td class="mono">' + esc(a.id) + '</td><td>' + esc(a.provider || '-') + '</td><td>' + esc(a.email || '-') + '</td><td>' + esc(cooldown) + '</td><td>' + esc(a.successCount || 0) + '/' + esc(a.failCount || 0) + '</td><td class="mono">' + esc(a.lastError || '-') + '</td></tr>';
          }).join('') +
          '</tbody>';

        const errors = Array.isArray(metrics.lastErrors) ? metrics.lastErrors : [];
        document.getElementById('errorList').innerHTML = errors.length === 0
          ? '<span class="muted">None</span>'
          : errors.slice(0, 10).map((e) => '<div class="pill err">' + esc(e.at || '-') + ' ' + esc(e.provider || '-') + ' ' + esc(e.message || '-') + '</div>').join('');

        document.getElementById('statusRaw').textContent = JSON.stringify(status, null, 2);
        document.getElementById('metricsRaw').textContent = JSON.stringify(metrics, null, 2);
        document.getElementById('accountsRaw').textContent = JSON.stringify({ ...accounts, accounts: list }, null, 2);
        document.getElementById('modelsRaw').textContent = JSON.stringify(models, null, 2);
      } catch (e) {
        document.getElementById('overview').innerHTML = '<div class="k">error</div><div class="v">' + esc(String(e)) + '</div>';
      }
    }
    tick();
    setInterval(tick, 2000);
  </script>
</body>
</html>`;
}

module.exports = {
  renderProxyStatusPage
};
