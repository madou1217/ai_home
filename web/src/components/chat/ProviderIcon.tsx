import type { Provider } from '@/types';
import claudeIcon from '@/assets/icons/claude.svg';
import geminiIcon from '@/assets/icons/gemini.svg';
import openaiIcon from '@/assets/icons/openai.svg';
import { providerNames } from './provider-names.js';
export { providerNames } from './provider-names.js';

const iconMap: Record<Provider, string> = {
  codex: openaiIcon,
  claude: claudeIcon,
  gemini: geminiIcon
};

interface Props {
  provider: Provider;
  size?: number;
  className?: string;
}

const ProviderIcon = ({ provider, size = 16, className }: Props) => (
  <img
    src={iconMap[provider]}
    alt={providerNames[provider]}
    className={className}
    style={{ width: size, height: size, display: 'block' }}
  />
);

export default ProviderIcon;
