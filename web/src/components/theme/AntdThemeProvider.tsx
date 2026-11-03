import { ConfigProvider, theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useThemeMode } from '@/hooks/use-theme-mode';
import { buildAntdColorTheme } from '@/theme/antd-theme';

// antd 默认在两个汉字的按钮中插入空格（「授 权」「重 置」），控制台里读起来像错字。
const BUTTON_CONFIG = { autoInsertSpace: false } as const;

/**
 * 让 antd 自身的 token 体系跟随 data-theme。
 *
 * 没有这一层时，antd 只有构建期配置的那一套浅色 token：CSS 覆写只能改到我们
 * 显式选中的少数选择器，按钮描边、次级文字、下拉项、Tooltip 等仍是浅色，
 * 深色模式下表现为深底上的深字。darkAlgorithm 让这些内部 token 一次性翻转，
 * CSS 层因此只需负责材质（切角、角标、光效），不再负责配色。
 *
 * 静态方法（Modal.confirm / message / notification）渲染在 React 树之外，
 * 通过 ConfigProvider.config 的 holderRender 注入同一套主题，保证所有确认框与提示
 * 都是 HUD 外观，而不是 antd 默认浅色（也不回退到浏览器原生 alert/confirm）。
 */
export default function AntdThemeProvider({ children }: { children: ReactNode }) {
  const mode = useThemeMode();
  const themeConfig = useMemo<ThemeConfig>(() => {
    const colors = buildAntdColorTheme(mode);
    return {
      algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: colors.token,
      components: colors.components,
    };
  }, [mode]);

  useEffect(() => {
    ConfigProvider.config({
      holderRender: (holderChildren) => (
        <ConfigProvider theme={themeConfig} button={BUTTON_CONFIG}>
          {holderChildren}
        </ConfigProvider>
      ),
    });
  }, [themeConfig]);

  return (
    <ConfigProvider button={BUTTON_CONFIG} theme={themeConfig}>
      {children}
    </ConfigProvider>
  );
}
