package aihserver

import (
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/kimiidentity"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/kimirelay"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// kimiRelayProvider 把「账号级参数」接进 relaycore 的 Provider 契约。
//
// 为什么需要这一层：kimi 的差异面**依赖账号**——设备指纹以 accountRef 为派生输入、
// 设备 id 优先取凭据里官方声明的值。而 relaycore 的 Provider 是通道级对象
// （一次构造、多次使用）。本类型只做**参数组装**，差异逻辑全在 kimirelay 包里
// （那里与 Node 侧同算法，由跨语言守卫测试钉住）。
//
// **设备策略的来源是凭据文档本身**（`native_auth_json.deviceProfile`）——不需要额外
// 存储通道：投影把凭据推给 Go 时策略一起过来，Node 与 Go 天然同源。这也是当初把策略
// 放进凭据而不是另开 app_kv 键的理由。
//
// 通道级的五个方法（Endpoint / AccessToken / RewriteRequest / DecorateUpstream /
// ClassifyFailure）在链上本无意义——relaycore 保证先 Resolve 再取差异面（见 chain.go
// 的说明）。这里给保守默认值而不是 panic：误用时得到「交还 Canonical」这个安全结果，
// 而不是崩掉一个正在服务的进程。
type kimiRelayProvider struct {
	// version 是自报的客户端版本（服务级常量：同一进程内所有账号一致）。
	version string
	// host 是 host-derived 策略需要的运行机器信息。
	host kimiidentity.HostFacts
}

var _ relaycore.Provider = (*kimiRelayProvider)(nil)

// ID 返回通道标识。
func (provider *kimiRelayProvider) ID() string { return kimirelay.ProviderID }

// Resolve 按账号组装具体的 kimi Provider。
func (provider *kimiRelayProvider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	if provider == nil || !strings.EqualFold(strings.TrimSpace(input.ProviderID), kimirelay.ProviderID) {
		return nil, false
	}
	accountRef := strings.TrimSpace(input.AccountRef)
	// 设备策略与官方 device_id 都从**凭据文档**读：投影已把它推给 Go，无需另开通道。
	profile := kimiidentity.DefaultProfile()
	credentialDeviceID := ""
	if payload := kimiCredentialPayload(input.Credential); len(payload) > 0 {
		profile = kimiidentity.ParseProfile(kimiidentity.DeviceProfileSection(payload))
		credentialDeviceID = kimiidentity.CredentialDeviceID(payload)
	}
	return kimirelay.NewProvider(kimirelay.ProviderOptions{
		Version:            provider.version,
		AccountRef:         accountRef,
		Profile:            profile,
		Host:               provider.host,
		CredentialDeviceID: credentialDeviceID,
	}), true
}

// kimiCredentialPayload 取凭据文档原始字节（非原生凭据返回 nil）。
func kimiCredentialPayload(credential accountapp.Credential) []byte {
	native, ok := credential.(interface{ Payload() []byte })
	if !ok || native == nil {
		return nil
	}
	return native.Payload()
}

// Endpoint 在通道级无意义（必须先 Resolve）。
func (provider *kimiRelayProvider) Endpoint() (string, bool) { return "", false }

// AccessToken 在通道级无意义（必须先 Resolve）：一律拒绝，不猜凭据形态。
func (provider *kimiRelayProvider) AccessToken(accountapp.Credential) (string, error) {
	return "", relaycore.ErrUnsupportedCredential
}

// RewriteRequest 在通道级无意义（必须先 Resolve）：原样返回。
func (provider *kimiRelayProvider) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
	return relaycore.RewriteResult{Body: body}, nil
}

// DecorateUpstream 在通道级无意义（必须先 Resolve）：不写任何头。
func (provider *kimiRelayProvider) DecorateUpstream(*http.Request, string) {}

// ClassifyFailure 在通道级无意义（必须先 Resolve）：报无失败证据，不猜分类。
func (provider *kimiRelayProvider) ClassifyFailure(
	int, http.Header, []byte, time.Time,
) (sharedfailure.Classification, error) {
	return sharedfailure.Classification{}, sharedfailure.ErrNoFailureEvidence
}

// kimiRelayTransportPolicy 判断领域凭据能否由 kimi 透传通道承载。
//
// 与家族同一口径：只有原生登录态（带 access token）能走透传；API Key 账号由
// Canonical 承载。策略只表达本地协议兼容性，不做网络请求，也不改变账号运行态。
type kimiRelayTransportPolicy struct{}

var _ accountrouting.CredentialTransportPolicy = kimiRelayTransportPolicy{}

func (kimiRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	if credential == nil || credential.ProviderID() != kimirelay.ProviderID {
		return false
	}
	_, err := kimirelay.AccessTokenFromCredential(credential)
	return err == nil
}

// newKimiRelayProvider 构造 kimi 的通道级 Provider。
//
// 版本与运行机器信息是**服务级**的（同一进程内所有账号一致）：版本由
// kimiClientVersion 动态解析（本地 CLI → 远端 npm → 兜底），机器信息只在账号选择
// host-derived 策略时才用得上。
func newKimiRelayProvider(version string) *kimiRelayProvider {
	return &kimiRelayProvider{
		version: version,
		host: kimiidentity.HostFacts{
			HostName:    hostNameOrEmpty(),
			DeviceModel: hostDeviceModelOrEmpty(),
			OSVersion:   hostOSVersionOrEmpty(),
		},
	}
}
