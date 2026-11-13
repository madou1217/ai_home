package pluginhost

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
)

// ModelCatalogCapability 是插件申报模型别名的能力名。
const ModelCatalogCapability = "model.catalog"

const (
	maxCatalogAliasesPerPlugin = 256
	defaultCatalogTimeout      = 3 * time.Second
)

var catalogAliasPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$`)

// CatalogAlias 描述插件在某个代次内申报的一条模型别名。
type CatalogAlias struct {
	Alias       string `json:"alias"`
	Target      string `json:"target"`
	InstanceID  string `json:"instanceId"`
	Description string `json:"description,omitempty"`
}

// CollectCatalogAliases 在候选准备阶段收集并校验插件声明的模型别名（与 gateway/catalog.js 一致）。
func CollectCatalogAliases(
	ctx context.Context,
	projection appplugins.Projection,
	invoke func(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error),
) ([]CatalogAlias, error) {
	chain := projection.ByCapability(ModelCatalogCapability)
	if len(chain) == 0 || invoke == nil {
		return nil, nil
	}
	owners := make(map[string]string)
	aliases := make([]CatalogAlias, 0)
	for _, item := range chain {
		raw, err := invoke(ctx, projection.Generation, item.ID, map[string]any{"kind": "aliases"}, defaultCatalogTimeout)
		if err != nil {
			code := firstNonEmpty(errorCode(err), CodeCatalogFailed)
			return nil, catalogRejected(item, code, err.Error())
		}
		trimmed := strings.TrimSpace(string(raw))
		if trimmed == "" || trimmed == "null" {
			continue
		}
		var payload struct {
			Aliases []struct {
				Alias       string `json:"alias"`
				Target      string `json:"target"`
				Description string `json:"description"`
			} `json:"aliases"`
			RawAliases json.RawMessage `json:"-"`
		}
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(raw, &probe); err != nil {
			return nil, catalogRejected(item, CodeCatalogInvalid, "返回值必须是 { aliases: [...] }")
		}
		aliasesRaw, hasAliases := probe["aliases"]
		if !hasAliases || len(aliasesRaw) == 0 || aliasesRaw[0] != '[' {
			return nil, catalogRejected(item, CodeCatalogInvalid, "返回值必须是 { aliases: [...] }")
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, catalogRejected(item, CodeCatalogInvalid, "返回值必须是 { aliases: [...] }")
		}
		if len(payload.Aliases) > maxCatalogAliasesPerPlugin {
			return nil, catalogRejected(item, CodeCatalogInvalid, fmt.Sprintf("别名不能超过 %d 个", maxCatalogAliasesPerPlugin))
		}
		for _, entry := range payload.Aliases {
			alias := strings.TrimSpace(entry.Alias)
			target := strings.TrimSpace(entry.Target)
			if !catalogAliasPattern.MatchString(alias) || target == "" || alias == target {
				return nil, catalogRejected(item, CodeCatalogInvalid, fmt.Sprintf("别名条目无效：%s", alias))
			}
			lower := strings.ToLower(alias)
			if prev, dup := owners[lower]; dup {
				return nil, catalogRejected(item, CodeCatalogConflict, fmt.Sprintf("别名 %s 已由 %s 声明", alias, prev))
			}
			owners[lower] = item.InstanceID
			desc := strings.TrimSpace(entry.Description)
			if len(desc) > 200 {
				desc = desc[:200]
			}
			aliases = append(aliases, CatalogAlias{
				Alias:       alias,
				Target:      target,
				InstanceID:  item.InstanceID,
				Description: desc,
			})
		}
	}
	return aliases, nil
}

func catalogRejected(item appplugins.Contribution, code string, message string) error {
	diag := PrepareDiagnostic{
		Code:       code,
		InstanceID: item.InstanceID,
		Detail:     message,
	}
	return newCandidateRejectedError(fmt.Sprintf("插件 %s 的 %s：%s", item.InstanceID, item.ID, message), []PrepareDiagnostic{diag})
}
