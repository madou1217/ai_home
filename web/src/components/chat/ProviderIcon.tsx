import type { Provider } from '@/types';
import claudeIcon from '@/assets/icons/claude.svg';
import geminiIcon from '@/assets/icons/gemini.svg';
import openaiIcon from '@/assets/icons/openai.svg';

export const providerNames: Record<Provider, string> = {
  codex: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini'
};

const iconMap: Record<Provider, string> = {
  codex: openaiIcon,
  claude: claudeIcon,
  gemini: geminiIcon
};

interface Props {
  provider: Provider;
  size?: number;
}

const ProviderIcon = ({ provider, size = 16 }: Props) => (
  <img
    src={iconMap[provider]}
    alt={providerNames[provider]}
    style={{ width: size, height: size, display: 'inline-block', verticalAlign: 'middle' }}
  />
);

export default ProviderIcon;
