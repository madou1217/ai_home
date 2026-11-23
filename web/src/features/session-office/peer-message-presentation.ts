import type {
  EnrichedPeerMessage,
  LegacyMailCategoryId,
  PeerFieldProvenance,
  PeerJargonHint,
  PeerMessageRecord,
  ReadableMailPresentation,
  ReadablePartySummary,
  ResolvedPeerEndpoint,
  ResolvedReplyPolicyKind,
} from './session-office-types';

export const DEFAULT_AUTO_DELIVER_HORIZON_MS = 30 * 60 * 1000;

export type MailLifecycleStatusKind =
  | 'canceled'
  | 'expired'
  | 'failed'
  | 'manual'
  | 'stale'
  | 'waiting'
  | 'ready'
  | 'delivered'
  | 'read';

export interface EvaluatedMailLifecycle {
  kind: MailLifecycleStatusKind;
  label: string;
  shortLabel: string;
  ledTone: 'ok' | 'info' | 'warn' | 'err' | 'neutral';
  pillTone: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
  isUndelivered: boolean;
  isStaleOrManual: boolean;
  isAttention: boolean;
  isPastSemanticExpiry: boolean;
  sentAbsoluteText: string;
  sentCompactText: string;
  deliveredAbsoluteText: string;
  deliveredCompactText: string;
  readAbsoluteText: string;
  validitySummary: string;
  processingCaveat: string;
  attemptCount: number;
  probeCount: number | null;
}

export interface ExplicitReplyChainNode {
  message: EnrichedPeerMessage;
  depth: number;
  isCurrent: boolean;
  parentShortId: string;
  parentMissing: boolean;
}

export interface ExplicitReplyChain {
  hasExplicitChain: boolean;
  rootMissingShortId: string;
  nodes: ExplicitReplyChainNode[];
}

const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  codexchat: 'Codex Chat',
  gemini: 'Gemini',
  agy: 'AGY',
  antigravity: 'AGY',
  opencode: 'OpenCode',
  codebuddy: 'CodeBuddy',
  codebuddycn: 'CodeBuddy CN',
  workbuddy: 'WorkBuddy',
  workbuddycn: 'WorkBuddy CN',
  qoder: 'Qoder',
  qodercn: 'Qoder CN',
  kimi: 'Kimi',
  kiro: 'Kiro',
  grok: 'Grok',
  cline: 'Cline',
  zcode: 'ZCode',
  shell: 'Shell',
  zsh: 'zsh',
  bash: 'bash',
};

const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_INLINE_RE = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PM_ID_EXACT_RE = /^pm[_-][a-z0-9_-]{6,}$/i;
const PM_ID_INLINE_RE = /\bpm[_-]([a-z0-9]{6})[a-z0-9_-]{2,}\b/gi;
const NATIVE_KEY_INLINE_RE = /\bnative:([a-z0-9_-]+):([0-9a-f]{8})[0-9a-f-]{6,}\b/gi;
const SHELL_KEY_EXACT_RE = /^shell-[0-9a-f]{12,}$/i;
const SHELL_KEY_INLINE_RE = /\bshell-([0-9a-f]{8})[0-9a-f]{6,}\b/gi;
const LONG_HEX_EXACT_RE = /^[0-9a-f]{16,}$/i;
const LONG_PATH_INLINE_RE = /(?:\/[\w.@+-]+){4,}/g;

export function formatAbsoluteTimestamp(ms: number | undefined | null): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatCompactAbsoluteTimestamp(ms: number | undefined | null): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatProviderDisplayName(rawProvider: string | undefined | null): string {
  const trimmed = String(rawProvider ?? '').trim();
  if (!trimmed) return '会话';
  const normalized = trimmed.toLowerCase();
  const mapped = PROVIDER_DISPLAY_NAMES[normalized];
  if (mapped) return mapped;
  return trimmed.length <= 16 ? trimmed : `${trimmed.slice(0, 15)}…`;
}

export function isOpaqueMachineToken(rawValue: string | undefined | null): boolean {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) return false;
  if (UUID_EXACT_RE.test(trimmed)) return true;
  if (PM_ID_EXACT_RE.test(trimmed)) return true;
  if (SHELL_KEY_EXACT_RE.test(trimmed)) return true;
  if (LONG_HEX_EXACT_RE.test(trimmed)) return true;
  if (/^(?:native|web-terminal):/i.test(trimmed)) return true;
  return false;
}

export function shortenMachineIdentifier(rawValue: string | undefined | null): string {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) return '';
  if (UUID_EXACT_RE.test(trimmed)) return trimmed.slice(0, 8);
  const nativeMatch = trimmed.match(/^native:[^:]+:(.+)$/i);
  if (nativeMatch && nativeMatch[1]) {
    const inner = nativeMatch[1].trim();
    return inner.length > 8 ? inner.slice(0, 8) : inner;
  }
  const webTermMatch = trimmed.match(/^web-terminal:(.+)$/i);
  if (webTermMatch && webTermMatch[1]) {
    return shortenMachineIdentifier(webTermMatch[1]);
  }
  const shellMatch = trimmed.match(/^shell-([0-9a-f]{8})/i);
  if (shellMatch && shellMatch[1]) return shellMatch[1];
  const pmMatch = trimmed.match(/^pm[_-]([a-z0-9]{6,8})/i);
  if (pmMatch && pmMatch[1]) return pmMatch[1];
  if (trimmed.length <= 10) return trimmed;
  return trimmed.slice(0, 8);
}

/**
 * Softens inline UUIDs, pm_ IDs, native session keys, and deep filesystem paths
 * strictly for human-readable display excerpts. Never used on raw.body or CLI commands.
 */
export function softenInlineTechnicalTokens(input: string): string {
  if (!input) return '';
  return input
    .replace(NATIVE_KEY_INLINE_RE, (_full, provider: string, shortUuid: string) => (
      `${formatProviderDisplayName(provider)}#${shortUuid}`
    ))
    .replace(UUID_INLINE_RE, '$1…')
    .replace(PM_ID_INLINE_RE, '#$1')
    .replace(SHELL_KEY_INLINE_RE, 'shell#$1')
    .replace(LONG_PATH_INLINE_RE, (fullPath: string) => {
      if (fullPath.length <= 42) return fullPath;
      const parts = fullPath.split('/').filter(Boolean);
      if (parts.length <= 3) return fullPath;
      return `…/${parts.slice(-2).join('/')}`;
    });
}

function truncateReadableText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, maxChars - 1).trimEnd();
  return `${slice}…`;
}

function cleanStationOrPartyName(
  rawName: string,
  providerLabel: string,
  projectName: string | null,
): string {
  const trimmed = rawName.trim();
  if (!trimmed || isOpaqueMachineToken(trimmed)) return '';

  if (trimmed.includes(' · ')) {
    const keptParts: string[] = [];
    for (const rawPart of trimmed.split(' · ')) {
      const part = rawPart.trim();
      if (!part) continue;
      if (projectName && part === projectName) continue;
      if (isOpaqueMachineToken(part)) continue;
      keptParts.push(softenInlineTechnicalTokens(part));
    }
    if (keptParts.length > 0) {
      return truncateReadableText(keptParts.join(' · '), 28);
    }
    return providerLabel;
  }

  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    const segments = trimmed.split(/[\\/]+/).filter(Boolean);
    const leaf = segments[segments.length - 1] || trimmed;
    return truncateReadableText(leaf, 24);
  }

  return truncateReadableText(softenInlineTechnicalTokens(trimmed), 28);
}

export function buildReadablePartySummary(endpoint: ResolvedPeerEndpoint): ReadablePartySummary {
  const { party } = endpoint;
  const providerLabel = formatProviderDisplayName(party.provider);
  const fullIdentity = (
    endpoint.sessionKey
    || party.sessionId
    || endpoint.sessionId
    || party.address
    || party.name
    || ''
  ).trim();
  const rawIdCandidate = party.sessionId || endpoint.sessionId || endpoint.sessionKey || party.address || '';
  const shortId = shortenMachineIdentifier(rawIdCandidate);
  const shortIdentity = shortId ? `#${shortId}` : '';

  const hasKnownProject = Boolean(
    endpoint.projectName
    && endpoint.projectName !== '未指定目录'
    && endpoint.projectKey
    && endpoint.projectKey !== '__no_cwd__',
  );
  const projectLabel = hasKnownProject
    ? endpoint.projectName!
    : endpoint.isExternalOrHistorical
      ? '外部/历史会话'
      : (endpoint.projectName || '未指定目录');

  const explicitHumanName = cleanStationOrPartyName(party.name, providerLabel, endpoint.projectName);
  const stationHumanName = endpoint.sessionLabel
    ? cleanStationOrPartyName(endpoint.sessionLabel, providerLabel, endpoint.projectName)
    : '';

  let shortName = explicitHumanName || stationHumanName;
  if (!shortName) {
    if (party.address && !isOpaqueMachineToken(party.address)) {
      shortName = cleanStationOrPartyName(party.address, providerLabel, endpoint.projectName);
    }
  }
  if (!shortName) {
    shortName = shortId ? `${providerLabel} ${shortId.slice(0, 6)}` : providerLabel;
  }

  return {
    shortName,
    providerLabel,
    projectLabel,
    hasKnownProject,
    shortIdentity,
    fullIdentity: fullIdentity || '未提供',
    isOnlineInOffice: !endpoint.isExternalOrHistorical && Boolean(endpoint.sessionKey),
  };
}

interface ExtractedLegacyHeaders {
  subject?: string;
  summary?: string;
  purpose?: string;
  action?: string;
  remainingLines: string[];
}

const HEADER_LINE_RE = /^(subject|title|主题|标题|summary|摘要|概述|purpose|why|reason|联系目的|目的|原因|action|action\s+required|所需行动|需要操作|待办)\s*[:：]\s*(.+)$/i;
const BODY_ACTION_LINE_RE = /^(?:[-*•]\s*)?(action|action\s+required|所需行动|需要操作|待办)\s*[:：]\s*(.+)$/i;
const EMPTY_HEADER_ACTION_RE = /^(?:none|n\/a|nil|null|无|暂无|无待办|无需操作|无须操作|不用操作|不需要操作|-+)$/i;

function extractExplicitBodyHeaders(rawBody: string): ExtractedLegacyHeaders {
  const normalized = rawBody.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return { remainingLines: [] };
  }

  const lines = normalized.split('\n');
  let inCodeFence = false;
  let scanningHeaders = true;
  const result: ExtractedLegacyHeaders = { remainingLines: [] };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      scanningHeaders = false;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    if (!trimmed) {
      if (result.remainingLines.length > 0) {
        scanningHeaders = false;
      }
      continue;
    }
    if (/^[-=_*]{3,}$/.test(trimmed)) {
      continue;
    }

    if (scanningHeaders && result.remainingLines.length === 0) {
      const headerMatch = trimmed.match(HEADER_LINE_RE);
      if (headerMatch) {
        const key = headerMatch[1].toLowerCase().replace(/\s+/g, ' ');
        const val = headerMatch[2].trim();
        if (val) {
          if (key === 'subject' || key === 'title' || key === '主题' || key === '标题') {
            if (!result.subject) result.subject = val;
            continue;
          }
          if (key === 'summary' || key === '摘要' || key === '概述') {
            if (!result.summary) result.summary = val;
            continue;
          }
          if (key === 'purpose' || key === 'why' || key === 'reason' || key === '联系目的' || key === '目的' || key === '原因') {
            if (!result.purpose) result.purpose = val;
            continue;
          }
          if (key === 'action' || key === 'action required' || key === '所需行动' || key === '需要操作' || key === '待办') {
            if (!result.action) result.action = val;
            // Preserve Chinese legacy lines like "待办：..." in remainingLines as well so
            // primary-clause category/summary parsing and inline no-ACK detection remain intact.
            if (key === '待办' || key === '需要操作' || key === '所需行动') {
              result.remainingLines.push(val);
              scanningHeaders = false;
            }
            continue;
          }
        }
      }
    }

    if (!trimmed.startsWith('>') && !result.action) {
      const bodyActionMatch = trimmed.match(BODY_ACTION_LINE_RE);
      if (bodyActionMatch && bodyActionMatch[2].trim()) {
        result.action = bodyActionMatch[2].trim();
      }
    }

    scanningHeaders = false;
    result.remainingLines.push(trimmed);
  }

  if (result.remainingLines.length === 0 && result.action) {
    result.remainingLines.push(result.action);
  }

  return result;
}

/**
 * Strips fenced code blocks, inline code spans, markdown blockquotes, and quoted spans
 * so quoted or negated examples never falsely trigger category or no-reply rules.
 */
function stripCodeAndQuotes(lines: string[]): string {
  const nonQuoteLines = lines
    .filter((line) => !line.startsWith('>'))
    .map((line) => line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
      .trim())
    .filter(Boolean);

  return nonQuoteLines
    .join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/'[^'\n]*'/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/‘[^’\n]*’/g, ' ')
    .replace(/「[^」\n]*」/g, ' ')
    .replace(/『[^』\n]*』/g, ' ');
}

interface LegacyCategoryClassification {
  category: LegacyMailCategoryId;
  title: string;
  purpose: string;
  summary: string;
}

const BROWSER_TERM_RE = /(?:Edge|浏览器|browser|窗口|bridge|daemon|run-code|tab\d*)/i;
const NO_REPLY_REJECT_RE = /(?:并非|不是|不能|不可|不要|切勿|禁止|不得|未说|没说|不确定|是否|如果|若|除非|待定|尚不|未必)/;
const REQUEST_REJECT_RE = /(?:并非|不是|不用|无需|无须|不必|不需要|不要请|切勿请|不确定是否要)/;
const POSITIVE_NO_REPLY_RE = /(?:无需\s*ACK|无须\s*ACK|不用\s*ACK|不必\s*ACK|不需要\s*ACK|无需回复|无须回复|不用回复|不必回复|不需要回复|无需回执|无须回执|不用回执|不必回执)/i;

/**
 * Conservative primary-clause classifier for historical unstructured messages.
 * Evaluates only the primary opening window (first 1-2 sentences / <= 210 chars)
 * so incidental browser mentions at the end of a long report do not hijack the category.
 */
function classifyLegacyPrimaryCategory(unquotedText: string): LegacyCategoryClassification | null {
  const compactText = unquotedText.replace(/\s+/g, ' ').trim();
  if (!compactText) return null;

  const sentences = unquotedText
    .split(/[。！？!?；;\n]+/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (sentences.length === 0) return null;

  const leadSentence = sentences[0].slice(0, 140);
  const primaryWindow = sentences.slice(0, 2).join('；').slice(0, 210);

  // 1. 迟到旧消息的状态对账
  if (
    /(?:迟到|滞后|延迟(?:送达|到达)|旧消息|历史消息|早先消息|此前消息|状态对账|补充对账|乱序|过时消息)/i.test(primaryWindow)
    || /(?:刚收到|才收到|收到你(?:刚才|此前|早先|之前))[^。；\n]{0,36}(?:pm[_-]|消息|询问|通知|请求|申请)/i.test(primaryWindow)
    || /(?:针对|回复)(?:你)?(?:此前|早先|之前|刚才)[^。；\n]{0,32}(?:排队|迟到|旧|询问|申请)[^。；\n]{0,32}(?:当前|现状|早已|已经|对账)/i.test(primaryWindow)
  ) {
    const mentionsNoBrowserNow =
      BROWSER_TERM_RE.test(compactText)
      && /(?:未占用|不占|已释放|未发\s*browser|没有浏览器操作|inflight\s*=?\s*0)/i.test(compactText);
    return {
      category: 'late-status-reconciliation',
      title: '迟到旧消息的状态对账',
      purpose: '状态对账（系统归类）',
      summary: mentionsNoBrowserNow
        ? '发送方针对较早或延迟送达的消息对账当前状态，表示本会话当前未占用共享浏览器（仅为发送方自述，不代表全桥已验证空闲）。'
        : '发送方针对较早或延迟送达的消息补充说明当前状态，供收件会话核对前后顺序（仅为发送方自述，详情请核对原文）。',
    };
  }

  // 2. 撤回浏览器申请
  if (
    /(?:不再申请|撤回|取消申请|放弃申请|无需再申请|不再借用)[^。；\n]{0,44}(?:Edge|浏览器|browser|窗口|串行|接入|daemon|bridge)/i.test(primaryWindow)
    || /(?:Edge|浏览器|browser|窗口|串行接入)[^。；\n]{0,32}(?:不再申请|申请撤回|请求撤回|已撤回)/i.test(primaryWindow)
  ) {
    return {
      category: 'browser-withdraw',
      title: '撤回浏览器使用申请',
      purpose: '浏览器资源协调（系统归类）',
      summary: '发送方表示不再申请共享浏览器窗口并撤回此前接入请求，当前未执行浏览器操作（正文声明撤回不证明原排队通知已实际取消）。',
    };
  }

  // 3. 浏览器使用结束与交接 (checked on opening primary window only)
  if (
    BROWSER_TERM_RE.test(primaryWindow)
    && (
      /(?:已结束并释放|验收已结束并释放|使用已结束|操作已结束|(?:已|现|现在)?(?:释放|归还|让出|交接)(?:共享)?(?:浏览器|Edge|窗口|操作权)|释放给你|交接给你)/i.test(primaryWindow)
      || /(?:浏览器|Edge|窗口|browser)[^。；\n]{0,20}(?:已结束|已释放|释放|交接|归还|使用完毕|操作完毕)/i.test(leadSentence)
    )
    && !/(?:证据已补齐|报告会如实写)/i.test(leadSentence)
  ) {
    return {
      category: 'browser-release',
      title: '浏览器使用结束，通知交接',
      purpose: '浏览器资源协调（系统归类）',
      summary: '发送方表示本会话的浏览器操作已结束并通知交接（这是发送方自述，不代表全桥已验证空闲）。',
    };
  }

  // 4. 确认没有本会话浏览器操作
  if (
    BROWSER_TERM_RE.test(primaryWindow)
    && (
      /(?:未发|未执行|没有发|没有执行|未进行|没有操作|未操作|未使用|未占用|没有占用|未触碰|全程未触碰|不并发操作|维持冻结|无任何?浏览器操作|没有浏览器操作)[^。；\n]{0,34}(?:browser|浏览器|Edge|commands?|命令|页面|窗口|reload|run-code)?/i.test(primaryWindow)
      && (
        /(?:未发|未执行|没有发|没有执行|未操作|没有操作|未占用|没有占用|未触碰|不并发操作|维持冻结|无任何?浏览器操作|没有浏览器操作)[^。；\n]{0,34}(?:browser|浏览器|Edge|commands?|页面|窗口|reload|run-code)/i.test(primaryWindow)
        || /(?:本线|本会话|我线|当前会话)[^。；\n]{0,26}(?:browser\s*inflight\s*=\s*0|inflight\s*=\s*0|维持冻结|未操作浏览器|无在途浏览器|没有浏览器操作|无任何浏览器操作)/i.test(primaryWindow)
      )
    )
  ) {
    return {
      category: 'browser-no-operation',
      title: '说明本会话没有浏览器操作',
      purpose: '浏览器资源协调（系统归类）',
      summary: '发送方说明本会话当前没有执行共享浏览器操作，不会并发操作对方页面（仅反映本会话自述，不证明其他会话或全桥空闲）。',
    };
  }

  // 5. 浏览器正在被占用
  if (
    /(?:正在使用|正使用|正在占用|当前占用|正在操作|正操作|正在执行|使用中|占用中|持有)[^。；\n]{0,48}(?:Edge|浏览器|browser|窗口|tab\d*|daemon|bridge)/i.test(primaryWindow)
    || /(?:Edge|浏览器|browser|窗口)[^。；\n]{0,28}(?:正在被占用|正在使用|占用中|使用中|仍有[^。；\n]{0,20}inflight|尚在运行)/i.test(primaryWindow)
    || (BROWSER_TERM_RE.test(primaryWindow) && /(?:请暂勿并行|请勿并行|暂勿操作浏览器|请先不要操作)/i.test(compactText))
  ) {
    const asksHoldOff = /(?:请暂勿|请勿并行|暂勿并行|不要碰|请先不要|请等待)/i.test(compactText);
    return {
      category: 'browser-occupied',
      title: '浏览器正在被占用',
      purpose: '浏览器资源协调（系统归类）',
      summary: asksHoldOff
        ? '发送方称正在使用共享浏览器，请收件会话暂不并行操作。'
        : '发送方称当前正在使用共享浏览器，待操作结束后再通知交接。',
    };
  }

  // 6. 浏览器使用申请/询问占用
  if (
    /(?:申请|请求|准备|计划|拟|需要|排队|先协调)[^。；\n]{0,28}(?:使用|借用|接入|操作|连接|占用|窗口)?[^。；\n]{0,28}(?:Edge|浏览器|browser|窗口|daemon|bridge)/i.test(primaryWindow)
    || /(?:Edge|浏览器|browser|窗口|bridge|daemon)[^。；\n]{0,32}(?:是否空闲|是否占用|是否在用|有无占用|谁在用|还在用|可否使用|能否使用|可以用吗|能否借用|询问占用|是否有[^。；\n]{0,16}(?:使用|占用))/i.test(primaryWindow)
    || /(?:询问|请问|确认|核实)[^。；\n]{0,28}(?:Edge|浏览器|browser|窗口|bridge)[^。；\n]{0,28}(?:占用|空闲|使用|状态|inflight)/i.test(primaryWindow)
  ) {
    return {
      category: 'browser-request-or-query',
      title: '浏览器使用申请/询问占用',
      purpose: '浏览器资源协调（系统归类）',
      summary: '发送方申请按序使用共享浏览器，或询问当前共享浏览器是否被占用。',
    };
  }

  // 7. 代码文件占用核实
  if (
    !/(?:接单|已接收任务|收到任务|收到派单)/i.test(primaryWindow)
    && (
      /(?:核实|询问|请问|确认|核查|同步)[^。；\n]{0,30}(?:代码|文件|目录|工作区|worktree|dirty|未提交修改|改动|修改)[^。；\n]{0,24}(?:占用|归属|边界|冲突|属于|持有|谁在改|是否在改)/i.test(primaryWindow)
      || /(?:代码文件占用|文件占用核实|目录占用|文件归属核实|代码归属|修改边界|未改动你的文件|未触碰你的文件|是否在改.*文件)/i.test(primaryWindow)
    )
  ) {
    return {
      category: 'code-file-ownership-check',
      title: '代码文件占用核实',
      purpose: '代码与工作区协调（系统归类）',
      summary: '发送方就共享工作区中的代码文件占用或修改边界进行核实与说明（具体文件路径请核对原文）。',
    };
  }

  // 8. 接收任务与范围确认
  if (
    /(?:原会话接单|接单|已接收任务|收到任务|收到派单|接收任务|确认接收[^。；\n]{0,20}任务|确认接手|开始接手)/i.test(primaryWindow)
    || (
      /(?:已按顺序读取|已读取|已审阅|收到[^。；\n]{0,20}(?:交接|指令|任务|派单)|确认按[^。；\n]{0,20}范围)/i.test(leadSentence)
      && /(?:仅做|仅改|只做|只改|不碰|不改|范围|边界|开始实现|开始执行)/i.test(primaryWindow)
    )
  ) {
    return {
      category: 'task-ack-and-scope',
      title: '接收任务与范围确认',
      purpose: '任务交接与范围确认（系统归类）',
      summary: '发送方表示已读取交接说明并接收任务，确认本次执行范围与不改动边界，完成后再回报结果。',
    };
  }

  // 9. 任务进度/交付回报
  if (
    /(?:证据已补齐|已完成|已修复|已实现|已更新|已补齐|已提交|已验证|已核查|已整理完毕|已跑通|阶段回报|进度回报|交付回报|回报当前|回报进展|回报结果|报告如下|同步[^。；\n]{0,16}(?:进度|进展|结果|结论)|排查结论|排查结果|审查结果|复审结果|核查结论|回归结果|自测结果)/i.test(primaryWindow)
    || /(?:报告会如实写|验收证据|静态证据|回归|编译通过|类型检查|契约文档|mock)/i.test(primaryWindow)
  ) {
    const clauses: string[] = ['发送方报告当前任务的执行与核查进展'];
    if (/(?:失响应|超时|阻塞|异常|偶发)/i.test(compactText)) {
      clauses.push('记录了验证过程中的现象与限制');
    }
    if (/(?:请你?(?:派其|安排|协助)?复审|请复审|提交复审)/i.test(compactText)) {
      clauses.push('请求协助安排复审');
    }
    if (/(?:浏览器(?:操作|窗口|使用)?(?:现在|已)?释放给你|释放给你，不再操作|不再操作浏览器)/i.test(compactText)) {
      clauses.push('并表示本会话已释放浏览器操作');
    }
    return {
      category: 'task-progress-report',
      title: '任务进度回报',
      purpose: '任务进度回报（系统归类）',
      summary: `${clauses.join('，')}（仅为发送方自述记录，不代表最终独立验收通过；详情请核对原文）。`,
    };
  }

  return null;
}

interface InferredLegacyAction {
  requestedAction: string;
  explicitNoReply: boolean;
}

function inferLegacyRecipientAction(unquotedText: string): InferredLegacyAction {
  const clauses = unquotedText
    .split(/[。！？!?；;，,\n]+/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let hasPositiveNoReply = false;
  let detectedRequest = '';

  for (const clause of clauses) {
    const isPositiveNoReply = !NO_REPLY_REJECT_RE.test(clause) && POSITIVE_NO_REPLY_RE.test(clause);
    if (isPositiveNoReply) {
      hasPositiveNoReply = true;
    }

    if (detectedRequest) continue;

    const clauseForRequest = isPositiveNoReply
      ? clause
        .replace(new RegExp(POSITIVE_NO_REPLY_RE.source, 'gi'), ' ')
        .replace(/[()（）,，;；\s]+/g, ' ')
        .trim()
      : clause;
    if (!clauseForRequest) continue;

    // Request 1: Hold off parallel browser commands
    if (
      !/(?:并非|不是|不确定|是否|如果|若|除非)/.test(clauseForRequest)
      && (
        /请(?:暂勿|勿|先不要|不要)(?:并行|并发)?(?:执行|发|操作|使用)?[^。；\n]{0,20}(?:browser|浏览器|Edge)/i.test(clauseForRequest)
        || /^不要碰\s*tab\d*/i.test(clauseForRequest)
      )
    ) {
      detectedRequest = '请收件会话暂勿并行执行浏览器操作（发送方请求）';
      continue;
    }

    if (REQUEST_REJECT_RE.test(clauseForRequest)) continue;

    // Request 2: Reply about browser occupancy
    if (
      /请(?:问|告知|确认|回复|说明)[^。；\n]{0,28}(?:Edge|浏览器|browser|窗口|bridge)[^。；\n]{0,24}(?:占用|空闲|在用|使用|状态|inflight)/i.test(clauseForRequest)
      || /空闲后请(?:告知|回复|通知)/i.test(clauseForRequest)
    ) {
      detectedRequest = '请收件会话说明当前共享浏览器占用情况或空闲后告知（发送方请求）';
      continue;
    }

    // Request 3: File ownership check
    if (
      /请(?:问|告知|确认|核实|回复)[^。；\n]{0,28}(?:代码|文件|目录|dirty|修改|改动)/i.test(clauseForRequest)
    ) {
      detectedRequest = '请收件会话核实相关代码文件占用或修改范围（发送方请求）';
      continue;
    }

    // Request 4: Review or verification check
    if (
      /请(?:你)?(?:派其|安排|协助)?复审/i.test(clauseForRequest)
      || /请(?:核对|核查|审阅)[^。；\n]{0,20}(?:结果|证据|报告|改动)/i.test(clauseForRequest)
    ) {
      detectedRequest = '请收件会话协助安排复审或核对结果（发送方请求，仅限原批准任务范围）';
    }
  }

  return {
    requestedAction: detectedRequest,
    explicitNoReply: hasPositiveNoReply,
  };
}

/**
 * Aggressively strips dense machine tokens, file paths, key=value pairs, and metrics
 * for unknown legacy messages so raw jargon strings never masquerade as readable prose.
 */
function buildUnknownLegacyFallback(unquotedText: string): {
  title: string;
  summary: string;
  hasReadableClause: boolean;
} {
  const cleaned = unquotedText
    .replace(/(?:\/[\w.@+-]+){2,}/g, ' ')
    .replace(/\b[\w.-]+\.(?:tsx?|jsx?|vue|css|json|md|go|py|sh|ya?ml)\b/gi, ' ')
    .replace(/\b[a-zA-Z0-9_.-]+=[^\s，。；;,）)]+/g, ' ')
    .replace(/\bpm[_-][a-z0-9_-]{4,}\b/gi, ' ')
    .replace(UUID_INLINE_RE, ' ')
    .replace(NATIVE_KEY_INLINE_RE, ' ')
    .replace(SHELL_KEY_INLINE_RE, ' ')
    .replace(/\bdaemon\d+\b/gi, ' ')
    .replace(/\binflight\d*\b/gi, ' ')
    .replace(/\b\d+(?:GET|POST|PUT|DELETE)\b/g, ' ')
    .replace(/\b[0-9a-f]{7,}\b/gi, ' ')
    .replace(/[()（）[\]【】/\\|+_=<>~`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const clauses = cleaned
    .split(/[。！？!?；;，,\n]+/)
    .map((part) => part.trim())
    .filter((part) => (part.match(/[\u4e00-\u9fff]/g) || []).length >= 4);

  if (clauses.length === 0) {
    return {
      title: '未归类消息（请核对原文）',
      summary: '发送方发来未结构化的技术记录片段，系统未做猜测性归类，请直接核对下方完整原始正文。',
      hasReadableClause: false,
    };
  }

  const shortTitle = truncateReadableText(clauses[0], 34);
  const shortExcerpt = truncateReadableText(clauses.slice(0, 2).join('，'), 96);
  return {
    title: shortTitle,
    summary: `发送方表示：${shortExcerpt}（系统未归入固定类别，完整上下文请核对原文）。`,
    hasReadableClause: true,
  };
}

function collectStableJargonHints(rawBody: string): ReadonlyArray<PeerJargonHint> {
  if (!rawBody) return [];
  const hints: PeerJargonHint[] = [];
  if (/\bACK\b/i.test(rawBody)) {
    hints.push({ term: 'ACK', meaning: '确认回执' });
  }
  if (/\bbrowser\s+commands?\b/i.test(rawBody)) {
    hints.push({ term: 'browser commands', meaning: '浏览器操作命令' });
  }
  if (/\binflight(?:=?\d+)?\b/i.test(rawBody)) {
    hints.push({ term: 'inflight', meaning: '在途操作数（0 表示当前无在途操作）' });
  }
  if (/\b(?:daemon\d*|bridge)\b/i.test(rawBody)) {
    hints.push({ term: 'daemon / bridge', meaning: '共享浏览器连接桥' });
  }
  if (/\bPASS\b/.test(rawBody)) {
    hints.push({ term: 'PASS', meaning: '发送方自报记录标记（不代表独立验收通过）' });
  }
  return hints;
}

function resolveExplicitReplyPolicy(rawPolicy: string | undefined): {
  kind: ResolvedReplyPolicyKind;
  label: string;
} {
  const normalized = String(rawPolicy ?? '').trim().toLowerCase();
  if (normalized === 'required') {
    return { kind: 'required', label: '需要回复' };
  }
  if (normalized === 'optional') {
    return { kind: 'optional', label: '可选回复' };
  }
  if (normalized === 'none') {
    return { kind: 'none', label: '无需回复' };
  }
  return { kind: 'unknown', label: '未说明' };
}

export function buildReadableMailPresentation(raw: PeerMessageRecord): ReadableMailPresentation {
  const explicitSubject = String(raw.subject ?? '').trim();
  const explicitSummary = String(raw.summary ?? '').trim();
  const explicitPurpose = String(raw.purpose ?? '').trim();
  const explicitAction = String(raw.action ?? '').trim();
  const explicitReplyPolicy = resolveExplicitReplyPolicy(raw.replyPolicy);

  const hasAnyStructured = Boolean(
    explicitSubject
    || explicitSummary
    || explicitPurpose
    || explicitAction
    || explicitReplyPolicy.kind !== 'unknown',
  );

  const headers = extractExplicitBodyHeaders(raw.body);
  const unquotedProse = stripCodeAndQuotes(headers.remainingLines);
  const unquotedHeaderAction = headers.action
    ? stripCodeAndQuotes([headers.action]).replace(/\s+/g, ' ').trim()
    : '';
  const categoryMatch = classifyLegacyPrimaryCategory(unquotedProse);
  const inferredAction = inferLegacyRecipientAction(
    [unquotedProse, unquotedHeaderAction].filter(Boolean).join('\n'),
  );
  const jargonHints = collectStableJargonHints(raw.body);

  // Reply policy: structured v2 wins; else explicit positive '无需ACK/无需回复' in raw prose
  let replyPolicyKind: ResolvedReplyPolicyKind = explicitReplyPolicy.kind;
  let replyPolicyLabel: string = explicitReplyPolicy.label;
  let replyPolicySource: PeerFieldProvenance = explicitReplyPolicy.kind !== 'unknown'
    ? 'explicit'
    : 'unknown';

  if (replyPolicyKind === 'unknown' && inferredAction.explicitNoReply) {
    replyPolicyKind = 'none';
    replyPolicyLabel = '无需回复（原文明示）';
    replyPolicySource = 'extracted';
  }

  // Fallback helper for unrecognized legacy text
  const unknownFallback = !categoryMatch ? buildUnknownLegacyFallback(unquotedProse) : null;

  // 1. Title
  let title = '';
  let titleSource: PeerFieldProvenance = 'unknown';
  if (explicitSubject) {
    title = truncateReadableText(explicitSubject, 68);
    titleSource = 'explicit';
  } else if (headers.subject) {
    title = truncateReadableText(softenInlineTechnicalTokens(headers.subject), 62);
    titleSource = 'extracted';
  } else if (categoryMatch) {
    title = categoryMatch.title;
    titleSource = 'classified';
  } else if (!raw.body.trim()) {
    title = '(空消息)';
    titleSource = 'unknown';
  } else if (unknownFallback) {
    title = unknownFallback.title;
    titleSource = unknownFallback.hasReadableClause ? 'extracted' : 'unknown';
  }

  // 2. Summary
  let summary = '';
  let summarySource: PeerFieldProvenance = 'unknown';
  if (explicitSummary) {
    summary = truncateReadableText(explicitSummary, 180);
    summarySource = 'explicit';
  } else if (headers.summary) {
    summary = truncateReadableText(softenInlineTechnicalTokens(headers.summary), 160);
    summarySource = 'extracted';
  } else if (categoryMatch) {
    summary = categoryMatch.summary;
    summarySource = 'classified';
  } else if (!raw.body.trim()) {
    summary = '(无正文内容)';
    summarySource = 'unknown';
  } else if (unknownFallback) {
    summary = unknownFallback.summary;
    summarySource = unknownFallback.hasReadableClause ? 'extracted' : 'unknown';
  }

  // 3. Purpose
  let purpose = '未说明';
  let purposeSource: PeerFieldProvenance = 'unknown';
  if (explicitPurpose) {
    purpose = truncateReadableText(explicitPurpose, 140);
    purposeSource = 'explicit';
  } else if (headers.purpose) {
    purpose = truncateReadableText(softenInlineTechnicalTokens(headers.purpose), 130);
    purposeSource = 'extracted';
  } else if (categoryMatch) {
    purpose = categoryMatch.purpose;
    purposeSource = 'classified';
  }

  // 4. Action required: explicit structured action -> safely labeled original header action ->
  // transparent classified clear request -> 未说明. Reply policy (including 无需回复 / 无需ACK)
  // never erases a requested action and never implies "no action required".
  let actionText = '未说明';
  let actionSource: PeerFieldProvenance = 'unknown';
  const cleanedHeaderAction = unquotedHeaderAction
    ? (
      !NO_REPLY_REJECT_RE.test(unquotedHeaderAction) && POSITIVE_NO_REPLY_RE.test(unquotedHeaderAction)
        ? unquotedHeaderAction.replace(new RegExp(POSITIVE_NO_REPLY_RE.source, 'gi'), ' ')
        : unquotedHeaderAction
    )
      .replace(/^[\s()（）,，;；·-]+|[\s()（）,，;；·-]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    : '';
  if (explicitAction) {
    actionText = truncateReadableText(explicitAction, 150);
    actionSource = 'explicit';
  } else if (
    cleanedHeaderAction
    && !EMPTY_HEADER_ACTION_RE.test(cleanedHeaderAction)
    && !REQUEST_REJECT_RE.test(cleanedHeaderAction)
  ) {
    actionText = `原文标注待办：${truncateReadableText(softenInlineTechnicalTokens(cleanedHeaderAction), 130)}`;
    actionSource = 'extracted';
  } else if (inferredAction.requestedAction) {
    actionText = inferredAction.requestedAction;
    actionSource = 'classified';
  }

  const sources: PeerFieldProvenance[] = [
    titleSource,
    summarySource,
    purposeSource,
    actionSource,
  ];
  const hasClassified = sources.includes('classified');
  const hasExtracted = sources.includes('extracted') || replyPolicySource === 'extracted';
  const hasExtractedFallback = hasClassified || hasExtracted;

  let provenanceLabel = '系统归类（可核对原文）';
  if (hasAnyStructured && !hasExtractedFallback) {
    provenanceLabel = '结构化字段';
  } else if (hasAnyStructured && hasExtractedFallback) {
    provenanceLabel = '结构化字段 + 系统归类';
  } else if (!hasClassified) {
    provenanceLabel = '原文整理（未归类，可核对原文）';
  }

  return {
    isStructured: hasAnyStructured,
    hasExtractedFallback,
    provenanceLabel,
    ...(categoryMatch ? { legacyCategory: categoryMatch.category } : {}),
    title,
    titleSource,
    summary,
    summarySource,
    purpose,
    purposeSource,
    actionText,
    actionSource,
    replyPolicyKind,
    replyPolicyLabel,
    replyPolicySource,
    jargonHints,
  };
}

export function evaluateMailLifecycle(
  msg: EnrichedPeerMessage,
  nowMs: number = Date.now(),
): EvaluatedMailLifecycle {
  const { raw } = msg;
  const sentAbsoluteText = formatAbsoluteTimestamp(raw.createdAt);
  const sentCompactText = formatCompactAbsoluteTimestamp(raw.createdAt);
  const hasDeliveredTimestamp = Number.isFinite(raw.deliveredAt) && raw.deliveredAt > 0;
  const hasReadTimestamp = Number.isFinite(raw.readAt) && raw.readAt > 0;

  const deliveredAbsoluteText = hasDeliveredTimestamp
    ? formatAbsoluteTimestamp(raw.deliveredAt)
    : '尚未送达';
  const deliveredCompactText = hasDeliveredTimestamp
    ? formatCompactAbsoluteTimestamp(raw.deliveredAt)
    : '尚未送达';
  const readAbsoluteText = hasReadTimestamp
    ? formatAbsoluteTimestamp(raw.readAt)
    : '未标记已读';

  const notif = String(raw.notificationState ?? '').trim().toLowerCase();
  const deliveryState = String(raw.state ?? '').trim().toLowerCase();
  const canceledAt = Number(raw.canceledAt) || 0;
  const expiresAt = Number(raw.expiresAt) || 0;
  const autoDeliverUntil = Number(raw.autoDeliverUntil) || 0;
  const busySince = Number(raw.busySince) || 0;
  const nextAttemptAt = Number(raw.nextAttemptAt) || 0;
  const waitingReasonLower = String(raw.waitingReason ?? '').trim().toLowerCase();
  const currentErrorLower = String(raw.error ?? '').trim().toLowerCase();
  const transportErrorLower = [raw.lastAttemptError, raw.error]
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  const isDeliveredOrRead =
    hasDeliveredTimestamp
    || deliveryState === 'delivered'
    || deliveryState === 'read'
    || notif === 'delivered';

  const isPastSemanticExpiry = expiresAt > 0 && expiresAt <= nowMs;
  const isCanceled = notif === 'canceled' || canceledAt > 0;
  const isExpiredUndelivered = !isDeliveredOrRead && (notif === 'expired' || isPastSemanticExpiry);
  const isFailed = !isDeliveredOrRead && !isCanceled && deliveryState === 'failed';
  const isManual = !isDeliveredOrRead && !isCanceled && !isExpiredUndelivered && notif === 'manual';

  const hasExplicitHorizon = autoDeliverUntil > 0;
  const horizonMs = hasExplicitHorizon
    ? autoDeliverUntil
    : (raw.createdAt > 0 ? raw.createdAt + DEFAULT_AUTO_DELIVER_HORIZON_MS : 0);
  const isPastAutoHorizon = !isDeliveredOrRead && horizonMs > 0 && horizonMs <= nowMs;

  const attemptCount = Math.max(0, Number(raw.attemptCount) || 0);
  const probeCount = typeof raw.probeCount === 'number' && Number.isFinite(raw.probeCount)
    ? Math.max(0, Math.trunc(raw.probeCount))
    : null;

  if (isCanceled) {
    return {
      kind: 'canceled',
      label: isDeliveredOrRead ? '已取消（历史已送达）' : '已取消 · 未送达',
      shortLabel: '已取消',
      ledTone: 'neutral',
      pillTone: 'neutral',
      isUndelivered: !isDeliveredOrRead,
      isStaleOrManual: false,
      isAttention: true,
      isPastSemanticExpiry,
      sentAbsoluteText,
      sentCompactText,
      deliveredAbsoluteText,
      deliveredCompactText,
      readAbsoluteText,
      validitySummary: canceledAt > 0
        ? `已于 ${formatAbsoluteTimestamp(canceledAt)} 取消自动通知`
        : '发件方或调度器已取消此通知',
      processingCaveat: '通知已取消，不会再自动注入目标终端。',
      attemptCount,
      probeCount,
    };
  }

  if (isExpiredUndelivered) {
    return {
      kind: 'expired',
      label: '已过期 · 未送达',
      shortLabel: '已过期',
      ledTone: 'err',
      pillTone: 'danger',
      isUndelivered: true,
      isStaleOrManual: false,
      isAttention: true,
      isPastSemanticExpiry: true,
      sentAbsoluteText,
      sentCompactText,
      deliveredAbsoluteText,
      deliveredCompactText,
      readAbsoluteText,
      validitySummary: expiresAt > 0 && expiresAt <= nowMs
        ? `语义有效期已过（截止 ${formatAbsoluteTimestamp(expiresAt)}），逾期未送达`
        : '消息已标记为过期，停止自动投递',
      processingCaveat: '消息在送达前已过期，保留原文仅供历史核查。',
      attemptCount,
      probeCount,
    };
  }

  if (isFailed) {
    return {
      kind: 'failed',
      label: '投递失败 · 未送达',
      shortLabel: '投递失败',
      ledTone: 'err',
      pillTone: 'danger',
      isUndelivered: true,
      isStaleOrManual: false,
      isAttention: true,
      isPastSemanticExpiry,
      sentAbsoluteText,
      sentCompactText,
      deliveredAbsoluteText,
      deliveredCompactText,
      readAbsoluteText,
      validitySummary: '自动投递未能完成，尚未送达收件会话',
      processingCaveat: '消息未送达收件方，需在邮箱人工查看或重新联系。',
      attemptCount,
      probeCount,
    };
  }

  if (isManual) {
    let manualSummary = '';
    let manualCaveat = '尚未自动注入目标终端，记录不会删除。';

    if (
      waitingReasonLower.includes('legacy')
      || waitingReasonLower.includes('history_uncertain')
      || waitingReasonLower.includes('attempt_history')
    ) {
      manualSummary = '历史尝试记录含旧版忙碌检查，无法安全确认真实失败次数，已转为人工查看';
      manualCaveat = '不将旧版累计计数推断为固定真实失败次数；消息保留供人工查阅。';
    } else if (
      waitingReasonLower.includes('retry_exhausted')
      || waitingReasonLower.includes('exhausted')
      || waitingReasonLower.includes('max_attempt')
    ) {
      manualSummary = '已达真实传输重试上限，自动投递已停止，保留供人工查看';
      if (hasExplicitHorizon && autoDeliverUntil > nowMs) {
        manualCaveat = '自动通知截止时间尚未到达，因传输重试已达上限而转为人工查阅。';
      }
    } else if (!isPastAutoHorizon && Boolean(transportErrorLower)) {
      manualSummary = '自动投递传输重试已停止，保留供人工查看';
      if (hasExplicitHorizon && autoDeliverUntil > nowMs) {
        manualCaveat = '自动通知截止时间尚未到达，因传输重试停止而转为人工查阅。';
      }
    } else if (hasExplicitHorizon && autoDeliverUntil <= nowMs) {
      manualSummary = `已超过自动通知截止时间（${formatAbsoluteTimestamp(autoDeliverUntil)}），保留供人工查阅`;
    } else if (!hasExplicitHorizon && isPastAutoHorizon) {
      manualSummary = '已超过 30 分钟自动通知窗口，保留供人工查阅';
    } else {
      manualSummary = '当前不满足自动投递条件，已转为邮箱人工查看';
    }

    return {
      kind: 'manual',
      label: '待人工查看 · 未自动送达',
      shortLabel: '待人工查看',
      ledTone: 'warn',
      pillTone: 'warning',
      isUndelivered: true,
      isStaleOrManual: true,
      isAttention: false,
      isPastSemanticExpiry,
      sentAbsoluteText,
      sentCompactText,
      deliveredAbsoluteText,
      deliveredCompactText,
      readAbsoluteText,
      validitySummary: manualSummary,
      processingCaveat: manualCaveat,
      attemptCount,
      probeCount,
    };
  }

  if (!isDeliveredOrRead && isPastAutoHorizon) {
    return {
      kind: 'stale',
      label: '滞留未送达',
      shortLabel: '滞留未送达',
      ledTone: 'warn',
      pillTone: 'warning',
      isUndelivered: true,
      isStaleOrManual: true,
      isAttention: false,
      isPastSemanticExpiry,
      sentAbsoluteText,
      sentCompactText,
      deliveredAbsoluteText,
      deliveredCompactText,
      readAbsoluteText,
      validitySummary: hasExplicitHorizon && autoDeliverUntil <= nowMs
        ? `已超过自动投递截止时间 ${formatAbsoluteTimestamp(autoDeliverUntil)}，仍未送达`
        : '距发送已超过 30 分钟且尚未送达收件终端',
      processingCaveat: '消息滞留在待送达队列中，尚未被目标会话接收。',
      attemptCount,
      probeCount,
    };
  }

  const hasCurrentErrorBackoff = Boolean(currentErrorLower) && nextAttemptAt > nowMs;
  if (!isDeliveredOrRead && (notif === 'waiting' || Boolean(waitingReasonLower) || hasCurrentErrorBackoff)) {
    let waitLabel = '等待投递窗口 · 尚未送达';
    let waitShortLabel = '等待投递';
    let waitSummary = '正在等待安全投递窗口';
    let waitCaveat = '尚未确认可安全注入，当前尚未送达。';

    const isCooldownWait =
      waitingReasonLower.includes('cooldown')
      || waitingReasonLower.includes('burst')
      || waitingReasonLower.includes('interval');

    const isInputUnavailableWait =
      waitingReasonLower === 'target_input_unavailable'
      || waitingReasonLower === 'input_unavailable'
      || ((waitingReasonLower.includes('input') || waitingReasonLower.includes('composer')) && (
        waitingReasonLower.includes('unavailable')
        || waitingReasonLower.includes('unknown')
        || waitingReasonLower.includes('uncertain')
        || waitingReasonLower.includes('unconfirmed')
      ));

    const isUnknownWait =
      isInputUnavailableWait
      || waitingReasonLower.includes('unknown')
      || waitingReasonLower.includes('uncertain')
      || waitingReasonLower.includes('unconfirmed')
      || waitingReasonLower.includes('probe_unavailable')
      || (waitingReasonLower.includes('probe') && !waitingReasonLower.includes('busy'));

    const isConfirmedDraftWait =
      !isUnknownWait
      && !waitingReasonLower.includes('unavailable')
      && (
        waitingReasonLower === 'target_has_draft'
        || waitingReasonLower.includes('has_draft')
        || waitingReasonLower.includes('draft')
        || waitingReasonLower.includes('composing')
      );

    const isExplicitBusyWait =
      waitingReasonLower.includes('busy')
      || waitingReasonLower.includes('working')
      || waitingReasonLower.includes('active_turn');

    const isKnownTransportWait =
      waitingReasonLower === 'send_keys_failed'
      || waitingReasonLower === 'native_send_failed'
      || waitingReasonLower === 'chat_send_failed'
      || waitingReasonLower.includes('send_keys_failed')
      || waitingReasonLower.includes('native_send_failed')
      || waitingReasonLower.includes('chat_send_failed')
      || waitingReasonLower.includes('transport')
      || waitingReasonLower.includes('backoff')
      || waitingReasonLower.includes('retry')
      || (Boolean(waitingReasonLower) && waitingReasonLower === currentErrorLower && hasCurrentErrorBackoff);

    if (isCooldownWait) {
      waitLabel = '短暂等待 · 尚未送达';
      waitShortLabel = '短暂等待';
      waitSummary = '上一条通知后的短暂等待';
      waitCaveat = '同目标通知保护间隔中，稍后将继续自动投递。';
    } else if (isConfirmedDraftWait) {
      waitLabel = '输入框有草稿 · 尚未送达';
      waitShortLabel = '输入框有草稿';
      waitSummary = '输入框有草稿，暂缓自动注入';
      waitCaveat = '等待收件终端输入框清空后再投递，避免打断输入。';
    } else if (isUnknownWait) {
      waitLabel = '状态待确认 · 尚未送达';
      waitShortLabel = '状态待确认';
      waitSummary = isInputUnavailableWait
        ? '无法确认输入状态，暂缓自动注入'
        : '无法安全确认状态，暂缓自动注入';
      waitCaveat = isInputUnavailableWait
        ? '无法安全确认收件终端输入状态，未知状态不视为空闲；当前尚未送达。'
        : '未知终端状态不视为空闲；当前尚未送达。';
    } else if (isExplicitBusyWait) {
      waitLabel = '对方忙碌 · 尚未送达';
      waitShortLabel = '对方忙碌';
      waitSummary = busySince > 0
        ? `对方正在处理任务（始于 ${formatAbsoluteTimestamp(busySince)}）`
        : '对方正在处理任务';
      waitCaveat = '目标级忙碌检查不计入本消息失败重试；当前尚未送达。';
    } else if (isKnownTransportWait || (!waitingReasonLower && hasCurrentErrorBackoff)) {
      waitLabel = '等待重试 · 尚未送达';
      waitShortLabel = '等待重试';
      waitSummary = nextAttemptAt > 0
        ? `传输失败等待重试（下次尝试 ${formatAbsoluteTimestamp(nextAttemptAt)}）`
        : '传输失败等待重试';
      waitCaveat = '上次传输未成功，正在等待退避重试；当前尚未送达。';
    } else if (!waitingReasonLower && busySince > 0) {
      waitLabel = '对方忙碌 · 尚未送达';
      waitShortLabel = '对方忙碌';
      waitSummary = `对方正在处理任务（始于 ${formatAbsoluteTimestamp(busySince)}）`;
      waitCaveat = '目标级忙碌检查不计入本消息失败重试；当前尚未送达。';
    }

    return {
      kind: 'waiting',
      label: waitLabel,
      shortLabel: waitShortLabel,
      ledTone: 'warn',
      pillTone: 'warning',
      isUndelivered: true,
      isStaleOrManual: false,
      isAttention: false,
      isPastSemanticExpiry,
      sentAbsoluteText,
      sentCompactText,
      deliveredAbsoluteText,
      deliveredCompactText,
      readAbsoluteText,
      validitySummary: waitSummary,
      processingCaveat: waitCaveat,
      attemptCount,
      probeCount,
    };
  }

  if (!isDeliveredOrRead) {
    return {
      kind: 'ready',
      label: '排队待送达',
      shortLabel: '待送达',
      ledTone: 'warn',
      pillTone: 'warning',
      isUndelivered: true,
      isStaleOrManual: false,
      isAttention: false,
      isPastSemanticExpiry,
      sentAbsoluteText,
      sentCompactText,
      deliveredAbsoluteText,
      deliveredCompactText,
      readAbsoluteText,
      validitySummary: autoDeliverUntil > 0
        ? `排队等待投递（自动通知窗口至 ${formatAbsoluteTimestamp(autoDeliverUntil)}）`
        : '排队等待投递至目标会话',
      processingCaveat: '尚未送达目标终端。',
      attemptCount,
      probeCount,
    };
  }

  const expirySuffix = expiresAt > 0
    ? (isPastSemanticExpiry
      ? `语义有效期已过（截止 ${formatAbsoluteTimestamp(expiresAt)}）`
      : `语义有效期至 ${formatAbsoluteTimestamp(expiresAt)}`)
    : '无语义过期限制';

  if (deliveryState === 'read' || hasReadTimestamp) {
    return {
      kind: 'read',
      label: '已读记录（未确认处理）',
      shortLabel: '已读记录',
      ledTone: 'ok',
      pillTone: 'success',
      isUndelivered: false,
      isStaleOrManual: false,
      isAttention: false,
      isPastSemanticExpiry,
      sentAbsoluteText,
      sentCompactText,
      deliveredAbsoluteText: hasDeliveredTimestamp ? deliveredAbsoluteText : sentAbsoluteText,
      deliveredCompactText: hasDeliveredTimestamp ? deliveredCompactText : sentCompactText,
      readAbsoluteText,
      validitySummary: expirySuffix,
      processingCaveat: '“已读记录”仅表示队列标记被读取，不代表收件会话已完成处理或达成结论。',
      attemptCount,
      probeCount,
    };
  }

  return {
    kind: 'delivered',
    label: '已送达（未确认处理）',
    shortLabel: '已送达',
    ledTone: 'info',
    pillTone: 'info',
    isUndelivered: false,
    isStaleOrManual: false,
    isAttention: false,
    isPastSemanticExpiry,
    sentAbsoluteText,
    sentCompactText,
    deliveredAbsoluteText,
    deliveredCompactText,
    readAbsoluteText,
    validitySummary: expirySuffix,
    processingCaveat: '“已送达”仅表示通知已注入或交付至收件终端，不代表对方已阅读或处理完毕。',
    attemptCount,
    probeCount,
  };
}

/**
 * Builds the chronological reply chain strictly from explicit `replyTo` / `replyToShort` links.
 * Never groups unrelated messages by heuristic subject matching.
 */
export function buildExplicitReplyChain(
  target: EnrichedPeerMessage,
  allMessages: EnrichedPeerMessage[],
): ExplicitReplyChain {
  const byId = new Map<string, EnrichedPeerMessage>();
  const byShortId = new Map<string, EnrichedPeerMessage>();
  for (const item of allMessages) {
    byId.set(item.id, item);
    if (item.shortId && !byShortId.has(item.shortId)) {
      byShortId.set(item.shortId, item);
    }
  }

  const findParent = (msg: EnrichedPeerMessage): EnrichedPeerMessage | null => {
    if (msg.raw.replyTo) {
      const exact = byId.get(msg.raw.replyTo);
      if (exact && exact.id !== msg.id) return exact;
    }
    if (msg.raw.replyToShort) {
      const byShort = byShortId.get(msg.raw.replyToShort);
      if (byShort && byShort.id !== msg.id) return byShort;
    }
    return null;
  };

  const component = allMessages.filter((candidate) => candidate.threadRootId === target.threadRootId);
  const hasExplicitLink =
    Boolean(target.raw.replyTo || target.raw.replyToShort)
    || component.some((item) => Boolean(item.raw.replyTo || item.raw.replyToShort));

  if (!hasExplicitLink) {
    return {
      hasExplicitChain: false,
      rootMissingShortId: '',
      nodes: [],
    };
  }

  const ordered = component.slice().sort((a, b) => {
    if (a.raw.createdAt !== b.raw.createdAt) {
      return a.raw.createdAt - b.raw.createdAt;
    }
    return a.id.localeCompare(b.id);
  });

  const depthById = new Map<string, number>();
  let rootMissingShortId = '';

  for (const item of ordered) {
    const parent = findParent(item);
    const hasReplyRef = Boolean(item.raw.replyTo || item.raw.replyToShort);
    if (parent) {
      const parentDepth = depthById.get(parent.id) ?? 0;
      depthById.set(item.id, Math.min(4, parentDepth + 1));
    } else {
      depthById.set(item.id, 0);
      if (hasReplyRef && !rootMissingShortId) {
        rootMissingShortId = item.raw.replyToShort || shortenMachineIdentifier(item.raw.replyTo);
      }
    }
  }

  const nodes: ExplicitReplyChainNode[] = ordered.map((item) => {
    const parent = findParent(item);
    const hasReplyRef = Boolean(item.raw.replyTo || item.raw.replyToShort);
    const parentShortId = parent
      ? parent.shortId
      : (hasReplyRef ? (item.raw.replyToShort || shortenMachineIdentifier(item.raw.replyTo)) : '');
    return {
      message: item,
      depth: depthById.get(item.id) ?? 0,
      isCurrent: item.id === target.id,
      parentShortId,
      parentMissing: hasReplyRef && !parent,
    };
  });

  return {
    hasExplicitChain: nodes.length > 1 || Boolean(rootMissingShortId),
    rootMissingShortId,
    nodes,
  };
}

export type MailBadgeTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export interface MailDisplayStateBadge {
  key: string;
  label: string;
  tone: MailBadgeTone;
  title?: string;
}

export interface MailDisplayStates {
  primary: MailDisplayStateBadge;
  reply: MailDisplayStateBadge | null;
  isUnread: boolean;
  isReplied: boolean;
}

/**
 * Collects IDs (full and short) of messages that have at least one explicit replyTo child.
 */
export function buildRepliedMessageIdSet(allMessages: EnrichedPeerMessage[]): Set<string> {
  const replied = new Set<string>();
  for (const item of allMessages) {
    const replyTo = String(item.raw.replyTo ?? '').trim();
    const replyToShort = String(item.raw.replyToShort ?? '').trim();
    if (replyTo) replied.add(replyTo);
    if (replyToShort) replied.add(replyToShort);
  }
  return replied;
}

/**
 * Resolves explicit, human-readable Chinese states for list rows and detail headers:
 * - Primary read/delivery state: 未读 / 已读 / 未送达 / 待人工 / 投递失败 / 已过期 / 已取消
 * - Secondary reply state: 已回复 / 等待回复 / 无需回复 / 可选回复
 */
export function resolveMailDisplayStates(
  msg: EnrichedPeerMessage,
  lifecycle: EvaluatedMailLifecycle,
  repliedIds: ReadonlySet<string>,
  locallyMarkedRead = false,
): MailDisplayStates {
  const isReplied =
    repliedIds.has(msg.id) || (Boolean(msg.shortId) && repliedIds.has(msg.shortId));

  let primary: MailDisplayStateBadge;
  let isUnread = false;

  switch (lifecycle.kind) {
    case 'read':
      primary = {
        key: 'read',
        label: '已读',
        tone: 'success',
        title: lifecycle.label,
      };
      break;
    case 'delivered':
      if (locallyMarkedRead) {
        primary = {
          key: 'read',
          label: '已读',
          tone: 'success',
          title: '已在本视图标记已读',
        };
      } else {
        isUnread = true;
        primary = {
          key: 'unread',
          label: '未读',
          tone: 'info',
          title: lifecycle.label,
        };
      }
      break;
    case 'waiting':
    case 'ready':
      isUnread = !locallyMarkedRead;
      primary = {
        key: 'undelivered',
        label: locallyMarkedRead ? '已读' : '未送达',
        tone: locallyMarkedRead ? 'success' : 'warning',
        title: lifecycle.label,
      };
      break;
    case 'manual':
    case 'stale':
      isUnread = !locallyMarkedRead;
      primary = {
        key: 'manual',
        label: locallyMarkedRead ? '已读' : '待人工',
        tone: locallyMarkedRead ? 'success' : 'warning',
        title: lifecycle.label,
      };
      break;
    case 'failed':
      primary = {
        key: 'failed',
        label: '失败',
        tone: 'danger',
        title: lifecycle.label,
      };
      break;
    case 'expired':
      primary = {
        key: 'expired',
        label: '已过期',
        tone: 'danger',
        title: lifecycle.label,
      };
      break;
    case 'canceled':
    default:
      primary = {
        key: 'canceled',
        label: '已取消',
        tone: 'neutral',
        title: lifecycle.label,
      };
      break;
  }

  let reply: MailDisplayStateBadge | null = null;
  if (isReplied) {
    reply = {
      key: 'replied',
      label: '已回复',
      tone: 'success',
      title: '该消息已有显式回复',
    };
  } else if (msg.presentation.replyPolicyKind === 'required') {
    reply = {
      key: 'awaiting-reply',
      label: '等待回复',
      tone: 'warning',
      title: '发送方要求回复，尚未收到显式回复',
    };
  } else if (msg.presentation.replyPolicyKind === 'none') {
    reply = {
      key: 'no-reply',
      label: '无需回复',
      tone: 'neutral',
      title: msg.presentation.replyPolicyLabel,
    };
  } else if (msg.presentation.replyPolicyKind === 'optional') {
    reply = {
      key: 'optional-reply',
      label: '可选回复',
      tone: 'info',
      title: '发送方标注为可选回复',
    };
  }

  return {
    primary,
    reply,
    isUnread,
    isReplied,
  };
}
