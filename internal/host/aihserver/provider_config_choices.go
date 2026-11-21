package aihserver

import (
	"context"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/modelsnapshot"
)

// providerConfigChoices 把模型快照与推理档位目录接成关键设置的候选来源。
type providerConfigChoices struct {
	models  modelsnapshot.Reader
	ladders modelmetadata.ReasoningLadderReader
}

// ModelIDs 返回宿主快照里该 Provider 的模型 ID（按名称排序）。
func (choices providerConfigChoices) ModelIDs(ctx context.Context, provider string) []string {
	if choices.models == nil {
		return nil
	}
	snapshot, err := choices.models.Read(ctx)
	if err != nil || snapshot == nil {
		return nil
	}
	ids := append([]string(nil), snapshot.ByProvider[strings.ToLower(strings.TrimSpace(provider))]...)
	sort.Strings(ids)
	return ids
}

// ReasoningEfforts 返回该模型目录声明的推理强度档位。
func (choices providerConfigChoices) ReasoningEfforts(provider string, model string) []string {
	if choices.ladders == nil || strings.TrimSpace(model) == "" {
		return nil
	}
	ladder, found := choices.ladders.LookupReasoningEfforts(
		strings.ToLower(strings.TrimSpace(provider)),
		strings.TrimSpace(model),
	)
	if !found || len(ladder) == 0 {
		return nil
	}
	values := make([]string, 0, len(ladder))
	for _, effort := range ladder {
		values = append(values, string(effort))
	}
	return values
}
