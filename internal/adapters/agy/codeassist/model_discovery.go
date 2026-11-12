package codeassist

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const maxModelCatalogBytes = 8 * 1024 * 1024

// ModelWireWriter 只接收公开 ID 的转发表，不接收凭据或上游目录正文。
type ModelWireWriter interface {
	Replace(accountRef accountcore.AccountRef, models map[string]string) error
}

type ModelCatalogSource struct {
	client HTTPClient
	wires  ModelWireWriter
}

var _ accountapp.ProviderModelDiscoverer = (*ModelCatalogSource)(nil)

func NewModelCatalogSource(client HTTPClient) (*ModelCatalogSource, error) {
	return NewModelCatalogSourceWithWireModels(client, nil)
}

func NewModelCatalogSourceWithWireModels(client HTTPClient, wires ModelWireWriter) (*ModelCatalogSource, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &ModelCatalogSource{client: client, wires: wires}, nil
}

func (*ModelCatalogSource) ProviderID() string { return agy.ProviderID }

func (source *ModelCatalogSource) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	auth, valid := credential.(*agy.OAuthAuth)
	if source == nil || source.client == nil || ctx == nil || !valid || auth == nil {
		return nil, ErrInvalidDependencies
	}
	project, err := loadProject(ctx, source.client, auth)
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]string{
		"project":   project,
		"requestId": "agent/models/goaih",
	})
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		defaultBaseURL+":fetchAvailableModels",
		bytes.NewReader(payload),
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	applyHeaders(request, auth, false)
	response, err := source.client.Do(request)
	if err != nil {
		return nil, err
	}
	if response == nil || response.Body == nil {
		return nil, ErrInvalidUpstreamResponse
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return nil, ErrInvalidUpstreamResponse
	}
	payload, err = io.ReadAll(io.LimitReader(response.Body, maxModelCatalogBytes+1))
	if err != nil || len(payload) > maxModelCatalogBytes {
		return nil, ErrInvalidUpstreamResponse
	}
	models, wires, err := decodeModelCatalog(payload)
	if err != nil {
		return nil, err
	}
	if source.wires != nil {
		accountRef, identityErr := accountcore.DeriveAccountRef(auth)
		if identityErr != nil {
			return nil, ErrInvalidDependencies
		}
		if err := source.wires.Replace(accountRef, wires); err != nil {
			return nil, err
		}
	}
	return models, nil
}

func decodeModelIDs(payload []byte) ([]string, error) {
	models, _, err := decodeModelCatalog(payload)
	return models, err
}

func decodeModelCatalog(payload []byte) ([]string, map[string]string, error) {
	var document modelCatalogDocument
	if err := oauthutil.DecodeJSONResponse(
		bytes.NewReader(payload),
		maxModelCatalogBytes,
		&document,
	); err != nil {
		return nil, nil, ErrInvalidUpstreamResponse
	}
	if len(document.Models) == 0 {
		return nil, nil, ErrInvalidUpstreamResponse
	}
	seen := make(map[string]struct{}, len(document.Models))
	aliasesToWire := make(map[string]string)
	for modelID, rawDetail := range document.Models {
		if !validCatalogModelID(modelID) {
			// Antigravity 的完整目录会混入 chat_/tab_/内部枚举和占位模型。
			// 它们不是账号可路由能力；过滤单项而不是让一个内部条目清空整池。
			continue
		}
		detail, err := decodeModelCatalogDetail(rawDetail)
		if err != nil {
			return nil, nil, ErrInvalidUpstreamResponse
		}
		seen[modelID] = struct{}{}
		tieredRaw := detail.TieredModelIDs
		if len(detail.TieredModelIDsSnake) > 0 {
			if len(tieredRaw) > 0 {
				return nil, nil, ErrInvalidUpstreamResponse
			}
			tieredRaw = detail.TieredModelIDsSnake
		}
		tiered, err := decodeTieredModelIDs(tieredRaw)
		if err != nil {
			return nil, nil, ErrInvalidUpstreamResponse
		}
		for _, tieredID := range tiered {
			if !validCatalogModelID(tieredID) {
				return nil, nil, ErrInvalidUpstreamResponse
			}
			seen[tieredID] = struct{}{}
		}
		// 上游把 high/medium/low 这类档位写在 detail 的别名/命令别名里，
		// 它们是可请求的公开 ID，必须进入目录并转回真实 wire model。
		for _, alias := range decodeCatalogAliases(detail) {
			if !validCatalogModelID(alias) || alias == modelID {
				continue
			}
			seen[alias] = struct{}{}
			// 多个基座声明同一别名时固定选字典序最小的基座：map 遍历顺序不固定，
			// 「最后写入者赢」会让转发表在同一份上游目录上每次刷新都漂移。
			if current, claimed := aliasesToWire[alias]; !claimed || modelID < current {
				aliasesToWire[alias] = modelID
			}
		}
	}
	wires, err := decodeDeprecatedModelWires(document, seen)
	if err != nil {
		return nil, nil, err
	}
	for publicID := range wires {
		seen[publicID] = struct{}{}
	}
	for alias, wireID := range aliasesToWire {
		if _, exists := wires[alias]; !exists {
			wires[alias] = wireID
		}
	}
	// Resolve 热路径只读一次 map，别名与 deprecated 链必须在这里展开到终点；
	// 环或指向目录外模型的链直接丢弃，不能把另一个公开 ID 当成 wire model。
	flattened := make(map[string]string, len(wires))
	for publicID := range wires {
		if wireID, ok := resolveWireTarget(publicID, wires, seen); ok {
			flattened[publicID] = wireID
		}
	}
	wires = flattened
	// 上游 fetchAvailableModels 只给 *-tiered 基座，agy CLI 把 high/medium/low 作为
	// 可直接请求的档位 ID 暴露；Go 迁移后不能只留基座，否则网关会报模型不存在。
	// 档位 ID 直接发给 agy 即可，不做 wire 改写。
	for modelID := range seen {
		if !strings.HasSuffix(modelID, "-tiered") {
			continue
		}
		base := strings.TrimSuffix(modelID, "-tiered")
		for _, tier := range []string{"high", "medium", "low"} {
			seen[base+"-"+tier] = struct{}{}
		}
	}
	models := make([]string, 0, len(seen))
	for modelID := range seen {
		models = append(models, modelID)
	}
	if len(models) == 0 || len(models) > accountapp.MaxDiscoveredModelsPerAccount {
		return nil, nil, errors.New("AGY 模型目录无效")
	}
	sort.Strings(models)
	return models, wires, nil
}

// resolveWireTarget 沿转发表把公开 ID 展开到目录内的真实模型。终点不在目录里、
// 或映射成环时返回 false，调用方丢弃该映射（与 deprecated 环的处理一致）。
func resolveWireTarget(publicID string, wires map[string]string, available map[string]struct{}) (string, bool) {
	visited := make(map[string]struct{}, 4)
	current := publicID
	for {
		next, mapped := wires[current]
		if !mapped {
			_, found := available[current]
			return current, found
		}
		if _, loop := visited[current]; loop {
			return "", false
		}
		visited[current] = struct{}{}
		current = next
	}
}

type modelCatalogDocument struct {
	Models             map[string]json.RawMessage `json:"models"`
	DeprecatedIDs      json.RawMessage            `json:"deprecatedModelIds"`
	DeprecatedIDsSnake json.RawMessage            `json:"deprecated_model_ids"`
}

// modelCatalogDetail 只建模参与路由的 tiered ids。模型描述、能力标记等上游
// metadata 不影响路由事实，新增字段应前向兼容，不能让整个账号从可用池消失。
type modelCatalogDetail struct {
	TieredModelIDs       json.RawMessage `json:"tieredModelIds,omitempty"`
	TieredModelIDsSnake  json.RawMessage `json:"tiered_model_ids,omitempty"`
	Aliases              json.RawMessage `json:"aliases,omitempty"`
	Alias                json.RawMessage `json:"alias,omitempty"`
	CommandModelIDs      json.RawMessage `json:"commandModelIds,omitempty"`
	CommandModelIDsSnake json.RawMessage `json:"command_model_ids,omitempty"`
}

func decodeModelCatalogDetail(raw json.RawMessage) (modelCatalogDetail, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return modelCatalogDetail{}, ErrInvalidUpstreamResponse
	}
	return modelCatalogDetail{
		TieredModelIDs:       fields["tieredModelIds"],
		TieredModelIDsSnake:  fields["tiered_model_ids"],
		Aliases:              fields["aliases"],
		Alias:                fields["alias"],
		CommandModelIDs:      fields["commandModelIds"],
		CommandModelIDsSnake: fields["command_model_ids"],
	}, nil
}

// decodeCatalogAliases 收集 alias/commandModelIds 里的字符串叶子；对象里的展示名会被
// validCatalogModelID 过滤，不会误注册。
func decodeCatalogAliases(detail modelCatalogDetail) []string {
	const maxAliasNodes = 4096
	out := make([]string, 0)
	seen := make(map[string]struct{})
	// 一次解码 + 显式栈：旧实现对每个节点重复 json.Unmarshal 成 string/list/map，
	// 深层嵌套会变成 O(depth²)。这里限制遍历节点数和别名数，避免畸形目录放大 CPU/内存。
	for _, raw := range []json.RawMessage{detail.Aliases, detail.Alias, detail.CommandModelIDs, detail.CommandModelIDsSnake} {
		if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			continue
		}
		var root any
		if json.Unmarshal(raw, &root) != nil {
			continue
		}
		stack := []any{root}
		nodes := 0
		for len(stack) > 0 && nodes < maxAliasNodes && len(out) < accountapp.MaxDiscoveredModelsPerAccount {
			nodes++
			value := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			switch typed := value.(type) {
			case string:
				if typed != "" {
					if _, exists := seen[typed]; !exists {
						seen[typed] = struct{}{}
						out = append(out, typed)
					}
				}
			case []any:
				stack = append(stack, typed...)
			case map[string]any:
				for _, child := range typed {
					stack = append(stack, child)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

func decodeTieredModelIDs(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var byTier map[string]string
	if err := json.Unmarshal(raw, &byTier); err == nil {
		ids := make([]string, 0, len(byTier))
		for tier, modelID := range byTier {
			if !validOpaque(tier) || !validCatalogModelID(modelID) {
				return nil, ErrInvalidUpstreamResponse
			}
			ids = append(ids, modelID)
		}
		return ids, nil
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return nil, ErrInvalidUpstreamResponse
	}
	for _, modelID := range ids {
		if !validCatalogModelID(modelID) {
			return nil, ErrInvalidUpstreamResponse
		}
	}
	return ids, nil
}

func validCatalogModelID(value string) bool {
	if _, err := runtimecore.NewModelID(value); err != nil || strings.Contains(value, "*") {
		return false
	}
	normalized := strings.ToLower(value)
	return !strings.HasPrefix(value, "MODEL_") &&
		!strings.HasPrefix(normalized, "chat_") &&
		!strings.HasPrefix(normalized, "tab_") &&
		!strings.HasPrefix(normalized, "models/") &&
		!strings.Contains(normalized, "placeholder") &&
		!strings.Contains(normalized, "proactive-observer")
}
