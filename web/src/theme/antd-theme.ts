// antd 的颜色型主题 token（深浅两套）。
// 结构型 token（圆角、字体、控件高度）与主题无关，留在 config.ts 的构建期配置里；
// 这里只放会随主题翻转的颜色，且取值与 design-tokens.css 的玻璃/表面档位保持一致，
// 保证 antd 组件与自绘组件在同一主题下是同一套材质。

import type { ThemeMode } from '@/services/theme-mode';

export interface AntdColorTheme {
  token: Record<string, string>;
  components: Record<string, Record<string, string>>;
}

const LIGHT: AntdColorTheme = {
  token: {
    colorPrimary: '#0a59f7',
    colorInfo: '#0a59f7',
    colorBorderSecondary: 'rgba(0, 0, 0, 0.06)',
    colorBorder: '#e2e8f0',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f8fafc',
  },
  components: {
    Table: {
      headerBg: 'rgba(241, 245, 249, 0.65)',
      headerColor: '#1e293b',
    },
    Card: {
      colorBgContainer: 'rgba(255, 255, 255, 0.85)',
      colorBorderSecondary: 'rgba(255, 255, 255, 0.9)',
    },
    Modal: {
      contentBg: 'rgba(255, 255, 255, 0.92)',
    },
    Drawer: {
      colorBgElevated: 'rgba(255, 255, 255, 0.92)',
    },
    Segmented: {
      trackBg: 'rgba(0, 0, 0, 0.04)',
      itemSelectedBg: '#ffffff',
    },
  },
};

// 深色取值对应 design-tokens.css 的 [data-theme='dark']：
// 表面 #1e293b、抬升面 #334155、玻璃层 rgba(30, 41, 59, .78/.88/.92)。
const DARK: AntdColorTheme = {
  token: {
    // 强调色同时充当前景（激活 Tab 文字、Alert 文案、链接）。#0a59f7 在深色底上
    // 是深蓝压深底，必须换成设计规范里的「鸿蒙流光蓝」#3b82f6（--hos-blue-500）。
    colorPrimary: '#3b82f6',
    colorInfo: '#3b82f6',
    colorBorderSecondary: 'rgba(255, 255, 255, 0.08)',
    // antd 深色算法默认是中性近黑(#141414)，与本项目的板岩色系不是同一套；
    // 对齐到 design-tokens.css 的 --color-surface / --color-bg / --color-border。
    colorBorder: 'rgba(255, 255, 255, 0.12)',
    colorBgContainer: '#1e293b',
    colorBgElevated: '#1e293b',
    colorBgLayout: '#0f172a',
  },
  components: {
    Table: {
      headerBg: 'rgba(30, 41, 59, 0.65)',
      headerColor: '#e2e8f0',
    },
    Card: {
      colorBgContainer: 'rgba(30, 41, 59, 0.85)',
      colorBorderSecondary: 'rgba(255, 255, 255, 0.1)',
    },
    Modal: {
      contentBg: 'rgba(30, 41, 59, 0.92)',
    },
    Drawer: {
      colorBgElevated: 'rgba(30, 41, 59, 0.92)',
    },
    Segmented: {
      trackBg: 'rgba(255, 255, 255, 0.06)',
      itemSelectedBg: '#334155',
    },
  },
};

/** 两套主题的键集必须一致，否则切换到另一主题时会残留上一主题的取值。 */
export function buildAntdColorTheme(mode: ThemeMode): AntdColorTheme {
  return mode === 'dark' ? DARK : LIGHT;
}

export const ANTD_COLOR_THEMES = { light: LIGHT, dark: DARK };
