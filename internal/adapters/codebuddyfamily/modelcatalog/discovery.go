// Package modelcatalog 提供 CodeBuddy / WorkBuddy 家族的**无客户端模型发现**。
//
// 背景（2026-10-15）：家族原先只有「解析桌面发行版 App 内嵌运行时的 --help」一条
// 发现路，没装 App 的机器上账号模型目录永远空。实测 CLI 拿到的「当前支持」清单来自
// 云端 `GET {site}/v3/config`，因此这条通道只需账号原生凭据，不依赖本机客户端——
// 与 Node 侧 lib/account/codebuddy-family-model-discovery.js 是同一份协议事实
// （路径、请求头、响应结构都必须逐字段对齐，两侧守卫测试盯住集合一致）。
//
// 三条口径（与 Node 实现一致）：
//  1. `data.agents[name=cli].models` 就是「当前支持」清单，取它而不是 `data.models`
//     ——后者是站点全集，含当前账号/套餐不可用的条目。
//  2. `data.models[].id` 只作回退：agent 清单缺席（云端结构调整）时至少不空手。
//  3. 无凭据拿不到清单（同一端点 200 但清单为空），所以通道是账号级的；取不到
//     access token 是确定性属性，直接报错，不猜别的字段。
package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
)

const (
	// ConfigPath 是云端「当前支持」配置端点（与会话/推理端点同站不同路径，
	// 刻意分开声明：两件事的变化彼此独立）。
	ConfigPath = "/v3/config"
	// maxConfigResponseBytes 限制响应正文读取上限，避免异常响应拖垮刷新 worker。
	maxConfigResponseBytes = 1 << 20
	// customLocalPrefix 是宿主本机自定义模型的命名空间，不属于账号（Node 同规则）。
	customLocalPrefix = "custom-local:"
)

var (
	// ErrInvalidDependencies 表示模型目录源缺少 HTTP 客户端。
	ErrInvalidDependencies = errors.New("家族模型目录源依赖无效")
	// ErrUnknownProvider 表示 Provider 不在家族表里，没有可用的站点根。
	ErrUnknownProvider = errors.New("家族模型目录源 Provider 未知")
	// ErrProviderMismatch 表示凭据归属与目录源不一致。
	ErrProviderMismatch = errors.New("家族模型目录源凭据归属不符")
	// ErrEmptyCatalog 表示响应结构不认或清单为空。
	//
	// 与「账号真的没有可用模型」是两件事：返回错误让刷新保持旧目录（last-known-good），
	// 返回空清单会把已有目录清掉。
	ErrEmptyCatalog = errors.New("家族模型目录响应不含模型清单")
)

// HTTPClient 是读取配置端点所需的最小端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// ModelCatalogSource 是家族某支的远端模型目录源。
type ModelCatalogSource struct {
	client     HTTPClient
	providerID string
	baseURL    string
}

// 编译期确认家族目录源实现统一 Provider 发现策略。
var _ accountapp.ProviderModelDiscoverer = (*ModelCatalogSource)(nil)

// NewModelCatalogSources 为家族四支各创建一个目录源。
//
// 返回独立切片而不是单个多 Provider 源：ModelDiscovery 注册表按 Provider 一对一
// 索引，逐支声明让「某支的站点根变化」不影响其他三支。
func NewModelCatalogSources(
	client HTTPClient,
) ([]accountapp.ProviderModelDiscoverer, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	sources := make(
		[]accountapp.ProviderModelDiscoverer,
		0,
		len(codebuddyfamilyrelay.FamilyProviders),
	)
	for _, providerID := range codebuddyfamilyrelay.FamilyProviders {
		baseURL, found := codebuddyfamilyrelay.InferenceBaseURL(providerID)
		if !found {
			return nil, fmt.Errorf(
				"%w: %s",
				ErrUnknownProvider,
				providerID,
			)
		}
		sources = append(sources, &ModelCatalogSource{
			client:     client,
			providerID: providerID,
			baseURL:    baseURL,
		})
	}
	return sources, nil
}

// ProviderID 返回该目录源唯一支持的家族 Provider。
func (source *ModelCatalogSource) ProviderID() string {
	if source == nil {
		return ""
	}
	return source.providerID
}

// DiscoverModels 读取账号当前可见的完整模型目录。
func (source *ModelCatalogSource) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	if source == nil ||
		source.client == nil ||
		ctx == nil ||
		credential == nil {
		return nil, ErrInvalidDependencies
	}
	if credential.ProviderID() != source.providerID {
		return nil, ErrProviderMismatch
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	token, err := codebuddyfamilyrelay.AccessTokenFromCredential(credential)
	if err != nil {
		return nil, err
	}
	payload, err := source.fetchConfig(ctx, token)
	if err != nil {
		return nil, err
	}
	models := ParseConfigModels(payload)
	if len(models) == 0 {
		return nil, ErrEmptyCatalog
	}
	return models, nil
}

// fetchConfig 发起配置端点请求并返回正文。
//
// 请求头与 Node 侧实现逐字段对齐：缺失 X-Requested-With / Origin 时上游返回的
// 清单与真实客户端不同（WAF 与站点注入都会看这些头）。
func (source *ModelCatalogSource) fetchConfig(
	ctx context.Context,
	token string,
) ([]byte, error) {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		source.baseURL+ConfigPath,
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("构造家族配置请求失败: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json, text/plain, */*")
	request.Header.Set("User-Agent", codebuddyfamilyrelay.UserAgent)
	request.Header.Set("Origin", source.baseURL)
	request.Header.Set("Referer", source.baseURL+"/")
	request.Header.Set("X-Requested-With", "XMLHttpRequest")
	response, err := source.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("请求家族配置失败: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxConfigResponseBytes))
		_ = response.Body.Close()
	}()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf(
			"家族配置端点返回 %d",
			response.StatusCode,
		)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxConfigResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("读取家族配置响应失败: %w", err)
	}
	return payload, nil
}

// ParseConfigModels 从 /v3/config 响应体里取「当前支持」的模型清单。
//
// 返回 nil 表示拿不到清单（结构不认 / 清单为空）。结构不认时保持宽容：agent 清单
// 与站点目录各自独立解析，一侧结构变了另一次仍可回退（与 Node 同语义）。
func ParseConfigModels(payload []byte) []string {
	var root struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload, &root); err != nil || len(root.Data) == 0 {
		return nil
	}
	var data struct {
		Agents json.RawMessage `json:"agents"`
		Models json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(root.Data, &data); err != nil {
		return nil
	}
	if models := parseAgentModels(data.Agents); len(models) > 0 {
		return models
	}
	return parseCatalogModels(data.Models)
}

// parseAgentModels 取 `data.agents[name=cli].models`（第一个 name 为 cli 的条目）。
func parseAgentModels(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var agents []struct {
		Name   string   `json:"name"`
		Models []string `json:"models"`
	}
	if err := json.Unmarshal(raw, &agents); err != nil {
		return nil
	}
	for _, agent := range agents {
		if strings.TrimSpace(agent.Name) != "cli" {
			continue
		}
		return normalizeModelList(agent.Models)
	}
	return nil
}

// parseCatalogModels 解析 `data.models[]`：元素可能是对象（取 id）或裸字符串。
func parseCatalogModels(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil
	}
	values := make([]string, 0, len(entries))
	for _, entry := range entries {
		trimmed := strings.TrimSpace(string(entry))
		if strings.HasPrefix(trimmed, `"`) {
			var text string
			if json.Unmarshal(entry, &text) == nil {
				values = append(values, text)
			}
			continue
		}
		var object struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(entry, &object) == nil {
			values = append(values, object.ID)
		}
	}
	return normalizeModelList(values)
}

// normalizeModelList 归一化模型 id 清单：去空白、去空项、去重，并剔除
// `custom-local:*`（宿主本机自定义模型，可能正指向 aih 网关本身，与 CLI 解析同规则）。
func normalizeModelList(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	models := make([]string, 0, len(values))
	for _, value := range values {
		id := strings.TrimSpace(value)
		if id == "" || strings.HasPrefix(id, customLocalPrefix) {
			continue
		}
		if _, found := seen[id]; found {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, id)
	}
	if len(models) == 0 {
		return nil
	}
	return models
}
