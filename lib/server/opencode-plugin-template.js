'use strict';

// opencode 会话生命周期 hook 桥(P4):opencode 没有 JSON hooks 配置,机制是 JS 插件——
// `<config>/opencode/plugin/*.js` 的 ESM 模块,export 一个 async 工厂返回 hooks 对象。
// 本模块生成一个「桥插件」源码:它订阅 opencode 事件总线,把会话开始/结束等生命周期信号
// fire-and-forget POST 给 aih 的 provider-hook receiver(与 claude/codex 的 sender→receiver
// 同一归一化管线),从而给 webUI 提供 opencode 默认(bypass)run 路径的实时 pending 状态。
//
// 事件映射(插件侧 → receiver ?event= → normalizer 归一):
//   会话首次活跃(收到消息/增量) → UserPromptSubmit → session:turn-started
//   session.idle                 → Stop            → session:turn-completed
// 只发这两类边界信号(每会话一次开/一次合),避免 message.part.delta 的高频放大。

const AIH_PLUGIN_MARKER = 'aih-session-hook';

// 生成插件源码。receiverUrl 形如 http://127.0.0.1:9527/v0/webui/session-events/provider-hook。
// 源码零外部依赖(Bun 环境:全局 fetch),把 marker 写进注释供安装诊断识别托管文件。
function buildOpenCodePluginSource(options = {}) {
  const receiverUrl = String(options.receiverUrl || '').trim();
  // 内嵌为字符串常量;JSON.stringify 保证转义安全。
  const urlLiteral = JSON.stringify(receiverUrl);
  return `// ${AIH_PLUGIN_MARKER}: AIH 托管的 opencode 会话生命周期桥(自动生成,勿手改)
// 作用:把 opencode 事件总线的会话开始/结束信号 POST 给 aih,驱动 webUI 实时 pending 状态。
const AIH_RECEIVER_URL = ${urlLiteral};
const aihActiveSessions = new Set();

function aihPost(eventName, sessionID) {
  if (!AIH_RECEIVER_URL || !sessionID) return;
  const url = AIH_RECEIVER_URL
    + '?provider=opencode&event=' + encodeURIComponent(eventName)
    + '&sessionId=' + encodeURIComponent(sessionID);
  try {
    // fire-and-forget:不 await,失败静默(不能拖慢/中断会话流)。
    const p = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventName: eventName, sessionId: sessionID, at: Date.now() })
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_error) { /* ignore */ }
}

export const AihSessionHook = async () => ({
  event: async ({ event }) => {
    if (!event || typeof event !== 'object') return;
    const type = String(event.type || '');
    const props = event.properties || {};
    const info = props.info || {};
    const sessionID = props.sessionID || info.sessionID || info.id
      || (props.part && props.part.sessionID) || '';
    if (!sessionID) return;

    if (type === 'session.idle') {
      if (aihActiveSessions.delete(sessionID)) aihPost('Stop', sessionID);
      return;
    }
    // 任意「会话产出」事件的首次出现 = 本轮开始(每会话去重,idle 后重置)。
    if (type === 'message.updated' || type === 'message.part.updated'
      || type === 'message.part.delta' || type === 'session.status') {
      if (!aihActiveSessions.has(sessionID)) {
        aihActiveSessions.add(sessionID);
        aihPost('UserPromptSubmit', sessionID);
      }
    }
  }
});
`;
}

module.exports = {
  AIH_PLUGIN_MARKER,
  buildOpenCodePluginSource
};
