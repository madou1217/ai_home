// antd 的颜色型主题 token（深浅两套）。
// 结构型 token（圆角、字体、控件高度）与主题无关，留在 config.ts 的构建期配置里；
// 这里只放会随主题翻转的颜色，取值与 design-tokens.css 的语义层一一对应
// （Calm Operator Console，见 web/DESIGN.md）：
//   - colorPrimary = 强调色（链接 / 选中 / Tab 指示 / 焦点）
//   - Button 组件内把 colorPrimary 覆盖为墨色：主按钮是墨底，不与强调色竞争

import type { ThemeMode } from '@/services/theme-mode';

export interface AntdColorTheme {
  token: Record<string, string>;
  components: Record<string, Record<string, string>>;
}

const LIGHT: AntdColorTheme = {
  token: {
    colorPrimary: '#2f5bd3',
    colorInfo: '#2f5bd3',
    colorLink: '#2f5bd3',
    colorSuccess: '#15803d',
    colorWarning: '#b45309',
    colorError: '#c2322b',
    colorText: '#27272a',
    colorTextHeading: '#18181b',
    colorTextSecondary: '#52525b',
    colorTextTertiary: '#71717a',
    colorTextQuaternary: '#a0a0a8',
    colorBorder: '#e3e3e7',
    colorBorderSecondary: '#ececef',
    colorSplit: 'rgba(24, 24, 27, 0.06)',
    colorFillSecondary: 'rgba(24, 24, 27, 0.05)',
    colorFillTertiary: 'rgba(24, 24, 27, 0.035)',
    colorFillQuaternary: 'rgba(24, 24, 27, 0.02)',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f7f7f8',
    colorBgMask: 'rgba(12, 12, 14, 0.4)',
    controlOutline: 'rgba(47, 91, 211, 0.2)',
    controlItemBgActive: 'rgba(47, 91, 211, 0.08)',
    controlItemBgHover: 'rgba(24, 24, 27, 0.04)',
  },
  components: {
    Button: {
      colorPrimary: '#18181b',
      colorPrimaryHover: '#3f3f46',
      colorPrimaryActive: '#000000',
      primaryColor: '#ffffff',
      defaultBorderColor: '#e3e3e7',
      defaultHoverBorderColor: '#d1d1d6',
      defaultHoverColor: '#18181b',
      defaultHoverBg: '#fafafa',
    },
    Table: {
      headerBg: '#f7f7f8',
      headerColor: '#52525b',
      rowHoverBg: 'rgba(24, 24, 27, 0.025)',
      borderColor: '#ececef',
    },
    Card: {
      colorBgContainer: '#ffffff',
      colorBorderSecondary: '#e3e3e7',
    },
    Modal: {
      contentBg: '#ffffff',
    },
    Drawer: {
      colorBgElevated: '#ffffff',
    },
    Segmented: {
      trackBg: '#f1f1f3',
      itemSelectedBg: '#ffffff',
      itemColor: '#71717a',
      itemSelectedColor: '#18181b',
    },
    Tabs: {
      itemColor: '#71717a',
      itemSelectedColor: '#18181b',
      itemHoverColor: '#27272a',
      inkBarColor: '#2f5bd3',
    },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#52525b',
      itemHoverColor: '#18181b',
      itemHoverBg: 'rgba(24, 24, 27, 0.04)',
      itemSelectedBg: '#f1f1f3',
      itemSelectedColor: '#18181b',
      subMenuItemBg: 'transparent',
    },
  },
};

// 深色取值对应 design-tokens.css 的 [data-theme='dark']：
// 画布 #0f0f11、表面 #17171a、抬升 #1e1e22、描边 #2b2b31。
const DARK: AntdColorTheme = {
  token: {
    colorPrimary: '#7b9cff',
    colorInfo: '#7b9cff',
    colorLink: '#7b9cff',
    colorSuccess: '#5cc389',
    colorWarning: '#e0a94a',
    colorError: '#f07068',
    colorText: '#e4e4e7',
    colorTextHeading: '#fafafa',
    colorTextSecondary: '#d4d4d8',
    colorTextTertiary: '#a1a1aa',
    colorTextQuaternary: '#71717a',
    colorBorder: '#2b2b31',
    colorBorderSecondary: '#242429',
    colorSplit: 'rgba(255, 255, 255, 0.06)',
    colorFillSecondary: 'rgba(255, 255, 255, 0.07)',
    colorFillTertiary: 'rgba(255, 255, 255, 0.05)',
    colorFillQuaternary: 'rgba(255, 255, 255, 0.03)',
    colorBgContainer: '#17171a',
    colorBgElevated: '#1e1e22',
    colorBgLayout: '#0f0f11',
    colorBgMask: 'rgba(0, 0, 0, 0.6)',
    controlOutline: 'rgba(123, 156, 255, 0.28)',
    controlItemBgActive: 'rgba(123, 156, 255, 0.14)',
    controlItemBgHover: 'rgba(255, 255, 255, 0.05)',
  },
  components: {
    Button: {
      colorPrimary: '#f4f4f5',
      colorPrimaryHover: '#d4d4d8',
      colorPrimaryActive: '#ffffff',
      primaryColor: '#18181b',
      defaultBorderColor: '#2b2b31',
      defaultHoverBorderColor: '#3b3b42',
      defaultHoverColor: '#fafafa',
      defaultHoverBg: '#1e1e22',
    },
    Table: {
      headerBg: '#1b1b1f',
      headerColor: '#d4d4d8',
      rowHoverBg: 'rgba(255, 255, 255, 0.03)',
      borderColor: '#242429',
    },
    Card: {
      colorBgContainer: '#17171a',
      colorBorderSecondary: '#2b2b31',
    },
    Modal: {
      contentBg: '#1e1e22',
    },
    Drawer: {
      colorBgElevated: '#1e1e22',
    },
    Segmented: {
      trackBg: '#1b1b1f',
      itemSelectedBg: '#2b2b31',
      itemColor: '#a1a1aa',
      itemSelectedColor: '#fafafa',
    },
    Tabs: {
      itemColor: '#a1a1aa',
      itemSelectedColor: '#fafafa',
      itemHoverColor: '#e4e4e7',
      inkBarColor: '#7b9cff',
    },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#a1a1aa',
      itemHoverColor: '#fafafa',
      itemHoverBg: 'rgba(255, 255, 255, 0.05)',
      itemSelectedBg: '#232328',
      itemSelectedColor: '#fafafa',
      subMenuItemBg: 'transparent',
    },
  },
};

/** 两套主题的键集必须一致，否则切换到另一主题时会残留上一主题的取值。 */
export function buildAntdColorTheme(mode: ThemeMode): AntdColorTheme {
  return mode === 'dark' ? DARK : LIGHT;
}

export const ANTD_COLOR_THEMES = { light: LIGHT, dark: DARK };
