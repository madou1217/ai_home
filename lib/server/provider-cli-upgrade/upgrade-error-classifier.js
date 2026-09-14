'use strict';

// 把一次安装失败归类。分类决定「算不算熔断」，这是防「静默自停」的关键一环。
//
// 最阴险的失败模式不是崩溃，而是功能一直报 healthy、实际什么都没做，漂移照旧扩大，
// 还带着一块绿色仪表盘。两类失败必须明确排除在熔断之外：
//   lock_busy —— Windows 上 npm 去 unlink 正在运行的 exe 必然 EPERM。实测过：
//     `npm i -g @openai/codex@…` 报 `EPERM: operation not permitted, unlink …\bin\codex.exe`。
//     这是常态不是故障，下个窗口重试即可。
//   network —— 安装 plan 强制 `--registry=registry.npmjs.org --userconfig=/dev/null`，
//     在走企业代理的机器上每次都会失败。若计入熔断，功能会在这类机器上永久自停。

const CATEGORIES = Object.freeze({
  LOCK_BUSY: 'lock_busy',
  NETWORK: 'network',
  NOT_FOUND: 'not_found',
  HARD_FAILURE: 'hard_failure'
});

// 计入熔断的只有 hard_failure。
const COUNTS_TOWARD_BREAKER = Object.freeze({
  [CATEGORIES.LOCK_BUSY]: false,
  [CATEGORIES.NETWORK]: false,
  [CATEGORIES.NOT_FOUND]: false,
  [CATEGORIES.HARD_FAILURE]: true
});

const PATTERNS = Object.freeze([
  [CATEGORIES.LOCK_BUSY, /\bEPERM\b|\bEBUSY\b|\bETXTBSY\b|operation not permitted|being used by another process|resource busy|access is denied/i],
  [CATEGORIES.NOT_FOUND, /\bE404\b|No matching version found|is not in this registry|version not found|404 Not Found/i],
  [CATEGORIES.NETWORK, /\bENOTFOUND\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bECONNRESET\b|\bEAI_AGAIN\b|\bENETUNREACH\b|network|proxy|tunneling socket|registry\b.*(unreachable|failed)|\b(407|502|503|504)\b/i]
]);

function classifyInstallFailure(result = {}) {
  // 顺序要紧：not_found 的文案里常常也带着 registry 字样，必须先于 network 判定。
  const text = [result.error, result.stderr, result.stdout]
    .map((part) => String(part == null ? '' : part))
    .join('\n');

  for (const [category, pattern] of PATTERNS) {
    if (pattern.test(text)) {
      return { category, countsTowardBreaker: COUNTS_TOWARD_BREAKER[category], evidence: text.slice(0, 500) };
    }
  }
  return {
    category: CATEGORIES.HARD_FAILURE,
    countsTowardBreaker: true,
    evidence: text.slice(0, 500)
  };
}

module.exports = { CATEGORIES, COUNTS_TOWARD_BREAKER, classifyInstallFailure };
