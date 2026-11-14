package webuiproviderhooksapi

// Hook 写盘逻辑：Provider 差异来自 Go 合同（core/providers.SessionSync），
// 本文件只实现三种写入格式适配器，不按 Provider 名写分支：
//   - json_hooks      事件 → [{hooks:[…]}]（codex / claude / gemini / grok）
//   - agy_named_hooks 顶层具名 hook 定义（agy）
//   - opencode_plugin 插件桥文件（opencode，见 opencode.go）
//
// 判定口径与 Node 的 provider-session-hook-config.js 对齐：只撤销带
// --aih-provider-session-hook 且指向同一 Provider 的托管 handler，用户自建
// hook 与其他配置键原样保留。文件写回使用有序 JSON（见 orderedjson.go）。

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	// managedHookMarker 是 AIH 托管 handler 的唯一识别标记。
	managedHookMarker = "--aih-provider-session-hook"
	// defaultHookTimeoutSeconds 与 Node 的 DEFAULT_HOOK_TIMEOUT_SECONDS 一致。
	defaultHookTimeoutSeconds = 10
	// defaultReceiverURL 与 Node 的 DEFAULT_RECEIVER_URL 一致。
	defaultReceiverURL = "http://127.0.0.1:9527/v0/webui/session-events/provider-hook"
	// agyManagedHookName 与 Node 的 AGY_MANAGED_HOOK_NAME 一致。
	agyManagedHookName = "aih-session-sync"
)

// hookProfile 是写文件所需的一份 Provider Hook 档案。
type hookProfile struct {
	providerID    string
	supported     bool
	adapter       providers.HookAdapterID
	target        []string
	targetKind    string
	timeoutUnit   providers.HookTimeoutUnit
	eventMatchers map[string]string
	featureFlag   bool
	events        []string
}

// normalizeProvider 与 Node 的 normalizeProvider 同口径。
func normalizeProvider(value string) string {
	return strings.TrimSpace(strings.ToLower(value))
}

// resolveHookProfile 从 Go 合同推导档案；合同没有声明的一律留空。
func resolveHookProfile(catalog *providers.Catalog, providerRaw string) hookProfile {
	provider := normalizeProvider(providerRaw)
	definition, exists := catalog.Get(provider)
	if !exists {
		return hookProfile{providerID: provider}
	}
	derived := providers.DeriveHookProfile(definition)
	profile := hookProfile{
		providerID:    provider,
		supported:     derived.Supported && strings.TrimSpace(string(derived.Adapter)) != "",
		adapter:       derived.Adapter,
		target:        append([]string{}, derived.Target...),
		targetKind:    strings.TrimSpace(definition.SessionSync.TargetKind),
		timeoutUnit:   derived.TimeoutUnit,
		eventMatchers: derived.EventMatchers,
		events:        normalizeEvents(definition.SessionSync.Events),
	}
	if derived.FeatureFlag != nil {
		profile.featureFlag = *derived.FeatureFlag
	}
	return profile
}

// normalizeEvents 去掉空事件名，保持合同顺序。
func normalizeEvents(events []string) []string {
	result := make([]string, 0, len(events))
	for _, event := range events {
		text := strings.TrimSpace(event)
		if text != "" {
			result = append(result, text)
		}
	}
	return result
}

// hookTargetPath 把合同里的 home 相对路径段拼成绝对路径；没有路径段时返回空串。
func hookTargetPath(profile hookProfile, hostHomeDir string) string {
	if len(profile.target) == 0 || strings.TrimSpace(hostHomeDir) == "" {
		return ""
	}
	parts := make([]string, 0, len(profile.target)+1)
	parts = append(parts, hostHomeDir)
	for _, segment := range profile.target {
		parts = append(parts, filepath.FromSlash(segment))
	}
	return filepath.Join(parts...)
}

// installContext 是一次安装请求的服务端上下文。
type installContext struct {
	hostHomeDir string
	receiverURL string
	// senderExecPath 覆盖发送器可执行文件路径；空时用当前进程自身。
	senderExecPath string
	codexVersion   string
	platform       string
}

func (context installContext) resolvedPlatform() string {
	if strings.TrimSpace(context.platform) != "" {
		return strings.TrimSpace(context.platform)
	}
	return runtime.GOOS
}

// buildCommandHookHandler 构造一个托管 command handler。
func buildCommandHookHandler(profile hookProfile, event string, context installContext) *orderedObject {
	handler := newOrderedObject()
	handler.set("type", "command")
	handler.set("command", buildProviderSessionHookSenderCommand(profile.providerID, event, context))
	handler.set("timeout", hookTimeout(profile))
	return handler
}

// hookTimeout 与 Node 的 buildCommandHookHandler 同口径：毫秒档案至少 100，
// 其余至少 1 秒；未配置时默认 10 秒。
func hookTimeout(profile hookProfile) int {
	if profile.timeoutUnit == providers.HookTimeoutMilliseconds {
		return defaultHookTimeoutSeconds * 1000
	}
	return defaultHookTimeoutSeconds
}

// buildProviderSessionHookSenderCommand 生成托管 handler 的命令行。
//
// 发送器就是宿主二进制自己的 __provider-hook 子命令：provider 侧执行 hook 时
// 不再需要 Node 或 PATH 上的 node。标记与参数顺序保持与 Node 版本一致，
// 旧的托管 handler 仍可被 isManagedCommand 识别并替换。
func buildProviderSessionHookSenderCommand(provider string, event string, context installContext) string {
	platform := context.resolvedPlatform()
	receiverURL := buildProviderHookReceiverURL(context.receiverURL, provider, event)
	senderExec := strings.TrimSpace(context.senderExecPath)
	if senderExec == "" {
		if resolved, err := os.Executable(); err == nil {
			senderExec = strings.TrimSpace(resolved)
		}
	}
	if senderExec == "" {
		senderExec = "aih-server"
	}
	if platform == "win32" {
		return strings.Join([]string{
			toWindowsHookToken(senderExec),
			"__provider-hook",
			managedHookMarker,
			"--provider",
			toWindowsHookToken(provider),
			"--event",
			toWindowsHookToken(event),
			"--url",
			toWindowsHookToken(stripURLQuery(receiverURL)),
		}, " ")
	}
	return strings.Join([]string{
		quoteShellArg(senderExec),
		"__provider-hook",
		managedHookMarker,
		"--provider",
		quoteShellArg(provider),
		"--event",
		quoteShellArg(event),
		"--url",
		quoteShellArg(receiverURL),
	}, " ")
}

// buildProviderHookReceiverURL 把 provider/event 写进接收地址。
// 参数顺序保持 Node 的 URLSearchParams 写法（provider 先于 event）。
func buildProviderHookReceiverURL(base string, provider string, event string) string {
	base = strings.TrimSpace(base)
	if base == "" {
		base = defaultReceiverURL
	}
	separator := "?"
	if strings.Contains(base, "?") {
		separator = "&"
	}
	parts := make([]string, 0, 2)
	if strings.TrimSpace(provider) != "" {
		parts = append(parts, "provider="+url.QueryEscape(provider))
	}
	if strings.TrimSpace(event) != "" {
		parts = append(parts, "event="+url.QueryEscape(event))
	}
	if len(parts) == 0 {
		return base
	}
	return base + separator + strings.Join(parts, "&")
}

// quoteShellArg 与 Node 的 quoteShellArg 一致：单引号包裹并把内部单引号转义。
func quoteShellArg(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// toWindowsHookToken 与 Node 的 toWindowsHookToken 一致：无空格的 token 保持裸文本，
// 反斜杠统一正斜杠；含空格时才加引号。
func toWindowsHookToken(value string) string {
	text := strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if !strings.ContainsAny(text, " \t") {
		return text
	}
	return "\"" + strings.ReplaceAll(text, "\"", "\"\"") + "\""
}

func stripURLQuery(value string) string {
	if index := strings.Index(value, "?"); index >= 0 {
		return value[:index]
	}
	return value
}

// commandReferencesProvider 与 Node 的 commandReferencesProvider 同口径：
// 先把带引号的 --provider 归一成裸标记，再按三种引号形态比对 Provider。
func commandReferencesProvider(command string, provider string) bool {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return false
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(command), "'--provider'", "--provider"), "\"--provider\"", "--provider")
	return strings.Contains(normalized, "--provider '"+provider+"'") ||
		strings.Contains(normalized, "--provider \""+provider+"\"") ||
		strings.Contains(normalized, "--provider "+provider)
}

func isManagedCommand(command string, provider string) bool {
	text := strings.TrimSpace(command)
	if text == "" || !strings.Contains(text, managedHookMarker) {
		return false
	}
	return commandReferencesProvider(text, provider)
}

func isManagedHandler(handler any, provider string) bool {
	object, ok := handler.(*orderedObject)
	if !ok {
		return false
	}
	command, _ := object.get("command").(string)
	return isManagedCommand(command, provider)
}

// removeManagedHandlersFromHooksObject 只移除 AIH 托管 handler，返回保序的新 hooks 对象。
func removeManagedHandlersFromHooksObject(hooks *orderedObject, provider string) (*orderedObject, bool) {
	next := newOrderedObject()
	changed := false
	if hooks == nil {
		return next, false
	}
	for _, eventName := range hooks.keys {
		groups, isArray := hooks.get(eventName).([]any)
		kept := make([]any, 0, len(groups))
		if isArray {
			for _, group := range groups {
				groupObject, isObject := group.(*orderedObject)
				if !isObject {
					kept = append(kept, group)
					continue
				}
				handlerList, hasHooks := groupObject.get("hooks").([]any)
				if !hasHooks {
					kept = append(kept, group)
					continue
				}
				remaining := make([]any, 0, len(handlerList))
				removed := false
				for _, handler := range handlerList {
					if isManagedHandler(handler, provider) {
						removed = true
						continue
					}
					remaining = append(remaining, handler)
				}
				if !removed {
					kept = append(kept, group)
					continue
				}
				changed = true
				if len(remaining) == 0 {
					continue
				}
				rebuilt := newOrderedObject()
				for _, key := range groupObject.keys {
					if key == "hooks" {
						rebuilt.set("hooks", remaining)
						continue
					}
					rebuilt.set(key, groupObject.get(key))
				}
				kept = append(kept, rebuilt)
			}
		}
		if len(kept) > 0 {
			next.set(eventName, kept)
			continue
		}
		if isArray && len(groups) > 0 {
			changed = true
		}
	}
	return next, changed
}

// installJSONHookFile 处理 json_hooks 档案的安装。
func installJSONHookFile(profile hookProfile, context installContext, dryRun bool) installResult {
	targetPath := hookTargetPath(profile, context.hostHomeDir)
	if targetPath == "" {
		return installFailure(profile.providerID, "hook_target_missing")
	}
	existing := readJSONObjectFile(targetPath)
	before := encodeOrderedCompact(asOrderedObject(existing))
	root := asOrderedObject(existing)
	hooks, _ := root.get("hooks").(*orderedObject)
	cleaned, _ := removeManagedHandlersFromHooksObject(hooks, profile.providerID)
	for _, event := range profile.events {
		handler := buildCommandHookHandler(profile, event, context)
		group := newOrderedObject()
		group.set("hooks", []any{handler})
		if matcher := strings.TrimSpace(profile.eventMatchers[event]); matcher != "" {
			group.set("matcher", matcher)
		}
		current, _ := cleaned.get(event).([]any)
		cleaned.set(event, append(append([]any{}, current...), group))
	}
	root.set("hooks", cleaned)
	changed := before != encodeOrderedCompact(root)
	if !dryRun {
		if err := writeJSONObjectFile(targetPath, root); err != nil {
			return installFailure(profile.providerID, "hook_write_failed")
		}
	}
	result := installSuccess(profile, targetPath, dryRun, changed, profile.events)
	if profile.featureFlag {
		features := installCodexHooksFeature(context, dryRun)
		result.CodexFeatures = &features
		if features.Changed {
			changedValue := true
			result.Changed = &changedValue
		}
	}
	return result
}

// installAgyHookFile 处理 agy_named_hooks 档案的安装。
func installAgyHookFile(profile hookProfile, context installContext, dryRun bool) installResult {
	targetPath := hookTargetPath(profile, context.hostHomeDir)
	if targetPath == "" {
		return installFailure(profile.providerID, "hook_target_missing")
	}
	existing := readJSONObjectFile(targetPath)
	before := encodeOrderedCompact(asOrderedObject(existing))
	root := asOrderedObject(existing)
	hookDefinition := newOrderedObject()
	hookDefinition.set("enabled", true)
	for _, event := range profile.events {
		handler := buildCommandHookHandler(profile, event, context)
		if event == "PreToolUse" || event == "PostToolUse" {
			group := newOrderedObject()
			group.set("matcher", "*")
			group.set("hooks", []any{handler})
			hookDefinition.set(event, []any{group})
			continue
		}
		hookDefinition.set(event, []any{handler})
	}
	root.set(agyManagedHookName, hookDefinition)
	changed := before != encodeOrderedCompact(root)
	if !dryRun {
		if err := writeJSONObjectFile(targetPath, root); err != nil {
			return installFailure(profile.providerID, "hook_write_failed")
		}
	}
	return installSuccess(profile, targetPath, dryRun, changed, profile.events)
}

func asOrderedObject(value any) *orderedObject {
	if object, ok := value.(*orderedObject); ok {
		return object
	}
	return newOrderedObject()
}

// readJSONObjectFile 与 Node 的 readJsonFileSafe 同口径：读不到或解析失败都当空对象。
func readJSONObjectFile(path string) any {
	raw, err := os.ReadFile(path)
	if err != nil {
		return newOrderedObject()
	}
	value, err := decodeOrderedJSON(raw)
	if err != nil {
		return newOrderedObject()
	}
	return value
}

func writeJSONObjectFile(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(encodeOrderedIndented(value)+"\n"), 0o644)
}

func installFailure(provider string, code string) installResult {
	return installResult{OK: false, Provider: provider, Error: code}
}

func installSuccess(profile hookProfile, targetPath string, dryRun bool, changed bool, events []string) installResult {
	dryRunValue := dryRun
	changedValue := changed
	return installResult{
		OK:         true,
		Provider:   profile.providerID,
		TargetPath: targetPath,
		TargetKind: profile.targetKind,
		DryRun:     &dryRunValue,
		Changed:    &changedValue,
		Events:     append([]string{}, events...),
	}
}
