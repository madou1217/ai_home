'use strict';

// Claude diagnostic scheduler: watches PTY output for Stop-hook JSON
// validation errors and tool-protocol problems, then (debounced, deduped by
// evidence signature, with a no-evidence cooldown) collects transcript
// diagnostics and appends them to the on-disk diagnostic log. The collectors
// themselves live in claude-hook-diagnostics.js; this module owns WHEN they
// run. Extracted from runCliPty; exported names match the original closure
// functions so call sites are unchanged.

const {
  appendClaudeHookDiagnosticLog,
  appendClaudeToolDiagnosticLog,
  collectClaudeStopHookDiagnostics,
  collectClaudeToolProtocolDiagnostics,
  containsClaudeToolProtocolProblem,
  containsClaudeStopHookJsonValidationError
} = require('./claude-hook-diagnostics');
function createClaudeDiagnosticScheduler(deps = {}) {
  const {
    fs,
    path,
    processObj,
    stripAnsi,
    aiHomeDir,
    hostHomeDir,
    provider: cliName,
    runtimeStartedAt,
    getAccountRef,
    isGateway,
    getCliPath,
    getForwardArgs,
    getRuntimeEnv,
    isCleanedUp
  } = deps;

  let lastClaudeHookDiagnosticSignature = '';
  let lastClaudeToolDiagnosticSignature = '';
  let lastClaudeHookNoEvidenceAt = 0;
  let lastClaudeToolNoEvidenceAt = 0;
  let pendingClaudeHookDiagnosticTimer = null;
  let pendingClaudeHookDiagnosticOutput = '';
  let pendingClaudeToolDiagnosticTimer = null;
  let pendingClaudeToolDiagnosticOutput = '';

  function getClaudeHookDiagnosticDelayMs() {
    return Math.max(0, Number(processObj.env.AIH_CLAUDE_HOOK_DIAGNOSTIC_DELAY_MS) || 250);
  }

  function getClaudeDiagnosticNoEvidenceCooldownMs() {
    return Math.max(1000, Number(processObj.env.AIH_CLAUDE_DIAGNOSTIC_NO_EVIDENCE_COOLDOWN_MS) || 60_000);
  }

  function shouldPrintClaudeDiagnostic(diagnostic) {
    if (diagnostic && diagnostic.found) return true;
    return String(processObj.env.AIH_CLAUDE_DIAGNOSTIC_VERBOSE || '').trim() === '1'
      && String(processObj.env.AIH_CLAUDE_DIAGNOSTIC_STDOUT || '').trim() === '1';
  }

  function appendPendingClaudeDiagnosticOutput(currentOutput, nextOutput) {
    const joined = [currentOutput, nextOutput].filter(Boolean).join('\n');
    return joined.length > 4000 ? joined.slice(-4000) : joined;
  }

  function readActiveProfileEnv() {
    if (typeof getRuntimeEnv === 'function') {
      const runtimeEnv = getRuntimeEnv();
      if (runtimeEnv && typeof runtimeEnv === 'object') return runtimeEnv;
    }
    return {};
  }

  function buildClaudeDiagnosticIdentity() {
    if (cliName !== 'claude') return {};
    const env = readActiveProfileEnv();
    const anthropicBaseUrl = String(env.ANTHROPIC_BASE_URL || '').trim();
    const gateway = typeof isGateway === 'function' && isGateway() === true;
    const accountRef = typeof getAccountRef === 'function' ? String(getAccountRef() || '').trim() : '';
    const relay = gateway
      ? {
        kind: 'aih_server',
        baseUrl: anthropicBaseUrl,
        gateway: true,
        providerMode: 'auto'
      }
      : null;
    return {
      provider: 'claude',
      clientProvider: 'claude',
      ...(accountRef ? { accountRef } : {}),
      ...(gateway ? { gateway: true } : {}),
      ...(relay ? { relay } : {})
    };
  }

  function captureClaudeHookDiagnostic(triggerOutput) {
    if (cliName !== 'claude') return;
    const diagnostic = collectClaudeStopHookDiagnostics({
      fs,
      path,
      hostHomeDir,
      cwd: processObj.cwd(),
      sinceMs: Math.max(0, runtimeStartedAt - 60_000)
    });
    const latest = diagnostic && diagnostic.latest ? diagnostic.latest : null;
    const hasEvidence = Boolean(diagnostic && diagnostic.found);
    if (!hasEvidence) {
      const now = Date.now();
      if (now - lastClaudeHookNoEvidenceAt < getClaudeDiagnosticNoEvidenceCooldownMs()) return;
      lastClaudeHookNoEvidenceAt = now;
    }
    const signature = latest
      ? `${latest.transcriptPath || ''}:${latest.timestamp || ''}:${latest.toolUseID || ''}:${latest.stderr || ''}`
      : `no-evidence:${String(triggerOutput || '').slice(0, 240)}`;
    if (signature && signature === lastClaudeHookDiagnosticSignature) return;
    lastClaudeHookDiagnosticSignature = signature;
    const result = appendClaudeHookDiagnosticLog({
      fs,
      path,
      ...buildClaudeDiagnosticIdentity(),
      aiHomeDir,
      cwd: processObj.cwd(),
      cliPath: getCliPath(),
      forwardArgs: getForwardArgs(),
      triggerOutput,
      diagnostic
    });
    if (!result || !result.ok || !result.logPath) return;
    const evidenceText = diagnostic && diagnostic.found
      ? `transcript=${path.basename(latest.transcriptPath || '')}`
      : 'transcript evidence not found yet';
    if (!shouldPrintClaudeDiagnostic(diagnostic)) return;
    processObj.stdout.write(`\r\n\x1b[33m[aih]\x1b[0m Claude Stop hook diagnostic saved: ${result.logPath} (${evidenceText})\r\n`);
  }

  function captureClaudeToolDiagnostic(triggerOutput) {
    if (cliName !== 'claude') return;
    const diagnostic = collectClaudeToolProtocolDiagnostics({
      fs,
      path,
      hostHomeDir,
      cwd: processObj.cwd(),
      sinceMs: Math.max(0, runtimeStartedAt - 60_000)
    });
    const latest = diagnostic && diagnostic.latest ? diagnostic.latest : null;
    const hasEvidence = Boolean(diagnostic && diagnostic.found);
    if (!hasEvidence) {
      const now = Date.now();
      if (now - lastClaudeToolNoEvidenceAt < getClaudeDiagnosticNoEvidenceCooldownMs()) return;
      lastClaudeToolNoEvidenceAt = now;
    }
    const signature = latest
      ? `${latest.transcriptPath || ''}:${latest.timestamp || ''}:${latest.type || ''}:${latest.toolName || ''}:${latest.text || ''}`
      : `no-evidence:${String(triggerOutput || '').slice(0, 240)}`;
    if (signature && signature === lastClaudeToolDiagnosticSignature) return;
    lastClaudeToolDiagnosticSignature = signature;
    const result = appendClaudeToolDiagnosticLog({
      fs,
      path,
      ...buildClaudeDiagnosticIdentity(),
      aiHomeDir,
      cwd: processObj.cwd(),
      cliPath: getCliPath(),
      forwardArgs: getForwardArgs(),
      triggerOutput,
      diagnostic
    });
    if (!result || !result.ok || !result.logPath) return;
    const evidenceText = diagnostic && diagnostic.found
      ? `transcript=${path.basename(latest.transcriptPath || '')}`
      : 'transcript evidence not found yet';
    if (!shouldPrintClaudeDiagnostic(diagnostic)) return;
    processObj.stdout.write(`\r\n\x1b[33m[aih]\x1b[0m Claude tool protocol diagnostic saved: ${result.logPath} (${evidenceText})\r\n`);
  }

  function scheduleClaudeHookDiagnostic(data) {
    if (cliName !== 'claude') return;
    const plain = stripAnsi(String(data || ''));
    if (!containsClaudeStopHookJsonValidationError(plain)) return;
    pendingClaudeHookDiagnosticOutput = appendPendingClaudeDiagnosticOutput(pendingClaudeHookDiagnosticOutput, plain);
    if (pendingClaudeHookDiagnosticTimer) return;
    const delayMs = getClaudeHookDiagnosticDelayMs();
    pendingClaudeHookDiagnosticTimer = setTimeout(() => {
      const output = pendingClaudeHookDiagnosticOutput;
      pendingClaudeHookDiagnosticTimer = null;
      pendingClaudeHookDiagnosticOutput = '';
      if (isCleanedUp()) return;
      captureClaudeHookDiagnostic(output);
    }, delayMs);
    if (pendingClaudeHookDiagnosticTimer && typeof pendingClaudeHookDiagnosticTimer.unref === 'function') {
      pendingClaudeHookDiagnosticTimer.unref();
    }
  }

  function scheduleClaudeToolDiagnostic(data) {
    if (cliName !== 'claude') return;
    const plain = stripAnsi(String(data || ''));
    if (!containsClaudeToolProtocolProblem(plain)) return;
    pendingClaudeToolDiagnosticOutput = appendPendingClaudeDiagnosticOutput(pendingClaudeToolDiagnosticOutput, plain);
    if (pendingClaudeToolDiagnosticTimer) return;
    const delayMs = getClaudeHookDiagnosticDelayMs();
    pendingClaudeToolDiagnosticTimer = setTimeout(() => {
      const output = pendingClaudeToolDiagnosticOutput;
      pendingClaudeToolDiagnosticTimer = null;
      pendingClaudeToolDiagnosticOutput = '';
      if (isCleanedUp()) return;
      captureClaudeToolDiagnostic(output);
    }, delayMs);
    if (pendingClaudeToolDiagnosticTimer && typeof pendingClaudeToolDiagnosticTimer.unref === 'function') {
      pendingClaudeToolDiagnosticTimer.unref();
    }
  }

  function clearClaudeDiagnosticTimers() {
    if (pendingClaudeHookDiagnosticTimer) {
      clearTimeout(pendingClaudeHookDiagnosticTimer);
      pendingClaudeHookDiagnosticTimer = null;
    }
    if (pendingClaudeToolDiagnosticTimer) {
      clearTimeout(pendingClaudeToolDiagnosticTimer);
      pendingClaudeToolDiagnosticTimer = null;
    }
  }

  return {
    scheduleClaudeHookDiagnostic,
    scheduleClaudeToolDiagnostic,
    clearClaudeDiagnosticTimers
  };
}

module.exports = {
  createClaudeDiagnosticScheduler
};
