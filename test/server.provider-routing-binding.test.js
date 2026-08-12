const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRequestProvider } = require('../lib/server/provider-routing');
const { buildModelAccountIndex } = require('../lib/server/model-account-index');

const THINKING_MODEL = 'claude-opus-4-6-thinking';
const BASE_MODEL = 'claude-opus-4-6';

function account(accountRef, extra = {}) {
  return {
    accountRef,
    accessToken: 'token',
    schedulableStatus: 'schedulable',
    apiKeyMode: true,
    ...extra
  };
}

/**
 * agy 账号真的绑定了 `-thinking` 变体；claude 账号只有基础模型。
 * byProvider.claude 被一个已删除账号的目录污染成「也有 thinking 变体」——
 * 这正是线上抓到的现场。
 */
function buildState({ agyModels = [THINKING_MODEL], claudeModels = [BASE_MODEL], agyAccountExtra = {} } = {}) {
  const state = {
    accounts: {
      agy: [account('acct_aaaaaaaaaaaaaaaaaaaa', agyAccountExtra)],
      claude: [account('acct_cccccccccccccccccccc')]
    },
    webUiModelsCache: {
      byAccount: {
        acct_aaaaaaaaaaaaaaaaaaaa: agyModels,
        acct_cccccccccccccccccccc: claudeModels
      },
      byProvider: {
        agy: agyModels,
        // 已删除账号留下的陈旧并集：provider 级目录声称 claude 也有 thinking 变体。
        claude: [BASE_MODEL, THINKING_MODEL]
      }
    }
  };
  state.modelAccountIndex = buildModelAccountIndex(state, {});
  return state;
}

test('a live per-account binding beats the stale provider-level union', () => {
  const state = buildState();
  assert.equal(
    resolveRequestProvider({}, { model: THINKING_MODEL }, {}, state),
    'agy'
  );
});

// 同族加成只该在同分时裁决，不该把请求从真正提供该模型的 provider 拽走。
test('the family bonus still wins when both providers are bound to the model', () => {
  const state = buildState({ agyModels: [BASE_MODEL], claudeModels: [BASE_MODEL] });
  assert.equal(
    resolveRequestProvider({}, { model: BASE_MODEL }, {}, state),
    'claude'
  );
});

// 绑定账号全被熔断时仍留在 agy：拿一个诚实的 429，好过甩到必定 404 的 claude。
test('a cooled-down binding still beats a provider with no binding at all', () => {
  const state = buildState({
    agyAccountExtra: { cooldownUntil: Date.now() + 60_000 }
  });
  assert.equal(
    resolveRequestProvider({}, { model: THINKING_MODEL }, {}, state),
    'agy'
  );
});

// 索引没热时没有逐账号事实可用，必须原样保留旧的缓存+注册表打分。
test('a cold index preserves the cache-based provider scoring', () => {
  const state = buildState();
  state.modelAccountIndex = { builtAt: 0, modelToAccounts: new Map(), accountByRef: new Map() };
  assert.equal(
    resolveRequestProvider({}, { model: THINKING_MODEL }, {}, state),
    'claude'
  );
});

test('explicit provider selection still overrides model bindings', () => {
  const state = buildState();
  assert.equal(
    resolveRequestProvider({}, { model: THINKING_MODEL }, { 'x-provider': 'claude' }, state),
    'claude'
  );
  assert.equal(
    resolveRequestProvider({ provider: 'claude' }, { model: THINKING_MODEL }, {}, state),
    'claude'
  );
});

// 谁都没绑定这个模型时退回按模型名推断，不能因为索引热了就返回空。
test('an unbound model falls back to family inference', () => {
  const state = buildState();
  assert.equal(
    resolveRequestProvider({}, { model: 'claude-sonnet-9-unknown' }, {}, state),
    'claude'
  );
});
