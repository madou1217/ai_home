package accountruntime

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const maxModelIDBytes = 256

var (
	// ErrInvalidModelRoute 表示账号与模型无法形成稳定运行态键。
	ErrInvalidModelRoute = errors.New("账号模型运行态键无效")
)

// ModelID 是 Provider 适配器已经解析完成的真实上游模型 ID。
//
// 该值不做大小写改写，避免把 Provider 的两个不同模型错误合并。
type ModelID string

// NewModelID 校验模型 ID 可以安全作为运行态键。
func NewModelID(value string) (ModelID, error) {
	if value == "" ||
		len(value) > maxModelIDBytes ||
		!utf8.ValidString(value) ||
		strings.TrimSpace(value) != value {
		return "", ErrInvalidModelRoute
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return "", ErrInvalidModelRoute
		}
	}
	return ModelID(value), nil
}

// String 返回未经改写的真实上游模型 ID。
func (modelID ModelID) String() string {
	return string(modelID)
}

// IsValid 判断模型 ID 是否仍满足运行态键约束。
func (modelID ModelID) IsValid() bool {
	parsed, err := NewModelID(modelID.String())
	return err == nil && parsed == modelID
}

// ModelRoute 是 cooldown 的最小身份，作用域固定为账号与真实模型元组。
type ModelRoute struct {
	accountRef accountcore.AccountRef
	modelID    ModelID
}

// NewModelRoute 创建不会退化为账号级 cooldown 的运行态键。
func NewModelRoute(
	accountRef accountcore.AccountRef,
	model string,
) (ModelRoute, error) {
	modelID, err := NewModelID(model)
	if !accountRef.IsValid() || err != nil {
		return ModelRoute{}, ErrInvalidModelRoute
	}
	return ModelRoute{
		accountRef: accountRef,
		modelID:    modelID,
	}, nil
}

// AccountRef 返回 cooldown 所属账号。
func (route ModelRoute) AccountRef() accountcore.AccountRef {
	return route.accountRef
}

// ModelID 返回 cooldown 所属真实上游模型。
func (route ModelRoute) ModelID() ModelID {
	return route.modelID
}

// IsValid 判断运行态键是否同时拥有合法账号和模型身份。
func (route ModelRoute) IsValid() bool {
	return route.accountRef.IsValid() && route.modelID.IsValid()
}
