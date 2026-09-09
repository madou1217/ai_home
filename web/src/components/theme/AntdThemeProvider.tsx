import { ConfigProvider, theme as antdTheme } from 'antd';
import type { ReactNode } from 'react';
import { useThemeMode } from '@/hooks/use-theme-mode';
import { buildAntdColorTheme } from '@/theme/antd-theme';

/**
 * 让 antd 自身的 token 体系跟随 data-theme。
 *
 * 没有这一层时，antd 只有构建期配置的那一套浅色 token：CSS 覆写只能改到我们
 * 显式选中的少数选择器，按钮描边、次级文字、下拉项、Tooltip 等仍是浅色，
 * 深色模式下表现为深底上的深字。darkAlgorithm 让这些内部 token 一次性翻转，
 * CSS 层因此只需负责材质（圆角、毛玻璃），不再负责配色。
 */
export default function AntdThemeProvider({ children }: { children: ReactNode }) {
  const mode = useThemeMode();
  const colors = buildAntdColorTheme(mode);
  return (
    <ConfigProvider
      theme={{
        algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: colors.token,
        components: colors.components,
      }}
    >
      {children}
    </ConfigProvider>
  );
}
