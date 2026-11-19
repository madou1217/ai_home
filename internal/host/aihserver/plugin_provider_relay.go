package aihserver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const pluginChatCompletionsEntry = "gateway.openai.chat_completions"

// pluginProviderEntry 是插件描述符里与推理/模型发现相关的稳定事实。
type pluginProviderEntry struct {
	ID            string
	Relay         bool
	ModelsHandler string
	Modes         []string
}

// pluginProviderRegistry 保存当前插件代次声明的 Provider。
//
// 插件描述符随代次整体替换；这里只在回调时整体替换一份不可变快照，读路径（推理
// 分派、模型发现）拿锁后立即复制，避免代次切换与请求并发交叉。
type pluginProviderRegistry struct {
	mu      sync.RWMutex
	entries map[string]pluginProviderEntry
}

func newPluginProviderRegistry() *pluginProviderRegistry {
	return &pluginProviderRegistry{entries: map[string]pluginProviderEntry{}}
}

// Update 用一次 provider.descriptor 收集结果替换注册表，并返回模型发现集合。
func (registry *pluginProviderRegistry) Update(result pluginhost.DescriptorCollectResult) {
	if registry == nil {
		return
	}
	entries := map[string]pluginProviderEntry{}
	for _, accepted := range result.Accepted {
		id := strings.ToLower(strings.TrimSpace(accepted.ProviderID))
		if id == "" {
			continue
		}
		descriptor := accepted.Descriptor
		capabilities, _ := descriptor["capabilities"].(map[string]any)
		entry := pluginProviderEntry{ID: id}
		if relay, ok := capabilities["relay"].(map[string]any); ok {
			entry.Relay = strings.EqualFold(strings.TrimSpace(fmt.Sprint(relay["transport"])), "http")
		}
		if models, ok := capabilities["models"].(map[string]any); ok && models["supported"] == true {
			for _, strategy := range descriptorMapSlice(models["strategies"]) {
				handler := strings.TrimSpace(fmt.Sprint(strategy["handler"]))
				if handler != "generic-models-probe" {
					continue
				}
				entry.ModelsHandler = handler
				for _, mode := range descriptorStringSlice(strategy["modes"]) {
					entry.Modes = append(entry.Modes, strings.TrimSpace(mode))
				}
				break
			}
		}
		entries[id] = entry
	}
	registry.mu.Lock()
	registry.entries = entries
	registry.mu.Unlock()
}

// ModelDescriptors 返回 Go 可执行的插件模型发现策略。
func (registry *pluginProviderRegistry) ModelDescriptors() []accounts.PluginProviderDescriptor {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	out := make([]accounts.PluginProviderDescriptor, 0, len(registry.entries))
	for _, entry := range registry.entries {
		if entry.ModelsHandler == "" {
			continue
		}
		out = append(out, accounts.PluginProviderDescriptor{
			ProviderID:    entry.ID,
			ModelsHandler: entry.ModelsHandler,
			Modes:         append([]string(nil), entry.Modes...),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ProviderID < out[j].ProviderID })
	return out
}

// Definitions 返回可注册进 Provider 目录的动态 Provider 定义。
func (registry *pluginProviderRegistry) Definitions() []providers.Definition {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	out := make([]providers.Definition, 0, len(registry.entries))
	for _, entry := range registry.entries {
		if !entry.Relay {
			continue
		}
		out = append(out, providers.Definition{
			ID: entry.ID,
			Presentation: providers.Presentation{
				ID:           entry.ID,
				Label:        entry.ID,
				Short:        entry.ID,
				TerminalIcon: "◌",
			},
			Gateway:      providers.GatewayActive,
			Capabilities: []providers.Capability{providers.CapabilityModelCatalog},
			RelayHosts: map[string]providers.RelayHost{
				"go": {Supported: true, Channel: providers.RelayChannelRelay, Entries: []string{pluginChatCompletionsEntry}},
			},
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (registry *pluginProviderRegistry) RelayProviderIDs() []string {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	out := make([]string, 0, len(registry.entries))
	for _, entry := range registry.entries {
		if entry.Relay {
			out = append(out, entry.ID)
		}
	}
	sort.Strings(out)
	return out
}

func (registry *pluginProviderRegistry) IsRelayProvider(providerID string) bool {
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	entry, ok := registry.entries[strings.ToLower(strings.TrimSpace(providerID))]
	return ok && entry.Relay
}

type pluginBaseURLCredential interface{ BaseURL() string }
type pluginAPIKeyCredential interface{ APIKey() string }

// pluginRelayProviderChain 把一个动态 Provider 对象接入 relaycore 的 ProviderChain。
// Resolve 每次请求都读注册表，插件代次切换无需重建 Handler。
type pluginRelayProviderChain struct {
	registry *pluginProviderRegistry
}

func (chain pluginRelayProviderChain) ID() string { return "plugin-providers" }

func (chain pluginRelayProviderChain) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	if chain.registry == nil || !chain.registry.IsRelayProvider(input.ProviderID) {
		return nil, false
	}
	endpoint := pluginChatEndpoint(input.Credential)
	if endpoint == "" {
		return nil, false
	}
	id := strings.ToLower(strings.TrimSpace(input.ProviderID))
	return pluginRelayProvider{
		BaseProvider: relaycore.NewBaseProvider(id, endpoint),
	}, true
}

func (chain pluginRelayProviderChain) Endpoint() (string, bool) { return "", false }

func (chain pluginRelayProviderChain) AccessToken(accounts.Credential) (string, error) {
	return "", relaycore.ErrUnsupportedCredential
}

func (chain pluginRelayProviderChain) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
	return relaycore.RewriteResult{Body: body}, nil
}

func (chain pluginRelayProviderChain) DecorateUpstream(request *http.Request, accessToken string) {
	relaycore.BaseProvider{}.DecorateUpstream(request, accessToken)
}

func (chain pluginRelayProviderChain) ClassifyFailure(statusCode int, header http.Header, body []byte, now time.Time) (sharedfailure.Classification, error) {
	return relaycore.BaseProvider{}.ClassifyFailure(statusCode, header, body, now)
}

type pluginRelayProvider struct {
	relaycore.BaseProvider
}

func (provider pluginRelayProvider) AccessToken(credential accounts.Credential) (string, error) {
	if key, ok := credential.(pluginAPIKeyCredential); ok {
		if value := strings.TrimSpace(key.APIKey()); value != "" {
			return value, nil
		}
	}
	return "", relaycore.ErrUnsupportedCredential
}

func pluginChatEndpoint(credential accounts.Credential) string {
	value, ok := credential.(pluginBaseURLCredential)
	if !ok {
		return ""
	}
	base := strings.TrimRight(strings.TrimSpace(value.BaseURL()), "/")
	if base == "" {
		return ""
	}
	if strings.HasSuffix(base, "/v1") {
		return base + "/chat/completions"
	}
	return base + "/v1/chat/completions"
}

// pluginRelayTransportPolicy 只接受能直接作为 Bearer/API Key 使用的凭据。
type pluginRelayTransportPolicy struct{}

func (pluginRelayTransportPolicy) SupportsCredential(credential accounts.Credential) bool {
	if credential == nil {
		return false
	}
	if key, ok := credential.(pluginAPIKeyCredential); !ok || strings.TrimSpace(key.APIKey()) == "" {
		return false
	}
	value, ok := credential.(pluginBaseURLCredential)
	return ok && strings.TrimSpace(value.BaseURL()) != ""
}

// pluginRelayAccountSource 按模型汇总所有插件 Provider 的征召会话。
type pluginRelayAccountSource struct {
	registry  *pluginProviderRegistry
	catalog   *providers.Catalog
	recruiter *accountrouting.Recruiter
	transport accountrouting.CredentialTransportPolicy
}

func (source *pluginRelayAccountSource) Accounts(ctx context.Context, modelID runtimecore.ModelID) (relaycore.AccountCursor, error) {
	if source == nil || source.registry == nil || source.catalog == nil || source.recruiter == nil {
		return &pluginRelayCursor{}, nil
	}
	cursors := make([]relaycore.AccountCursor, 0)
	for _, providerID := range source.registry.RelayProviderIDs() {
		request, err := accountrouting.NewRequest(source.catalog, providerID, modelID.String())
		if err != nil {
			continue
		}
		session, err := source.recruiter.Begin(ctx, request, source.transport)
		if err != nil {
			continue
		}
		cursors = append(cursors, &providerRelayAccountCursor{session: session})
	}
	return &pluginRelayCursor{cursors: cursors}, nil
}

func (source *pluginRelayAccountSource) ReacquireFor429Retry(
	ctx context.Context,
	providerID string,
	modelID runtimecore.ModelID,
	target accountcore.AccountRef,
	receipt runtimecore.CooldownReceipt,
	originObservation accountcredentials.CredentialObservation,
) (accountcore.AccountRef, bool, bool, error) {
	if source == nil || source.registry == nil || !source.registry.IsRelayProvider(providerID) || !target.IsValid() {
		return "", false, false, nil
	}
	request, err := accountrouting.NewPinnedRequest(source.catalog, providerID, modelID.String(), target)
	if err != nil {
		return "", false, false, nil
	}
	waiver := accountrouting.RateLimitCooldownWaiver{Receipt: receipt, Observation: originObservation}
	if waiver.IsValid() {
		request = request.WithRateLimitCooldownWaiver(waiver)
	}
	session, err := source.recruiter.Begin(ctx, request, source.transport)
	if err != nil {
		return "", false, false, err
	}
	recruited, err := session.Next(ctx)
	if err != nil {
		if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
			return "", false, false, nil
		}
		return "", false, false, err
	}
	return recruited.Account().Ref(), recruited.UsedRateLimitCooldownWaiver(), true, nil
}

type pluginRelayCursor struct {
	cursors []relaycore.AccountCursor
	index   int
}

func (cursor *pluginRelayCursor) Next(ctx context.Context) (accountcore.AccountRef, bool, error) {
	for cursor != nil && cursor.index < len(cursor.cursors) {
		ref, found, err := cursor.cursors[cursor.index].Next(ctx)
		if err != nil || found {
			return ref, found, err
		}
		cursor.index++
	}
	return "", false, nil
}
