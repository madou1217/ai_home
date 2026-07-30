package accounts

import (
	"context"
	"errors"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidRoutableModel 表示本地模型目录包含未知 Provider 或无效模型标识。
	ErrInvalidRoutableModel = errors.New("可路由模型无效")
)

// RoutableModelReader 是标准模型目录读取本地物化索引的最小端口。
type RoutableModelReader interface {
	// ListRoutableModels 返回按模型和 Provider 排序且至少有一个启用账号支持的元组。
	ListRoutableModels(ctx context.Context) ([]RoutableModel, error)
}

// RoutableModel 是不会读取凭据、SQLite 或上游的本地模型目录项。
type RoutableModel struct {
	providerID string
	modelID    runtimecore.ModelID
}

// NewRoutableModel 校验 Provider 与真实模型标识并创建目录项。
func NewRoutableModel(
	catalog *providers.Catalog,
	providerID string,
	modelID string,
) (RoutableModel, error) {
	if catalog == nil {
		return RoutableModel{}, ErrInvalidRoutableModel
	}
	canonicalProviderID, found := catalog.CanonicalID(providerID)
	runtimeModelID, err := runtimecore.NewModelID(modelID)
	if !found || canonicalProviderID != providerID || err != nil {
		return RoutableModel{}, ErrInvalidRoutableModel
	}
	return RoutableModel{
		providerID: canonicalProviderID,
		modelID:    runtimeModelID,
	}, nil
}

// ProviderID 返回至少有一个有效账号的规范 Provider。
func (model RoutableModel) ProviderID() string {
	return model.providerID
}

// ModelID 返回未经别名改写的真实上游模型标识。
func (model RoutableModel) ModelID() runtimecore.ModelID {
	return model.modelID
}

// IsValid 复核本地索引跨层传递后的非空不变量。
func (model RoutableModel) IsValid() bool {
	return model.providerID != "" && model.modelID.IsValid()
}
