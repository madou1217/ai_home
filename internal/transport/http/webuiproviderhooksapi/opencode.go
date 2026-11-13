package webuiproviderhooksapi

// opencode 没有 JSON hooks 配置，机制是 <config>/opencode/plugin/*.js 的 ESM 插件。
// 本文件生成与 Node 的 opencode-plugin-template.js 完全一致的桥插件源码：opencode
// 事件总线把会话开始/结束信号 fire-and-forget POST 给 aih 的 provider-hook receiver。
//
// 模板逐字保留（含 v2/v1 兼容矩阵与事件映射），Go 只负责替换接收地址并写文件；
// 安装诊断依赖其中的 marker 与源码形状，改写模板会让两边结论不一致。

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	// openCodePluginMarker 是托管插件文件的识别名。
	openCodePluginMarker = "aih-session-hook"
	// openCodeReceiverPlaceholder 是模板里被替换成 JSON 字符串字面量的占位符。
	openCodeReceiverPlaceholder = "__AIH_RECEIVER_URL_LITERAL__"
)

// openCodePluginTemplate 与 Node 的 buildOpenCodePluginSource 输出逐字一致。
const openCodePluginTemplate = "// aih-session-hook: AIH 托管的 opencode 会话生命周期桥(自动生成,勿手改)\n// 作用:把 opencode 事件总线(随 opencode 主版本)的会话开始/结束信号 POST 给 aih,\n// 驱动 webUI 实时 pending 状态。兼容 opencode v2(default 对象 + setup)与\n// v1>=1.18.29(default 对象 + server() 旧式 hooks)。\nconst AIH_RECEIVER_URL = __AIH_RECEIVER_URL_LITERAL__;\nconst aihActiveSessions = new Set();\nlet aihV2SetupActive = false;\n\nfunction aihPost(eventName, sessionID) {\n  if (!AIH_RECEIVER_URL || !sessionID) return;\n  const url = AIH_RECEIVER_URL\n    + '?provider=opencode&event=' + encodeURIComponent(eventName)\n    + '&sessionId=' + encodeURIComponent(sessionID);\n  try {\n    // fire-and-forget:不 await,失败静默(不能拖慢/中断会话流)。\n    const p = fetch(url, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ eventName: eventName, sessionId: sessionID, at: Date.now() })\n    });\n    if (p && typeof p.catch === 'function') p.catch(() => {});\n  } catch (_error) { /* ignore */ }\n}\n\n// —— v2 事件映射(信封:{type, data:{sessionID, ...}}) ——\n// session.execution.started 首次出现 = 本轮开始(每会话去重,终态后重置)。\n// session.execution.succeeded|failed|interrupted = 本轮结束(仅对已开始的会话发 Stop)。\nfunction aihHandleV2Event(event) {\n  if (!event || typeof event !== 'object') return;\n  const type = String(event.type || '');\n  const data = event.data || {};\n  const sessionID = data.sessionID || event.sessionID || '';\n  if (!sessionID) return;\n\n  if (type === 'session.execution.started') {\n    if (!aihActiveSessions.has(sessionID)) {\n      aihActiveSessions.add(sessionID);\n      aihPost('UserPromptSubmit', sessionID);\n    }\n    return;\n  }\n  if (type === 'session.execution.succeeded' || type === 'session.execution.failed'\n    || type === 'session.execution.interrupted') {\n    if (aihActiveSessions.delete(sessionID)) aihPost('Stop', sessionID);\n  }\n}\n\n// —— v1 事件映射(旧式:{type, properties}) ——\nfunction aihHandleV1Event(event) {\n  if (!event || typeof event !== 'object') return;\n  const type = String(event.type || '');\n  const props = event.properties || {};\n  const info = props.info || {};\n  const sessionID = props.sessionID || info.sessionID || info.id\n    || (props.part && props.part.sessionID) || '';\n  if (!sessionID) return;\n\n  if (type === 'session.idle') {\n    if (aihActiveSessions.delete(sessionID)) aihPost('Stop', sessionID);\n    return;\n  }\n  // 任意「会话产出」事件的首次出现 = 本轮开始(每会话去重,idle 后重置)。\n  if (type === 'message.updated' || type === 'message.part.updated'\n    || type === 'message.part.delta' || type === 'session.status') {\n    if (!aihActiveSessions.has(sessionID)) {\n      aihActiveSessions.add(sessionID);\n      aihPost('UserPromptSubmit', sessionID);\n    }\n  }\n}\n\nexport default {\n  id: 'aih-session-hook',\n  // v2 入口:订阅信封事件流;返回 cleanup(abort 订阅)。\n  async setup(ctx) {\n    if (!ctx || !ctx.event || typeof ctx.event.subscribe !== 'function') return;\n    aihV2SetupActive = true;\n    const controller = new AbortController();\n    const consume = async () => {\n      try {\n        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {\n          try { aihHandleV2Event(event); } catch (_error) { /* ignore */ }\n        }\n      } catch (_error) { /* 订阅结束/被 abort:静默退出 */ }\n    };\n    consume();\n    return () => { try { controller.abort(); } catch (_error) { /* ignore */ } };\n  },\n  // v1 入口(>=1.18.29 的对象入口会调用它;v2 忽略未知键)。\n  // 同一进程里若 v2 的 setup 已生效,则不再注册旧式事件钩子,避免双发。\n  async server() {\n    if (aihV2SetupActive) return {};\n    return {\n      event: async ({ event }) => { aihHandleV1Event(event); }\n    };\n  }\n};\n"

// buildOpenCodePluginSource 生成带目标接收地址的插件源码。
func buildOpenCodePluginSource(receiverURL string) string {
	return strings.Replace(openCodePluginTemplate, openCodeReceiverPlaceholder, quoteJSONString(receiverURL), 1)
}

// quoteJSONString 输出与 JSON.stringify 一致的字符串字面量（不转义 HTML）。
func quoteJSONString(value string) string {
	buffer := &strings.Builder{}
	encoder := jsonStringEncoder{buffer: buffer}
	encoder.write(value)
	return buffer.String()
}

// jsonStringEncoder 只做一件事：把字符串写成 JSON 字面量。
type jsonStringEncoder struct {
	buffer *strings.Builder
}

func (encoder jsonStringEncoder) write(value string) {
	encoder.buffer.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"':
			encoder.buffer.WriteString("\"")
		case '\\':
			encoder.buffer.WriteString("\\\\")
		case '\n':
			encoder.buffer.WriteString("\n")
		case '\r':
			encoder.buffer.WriteString("\r")
		case '\t':
			encoder.buffer.WriteString("\t")
		default:
			encoder.buffer.WriteRune(character)
		}
	}
	encoder.buffer.WriteByte('"')
}

// openCodePluginPath 跟随 opencode 自己的配置根：OPENCODE_CONFIG_DIR 优先，
// 其次 XDG_CONFIG_HOME，最后 host 家目录下的 .config/opencode。
func openCodePluginPath(hostHomeDir string) string {
	configDir := strings.TrimSpace(os.Getenv("OPENCODE_CONFIG_DIR"))
	if configDir == "" {
		if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
			configDir = filepath.Join(xdg, "opencode")
		} else {
			configDir = filepath.Join(hostHomeDir, ".config", "opencode")
		}
	}
	return filepath.Join(configDir, "plugin", openCodePluginMarker+".js")
}

// openCodeReceiverURL 与 Node 的 buildReceiverUrl 同口径。
func openCodeReceiverURL(context installContext) string {
	if explicit := strings.TrimSpace(context.receiverURL); explicit != "" {
		return explicit
	}
	port := parseIntDefault(os.Getenv("AIH_SERVER_PORT"), 9527)
	return fmt.Sprintf("http://127.0.0.1:%d/v0/webui/session-events/provider-hook", port)
}

// installOpenCodePluginHook 写插件文件；dryRun 只计算补丁。
func installOpenCodePluginHook(profile hookProfile, context installContext, dryRun bool) installResult {
	targetPath := openCodePluginPath(context.hostHomeDir)
	receiverURL := openCodeReceiverURL(context)
	source := buildOpenCodePluginSource(receiverURL)
	current := readTextFile(targetPath)
	changed := current != source
	if !dryRun {
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return installFailure(profile.providerID, "plugin_write_failed")
		}
		if err := os.WriteFile(targetPath, []byte(source), 0o644); err != nil {
			return installFailure(profile.providerID, "plugin_write_failed")
		}
	}
	result := installSuccess(profile, targetPath, dryRun, changed, []string{"UserPromptSubmit", "Stop"})
	result.TargetKind = "plugin.js"
	result.ReceiverURL = receiverURL
	return result
}

// parseIntDefault 是 Node Number(...) 的宽松兜底：解析失败用默认值。
func parseIntDefault(raw string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return value
}

func readTextFile(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(raw)
}
