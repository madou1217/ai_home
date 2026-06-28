# AIH WebUI & Tauri 桌面应用视觉及交互设计规范

本规范是整个 AIH (AI Home) 桌面级混合应用的前端与产品交互设计的单一真相源。任何前端组件重构、界面升级及新页面设计，都必须强制性地以此规范为最高指导准则，确保视觉美感与交互深度与行业一流标准对齐。

---

## 一、 空间、栅格与布局系统 (Spacing & Grid)

### 1. 视口与页面内衬 (Page Padding)
* **全局外距**：页面内容区域的四周 Padding 统一固化为 **`24px`**，由 Umi Layout 自动托管（强制应用到 `.ant-pro-page-container-children-content` 及 `.ant-pro-grid-content`），禁止任何子页面手写自定义 `padding` 或 `margin`。
* **双栏/多栏网格 (Gutter)**：页面内多卡片并排一律采用标准的 **`16px`** 间距（Gutter），确保横向和纵向间距的绝对平衡与对称。

### 2. 卡片内衬 (Card Padding)
* **SectionCard 内衬**：常规内容卡片的 Padding 统一为 **`20px`**，表单卡片 Padding 统一为 **`24px`**，使信息具备优美的呼吸感，杜绝拥挤的程序员布局风格。

---

## 二、 纵深、阴影与圆角系统 (Depth & Radius)

### 1. 纵深与阴影 (Box Shadow)
摒弃传统的生硬 `1px` 实线边框，全面改用基于扁平渐变的现代纵深阴影。卡片有且仅有两类纵深层级：
* **Level 1 (常规卡片 & 表格)**：
  * `border: 1px solid rgba(226, 232, 240, 0.8);`
  * `box-shadow: 0 4px 6px -1px rgba(15, 23, 42, 0.03), 0 2px 4px -1px rgba(15, 23, 42, 0.02);`
  * 使得卡片呈现极其温和地“贴在页面背景上”的质感。
* **Level 2 (浮动弹窗、下拉 Dropdown & 抽屉 Drawer)**：
  * `border: none;`
  * `box-shadow: 0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -2px rgba(15, 23, 42, 0.04);`
  * 具有高度纵深感，引导用户的核心注意力聚焦。

### 2. 圆角规格 (Border Radius)
* **外层卡片 (SectionCard)**：统一为 **`16px`**。
* **操作控件 (Button / Input / Select / Segmented)**：统一为 **`10px`**（对齐基线高度 `36px`，呈现适度的现代圆润感）。
* **通知/徽标/Tag**：统一为 **`6px`**。
* **弹窗/抽屉 (Modal / Drawer)**：统一为 **`16px`**。

---

## 三、 色系、品牌与字体排版 (Colors & Typography)

### 1. 基础背景与前景色
* **全景页面背景**：极淡 slate 灰与低饱和度蓝灰的渐变 (`#f8fafc` 到 `#f1f5f9` 渐变)，替代单调的纯白或刺眼的亮灰。
* **卡片背景**：纯白色 (`#ffffff`)，与页面背景拉开高对比度。
* **文字前景色**：主标题与正文采用科技墨黑 (`#0f172a`， slate-900)，辅助与描述字采用灰蓝 (`#64748b`， slate-500)。

### 2. 供应商 (Provider) 专属色系绑定
各 AI 供应商会话和标志，必须在界面上严格应用其绑定的专属色，以此区分会话的品牌重心，杜绝配色杂乱：
* **OpenAI (Codex)**：`#10a37f` (翡翠绿)，背景 Tint `#f0fdf4`。
* **Anthropic (Claude)**：`#d97757` (珊瑚红)，背景 Tint `#fff7ed`。
* **Google (Gemini)**：`#1a73e8` (谷歌蓝)，背景 Tint `#eff6ff`。
* **Antigravity (Agy)**：`#8b5cf6` (极光紫)，背景 Tint `#faf5ff`。

### 3. 状态标识的 Badge 规范
全站列表状态表示，**严禁大面积使用粗糙的背景色块 Tag 铺排**，必须使用更精致的 **`Badge` 状态指示灯**：
* `● 正常 / 启用`：`status="success"`，绿色灯。
* `● 异常 / 冷却`：`status="warning"`，金色灯。
* `● 耗尽 / 停池`：`status="error"`，红色灯。
* `● 未配置`：`status="default"`，灰色灯。

---

## 四、 交互体验与微动效 (Interaction)

### 1. 平滑鼠标悬停 (Hover Effects)
任何可点击的卡片 (SectionCard) 与表格行在 Hover 时，一律加上温和的微位移与背景过渡：
* `transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);`
* Hover 状态：卡片上移 `2px`，投影变深 30%，表格行背景淡入 `#f8fafc`。

### 2. 状态切换的平滑转场
* 列表的分页器 (Pagination) 切换、Tabs 菜单切换，必须配备平缓的 Opacity 渐变（Animate.css 中的 `animate__fadeIn`，过渡时长 `0.15s`），杜绝页面瞬间闪烁。

---

## 五、 组件层级规范 (Component Contract)

### 1. 唯一页头脚手架 (PageScaffold)
* 页面大标题、说明和全局刷新按钮一律收纳进 `PageScaffold` 顶栏。
* **列表上方禁止堆叠平铺的 `Statistic` 统计大卡片**，页头右侧或 Descriptions 会话条仅用于渲染今日账号池等核心指标，列表首行直入切换 Tabs 菜单。

### 2. 唯一的选项卡过滤 (ListTable Toolbar Tabs)
* 列表表格（如账号池、别名、开发机）如需分栏过滤，**禁止在外部手写 Tabs 组件包裹表格**，必须使用 `ListTable` (ProTable) 内部集成的 `toolbar.menu` (类型为 `'tab'`)。Tab 的 label 格式统一为 `供应商名称 (数量)`，极简工整。

### 3. 唯一的空状态 (Unified Empty)
* 表格或卡片没有数据时，一律统一使用 AntD 的 `Empty.PRESENTED_IMAGE_SIMPLE` 扁平线框图片，配合文案 **“暂无数据”**，颜色 `#94a3b8`，严禁各页手写奇形怪状的自定义 Empty。
