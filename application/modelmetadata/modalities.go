// Package modelmetadata 定义模型能力元数据的应用层只读合同。
package modelmetadata

import (
	"errors"
	"strings"
)

var (
	// ErrInvalidModalities 表示输入或输出模态为空、含空项或重复项。
	ErrInvalidModalities = errors.New("模型模态无效")
)

// Reader 是模型目录投影所需的最小元数据读取端口。
type Reader interface {
	LookupModalities(providerID string, modelID string) (Modalities, bool)
}

// Modalities 是不共享可变切片的输入和输出模态值对象。
type Modalities struct {
	input  []string
	output []string
}

// NewModalities 校验并复制 models.dev 提供的稳定模态顺序。
func NewModalities(input []string, output []string) (Modalities, error) {
	normalizedInput, err := normalizeModalities(input)
	if err != nil {
		return Modalities{}, err
	}
	normalizedOutput, err := normalizeModalities(output)
	if err != nil {
		return Modalities{}, err
	}
	return Modalities{
		input:  normalizedInput,
		output: normalizedOutput,
	}, nil
}

// TextOnly 返回无法从权威快照解析模型时使用的保守能力。
func TextOnly() Modalities {
	return Modalities{
		input:  []string{"text"},
		output: []string{"text"},
	}
}

// Input 返回不会修改值对象内部状态的输入模态副本。
func (modalities Modalities) Input() []string {
	return append([]string(nil), modalities.input...)
}

// Output 返回不会修改值对象内部状态的输出模态副本。
func (modalities Modalities) Output() []string {
	return append([]string(nil), modalities.output...)
}

// normalizeModalities 规范化单个列表，并拒绝空值和重复值。
func normalizeModalities(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, ErrInvalidModalities
	}
	normalized := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		item := strings.TrimSpace(value)
		if item == "" {
			return nil, ErrInvalidModalities
		}
		if _, found := seen[item]; found {
			return nil, ErrInvalidModalities
		}
		seen[item] = struct{}{}
		normalized = append(normalized, item)
	}
	return normalized, nil
}
