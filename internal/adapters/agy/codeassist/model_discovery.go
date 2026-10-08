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
	}
	wires, err := decodeDeprecatedModelWires(document, seen)
	if err != nil {
		return nil, nil, err
	}
	for publicID := range wires {
		seen[publicID] = struct{}{}
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

type modelCatalogDocument struct {
	Models             map[string]json.RawMessage `json:"models"`
	DeprecatedIDs      json.RawMessage            `json:"deprecatedModelIds"`
	DeprecatedIDsSnake json.RawMessage            `json:"deprecated_model_ids"`
}

// modelCatalogDetail 只建模参与路由的 tiered ids。模型描述、能力标记等上游
// metadata 不影响路由事实，新增字段应前向兼容，不能让整个账号从可用池消失。
type modelCatalogDetail struct {
	TieredModelIDs      json.RawMessage `json:"tieredModelIds,omitempty"`
	TieredModelIDsSnake json.RawMessage `json:"tiered_model_ids,omitempty"`
}

func decodeModelCatalogDetail(raw json.RawMessage) (modelCatalogDetail, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return modelCatalogDetail{}, ErrInvalidUpstreamResponse
	}
	return modelCatalogDetail{
		TieredModelIDs:      fields["tieredModelIds"],
		TieredModelIDsSnake: fields["tiered_model_ids"],
	}, nil
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
