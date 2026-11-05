package zcoderelay

import (
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// ProviderID 是本通道服务的 Provider。
const ProviderID = "zcode"

// HostFacts 是宿主提供的事实（官方 harness、设备 mid、客户端版本）。
//
// 这些值来自本机 zcode 客户端安装目录，由接线层读取后注入；传输层不认识文件布局。
type HostFacts struct {
	// AIHomeDir 用于派生账号级稳定 device mid（读不到桌面端遗留文件时的兜底）。
	AIHomeDir     string
	AppVersion    string
	DeviceMid     string
	OSVersion     string
	AccountUUID   string
	SessionKey    string
	HarnessBlocks []map[string]any
}

// Provider 是 zcode 在 relaycore 上的实现。
//
// 与 cline 这类「零覆盖」不同，zcode 的真实差异集中在三处：
//   - 端点随套餐/区域变化（Resolve 时定下来）；
//   - 鉴权是单头 jwt 或双头（AccessToken + DecorateUpstream）；
//   - 请求体必须整形成官方 harness，且要补客户端身份头。
type Provider struct {
	relaycore.BaseProvider
	host     HostFacts
	baseURL  string
	facts    Facts
	resolved bool
}

var _ relaycore.Provider = (*Provider)(nil)

// NewProvider 创建 zcode 透传 Provider。host 可为零值（测试/未装客户端）。
func NewProvider(host HostFacts) *Provider {
	return &Provider{
		BaseProvider: relaycore.NewBaseProvider(ProviderID, ""),
		host:         host,
	}
}

// Resolve 认领 zcode，并按账号凭据解析端点。
//
// 没有凭据时仍然认领（能力判定路径），端点留空；真正取令牌/改写时再拒绝，
// 避免把「本通道不服务 zcode」误判成「凭据形态不支持」。
func (provider *Provider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	if !strings.EqualFold(strings.TrimSpace(input.ProviderID), ProviderID) {
		return nil, false
	}
	variant := &Provider{
		BaseProvider: relaycore.NewBaseProvider(ProviderID, ""),
		host:         provider.host,
	}
	if variant.host.DeviceMid == "" {
		variant.host.DeviceMid = DeriveDeviceMid(variant.host.AIHomeDir, input.AccountRef)
	}
	facts, err := ExtractFacts(input.Credential)
	if err != nil {
		// 认领但保持未解析：AccessToken/RewriteRequest 会返回 ErrUnsupportedCredential，
		// 由 Handler 交还 Canonical（静态凭据/CLI 账号仍归 Node）。
		return variant, true
	}
	variant.facts = facts
	variant.resolved = true
	variant.baseURL = ResolveInferenceBaseURL(facts.PlanID, facts.Region)
	variant.BaseProvider = relaycore.NewBaseProvider(ProviderID, variant.baseURL+Path)
	return variant, true
}

// Endpoint 返回已解析的上游 URL；未解析时交还 Canonical。
func (provider *Provider) Endpoint() (string, bool) {
	if provider == nil || !provider.resolved || provider.baseURL == "" {
		return "", false
	}
	return provider.baseURL + Path, true
}

// AccessToken 返回 BaseProvider 写到 Authorization 的令牌。
//
// zcode-plan 端点用长期 jwt；ultra 端点用区域 access_token（jwt 另走
// X-Zcode-Authorization，见 DecorateUpstream）。
func (provider *Provider) AccessToken(accountapp.Credential) (string, error) {
	if provider == nil || !provider.resolved {
		return "", relaycore.ErrUnsupportedCredential
	}
	if IsUltraEndpoint(provider.baseURL) {
		if provider.facts.AccessToken == "" {
			return "", ErrMissingCredential
		}
		return provider.facts.AccessToken, nil
	}
	if provider.facts.JWT == "" {
		return "", ErrMissingCredential
	}
	return provider.facts.JWT, nil
}

// RewriteRequest 把 system 整形成官方 harness（已带 harness 的请求逐字节不变）。
func (provider *Provider) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
	if provider == nil || !provider.resolved {
		return relaycore.RewriteResult{}, relaycore.ErrUnsupportedCredential
	}
	return relaycore.RewriteResult{
		Body: ApplyHarness(body, HarnessInput{
			Blocks:      provider.host.HarnessBlocks,
			DeviceMid:   provider.host.DeviceMid,
			AccountUUID: provider.host.AccountUUID,
			SessionID:   provider.sessionID(),
		}),
	}, nil
}

// DecorateUpstream 补齐 ZCode 客户端身份头；ultra 端点再加第二个鉴权头。
func (provider *Provider) DecorateUpstream(request *http.Request, accessToken string) {
	if provider == nil || request == nil {
		return
	}
	provider.BaseProvider.DecorateUpstream(request, accessToken)
	ApplyIdentityHeaders(request.Header, HeaderInput{
		AppVersion: provider.host.AppVersion,
		DeviceMid:  provider.host.DeviceMid,
		OSVersion:  provider.host.OSVersion,
		SessionKey: provider.sessionID(),
	})
	if IsUltraEndpoint(provider.baseURL) && provider.facts.JWT != "" {
		request.Header.Set("X-Zcode-Authorization", "Bearer "+provider.facts.JWT)
	}
}

// sessionID 优先用宿主注入的会话键；没有时用账号级稳定值（由 device mid 派生）。
func (provider *Provider) sessionID() string {
	if provider == nil {
		return ""
	}
	if key := strings.TrimSpace(provider.host.SessionKey); key != "" {
		return ResolveSessionID(key, provider.host.DeviceMid, nil)
	}
	if deviceMid := strings.TrimSpace(provider.host.DeviceMid); deviceMid != "" {
		return ResolveSessionID("", deviceMid, nil)
	}
	return ""
}
