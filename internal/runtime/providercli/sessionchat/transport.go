package sessionchat

// 传输模式：一次 WebUI 聊天轮怎么跑（声明式描述符，不在调用点散落 Provider 名单）。
const (
	// ModeHeadlessStream 是非交互 CLI + 结构化 JSON 流，stdout 逐行解析。
	ModeHeadlessStream = "headless-stream"
	// ModePTYTranscript 是交互式 PTY，本轮完成靠 transcript 轮询。
	ModePTYTranscript = "pty-transcript"
	// ModeACPSession 是 ACP 协议通道（stdio NDJSON JSON-RPC），prompt 走协议。
	ModeACPSession = "acp-session"
	// ModeDesktopSession 是桌面端会话 runner（zcode）。
	ModeDesktopSession = "desktop-session"

	// PromptDeliveryArgv 表示 prompt 经 argv 传入。
	PromptDeliveryArgv = "argv"
	// PromptDeliveryTyped 表示 prompt 必须由 PTY 输入通道敲入。
	PromptDeliveryTyped = "typed"
)

// Transport 是单个 Provider 的传输声明。
type Transport struct {
	Mode           string
	PromptDelivery string
	StreamUsage    bool
}

// transportDecl 是 Provider 的完整声明（含续聊覆盖）。
type transportDecl struct {
	mode           string
	resumeMode     string
	promptDelivery string
	resumeDelivery string
	streamUsage    bool
	tmuxRun        bool
}

// defaultTransport 是未声明 Provider 的缺省：交互式 PTY + argv prompt。
var defaultTransport = Transport{Mode: ModePTYTranscript, PromptDelivery: PromptDeliveryArgv}

// transportByProvider 与 lib/server/native-session-chat-transport.js 的
// TRANSPORT_BY_PROVIDER 同序同值。
var transportByProvider = map[string]transportDecl{
	"claude":   {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, tmuxRun: true},
	"codex":    {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, tmuxRun: true},
	"opencode": {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, tmuxRun: true},
	// qoder 的会话 JSONL 不写 token 用量，唯一可信来源是 stream-json 的 result.usage。
	"qoder":   {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, streamUsage: true},
	"qodercn": {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, streamUsage: true},
	"grok":    {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv},
	"zcode":   {mode: ModeDesktopSession, promptDelivery: PromptDeliveryArgv},
	// cline 续聊走 ACP：TUI 敲入在进程启动期会被吞（2026-10-16 实测）。
	"cline": {mode: ModeHeadlessStream, resumeMode: ModeACPSession, promptDelivery: PromptDeliveryArgv},
	// agy 新会话是 headless --print（一次性），续接走 TUI --conversation。
	"agy":         {mode: ModePTYTranscript, promptDelivery: PromptDeliveryArgv, tmuxRun: true},
	"codebuddy":   {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv},
	"codebuddycn": {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv},
	"workbuddy":   {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv},
	"workbuddycn": {mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv},
}

// transportProviderOrder 是声明顺序，供 TmuxRunProviders 保持与 Node 一致的顺序。
var transportProviderOrder = []string{
	"claude", "codex", "opencode", "qoder", "qodercn", "grok", "zcode",
	"cline", "agy", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn",
}

// ResolveNativeChatTransport 解析某 Provider（可选续聊轮）的传输方式。
func ResolveNativeChatTransport(provider string, isResume bool) Transport {
	declared, found := transportByProvider[NormalizeProvider(provider)]
	if !found {
		return defaultTransport
	}
	mode := declared.mode
	delivery := declared.promptDelivery
	if isResume && declared.resumeMode != "" {
		mode = declared.resumeMode
	}
	if isResume && declared.resumeDelivery != "" {
		delivery = declared.resumeDelivery
	}
	return Transport{Mode: mode, PromptDelivery: delivery, StreamUsage: declared.streamUsage}
}

// UsesHeadlessNativeStream 判断该轮是否走「非交互 CLI + 结构化 JSON 流」。
func UsesHeadlessNativeStream(provider string, isResume bool) bool {
	return ResolveNativeChatTransport(provider, isResume).Mode == ModeHeadlessStream
}

// UsesNativeStreamUsage 判断 token 用量是否只能从 stream-json 的 result.usage 读取。
func UsesNativeStreamUsage(provider string, isResume bool) bool {
	return ResolveNativeChatTransport(provider, isResume).StreamUsage
}

// TypesPromptIntoTerminal 判断 prompt 是否必须由 PTY 输入通道敲入。
func TypesPromptIntoTerminal(provider string, isResume bool) bool {
	return ResolveNativeChatTransport(provider, isResume).PromptDelivery == PromptDeliveryTyped
}

// UsesTmuxRun 判断该 Provider 的非交互轮是否声明了 tmux 化 run。
func UsesTmuxRun(provider string) bool {
	declared, found := transportByProvider[NormalizeProvider(provider)]
	return found && declared.tmuxRun
}

// TmuxRunProviders 返回声明 tmuxRun 的 Provider（保持声明顺序）。
func TmuxRunProviders() []string {
	result := make([]string, 0, 4)
	for _, provider := range transportProviderOrder {
		if transportByProvider[provider].tmuxRun {
			result = append(result, provider)
		}
	}
	return result
}

// InfersCLIGeneratedSessionIDOnExit 判断退出后是否需要回认 CLI 自己生成的会话 id。
func InfersCLIGeneratedSessionIDOnExit(provider string) bool {
	normalized := NormalizeProvider(provider)
	return normalized == "agy" || normalized == "cline"
}
