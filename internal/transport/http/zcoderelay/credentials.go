package zcoderelay

import (
	"encoding/json"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// Facts 是 zcode 推理所需的最小凭据事实。
//
// 旧实现（Node）在每次请求里现读本机文件、解 enc:v1 区域、再推端点；Go 只从
// 领域凭据里取**已经存在**的字段，取不到就明确拒绝（交还 Canonical），不做猜测。
type Facts struct {
	// JWT 是 zcode 长期令牌（zcodejwttoken），两个端点都要用。
	JWT string
	// AccessToken 是区域 access_token；只有 ultra 端点需要。
	AccessToken string
	// Region 是 access_token 的键前缀（zai / bigmodel），不依赖解密 active_provider。
	Region string
	// PlanID 来自额度文档；为空时按 Node 结论回落 zcode-plan 端点。
	PlanID string
}

// ExtractFacts 从领域凭据里提取 zcode 事实。
//
// 约定：只接受 zcode 的原生 JSON 凭据。区域由 `oauth:<region>:access_token` 的
// 键前缀判定，不去解 `enc:v1:` 的 active_provider（解密密钥属于客户端宿主，
// 服务端不该依赖它）。
func ExtractFacts(credential accountapp.Credential) (Facts, error) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != "zcode" {
		return Facts{}, ErrMissingCredential
	}
	var payload map[string]any
	if err := json.Unmarshal(native.Payload(), &payload); err != nil || payload == nil {
		return Facts{}, ErrMissingCredential
	}
	credentials, _ := payload["credentials"].(map[string]any)
	if credentials == nil {
		// 兼容「已经收窄到 credentials」的形态。
		credentials = payload
	}
	facts := Facts{}
	for key, value := range credentials {
		text, _ := value.(string)
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		switch {
		case key == "zcodejwttoken":
			facts.JWT = text
		case strings.HasPrefix(key, "oauth:") && strings.HasSuffix(key, ":access_token"):
			facts.AccessToken = text
			facts.Region = strings.TrimSuffix(strings.TrimPrefix(key, "oauth:"), ":access_token")
		}
	}
	if facts.JWT == "" {
		return Facts{}, ErrMissingCredential
	}
	return facts, nil
}

// EndpointFor 组合事实与端点规则，返回本次请求的上游 URL 与鉴权头。
func EndpointFor(facts Facts) (string, map[string]string, error) {
	base := ResolveInferenceBaseURL(facts.PlanID, facts.Region)
	headers, err := AuthHeaders(base, facts.AccessToken, facts.JWT)
	if err != nil {
		return "", nil, err
	}
	return base + Path, headers, nil
}
