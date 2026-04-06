# 底部状态行优化说明

## 🐛 **修复的问题**

### 问题 1: 状态行严重闪烁
**症状**：
- 底部的 `[aih] account X usage remaining: XX%` 状态行不断闪烁
- 右侧的 tips 提示信息闪烁尤其严重
- 即使内容没有变化也在重复重绘

**根本原因**：
1. `usageIdleStatusTimer` 每 900ms 执行一次状态行更新
2. `usageDisplayTimer` 定期刷新 usage 数据并重绘
3. `tips` 消息每分钟轮换一次
4. **每次调用 `writeUsageStatusLine()` 都无条件重绘整行**，即使内容完全相同

### 问题 2: 终端宽度变化时显示异常
**症状**：
- 调整终端窗口宽度后，状态行会一行接一行地重复显示
- 超长文本没有被正确截断
- 状态行位置不稳定

**根本原因**：
1. 使用 `\x1b[999;1H` 跳转到"最后一行"，但终端实际行数可能变化
2. Resize 事件后没有正确清理和重绘状态行
3. 长文本超出终端宽度时没有截断处理

---

## ✅ **修复方案**

### 修复 1: 防止无意义的重绘（解决闪烁）

**核心思路**：只有内容真正变化时才重绘

**实现**：
```javascript
let lastRenderedStatusLine = '';

function writeUsageStatusLine(lineText) {
  if (shellDrawerVisible) return;
  const text = String(lineText || '');

  // ...

  // ✅ 防止闪烁：只有内容真正变化时才重绘
  if (text === lastRenderedStatusLine) {
    return; // 内容相同，直接跳过
  }
  lastRenderedStatusLine = text;

  // 继续执行重绘逻辑...
}
```

**效果**：
- ✅ 当 `usageIdleStatusTimer` 每 900ms 触发时，如果内容相同则跳过重绘
- ✅ Tips 消息在同一分钟内不会重复闪烁
- ✅ 只有真正的数据更新（如 usage 百分比变化）才会触发重绘

### 修复 2: 使用实际行数替代 999

**之前的问题代码**：
```javascript
// ❌ 使用 999 跳转到"最后一行"，但实际行数可能只有 24
processObj.stdout.write(`\x1b[s\x1b[999;1H\x1b[2K${text}\x1b[u`);
```

**修复后**：
```javascript
// ✅ 使用实际终端行数
const rows = Math.max(1, Number(processObj.stdout.rows) || 24);
processObj.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K${displayText}\x1b[u`);
```

**效果**：
- ✅ 状态行始终显示在终端的最后一行
- ✅ 不会因为行数变化导致位置错乱

### 修复 3: 根据终端宽度截断文本

**实现**：
```javascript
function writeUsageStatusLine(lineText) {
  // ...

  const rows = Math.max(1, Number(processObj.stdout.rows) || 24);
  const cols = Math.max(20, Number(processObj.stdout.columns) || 80);

  // 移除 ANSI 转义码计算实际文本长度
  const stripped = stripAnsi(text);
  const textWidth = getPlainTextWidth(stripped);

  // 如果文本超宽，截断并添加省略号
  let displayText = text;
  if (textWidth > cols) {
    const maxPlainWidth = cols - 3; // 为 "..." 留空间
    const truncatedPlain = truncatePlainText(stripped, maxPlainWidth);
    displayText = `${truncatedPlain}...`;
  }

  processObj.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K${displayText}\x1b[u`);
}
```

**效果**：
- ✅ 超长文本自动截断并添加 `...`
- ✅ 防止文本溢出导致显示错乱

### 修复 4: Resize 事件时重新渲染

**实现**：
```javascript
const onResize = () => {
  if (ptyProc) {
    try { ptyProc.resize(processObj.stdout.columns, processObj.stdout.rows); } catch (_error) {}
  }

  // ...省略其他逻辑...

  if (!shellDrawerVisible) {
    // ✅ 终端尺寸变化时，强制重新渲染状态行（使用新的尺寸）
    lastRenderedStatusLine = '';
    if (canRenderUsageStatusBar()) {
      emitUsageStatus(activeId, { forcePrint: true, forceRefresh: false });
    }
  }
};
```

**效果**：
- ✅ 调整终端宽度后，状态行立即适应新宽度
- ✅ 清除旧内容，避免重复显示

### 修复 5: 清除状态行时重置缓存

**实现**：
```javascript
function clearUsageStatusLine() {
  const canRenderFixedRow = canRenderUsageStatusBar();
  if (!canRenderFixedRow) return;

  const rows = Math.max(1, Number(processObj.stdout.rows) || 24);
  processObj.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K\x1b[u`);

  // ✅ 清除缓存，确保下次重绘
  lastRenderedStatusLine = '';
}
```

---

## 📊 **优化效果对比**

### 优化前

| 场景 | 问题 |
|------|------|
| 状态行每 900ms 更新一次 | ❌ 即使内容相同也会闪烁 |
| Tips 消息每 60 秒轮换一次 | ❌ 同一分钟内持续闪烁 |
| 调整终端宽度 | ❌ 状态行重复显示多行 |
| 超长文本 | ❌ 文本溢出换行 |
| 使用 `\x1b[999;1H` | ❌ 位置不稳定 |

### 优化后

| 场景 | 效果 |
|------|------|
| 状态行每 900ms 更新一次 | ✅ 内容相同时跳过重绘，不闪烁 |
| Tips 消息每 60 秒轮换一次 | ✅ 只在切换时更新一次 |
| 调整终端宽度 | ✅ 自动适应新宽度，单行显示 |
| 超长文本 | ✅ 自动截断并添加 `...` |
| 使用 `\x1b[{rows};1H` | ✅ 始终在最后一行显示 |

---

## 🧪 **测试验证**

### 测试场景 1: 内容不变时不重绘

```bash
# 启动 codex 会话
aih codex 1

# 观察底部状态行
# 预期：状态行稳定显示，不闪烁
# ✅ 只有 usage 百分比真正变化时才会更新
```

### 测试场景 2: 调整终端宽度

```bash
# 启动 codex 会话
aih codex 1

# 手动拖动终端窗口边缘，调整宽度
# 预期：状态行自动适应新宽度，保持单行显示
# ✅ 超长文本会被截断并显示 "..."
```

### 测试场景 3: Tips 消息不再频繁闪烁

```bash
# 启动 codex 会话，观察右侧 tips
aih codex 1

# 观察底部状态行的右侧 tips 区域
# 之前：tips 区域每 900ms 闪烁一次
# 现在：tips 在同一分钟内保持稳定
# ✅ 只有到下一分钟才切换新 tip
```

---

## 🔧 **技术细节**

### ANSI 转义序列

| 序列 | 功能 |
|------|------|
| `\x1b[s` | 保存当前光标位置 |
| `\x1b[{row};{col}H` | 移动光标到指定位置 (row, col) |
| `\x1b[2K` | 清除当前行 |
| `\x1b[u` | 恢复保存的光标位置 |

### 关键函数

| 函数 | 功能 |
|------|------|
| `writeUsageStatusLine(text)` | 写入状态行（带重绘优化） |
| `clearUsageStatusLine()` | 清除状态行（重置缓存） |
| `stripAnsi(text)` | 移除 ANSI 颜色代码 |
| `getPlainTextWidth(text)` | 计算可见文本宽度（处理中文等宽字符） |
| `truncatePlainText(text, maxWidth)` | 截断文本到指定宽度 |

### 重要变量

| 变量 | 用途 |
|------|------|
| `lastRenderedStatusLine` | 缓存上次渲染的内容，用于去重 |
| `processObj.stdout.rows` | 终端实际行数 |
| `processObj.stdout.columns` | 终端实际列数 |

---

## 📝 **注意事项**

### 1. 内容比较是字符串完全匹配

当前的去重逻辑使用 `text === lastRenderedStatusLine` 进行精确匹配。这意味着：

**✅ 会跳过重绘的情况**：
- Usage 百分比相同
- 更新时间戳相同
- Tips 消息相同

**❌ 会触发重绘的情况**：
- Usage 百分比变化（如 `95.5%` → `95.4%`）
- 更新时间戳变化（如 `15:10:30` → `15:10:31`）
- Tips 消息轮换

### 2. 时间戳导致的更新

由于状态行包含时间戳（如 `updated 15:10:30`），每次 usage 刷新都会导致时间戳变化，从而触发重绘。

**如果希望进一步减少重绘**，可以考虑：
- 只比较 usage 数据部分，忽略时间戳
- 或者移除时间戳显示

### 3. 终端兼容性

当前实现依赖于：
- `processObj.stdout.rows` 和 `processObj.stdout.columns` 的准确性
- ANSI 转义序列的支持

在某些终端模拟器上，这些值可能不准确。代码中已使用后备值：
```javascript
const rows = Math.max(1, Number(processObj.stdout.rows) || 24);
const cols = Math.max(20, Number(processObj.stdout.columns) || 80);
```

---

## 🎯 **总结**

### 修复内容

1. ✅ **防止无意义的重绘** - 内容相同时跳过更新
2. ✅ **使用实际行数** - 替代固定的 999
3. ✅ **自动截断超长文本** - 根据终端宽度
4. ✅ **Resize 事件处理** - 自动适应新尺寸
5. ✅ **清除时重置缓存** - 确保下次正确渲染

### 代码影响范围

**修改文件**：
- `lib/cli/services/pty/runtime.js`

**修改函数**：
- `writeUsageStatusLine()` - 添加去重逻辑和宽度处理
- `clearUsageStatusLine()` - 重置缓存
- `onResize()` - 添加状态行重绘逻辑

**新增变量**：
- `lastRenderedStatusLine` - 缓存上次渲染内容

### 向后兼容性

✅ 完全向后兼容
- 不改变 API 接口
- 不影响现有功能
- 只是优化渲染逻辑

---

**版本**：v1.1.0
**最后更新**：2026-04-06
**作者**：ai-home 开发团队
