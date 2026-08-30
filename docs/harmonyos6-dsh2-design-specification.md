# HarmonyOS 6 & DeepSeek-Harness 2.0 (HOS6-DSH2) 统一设计系统规范

> **版本**：v2.0 · 2026-08-30  
> **设计哲学**：极致通透（Acrylic Glass）、超级连续曲率（Squircle Geometry）、灵动声光律动（Fluid Physics Dynamics）与生产级工程精密度（Zero Jitter 60fps）。

---

## 📐 一、字体阶梯体系与排版规范 (Typography Scale Hierarchy)

| 级别 | Token 变量 | 字号 (px/rem) | 字重 (Font Weight) | 行高 (Line Height) | 字距 (Letter Spacing) | 适用场景 |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **特大标题 (Display)** | `--hos-text-display` | `32px / 2.0rem` | `800 (Extrabold)` | `1.2` | `-0.03em` | 页面 Hero 视口、核心指标大数 |
| **一级标题 (H1)** | `--hos-text-h1` | `24px / 1.5rem` | `700 (Bold)` | `1.3` | `-0.02em` | 各页面主标题、弹窗核心标题 |
| **二级标题 (H2)** | `--hos-text-h2` | `18px / 1.125rem` | `600 (Semibold)` | `1.4` | `-0.01em` | 模块卡片标题、分栏面板顶栏 |
| **三级标题 (H3)** | `--hos-text-h3` | `15px / 0.9375rem` | `600 (Semibold)` | `1.45` | `0` | 抽屉二级分组、消息发送者名称 |
| **正文主字号 (Body)** | `--hos-text-body` | `14px / 0.875rem` | `400 (Regular)` | `1.6` | `0` | 对话气泡正文、表单主内容 |
| **次级正文 (Body Muted)** | `--hos-text-body-sm`| `13px / 0.8125rem` | `400 (Regular)` | `1.5` | `0` | 描述文字、下拉选项、代码块描述 |
| **辅助标注 (Caption)** | `--hos-text-caption` | `12px / 0.75rem` | `500 (Medium)` | `1.4` | `0.02em` | 状态徽标、耗时 Token 度量条 |
| **微型标签 (Micro)** | `--hos-text-micro` | `10px / 0.625rem` | `600 (Semibold)` | `1.2` | `0.04em` | 胶囊角标、微状态水滴计数 |

---

## 🎨 二、色彩与通透材质体系 (Color Harmony & Acrylic Glass)

### 1. 品牌与强调色谱
- **鸿蒙流光蓝 (Primary Aura)**: `#3b82f6` / `linear-gradient(135deg, #1d4ed8 0%, #2563eb 50%, #3b82f6 100%)`
- **深空星环紫 (Thinking Glow)**: `#8b5cf6` / `linear-gradient(135deg, #6d28d9 0%, #8b5cf6 100%)`
- **极光流光绿 (Success / Live)**: `#10b981` / `rgba(16, 185, 129, 0.15)`
- **琥珀流金 (Warning / High Watermark)**: `#f59e0b` / `rgba(245, 158, 11, 0.15)`
- **日蚀朱砂 (Danger / Terminated)**: `#ef4444` / `rgba(239, 68, 68, 0.15)`

### 2. 多层亚克力毛玻璃分层规范
```css
/* 浅色模式分层 */
--hos-glass-bg-subtle:   rgba(255, 255, 255, 0.65); /* 底部状态栏、弱强调背景 */
--hos-glass-bg-card:     rgba(255, 255, 255, 0.82); /* 核心卡片、会话气泡 */
--hos-glass-bg-floating: rgba(255, 255, 255, 0.92); /* 悬浮输入框、模态窗、Popover */

/* 深色模式分层 */
--hos-glass-bg-dark-card: rgba(30, 41, 59, 0.80);
--hos-glass-bg-dark-float: rgba(15, 23, 42, 0.92);

/* 双层微描边规范：内高光 0.8px + 外环境 1px */
--hos-border-hairline: 0.8px solid rgba(255, 255, 255, 0.8);
--hos-border-dark:     0.8px solid rgba(255, 255, 255, 0.1);
```

---

## 🔘 三、全站原子交互组件规范 (Atomic UI Components)

### 1. 按钮体系 (Buttons)
- **主操作按钮 (Primary Button)**: 高度 `38px` (手机 `42px`)，全圆角 `9999px` 或微曲率 `12px`，流光渐变背景 + 4px 弥散环境阴影，按下物理缩放 `scale(0.96)`；
- **次操作按钮 (Secondary Button)**: 通透毛玻璃底色 + `0.8px` 细微描边，悬浮背景亮度提升 5%；
- **图标胶囊按钮 (Icon Capsule)**: 宽高 `32px`，内嵌 SVG 图标，带有触觉高光。

### 2. 交互下拉与选择器 (Select & Dropdown)
- 超级曲率圆角 `14px`；
- 展开浮层具备 `--hos-blur-floating` 32px 毛玻璃穿透，项高度 `34px`，选中项带左侧微水滴指示。

### 3. 输入框与多行编辑 (Input & Composer)
- 物理悬浮底座，边框默认 `rgba(0, 0, 0, 0.08)`，聚焦时触发 `--hos-ring-glow` 2.5px 柔光外发光轮廓。

---

## ⚡ 四、物理动力学与动效规范 (Fluid Physics Dynamics)

- **弹性曲线 (Spring Curve)**: `cubic-bezier(0.34, 1.56, 0.64, 1)`（用于弹窗弹出、卡片悬浮、按钮点击）；
- **平滑渐变曲线 (Smooth Curve)**: `cubic-bezier(0.2, 0.8, 0.2, 1)`（用于颜色过渡、折叠展开、Tab 滑动）；
- **60fps 节流守护 (rAF Scheduler)**: 所有数据流右滚与滚动跟随统一收敛至 `requestAnimationFrame`。
