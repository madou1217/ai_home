// Package modelmetadata 定义模型能力元数据的应用层只读合同。
package modelmetadata

import (
	"errors"
	"strings"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidModalities 表示输入或输出模态为空、含空项或重复项。
	ErrInvalidModalities = errors.New("模型模态无效")
	// ErrInvalidModelDescriptor 表示运行时模型能力描述不满足低敏值对象合同。
	ErrInvalidModelDescriptor = errors.New("模型能力描述无效")
)

// Reader 是模型目录投影所需的最小元数据读取端口。
type Reader interface {
	LookupModalities(providerID string, modelID string) (Modalities, bool)
	// LookupOrInferModalities 在快照未命中时按保守家族兜底，供「需要明确判定」的消费方
	// （模型目录 capability 过滤、vision guard）使用：它们要的是答案，不是「不知道」。
	LookupOrInferModalities(providerID string, modelID string) (Modalities, bool)
}

// ReasoningLadderReader 返回模型声明的推理强度档位（升序）。
//
// 它刻意不提供「兜底推断」：猜错模态只是多剥或少剥一张图，猜错强度却会把用户明确要求
// 的 high 静默降档。查不到时返回未命中，由调用方决定是去掉强度意图还是拒绝。
type ReasoningLadderReader interface {
	LookupReasoningEfforts(providerID string, modelID string) ([]inference.ReasoningEffort, bool)
}

// Modalities 是不共享可变切片的输入和输出模态值对象。
type Modalities struct {
	input  []string
	output []string
}

// ModelDescriptorInput 是 Provider 探测结果进入应用层前的低敏能力投影。
//
// 它刻意只保留稳定 Provider、模型 ID 和模态，不携带账号、凭据或上游正文。
type ModelDescriptorInput struct {
	ProviderID string
	ModelID    string
	Modalities Modalities
}

// ModelDescriptor 是不可变的 Provider + 模型能力值对象。
type ModelDescriptor struct {
	providerID string
	modelID    runtimecore.ModelID
	modalities Modalities
}

// NewModelDescriptor 校验并复制一条低敏模型能力描述。
func NewModelDescriptor(input ModelDescriptorInput) (ModelDescriptor, error) {
	providerID := strings.ToLower(strings.TrimSpace(input.ProviderID))
	modelID, err := runtimecore.NewModelID(input.ModelID)
	if providerID == "" || err != nil || !validModalities(input.Modalities) {
		return ModelDescriptor{}, ErrInvalidModelDescriptor
	}
	return ModelDescriptor{
		providerID: providerID,
		modelID:    modelID,
		modalities: copyModalities(input.Modalities),
	}, nil
}

// ProviderID 返回规范 Provider ID。
func (descriptor ModelDescriptor) ProviderID() string {
	return descriptor.providerID
}

// ModelID 返回真实上游模型 ID。
func (descriptor ModelDescriptor) ModelID() runtimecore.ModelID {
	return descriptor.modelID
}

// Modalities 返回不会暴露内部切片的模态副本。
func (descriptor ModelDescriptor) Modalities() Modalities {
	return copyModalities(descriptor.modalities)
}

// IsValid 复核跨层传递后的 descriptor 不变量。
func (descriptor ModelDescriptor) IsValid() bool {
	restored, err := NewModelDescriptor(ModelDescriptorInput{
		ProviderID: descriptor.providerID,
		ModelID:    descriptor.modelID.String(),
		Modalities: descriptor.modalities,
	})
	return err == nil && restored.providerID == descriptor.providerID && restored.modelID == descriptor.modelID
}

// ModelDescriptorRegistrar 接收 Provider 级运行时能力快照。
type ModelDescriptorRegistrar interface {
	ReplaceModelDescriptors(providerID string, descriptors []ModelDescriptor) error
}

func validModalities(modalities Modalities) bool {
	return len(modalities.input) > 0 && len(modalities.output) > 0 &&
		modalities.IsValid()
}

func copyModalities(modalities Modalities) Modalities {
	return Modalities{
		input:  append([]string(nil), modalities.input...),
		output: append([]string(nil), modalities.output...),
	}
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

// IsValid 复核模态值对象仍满足非空、无重复的合同。
func (modalities Modalities) IsValid() bool {
	_, err := NewModalities(modalities.input, modalities.output)
	return err == nil
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
