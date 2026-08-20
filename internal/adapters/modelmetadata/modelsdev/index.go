// Package modelsdev 提供由固定 models.dev API 快照生成的进程内只读模态索引。
package modelsdev

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

var (
	// ErrInvalidSnapshot 表示嵌入快照损坏或不满足应用层值对象合同。
	ErrInvalidSnapshot = errors.New("models.dev 嵌入模态快照无效")
	// embeddedSnapshot 由 Go 生成器从仓库内固定的 models.dev catalog 快照生成。
	//go:embed modalities.json
	embeddedSnapshot []byte
)

// providerSourceIDs 把当前 Go 重构范围内的 Provider 映射到 models.dev 基础模型命名空间。
var providerSourceIDs = map[string]string{
	"codex":  "openai",
	"claude": "anthropic",
}

// snapshotRecord 是生成快照的 JSON 传输形状。
type snapshotRecord struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// Index 保存启动时构建后不再修改的 O(1) 模态查找表。
type Index struct {
	models map[string]modelmetadata.Modalities
}

// 编译期确认索引满足 HTTP 模型目录所依赖的应用层端口。
var _ modelmetadata.Reader = (*Index)(nil)

// New 解码并完整校验嵌入快照；损坏时失败关闭，避免发布虚假能力。
func New() (*Index, error) {
	var records map[string]snapshotRecord
	if err := json.Unmarshal(embeddedSnapshot, &records); err != nil || len(records) == 0 {
		return nil, fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}
	models := make(map[string]modelmetadata.Modalities, len(records))
	for modelID, record := range records {
		if strings.TrimSpace(modelID) == "" || modelID != strings.TrimSpace(modelID) {
			return nil, ErrInvalidSnapshot
		}
		modalities, err := modelmetadata.NewModalities(record.Input, record.Output)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrInvalidSnapshot, modelID)
		}
		models[modelID] = modalities
	}
	return &Index{models: models}, nil
}

// LookupModalities 按 AIH Provider 和真实模型 ID 返回不可变值对象。
func (index *Index) LookupModalities(
	providerID string,
	modelID string,
) (modelmetadata.Modalities, bool) {
	if index == nil || index.models == nil {
		return modelmetadata.Modalities{}, false
	}
	sourceProviderID, found := providerSourceIDs[providerID]
	if !found {
		return modelmetadata.Modalities{}, false
	}
	modalities, found := index.models[sourceProviderID+"/"+modelID]
	return modalities, found
}

//go:generate go run ../../../tools/modelsdevmodalities --source ../../../../data/models-dev/catalog.json --target modalities.json
