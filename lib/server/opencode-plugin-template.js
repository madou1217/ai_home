'use strict';

// opencode 会话生命周期 hook 桥(P4):opencode 没有 JSON hooks 配置,机制是 JS 插件——
// `<config>/opencode/plugin/*.js` 的 ESM 模块。本模块生成一个「桥插件」源码:它订阅
// opencode 事件总线,把会话开始/结束等生命周期信号 fire-and-forget POST 给 aih 的
// provider-hook receiver(与 claude/codex 的 sender→receiver 同一归一化管线),从而给
// webUI 提供 opencode 默认(bypass)run 路径的实时 pending 状态。
//
// 兼容矩阵(opencode 2.0 变更:插件入口从「工厂函数返回 hooks」改为「default 对象
// {id, effect|setup}」,函数/具名导出会被直接拒绝;事件形状也从 {type, properties}
// 改为信封 {type, data:{sessionID, ...}},会话生命周期事件改名):
//   - v2(2.0+): default 对象取 id + setup;setup 里 ctx.event.subscribe({signal})
//     拿到信封事件流。映射:session.execution.started → UserPromptSubmit;
//     session.execution.succeeded|failed|interrupted → Stop。
//   - v1(>=1.18.29): 同一 default 对象上的 server() 入口(旧式 hooks 对象),
//     事件形状 {type, properties}。映射:首个产出事件 → UserPromptSubmit;
//     session.idle → Stop。(1.18.29 以下不认识对象入口,插件静默不生效,不再崩溃。)
// 只发这两类边界信号(每会话一次开/一次合),避免 delta 类高频事件放大。
//
// 事件映射(插件侧 → receiver ?event= → normalizer 归一):
//   会话首次活跃(execution/产出事件) → UserPromptSubmit → session:turn-started
//   执行结束(execution 终态/session.idle) → Stop       → session:turn-completed

const AIH_PLUGIN_MARKER = 'aih-session-hook';

// 生成插件源码。receiverUrl 形如 http://127.0.0.1:9527/v0/webui/session-events/provider-hook。
// 源码零外部依赖(ESM:全局 fetch),把 marker 写进注释供安装诊断识别托管文件。
function buildOpenCodePluginSource(options = {}) {
  const receiverUrl = String(options.receiverUrl || '').trim();
  // 内嵌为字符串常量;JSON.stringify 保证转义安全。
  const urlLiteral = JSON.stringify(receiverUrl);
  return `// ${AIH_PLUGIN_MARKER}: AIH 托管的 opencode 会话生命周期桥(自动生成,勿手改)
// 作用:把 opencode 事件总线(随 opencode 主版本)的会话开始/结束信号 POST 给 aih,
// 驱动 webUI 实时 pending 状态。兼容 opencode v2(default 对象 + setup)与
// v1>=1.18.29(default 对象 + server() 旧式 hooks)。
const AIH_RECEIVER_URL = ${urlLiteral};
const aihActiveSessions = new Set();
let aihV2SetupActive = false;

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

// —— v2 事件映射(信封:{type, data:{sessionID, ...}}) ——
// session.execution.started 首次出现 = 本轮开始(每会话去重,终态后重置)。
// session.execution.succeeded|failed|interrupted = 本轮结束(仅对已开始的会话发 Stop)。
function aihHandleV2Event(event) {
  if (!event || typeof event !== 'object') return;
  const type = String(event.type || '');
  const data = event.data || {};
  const sessionID = data.sessionID || event.sessionID || '';
  if (!sessionID) return;

  if (type === 'session.execution.started') {
    if (!aihActiveSessions.has(sessionID)) {
      aihActiveSessions.add(sessionID);
      aihPost('UserPromptSubmit', sessionID);
    }
    return;
  }
  if (type === 'session.execution.succeeded' || type === 'session.execution.failed'
    || type === 'session.execution.interrupted') {
    if (aihActiveSessions.delete(sessionID)) aihPost('Stop', sessionID);
  }
}

// —— v1 事件映射(旧式:{type, properties}) ——
function aihHandleV1Event(event) {
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

export default {
  id: '${AIH_PLUGIN_MARKER}',
  // v2 入口:订阅信封事件流;返回 cleanup(abort 订阅)。
  async setup(ctx) {
    if (!ctx || !ctx.event || typeof ctx.event.subscribe !== 'function') return;
    aihV2SetupActive = true;
    const controller = new AbortController();
    const consume = async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try { aihHandleV2Event(event); } catch (_error) { /* ignore */ }
        }
      } catch (_error) { /* 订阅结束/被 abort:静默退出 */ }
    };
    consume();
    return () => { try { controller.abort(); } catch (_error) { /* ignore */ } };
  },
  // v1 入口(>=1.18.29 的对象入口会调用它;v2 忽略未知键)。
  // 同一进程里若 v2 的 setup 已生效,则不再注册旧式事件钩子,避免双发。
  async server() {
    if (aihV2SetupActive) return {};
    return {
      event: async ({ event }) => { aihHandleV1Event(event); }
    };
  }
};
`;
}

module.exports = {
  AIH_PLUGIN_MARKER,
  buildOpenCodePluginSource
};
