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

// nativeChatTransportDecl 按 Node 的 TRANSPORT_BY_PROVIDER 声明顺序登记一个
// Provider 的会话传输方式。顺序本身是合同的一部分（TmuxRunProviders 依赖它），
// 因此用有序表声明，再由它派生查询表与顺序表，避免两份名单漂移。
type nativeChatTransportDecl struct {
	ProviderID string
	transportDecl
}

var nativeChatTransportDecls = []nativeChatTransportDecl{
	{ProviderID: "claude", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, tmuxRun: true}},
	{ProviderID: "codex", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, tmuxRun: true}},
	{ProviderID: "opencode", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, tmuxRun: true}},
	// qoder 的会话 JSONL 不写 token 用量，唯一可信来源是 stream-json 的 result.usage。
	{ProviderID: "qoder", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, streamUsage: true}},
	{ProviderID: "qodercn", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, streamUsage: true}},
	{ProviderID: "grok", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv}},
	{ProviderID: "zcode", transportDecl: transportDecl{mode: ModeDesktopSession, promptDelivery: PromptDeliveryArgv}},
	// cline 续聊走 ACP：TUI 敲入在进程启动期会被吞（2026-10-16 实测）。
	{ProviderID: "cline", transportDecl: transportDecl{mode: ModeHeadlessStream, resumeMode: ModeACPSession, promptDelivery: PromptDeliveryArgv}},
	// AGY 新建和精确续聊都使用 --print --output-format stream-json；不冒充 PTY transcript。
	{ProviderID: "agy", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv, tmuxRun: true}},
	{ProviderID: "codebuddy", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv}},
	{ProviderID: "codebuddycn", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv}},
	{ProviderID: "workbuddy", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv}},
	{ProviderID: "workbuddycn", transportDecl: transportDecl{mode: ModeHeadlessStream, promptDelivery: PromptDeliveryArgv}},
}

// transportByProvider 由有序表派生，与 Node 的 TRANSPORT_BY_PROVIDER 同序。
var transportByProvider = func() map[string]transportDecl {
	indexed := make(map[string]transportDecl, len(nativeChatTransportDecls))
	for _, entry := range nativeChatTransportDecls {
		indexed[entry.ProviderID] = entry.transportDecl
	}
	return indexed
}()

// transportProviderOrder 由有序表派生，供 TmuxRunProviders 保持与 Node 一致的顺序。
var transportProviderOrder = func() []string {
	order := make([]string, 0, len(nativeChatTransportDecls))
	for _, entry := range nativeChatTransportDecls {
		order = append(order, entry.ProviderID)
	}
	return order
}()

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
