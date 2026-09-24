// antd 的颜色型主题 token（深浅两套）。
// 结构型 token（圆角、字体、控件高度）与主题无关，留在 config.ts 的构建期配置里；
// 这里只放会随主题翻转的颜色，取值与 design-tokens.css 的语义层一一对应（Cyber HUD，见 web/DESIGN.md）：
//   - DARK  = Cyber HUD：Void Black 画布、Electric Cyan 强调、Matrix Green / Amber / Rose 状态
//   - LIGHT = 日光 HUD：同一套几何，冷灰画布 + 深青强调
// 主按钮的「半透明青底 → 悬停实底」外观由 App.css 负责，这里只给出实底取值。

import type { ThemeMode } from '@/services/theme-mode';

export interface AntdColorTheme {
  token: Record<string, string>;
  components: Record<string, Record<string, string>>;
}

const LIGHT: AntdColorTheme = {
  token: {
    colorPrimary: '#0086a0',
    colorInfo: '#0086a0',
    colorLink: '#0086a0',
    colorSuccess: '#00874a',
    colorWarning: '#b86e00',
    colorError: '#c20042',
    colorText: '#13233a',
    colorTextHeading: '#07121f',
    colorTextSecondary: '#34506b',
    colorTextTertiary: '#4f6a83',
    colorTextQuaternary: '#7f96aa',
    colorBorder: '#cbd8e3',
    colorBorderSecondary: '#dce5ed',
    colorSplit: 'rgba(7, 18, 31, 0.07)',
    colorFillSecondary: 'rgba(0, 134, 160, 0.07)',
    colorFillTertiary: 'rgba(0, 134, 160, 0.05)',
    colorFillQuaternary: 'rgba(0, 134, 160, 0.03)',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#f7fafc',
    colorBgLayout: '#eef3f7',
    colorBgMask: 'rgba(3, 8, 15, 0.45)',
    controlOutline: 'rgba(0, 134, 160, 0.22)',
    controlItemBgActive: 'rgba(0, 134, 160, 0.10)',
    controlItemBgHover: 'rgba(0, 134, 160, 0.06)',
  },
  components: {
    Button: {
      colorPrimary: '#0086a0',
      colorPrimaryHover: '#00a3c2',
      colorPrimaryActive: '#006d83',
      primaryColor: '#ffffff',
      defaultBorderColor: '#cbd8e3',
      defaultHoverBorderColor: '#0086a0',
      defaultHoverColor: '#0086a0',
      defaultHoverBg: '#f7fafc',
    },
    Table: {
      headerBg: '#e6edf3',
      headerColor: '#34506b',
      rowHoverBg: 'rgba(0, 134, 160, 0.05)',
      borderColor: '#dce5ed',
    },
    Card: {
      colorBgContainer: '#ffffff',
      colorBorderSecondary: '#cbd8e3',
    },
    Modal: {
      contentBg: '#f7fafc',
    },
    Drawer: {
      colorBgElevated: '#f7fafc',
    },
    Segmented: {
      trackBg: '#e6edf3',
      itemSelectedBg: '#ffffff',
      itemColor: '#4f6a83',
      itemSelectedColor: '#006d83',
    },
    Tabs: {
      itemColor: '#4f6a83',
      itemSelectedColor: '#006d83',
      itemHoverColor: '#0086a0',
      inkBarColor: '#0086a0',
    },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#34506b',
      itemHoverColor: '#0086a0',
      itemHoverBg: 'rgba(0, 134, 160, 0.06)',
      itemSelectedBg: 'rgba(0, 134, 160, 0.10)',
      itemSelectedColor: '#006d83',
      subMenuItemBg: 'transparent',
    },
  },
};

// 深色取值对应 design-tokens.css 的 [data-theme='dark']（Cyber HUD）。
const DARK: AntdColorTheme = {
  token: {
    colorPrimary: '#00f0ff',
    colorInfo: '#00f0ff',
    colorLink: '#00f0ff',
    colorSuccess: '#00ff66',
    colorWarning: '#ffaa00',
    colorError: '#ff0055',
    colorText: '#e2f1f8',
    colorTextHeading: '#f2fbff',
    colorTextSecondary: '#a9c2d6',
    colorTextTertiary: '#7f9bb3',
    colorTextQuaternary: '#5c7890',
    colorBorder: '#15263d',
    colorBorderSecondary: '#122036',
    colorSplit: 'rgba(0, 240, 255, 0.07)',
    colorFillSecondary: 'rgba(0, 240, 255, 0.08)',
    colorFillTertiary: 'rgba(0, 240, 255, 0.05)',
    colorFillQuaternary: 'rgba(0, 240, 255, 0.03)',
    colorBgContainer: '#0a101a',
    colorBgElevated: '#0c1524',
    colorBgLayout: '#05080e',
    colorBgMask: 'rgba(2, 4, 8, 0.78)',
    controlOutline: 'rgba(0, 240, 255, 0.30)',
    controlItemBgActive: 'rgba(0, 240, 255, 0.12)',
    controlItemBgHover: 'rgba(0, 240, 255, 0.06)',
  },
  components: {
    Button: {
      colorPrimary: '#00f0ff',
      colorPrimaryHover: '#6ff7ff',
      colorPrimaryActive: '#00c8d6',
      primaryColor: '#05080e',
      defaultBorderColor: '#15263d',
      defaultHoverBorderColor: '#00f0ff',
      defaultHoverColor: '#00f0ff',
      defaultHoverBg: '#0c1524',
    },
    Table: {
      headerBg: '#0c1524',
      headerColor: '#7f9bb3',
      rowHoverBg: 'rgba(0, 240, 255, 0.04)',
      borderColor: '#122036',
    },
    Card: {
      colorBgContainer: '#0a101a',
      colorBorderSecondary: '#15263d',
    },
    Modal: {
      contentBg: '#0a101a',
    },
    Drawer: {
      colorBgElevated: '#0a101a',
    },
    Segmented: {
      trackBg: '#05080e',
      itemSelectedBg: 'rgba(0, 240, 255, 0.14)',
      itemColor: '#7f9bb3',
      itemSelectedColor: '#00f0ff',
    },
    Tabs: {
      itemColor: '#7f9bb3',
      itemSelectedColor: '#00f0ff',
      itemHoverColor: '#e2f1f8',
      inkBarColor: '#00f0ff',
    },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#7f9bb3',
      itemHoverColor: '#00f0ff',
      itemHoverBg: 'rgba(0, 240, 255, 0.05)',
      itemSelectedBg: 'rgba(0, 240, 255, 0.10)',
      itemSelectedColor: '#00f0ff',
      subMenuItemBg: 'transparent',
    },
  },
};

/** 两套主题的键集必须一致，否则切换到另一主题时会残留上一主题的取值。 */
export function buildAntdColorTheme(mode: ThemeMode): AntdColorTheme {
  return mode === 'dark' ? DARK : LIGHT;
}

export const ANTD_COLOR_THEMES = { light: LIGHT, dark: DARK };
