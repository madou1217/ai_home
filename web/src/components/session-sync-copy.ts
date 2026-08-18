/**
 * 会话同步的用户可见边界，供设置页和 Toolkit 共用，避免不同页面给出
 * 相互矛盾的“自动同步”解释。
 */
export const SESSION_SYNC_SCOPE = '会话/对话 ID、项目目录、transcript 路径、回合/事件、运行状态和错误/终止标记';

export const SESSION_SYNC_BOUNDARY = 'Hook 载荷不包含凭据、配置文件内容或模型输出正文；WebUI 按本机 session 存储读取 transcript 来渲染会话。';

export const SESSION_SYNC_POLICY = '会话同步不是账号或配置同步：Server 启动不会修改 Provider 配置。只有点击“启用会话同步”并确认后，才会写入 AIH 标记的官方 Hook；没有 Hook 时使用文件轮询，无法读取会话文件时标记为不可用。';
