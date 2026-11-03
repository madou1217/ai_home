# Chat 消息体验与大文本引用设计

## 背景

当前 Chat 已经分别具备部分消息指标、模型字段、Markdown/代码渲染和附件持久化能力，但这些能力没有在所有 Chat 入口形成一致的用户体验。普通消息的复制入口不统一，模型和耗时在流式、历史、恢复三种状态下显示口径不一致；用户直接粘贴大段文本时，正文仍可能进入输入框并随请求发送，失去了文件引用、可恢复和可复用的优势。

本设计覆盖 WebUI Chat、Chat Mini Window 与 Workbench 共用的消息和 composer 边界。目标是让用户始终知道“这条回复用了什么模型、花了多久、如何复制”，并让大文本以文件引用进入请求，同时保留现有图片、文档、视频附件协议和服务端安全边界。

## 目标与非目标

### 目标

1. 每条 assistant 回复在完成后显示真实的模型/provider、总耗时、首字节耗时；流式期间显示实时耗时和生成状态，完成后冻结真实指标。
2. 普通消息提供统一的整条复制操作，复制成功有短暂的明确反馈；代码块继续提供局部代码复制。
3. 模型展示使用响应实际使用的模型/provider，不能只读取当前 composer 选择。
4. 用户粘贴达到阈值的大文本时，文本不进入聊天输入框；前端将其转换成 UTF-8 文本附件并复用现有附件上传/持久化链路。
5. 大文本附件在输入框中显示可移除的文件引用芯片，发送时使用附件引用 ID；服务端将它落盘到受控目录，并把真实文件路径提供给 harness/provider 的文件引用逻辑。
6. 普通文件上传、大文本粘贴和 Chat/Workbench 两个入口使用同一套附件状态和引用语义。
7. 附件准备、上传、发送失败时保留可重试状态，不丢失用户已经粘贴或选择的内容。

### 非目标

- 不更换现有 Markdown 渲染库或重新设计完整 Chat 视觉主题。
- 不改变 provider 路由、模型选择策略或服务端凭据边界。
- 不把任意本地路径直接暴露给浏览器；浏览器只持有受控附件 ID、名称和大小。
- 不为本次改动新增独立环境变量。

## 用户交互

### 回复信息条

assistant 消息底部统一显示一个紧凑信息条：

```text
模型名 · 供应商 · 用时 8.4s · 首字节 1.2s                 复制
```

字段按真实数据存在性显示。没有真实 `durationMs` 或 `ttftMs` 时隐藏对应字段，不显示猜测值。流式期间显示“生成中 · 计时 2.3s”，停止、失败和恢复历史分别显示对应终态。复制整条消息时复制渲染前的 Markdown/纯文本语义内容，成功后按钮显示“已复制”约 1.8 秒。

### 大文本粘贴

阈值为 **200 个 Unicode 字符，达到即转换**（2026-10-31 由 12,000 字符 / 48 KiB 下调）。短文本仍直接写入 composer。

大文本粘贴流程：

1. 拦截粘贴事件并计算字符数与 UTF-8 字节数。
2. 超过阈值时生成名称 `pasted-text-YYYYMMDD-HHmmss.txt`，进入附件准备状态；原文不写入输入框。
3. composer 显示“粘贴文本 · N KB”的文件芯片和“准备中/已就绪/失败”状态。
4. 用户可移除、重试或继续输入补充说明；补充说明与附件引用分开保存。
5. 发送时先上传/持久化附件，成功后只提交 attachment ID；请求正文不重复包含全文。
6. 上传失败时保留本地附件内容在内存状态中，显示“重试上传”，不静默丢弃。

普通文件通过相同状态机进入 composer：`preparing → ready → uploading → uploaded → failed`。发送时只使用 `uploaded` 的引用。

## 数据与接口

### 消息元数据

现有 `ChatMessage` 的 `model`、`provider` 和 `metrics` 继续作为权威展示输入。`metrics` 使用现有字段：

```ts
interface ChatMessageMetrics {
  durationMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSec?: number;
}
```

如果 canonical timeline 使用 detail/source payload，则在投影层统一映射到同一展示模型；渲染组件不再分别猜测 legacy/native 字段。

### 附件引用

浏览器侧附件状态包含：

```ts
type PendingAttachmentStatus = 'preparing' | 'ready' | 'uploading' | 'uploaded' | 'failed';

interface PendingAttachment {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  documentText?: string;
  status: PendingAttachmentStatus;
  error?: string;
  attachmentId?: string;
}
```

大文本使用现有文档附件验证、上传和持久化接口。服务端成功响应至少返回 `attachmentId`、安全显示名、字节数和 kind；实际文件路径只在服务端内部传给 `appendDocumentPathsToPrompt` 或对应 harness 投影，不进入普通浏览器消息正文。

### 去重与失败

- 同一个 composer 状态中，附件以 `key` 去重；一次粘贴只生成一个文本附件。
- 上传成功后，重新发送不重复上传同一个 `attachmentId`。
- 发送取消或请求失败不删除已上传附件，允许用户重试当前消息。
- 服务端仍使用现有大小、MIME、UTF-8、路径清理和原子写入校验。

## 模块边界

- `web/src/components/chat/MessageMetadata.tsx` 与消息操作组件：只负责消息元数据、复制反馈和可访问性。
- `web/src/components/chat/MessageBubble.tsx`、`MessageArea.tsx`、`TimelineItemView.tsx`：把 legacy/canonical 消息投影到统一展示组件，不自行格式化时间或复制逻辑。
- `web/src/components/chat/attachment-files.ts`、`use-chat-file-input.ts`、`web/src/features/chat-runtime/use-composer-attachments.ts`：统一附件状态和大文本粘贴转换。
- `web/src/features/chat-runtime/use-composer-controller.ts`、`Composer.tsx`、legacy composer：只负责提交时解析已上传的附件引用，不重复内联全文。
- `lib/server/chat-attachment-validation.js`、`chat-attachment-persistence.js`、`webui-chat-routes.js`：继续作为服务端文件安全与路径投影边界，必要时补充“预存附件引用”分支。
- 现有 `message-metrics-format.ts`、`stats-line-aggregation.ts` 和 server `buildChatTurnMetrics` 作为指标事实源，不新增第二套计时协议。

## 错误与可观察性

- 大文本转换失败：composer 保留原文的待处理附件状态，显示可重试错误。
- 服务端拒绝附件：显示服务端错误和限制信息；不发送正文全文作为隐式降级。
- 指标缺失：只隐藏缺失字段；不以本地请求时间替代服务端真实指标。
- 模型缺失：优先使用消息实际模型，其次使用 canonical detail model；没有证据时显示“模型信息不可用”，不使用当前选择冒充。

## 验收标准

1. 流式回复期间能看到生成中状态和实时计时，完成后显示真实总耗时和首字节耗时。
2. 历史消息、刷新恢复消息和实时消息使用同一信息条格式，并显示实际模型/provider。
3. 普通消息复制成功有反馈；复制内容不包含 UI 元数据；代码块复制仍可用。
4. 粘贴低于阈值的文本仍直接进入输入框。
5. 粘贴达到任一阈值的大文本不会进入输入框，显示文本文件引用芯片，发送请求只带附件引用 ID。
6. 服务端能从附件引用得到受控文件路径并交给现有文件引用 prompt；浏览器不会收到任意路径。
7. 附件失败可重试，短文本、普通文件、图片/视频现有上传行为不回归。
8. WebUI 全量构建、改动文件 ESLint、现有相关 Chat/附件/指标测试和真机页面检查全部通过。

## 设计模式

- **Projection/Facade**：legacy 与 canonical 消息先投影到统一消息展示模型，再由 `MessageMetadata`/复制操作渲染，避免多个入口重复判断字段。
- **State machine**：附件从准备到上传、失败、重试使用显式状态，避免“有 dataUrl 就认为已发送”。
- **Capability-preserving adapter**：复用现有附件验证、原子写入和 provider 文件路径投影，不改变 provider 路由与凭据边界。
- **KISS/YAGNI**：不引入新的消息协议和独立存储服务；只有超过阈值的粘贴内容转为文件，其余文本保持原路径。
