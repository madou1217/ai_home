import type { CSSProperties } from 'react';
import type { Provider } from '@/types';
import antigravityIcon from '@/assets/icons/antigravity.svg';
import claudeIcon from '@/assets/icons/claude.svg';
import geminiIcon from '@/assets/icons/gemini.svg';
import opencodeIcon from '@/assets/icons/opencode.svg';
import chatgptIcon from '@/assets/icons/chatgpt.svg';
import openaiIcon from '@/assets/icons/openai.svg';
import grokIcon from '@/assets/icons/grok.svg';
import aiHomeMark from '@/assets/brand/ai-home-mark.png';
import agyTerminalIcon from '../../../../assets/provider-icons/agy.png';
import claudeTerminalIcon from '../../../../assets/provider-icons/claude.png';
import codexTerminalIcon from '../../../../assets/provider-icons/codex.png';
import geminiTerminalIcon from '../../../../assets/provider-icons/gemini.png';
import opencodeTerminalIcon from '../../../../assets/provider-icons/opencode.png';
import { PROVIDER_CATALOG, CATALOG_FALLBACK, getProviderLabel, getProviderTagColor, getProviderTerminalBadge, getProviderTerminalIcon, getProviderTerminalIconAsset, providerIds, providerNames } from './provider-catalog.js';

// label / short / 颜色等非视觉资源在 Node 安全的 provider-catalog.js 里统一维护；
// 这里只负责叠加前端独有的品牌图标（SVG url）。详见 web/DESIGN.md。
export { getProviderLabel, getProviderTagColor, getProviderTerminalBadge, getProviderTerminalIcon, getProviderTerminalIconAsset, providerIds, providerNames };

/**
 * Provider 注册表 —— 在数据目录之上叠加图标，得到完整的 provider 视觉元信息。
 */
export interface ProviderMeta {
  id: Provider;
  /** 显示名 */
  label: string;
  /** 简称/角标（移动端、密集列表用） */
  short: string;
  /** 终端标题 / tmux 列表可识别的文本图标 */
  terminalIcon: string;
  /** 终端 profile 可使用的真实图标资产 */
  terminalIconAsset: string;
  /** 品牌图标（SVG url） */
  icon: string;
  /** 强调色 CSS 变量引用 */
  accentVar: string;
  /** 弱化底色 CSS 变量引用 */
  softVar: string;
  /** antd Tag 颜色 */
  tagColor: string;
}

const ICONS: Record<Provider, string> = {
  codex: chatgptIcon,
  gemini: geminiIcon,
  claude: claudeIcon,
  agy: antigravityIcon,
  opencode: opencodeIcon,
  grok: grokIcon
};

const TERMINAL_ICON_ASSETS: Record<Provider, string> = {
  codex: codexTerminalIcon,
  gemini: geminiTerminalIcon,
  claude: claudeTerminalIcon,
  agy: agyTerminalIcon,
  opencode: opencodeTerminalIcon,
  grok: aiHomeMark
};

export const PROVIDERS: Record<Provider, ProviderMeta> = Object.fromEntries(
  (Object.entries(PROVIDER_CATALOG) as Array<[Provider, Omit<ProviderMeta, 'icon'>]>)
    .map(([id, meta]) => [id, { ...meta, icon: ICONS[id] }])
) as Record<Provider, ProviderMeta>;

const FALLBACK: ProviderMeta = { ...CATALOG_FALLBACK, icon: openaiIcon } as ProviderMeta;

export function getProvider(provider: Provider | string | undefined | null): ProviderMeta {
  return PROVIDERS[provider as Provider] || FALLBACK;
}

export function getProviderIcon(provider: Provider | string | undefined | null): string {
  return getProvider(provider).icon;
}

export function getProviderTerminalIconAssetUrl(provider: Provider | string | undefined | null): string {
  return TERMINAL_ICON_ASSETS[provider as Provider] || aiHomeMark;
}

/**
 * 给会话容器套上当前 provider 的强调色：
 *   <div data-provider={p} style={providerAccentStyle(p)}>…</div>
 * 子组件统一引用 var(--provider-accent) / var(--provider-accent-soft) 即可自动适配。
 */
export function providerAccentStyle(provider: Provider | string | undefined | null): CSSProperties {
  const meta = getProvider(provider);
  return {
    '--provider-accent': meta.accentVar,
    '--provider-accent-soft': meta.softVar
  } as CSSProperties;
}
