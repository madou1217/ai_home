package chatruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const (
	// GatewayRuntimeScope 表示不绑定单账号，由网关按模型池选号执行。
	GatewayRuntimeScope = "gateway"
)

var (
	gatewayRuntimeScopePattern = regexp.MustCompile(`(?i)^gateway(?::[a-z0-9][a-z0-9-]*)?$`)
	publicAccountRefPattern    = regexp.MustCompile(`^acct_[a-zA-Z0-9_-]{12,}$`)
	// CanonicalChatSlashCommands 定义 chat 模式内置并持久化声明的斜杠命令。
	CanonicalChatSlashCommands = []string{"compact", "goal", "plan"}
)

// RuntimeTarget 描述归约后的执行目标（网关池化 或 单账号直连）。
type RuntimeTarget struct {
	Gateway      bool   `json:"gateway"`
	AccountRef   string `json:"accountRef,omitempty"`
	RuntimeScope string `json:"runtimeScope"`
}

// IsGatewayRuntimeScope 判断作用域标记是否指向网关池。
func IsGatewayRuntimeScope(value string) bool {
	return gatewayRuntimeScopePattern.MatchString(strings.TrimSpace(value))
}

// IsPublicAccountRef 判断字符串是否为合规的公开账号引用。
func IsPublicAccountRef(value string) bool {
	return publicAccountRefPattern.MatchString(strings.TrimSpace(value))
}

// ResolveRuntimeTarget 解析 gateway/accountRef 到统一的执行作用域（非法目标返回 nil）。
func ResolveRuntimeTarget(gatewayFlag bool, accountRef string) *RuntimeTarget {
	if gatewayFlag {
		return &RuntimeTarget{
			Gateway:      true,
			RuntimeScope: GatewayRuntimeScope,
		}
	}
	ref := strings.TrimSpace(accountRef)
	if IsGatewayRuntimeScope(ref) {
		sanitized := sanitizeRuntimeScope(ref)
		return &RuntimeTarget{
			Gateway:      true,
			RuntimeScope: sanitized,
		}
	}
	if !IsPublicAccountRef(ref) {
		return nil
	}
	return &RuntimeTarget{
		Gateway:      false,
		AccountRef:   ref,
		RuntimeScope: ref,
	}
}

func sanitizeRuntimeScope(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' {
			b.WriteByte(c)
		} else {
			b.WriteByte('-')
		}
	}
	return b.String()
}

// SerializeRuntimeTarget 序列化运行目标用于 JSON 响应或日志。
func SerializeRuntimeTarget(target *RuntimeTarget) map[string]any {
	if target == nil {
		return map[string]any{}
	}
	if target.Gateway {
		return map[string]any{"gateway": true}
	}
	return map[string]any{"accountRef": target.AccountRef}
}

// ChatWorkingDirectory 为纯聊天会话分配独立且仅用户可访问的工作目录。
func ChatWorkingDirectory(aiHomeDir, sessionID string) (string, error) {
	sum := sha256.Sum256([]byte(sessionID))
	dir := filepath.Join(aiHomeDir, "run", "chat-workspaces", hex.EncodeToString(sum[:]))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// EntryCapabilities 按当前会话策略求值驱动能力快照，求值失败时安全回退到注册快照。
func EntryCapabilities(entry *DriverEntry, sess *Session) map[string]any {
	if entry == nil {
		return nil
	}
	if entry.CapabilitiesFor != nil {
		if dynamic := safeCapabilitiesFor(entry.CapabilitiesFor, sess); dynamic != nil {
			return dynamic
		}
	}
	if entry.Capabilities == nil {
		return nil
	}
	return CloneMap(entry.Capabilities)
}

func safeCapabilitiesFor(fn func(*Session) map[string]any, sess *Session) map[string]any {
	defer func() { _ = recover() }()
	return fn(sess)
}

// SameCapabilitySnapshot 按规范 JSON 比较两份能力快照是否一致。
func SameCapabilitySnapshot(left, right map[string]any) bool {
	if left == nil {
		left = map[string]any{}
	}
	if right == nil {
		right = map[string]any{}
	}
	return CanonicalJSONEquals(left, right)
}

// RefreshSlashCapabilities 补齐会话的 slash 命令能力快照；若无变化则原样返回（bool 为是否变更）。
func RefreshSlashCapabilities(sess *Session, providerSlashFn func(provider string) ([]string, bool)) (map[string]any, bool) {
	var current map[string]any
	if sess != nil && sess.CapabilitySnapshot != nil {
		current = sess.CapabilitySnapshot
	} else {
		current = map[string]any{}
	}
	var names []string
	slashPassthrough := false
	if IsChatSession(sess) {
		names = append(names, CanonicalChatSlashCommands...)
	} else if providerSlashFn != nil && sess != nil {
		names, slashPassthrough = providerSlashFn(sess.Provider)
	}
	if len(names) == 0 {
		return current, false
	}

	prevNames := stringSlice(current["slashCommands"])
	seen := make(map[string]struct{}, len(prevNames)+len(names))
	merged := make([]string, 0, len(prevNames)+len(names))
	for _, n := range prevNames {
		if _, ok := seen[n]; !ok {
			seen[n] = struct{}{}
			merged = append(merged, n)
		}
	}
	for _, n := range names {
		if _, ok := seen[n]; !ok {
			seen[n] = struct{}{}
			merged = append(merged, n)
		}
	}

	caps, _ := current["capabilities"].(map[string]any)
	nextCaps := caps
	if caps == nil || caps["slash.execute"] == nil {
		nextCaps = CloneMap(caps)
		nextCaps["slash.execute"] = map[string]any{"support": "native"}
	}

	prevPass, hasPrevPass := current["slashPassthrough"].(bool)
	if slices.Equal(merged, prevNames) && caps != nil && caps["slash.execute"] != nil &&
		hasPrevPass && prevPass == slashPassthrough {
		return current, false
	}

	out := CloneMap(current)
	out["capabilities"] = nextCaps
	anyMerged := make([]any, len(merged))
	for i, s := range merged {
		anyMerged[i] = s
	}
	out["slashCommands"] = anyMerged
	out["slashPassthrough"] = slashPassthrough
	return out, true
}

func stringSlice(raw any) []string {
	arr, ok := raw.([]any)
	if !ok {
		if sArr, ok := raw.([]string); ok {
			return append([]string(nil), sArr...)
		}
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func sessionEventSource(sess *Session) EventSource {
	runtimeID := "unbound"
	provider := "unknown"
	if sess != nil {
		if strings.TrimSpace(sess.Provider) != "" {
			provider = sess.Provider
		}
		if id, _ := sess.RuntimeBinding["runtimeId"].(string); strings.TrimSpace(id) != "" {
			runtimeID = id
		}
	}
	return EventSource{
		Provider:  provider,
		RuntimeID: runtimeID,
	}
}

// RuntimeBindingPatch 计算叠加运行时指纹与代际后的 runtimeBinding 补丁。
func RuntimeBindingPatch(sess *Session, rt RuntimeDescriptor) map[string]any {
	provider := strings.TrimSpace(rt.Provider)
	if provider == "" && sess != nil {
		provider = sess.Provider
	}
	scope := strings.TrimSpace(rt.RuntimeScope)
	if scope == "" && sess != nil {
		scope = sess.ExecutionAccountRef
	}
	if scope == "" {
		scope = "global"
	}
	var base map[string]any
	if sess != nil && sess.RuntimeBinding != nil {
		base = CloneMap(sess.RuntimeBinding)
	} else {
		base = make(map[string]any)
	}
	delete(base, "projectPath")
	base["runtimeId"] = provider + ":" + scope
	if rt.Fingerprint != "" {
		base["fingerprint"] = rt.Fingerprint
	}
	if rt.Generation > 0 || rt.HasGeneration {
		base["runtimeGeneration"] = rt.Generation
	}
	if rt.Version != "" {
		base["version"] = rt.Version
	}
	return base
}

func sameRuntimeDescriptor(left, right RuntimeDescriptor) bool {
	return left.Fingerprint == right.Fingerprint && left.Generation == right.Generation
}

func sameRuntimeTarget(left, right RuntimeDescriptor) bool {
	return left.Provider == right.Provider && left.RuntimeScope == right.RuntimeScope
}

func sameRuntimeBinding(left, right map[string]any) bool {
	for _, key := range []string{"runtimeId", "fingerprint", "runtimeGeneration", "version"} {
		if left == nil || right == nil {
			return false
		}
		if !CanonicalJSONEquals(left[key], right[key]) {
			return false
		}
	}
	return true
}

// AssertRecoverableRuntime 校验重启恢复期间目标 provider + runtimeScope 未发生跨目标 drift。
func AssertRecoverableRuntime(sess *Session, rt RuntimeDescriptor, recovery *RecoveryState) error {
	if recovery == nil || !recovery.Recoverable || sess == nil {
		return nil
	}
	boundID, _ := sess.RuntimeBinding["runtimeId"].(string)
	provider := strings.TrimSpace(rt.Provider)
	if provider == "" {
		provider = sess.Provider
	}
	scope := strings.TrimSpace(rt.RuntimeScope)
	if scope == "" {
		scope = sess.ExecutionAccountRef
	}
	if scope == "" {
		scope = "global"
	}
	currentID := provider + ":" + scope
	if boundID != "" && boundID != currentID {
		return NewError("chat_runtime_changed_during_recovery", 409, map[string]any{
			"boundRuntimeId":   boundID,
			"currentRuntimeId": currentID,
		})
	}
	return nil
}
