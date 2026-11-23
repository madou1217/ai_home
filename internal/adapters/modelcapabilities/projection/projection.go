// Package projection 把 host 推送的模型目录投影（aih.db 快照）暴露为能力来源。
//
// 投影是聚合视图（模型 ID 与 owned_by 为维度），不按 Provider 区分；这里按精确模型 ID
// 匹配，Provider 参数不参与判定。投影为空（generation=0）时所有查询都未命中，
// 由后续来源（能力基线/兼容来源）兜底。
package projection

import (
	"strings"

	"github.com/madou1217/ai_home/application/modelcatalog"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/core/inference"
)

// Source 是模型目录投影的只读能力来源。
type Source struct {
	store *modelcatalog.Store
}

var _ modelmetadata.FactsSource = (*Source)(nil)

// New 创建投影来源；store 为空时所有查询都未命中。
func New(store *modelcatalog.Store) *Source {
	return &Source{store: store}
}

// Generation 返回当前投影代号，0 表示宿主尚未推送。
func (source *Source) Generation() int64 {
	if source == nil || source.store == nil {
		return 0
	}
	return source.store.Snapshot().Generation
}

func (source *Source) LookupModalities(providerID string, modelID string) (modelmetadata.Modalities, bool) {
	item, found := source.item(modelID)
	if !found {
		return modelmetadata.Modalities{}, false
	}
	modalities, err := modelmetadata.NewModalities(item.InputModalities, item.OutputModalities)
	if err != nil {
		return modelmetadata.Modalities{}, false
	}
	return modalities, true
}

func (source *Source) LookupReasoningEfforts(providerID string, modelID string) ([]inference.ReasoningEffort, bool) {
	item, found := source.item(modelID)
	if !found || len(item.ReasoningEfforts) == 0 {
		return nil, false
	}
	return append([]inference.ReasoningEffort(nil), item.ReasoningEfforts...), true
}

func (source *Source) LookupContextWindow(string, string) (int, bool) { return 0, false }

func (source *Source) LookupDisplayName(string, string) (string, bool) { return "", false }

func (source *Source) item(modelID string) (modelcatalog.Item, bool) {
	if source == nil || source.store == nil {
		return modelcatalog.Item{}, false
	}
	key := normalizeModelKey(modelID)
	if key == "" {
		return modelcatalog.Item{}, false
	}
	snapshot := source.store.Snapshot()
	if snapshot.Generation <= 0 {
		return modelcatalog.Item{}, false
	}
	for _, item := range snapshot.Items {
		if normalizeModelKey(item.ID) == key {
			return item, true
		}
	}
	return modelcatalog.Item{}, false
}

func normalizeModelKey(modelID string) string {
	return strings.ToLower(strings.TrimSpace(modelmetadata.NormalizeVersionSeparators(modelID)))
}
