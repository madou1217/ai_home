'use strict';

// Canonical launch vocabulary (harness review plan, Phase 1).
//
// Before this, every entry point re-derived the same facts from each other: the
// harness was `input.harness || provider`, whether the identity provider's own CLI or
// an external harness was meant had to be inferred again from that, and each caller
// re-checked capabilities in its own order. resolveLaunchPlan answers it once, from
// descriptors, and returns either a complete plan or one stable error code.
//
//   identityProvider  the account's provider (whose credentials are used)
//   accountRef        persistent account id ('' = no account, e.g. gateway pool)
//   harnessId         what actually runs: identity provider's native CLI, or an external harness
//   harnessKind       'native' | 'external'
//   crossProvider     harness is not the identity provider (routes through the local gateway)
//   managedAppId      installer target for the harness (descriptor data, never re-mapped)
//   binaryName        executable the harness needs on PATH
//   kind / action     'cli' | 'desktop'  /  'open' | 'close'
//   model, terminalId, workdir   pass-through launch options
//
// Pure: it reads descriptors only, never the filesystem or account store.

const { getProviderCLIConfig, getProviderDefinition } = require('../provider-catalog');
const { getExternalHarness } = require('./catalog');

const KINDS = new Set(['cli', 'desktop']);
const ACTIONS = new Set(['open', 'close']);

function text(value) { return String(value == null ? '' : value).trim(); }
function lower(value) { return text(value).toLowerCase(); }

function failure(code, detail = {}) { return { ok: false, error: code, ...detail }; }

function resolveLaunchPlan(input = {}, options = {}) {
  const identityProvider = lower(input.provider);
  const kind = lower(input.kind);
  const action = lower(input.action) || 'open';
  if (!KINDS.has(kind)) return failure('unsupported_kind');
  if (!ACTIONS.has(action)) return failure('unsupported_action');

  // Harness defaults to the identity provider's own CLI only when none is named.
  const harnessId = lower(input.harness) || identityProvider;
  const external = getExternalHarness(harnessId);
  const identityCli = identityProvider ? getProviderCLIConfig(identityProvider) : null;
  if (!identityCli && !(kind === 'cli' && external)) return failure('unsupported_provider');
  const identityDefinition = identityProvider ? getProviderDefinition(identityProvider) : null;

  if (kind === 'desktop') {
    if (!identityDefinition || !identityDefinition.clients || !identityDefinition.clients.desktop) {
      return failure('desktop_not_supported');
    }
    return {
      ok: true,
      plan: Object.freeze({
        identityProvider,
        accountRef: text(input.accountRef),
        harnessId: identityProvider,
        harnessKind: 'native',
        crossProvider: false,
        managedAppId: identityProvider,
        // Same rule as the launcher's PATH probe: a provider without an explicit
        // binaryName is invoked by its id.
        binaryName: text(identityCli && identityCli.binaryName) || identityProvider,
        kind,
        action,
        model: '',
        terminalId: '',
        workdir: ''
      })
    };
  }

  const crossProvider = harnessId !== identityProvider;
  // The identity provider must itself declare a CLI only when it is the harness.
  if (!crossProvider && (!identityDefinition || !identityDefinition.clients || !identityDefinition.clients.cli)) {
    return failure('cli_not_supported');
  }
  const harnessCli = getProviderCLIConfig(harnessId) || (external ? { binaryName: external.binaryName } : null);
  const harnessDefinition = getProviderDefinition(harnessId) || (external ? { clients: { cli: true, desktop: false } } : null);
  if (!harnessCli || !harnessDefinition || !harnessDefinition.clients || !harnessDefinition.clients.cli) {
    return failure('cli_not_supported', { provider: harnessId, kind: 'cli' });
  }
  return {
    ok: true,
    plan: Object.freeze({
      identityProvider,
      accountRef: text(input.accountRef),
      harnessId,
      harnessKind: external ? 'external' : 'native',
      crossProvider,
      managedAppId: lower(external ? external.managedAppId : harnessId) || harnessId,
      binaryName: text(harnessCli.binaryName) || harnessId,
      kind,
      action,
      model: text(input.model),
      terminalId: lower(input.terminalId) || text(options.defaultTerminalId),
      workdir: text(input.workdir)
    })
  };
}

module.exports = { resolveLaunchPlan };
