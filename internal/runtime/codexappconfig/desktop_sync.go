package codexappconfig

import (
	"encoding/json"
	"os"
	"strings"
	"sync"
)

// DesktopAccountState 是 desktop hook state 中与账号同步相关的字段。
type DesktopAccountState struct {
	Enabled           bool
	DesktopAccountRef string
}

// DesktopSyncOptions 描述账号同步控制器的依赖。
type DesktopSyncOptions struct {
	ReadState       func() DesktopAccountState
	ResolveIdentity func(accountRef string) *DesktopIdentity
	WriteUpstream   func([]byte) error
	InitialRef      string
}

// DesktopSyncController 在 desktopAccountRef 变化时向上游发送 account/login/start。
type DesktopSyncController struct {
	mu            sync.Mutex
	readState     func() DesktopAccountState
	resolve       func(string) *DesktopIdentity
	writeUpstream func([]byte) error
	activeRef     string
	rejectedRef   string
	pendingID     string
	pendingRef    string
	sequence      int
}

// NewDesktopSyncController 创建控制器；WriteUpstream 必须能并入 bridge 的 stdin 写入。
func NewDesktopSyncController(options DesktopSyncOptions) *DesktopSyncController {
	return &DesktopSyncController{
		readState: options.ReadState, resolve: options.ResolveIdentity,
		writeUpstream: options.WriteUpstream, activeRef: strings.TrimSpace(options.InitialRef),
	}
}

// ReadDesktopStateFile 读取 hook state 的 enabled / desktopAccountRef。
func ReadDesktopStateFile(path string) DesktopAccountState {
	state := DesktopAccountState{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return state
	}
	var decoded map[string]any
	if json.Unmarshal(raw, &decoded) != nil {
		return state
	}
	state.Enabled = decoded["enabled"] == true
	if ref, ok := decoded["desktopAccountRef"].(string); ok {
		state.DesktopAccountRef = strings.TrimSpace(ref)
	}
	return state
}

// Refresh 检查状态并在需要时发送登录请求；返回是否写入了上游。
func (controller *DesktopSyncController) Refresh() bool {
	if controller == nil || controller.readState == nil || controller.resolve == nil || controller.writeUpstream == nil {
		return false
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	state := controller.readState()
	desired := strings.TrimSpace(state.DesktopAccountRef)
	if !state.Enabled || desired == "" || desired == controller.activeRef || desired == controller.rejectedRef || controller.pendingID != "" {
		return false
	}
	identity := controller.resolve(desired)
	if identity == nil || identity.AuthType != DesktopAuthTypeChatGPT || identity.AccessToken == "" || identity.UpstreamAccountID == "" {
		controller.rejectedRef = desired
		return false
	}
	controller.sequence++
	controller.pendingID = "aih-desktop-account-sync:" + itoa(controller.sequence)
	controller.pendingRef = desired
	payload := map[string]any{
		"id": controller.pendingID, "method": "account/login/start",
		"params": map[string]any{
			"type": "chatgptAuthTokens", "accessToken": identity.AccessToken,
			"chatgptAccountId": identity.UpstreamAccountID,
			"chatgptPlanType":  planTypeOrNil(identity.Account),
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		controller.pendingID = ""
		controller.pendingRef = ""
		return false
	}
	if err := controller.writeUpstream(append(encoded, '\n')); err != nil {
		controller.pendingID = ""
		controller.pendingRef = ""
		return false
	}
	return true
}

// HandleResponse 处理上游响应；同步请求的响应返回 true（调用方应丢弃）。
func (controller *DesktopSyncController) HandleResponse(payload []byte) bool {
	if controller == nil {
		return false
	}
	var decoded map[string]any
	if json.Unmarshal(payload, &decoded) != nil {
		return false
	}
	responseID, _ := decoded["id"].(string)
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if controller.pendingID == "" || responseID != controller.pendingID {
		return false
	}
	completedRef := controller.pendingRef
	controller.pendingID = ""
	controller.pendingRef = ""
	if _, hasError := decoded["error"]; hasError {
		controller.rejectedRef = completedRef
	} else {
		controller.activeRef = completedRef
	}
	return true
}

func planTypeOrNil(account *ChatGPTAccount) any {
	if account == nil || strings.TrimSpace(account.PlanType) == "" {
		return nil
	}
	return strings.TrimSpace(account.PlanType)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 8)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
