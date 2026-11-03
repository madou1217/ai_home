// AI 翻译的纯逻辑层（不依赖 React / DOM）。
//
// 这里只放「可以单测的判定」：语言选项构造、默认值解析、选区/悬浮窗的注入判定、
// 原文分块、结果统计。页面与悬浮窗共用，避免两处出现两套语言列表或两套上限。

import type {
  TranslationLanguage,
  TranslationModelOption,
  TranslationSettings,
} from '@/types';

export const AUTO_LANGUAGE = 'auto';
/** 与 lib/server/webui-translation-routes.js 的 MAX_TRANSLATION_INPUT_CHARS 对齐。 */
export const MAX_TRANSLATION_INPUT_CHARS = 40000;
/** 悬浮窗最多接管的选区长度：更长的选区直接引导到页面（浮层不适合长文档）。 */
export const MAX_FLOATING_SELECTION_CHARS = 8000;

export interface TranslationOption {
  value: string;
  label: string;
  /** 次要说明（英文名），用于下拉里区分「简体 / 繁體」这类近邻项 */
  hint?: string;
}

/** 语言下拉项：自动检测永远排在第一项，其余按服务端目录顺序（= 常用度）。 */
export function buildLanguageOptions(
  languages: readonly TranslationLanguage[],
  options: { includeAuto?: boolean; autoLabel?: string } = {},
): TranslationOption[] {
  const list: TranslationOption[] = [];
  if (options.includeAuto !== false) {
    list.push({ value: AUTO_LANGUAGE, label: options.autoLabel || '自动检测' });
  }
  for (const language of languages) {
    if (!language || !language.code) continue;
    list.push({
      value: language.code,
      label: language.label || language.code,
      hint: language.native && language.native !== language.label ? language.native : '',
    });
  }
  return list;
}

export function languageLabelOf(
  languages: readonly TranslationLanguage[],
  code: string | undefined,
): string {
  const normalized = String(code || '').trim();
  if (!normalized || normalized === AUTO_LANGUAGE) return '自动检测';
  const found = languages.find((language) => language.code === normalized);
  return found ? found.label : normalized;
}

/**
 * Keep the route summary useful when the source and target resolve to the
 * same language. Showing `英语 → 英语` looks like a successful translation
 * even though the safe action is to ask for another target first.
 */
export function formatTranslationRouteLabel(input: {
  fromLabel?: string;
  toLabel?: string;
  sameLanguage?: boolean;
}): string {
  const from = String(input.fromLabel || '').trim();
  const to = String(input.toLabel || '').trim();
  if (input.sameLanguage || (from && to && from === to)) {
    return to ? `无需翻译 · 原文为${to}` : '无需翻译';
  }
  if (from && to) return `${from} → ${to}`;
  if (to) return `目标语言：${to}`;
  if (from) return `检测到${from}`;
  return '等待目标语言';
}

/** 「简繁互换」这类一键动作只需要在中文两种形态之间切换；其它语言返回空串（按钮隐藏）。 */
export function counterpartLanguage(code: string | undefined): string {
  const normalized = String(code || '').trim();
  if (normalized === 'zh-Hans') return 'zh-Hant';
  if (normalized === 'zh-Hant') return 'zh-Hans';
  return '';
}

export function swapLanguages(source: string, target: string): { source: string; target: string } {
  // 源是「自动检测」时无法直接互换（交换后源=具体目标语言，目标=自动检测没有意义），
  // 保持目标不变，只把源语言落成目标语言的反向：由 UI 决定要不要禁用按钮。
  if (!source || source === AUTO_LANGUAGE) return { source, target };
  return { source: target, target: source };
}

export function canSwapLanguages(source: string, target: string): boolean {
  return Boolean(source && source !== AUTO_LANGUAGE && target);
}

/**
 * 本次翻译实际使用的源语言：显式选择优先，auto 时用检测结果。
 * 检测未完成 / 未知时返回空串，调用方应继续翻译而不是误判「同语言」。
 */
export function resolveEffectiveSourceLanguage(
  source: string | undefined,
  detected: string | undefined,
): string {
  const configured = String(source || '').trim();
  if (configured && configured !== AUTO_LANGUAGE) return configured;
  return String(detected || '').trim();
}

/** 源语言与目标语言相同（且源语言已确定）时不需要翻译。 */
export function isSameTranslationLanguage(
  source: string | undefined,
  target: string | undefined,
  detected?: string,
): boolean {
  const from = resolveEffectiveSourceLanguage(source, detected);
  const to = String(target || '').trim();
  return Boolean(from && to && from === to);
}

/**
 * 模型下拉的分组与文案。可用账号数 = 0 的模型保留但标注（用户可能就是想先选好，
 * 等账号恢复后再用），不隐藏——隐藏会让「模型列表忽然变短」变成不可解释的现象。
 */
export function buildModelOptions(models: readonly TranslationModelOption[]): Array<{
  value: string;
  label: string;
  providerLabel: string;
  available: number;
  disabled: boolean;
}> {
  return models.map((model) => ({
    value: model.id,
    label: model.id,
    providerLabel: model.providerLabel || model.provider || '别名',
    available: Number(model.availableAccountCount) || 0,
    disabled: false,
  }));
}

export function modelOptionLabel(option: {
  label: string;
  providerLabel: string;
  available: number;
}): string {
  const parts = [option.label];
  if (option.providerLabel) parts.push(`· ${option.providerLabel}`);
  if (option.available < 1) parts.push('· 暂无可用账号');
  else if (option.available === 1) parts.push('· 1 个账号');
  else parts.push(`· ${option.available} 个账号`);
  return parts.join(' ');
}

/** 当前设置里的模型是否仍在目录中（账号被删 / 模型下线后设置会「悬空」）。 */
export function isModelStillAvailable(
  models: readonly TranslationModelOption[],
  model: string,
): boolean {
  const normalized = String(model || '').trim();
  if (!normalized) return false;
  return models.some((item) => item.id === normalized);
}

export interface ResolvedTranslationSelection {
  model: string;
  provider: string;
  /** 设置里的模型已不存在，回落到了目录默认值 */
  fallback: boolean;
}

/**
 * 解析「实际要用的模型」：显式设置且仍存在 → 用它；否则用服务端给的默认值。
 * 这一步必须在请求前算清楚，否则会把一个已下线的模型名发给网关，得到的是
 * 「无可用账号」这种和真实原因无关的报错。
 */
export function resolveTranslationSelection(
  settings: Pick<TranslationSettings, 'model' | 'provider'> | null,
  models: readonly TranslationModelOption[],
  autoDetected: { model: string; provider: string },
): ResolvedTranslationSelection {
  const configured = String(settings?.model || '').trim();
  if (configured && isModelStillAvailable(models, configured)) {
    const hit = models.find((item) => item.id === configured);
    // A model can remain in the catalog after every matching account has
    // become unavailable.  Keep it selectable for explicit recovery, but do
    // not silently send it as the default when the catalog already has a
    // usable automatic choice.
    const availability = hit?.availableAccountCount;
    if (availability === undefined || Number(availability) > 0) {
      return {
        model: configured,
        provider: String(settings?.provider || hit?.provider || '').trim(),
        fallback: false,
      };
    }
  }
  return {
    model: String(autoDetected.model || '').trim(),
    provider: String(autoDetected.provider || '').trim(),
    fallback: Boolean(configured),
  };
}

/** 输入为空 / 纯空白时不发起翻译。 */
export function canTranslate(text: string): boolean {
  return String(text || '').trim().length > 0;
}

/** 超长文本的判定与提示（页面直接拒绝，悬浮窗引导到页面）。 */
export function exceedsInputLimit(text: string, limit = MAX_TRANSLATION_INPUT_CHARS): boolean {
  return String(text || '').length > limit;
}

export function countCharacters(text: string): number {
  // 按码点计数：emoji 与部分中日韩扩展字在 JS 里占两个 UTF-16 单元，
  // 用 length 会显示成两倍，用户会以为多算了。
  return Array.from(String(text || '')).length;
}

/**
 * 原文分块：只用于「统计与展示」（例如段落数），不做网络分段。
 * 翻译必须整段交给模型，分段请求会破坏上下文与指代。
 */
export function splitParagraphs(text: string): string[] {
  return String(text || '')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 结果里的「保留格式」提示需要的判定：原文含代码块/行内代码/链接时不建议一键套用纯文本。 */
export function detectPreservedStructures(text: string): {
  codeBlock: boolean;
  inlineCode: boolean;
  url: boolean;
  list: boolean;
} {
  const source = String(text || '');
  return {
    codeBlock: /```/.test(source),
    inlineCode: /`[^`\n]+`/.test(source),
    url: /https?:\/\/[^\s]+/i.test(source),
    list: /(^|\n)\s*(?:[-*+]|\d+[.)])\s+/.test(source),
  };
}

/**
 * 悬浮窗的「唤起入口」判定：鼠标在文本上停留后出现小图标，点击才打开浮层。
 *
 * 这里只做纯计算（给定选中文本与修饰键 → 是否应唤起），把 DOM 事件留在组件里，
 * 便于测试「怎样算一次有效的选区唤起」。
 */
export interface SelectionTriggerInput {
  selectionText: string;
  /** 选区所在元素是否可编辑（输入框/文本域里不要抢浮层） */
  inEditable?: boolean;
  /** 用户按住了 Shift（正在扩大选区，先不弹） */
  shiftKey?: boolean;
  /** 全局悬浮翻译是否开启 */
  enabled?: boolean;
}

export function shouldOfferFloatingTranslation(input: SelectionTriggerInput): boolean {
  if (!input.enabled) return false;
  if (input.inEditable) return false;
  if (input.shiftKey) return false;
  const text = String(input.selectionText || '').trim();
  if (!text) return false;
  if (text.length > MAX_FLOATING_SELECTION_CHARS) return false;
  // 纯符号/纯数字没有翻译价值，不打扰用户。
  if (!/[\p{L}]/u.test(text)) return false;
  return true;
}

/** 悬浮窗定位：把浮层夹在视口内，且优先出现在选区下方。 */
export interface FloatingAnchor {
  left: number;
  top: number;
  placement: 'below' | 'above';
}

export function computeFloatingAnchor(
  rect: { left: number; top: number; right: number; bottom: number; width?: number; height?: number },
  viewport: { width: number; height: number },
  panel: { width: number; height: number },
  margin = 12,
): FloatingAnchor {
  const rectWidth = Number(rect.width) || Math.max(0, Number(rect.right) - Number(rect.left));
  const anchorLeft = Number(rect.left) + rectWidth / 2 - panel.width / 2;
  const maxLeft = Math.max(margin, viewport.width - panel.width - margin);
  const left = Math.min(Math.max(anchorLeft, margin), maxLeft);

  const below = Number(rect.bottom) + margin;
  const above = Number(rect.top) - panel.height - margin;
  const fitsBelow = below + panel.height <= viewport.height - margin;
  const placement: 'below' | 'above' = fitsBelow || above < margin ? 'below' : 'above';
  const rawTop = placement === 'below' ? below : above;
  const maxTop = Math.max(margin, viewport.height - panel.height - margin);
  return {
    left: Math.round(left),
    top: Math.round(Math.min(Math.max(rawTop, margin), maxTop)),
    placement,
  };
}

/** 快捷键展示用：不同平台统一按 macOS 习惯显示（项目其它地方同样如此）。
 * 用 ⌥⌘T 而不是 ⇧⌘T：后者是浏览器的「重新打开关闭的标签页」，页面拿不到 keydown。 */
export function shortcutLabel(): string {
  return '⌥⌘T';
}
