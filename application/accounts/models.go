package accounts

import (
	"context"
	"errors"
	"sort"
	"time"
	"unicode/utf8"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// MaxDiscoveredModelsPerAccount 限制一次远端发现可以写入的账号模型数量。
	MaxDiscoveredModelsPerAccount = 1024
)

var (
	// ErrInvalidAccountModel 表示账号模型关系缺少合法身份、模型、策略或时间。
	ErrInvalidAccountModel = errors.New("账号模型关系无效")
	// ErrInvalidDiscoveredModels 表示远端模型发现结果为空、重复或超过安全上限。
	ErrInvalidDiscoveredModels = errors.New("账号模型发现结果无效")
	// ErrInvalidModelProbe 表示探测事实缺少合法账号、时间或成功/失败字段。
	ErrInvalidModelProbe = errors.New("账号模型探测事实无效")
)

// AccountModelStore 是账号模型查询、自动发现替换和人工覆盖的持久化端口。
type AccountModelStore interface {
	// ListAccountModels 返回按模型 ID 排序的完整账号模型关系。
	ListAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]AccountModel, error)
	// ReplaceDiscoveredModelsIfCredentialVersion 仅在凭据版本未变化时原子替换
	// 上游发现部分，并保留人工覆盖。
	ReplaceDiscoveredModelsIfCredentialVersion(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		models []runtimecore.ModelID,
		expectedCredentialUpdatedAt time.Time,
		updatedAt time.Time,
	) ([]AccountModel, error)
	// SetManualModelPolicy 原子设置一个模型的人工覆盖策略。
	SetManualModelPolicy(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		modelID runtimecore.ModelID,
		policy ModelManualPolicy,
		updatedAt time.Time,
	) ([]AccountModel, error)
}

const (
	// MaxModelProbeErrorMessageLength 是探测错误消息的持久化上限。
	//
	// 上游错误可能带整段响应正文；稳定错误码已经表达分类，消息只需要足够定位的
	// 前缀，因此按字符（不是字节）截断，避免中文错误被切坏。
	MaxModelProbeErrorMessageLength = 300
	// ModelProbeSourceRemote 表示最近一次探测真实命中了上游目录。
	ModelProbeSourceRemote = "remote"
	// ModelProbeSourceError 表示最近一次探测失败，目录仍是上一次成功的快照。
	ModelProbeSourceError = "error"
)

// ModelProbeRecord 是一次账号模型探测的结果事实。
//
// 探测与目录快照分开记录：刷新失败时目录保持不变，但「什么时候试过、为什么失败」
// 必须可读，否则 WebUI 只能把旧目录当成最新结果。
type ModelProbeRecord struct {
	// AccountRef 是探测所属的稳定账号身份。
	AccountRef accountcore.AccountRef
	// AttemptedAt 是本次探测发生的 UTC 毫秒时刻。
	AttemptedAt time.Time
	// Succeeded 区分成功与失败；失败时 ModelCount 必须为 0。
	Succeeded bool
	// Source 是本次探测结果来源（remote / error）。
	Source string
	// ModelCount 是本次成功探测得到的模型数量。
	ModelCount int
	// ErrorCode 是稳定的失败分类；成功时为空。
	ErrorCode string
	// ErrorMessage 是截断后的失败消息；成功时为空。
	ErrorMessage string
	// UpdatedAt 是这条事实的写入时刻（UTC 毫秒）。
	UpdatedAt time.Time
}

// IsValid 校验探测事实的字段范围与成功/失败互斥关系。
func (record ModelProbeRecord) IsValid() bool {
	if !record.AccountRef.IsValid() ||
		record.ModelCount < 0 ||
		record.ModelCount > MaxDiscoveredModelsPerAccount {
		return false
	}
	attemptedAt, attemptedErr := normalizeModelTime(record.AttemptedAt)
	updatedAt, updatedErr := normalizeModelTime(record.UpdatedAt)
	if attemptedErr != nil ||
		updatedErr != nil ||
		!attemptedAt.Equal(record.AttemptedAt) ||
		!updatedAt.Equal(record.UpdatedAt) {
		return false
	}
	if record.Succeeded {
		return record.Source == ModelProbeSourceRemote &&
			record.ErrorCode == "" &&
			record.ErrorMessage == ""
	}
	return record.Source == ModelProbeSourceError &&
		record.ModelCount == 0 &&
		record.ErrorCode != "" &&
		len(record.ErrorCode) <= 64 &&
		utf8.RuneCountInString(record.ErrorMessage) <= MaxModelProbeErrorMessageLength
}

// ModelProbeRecorder 记录每次探测的结果事实。
//
// 独立于 AccountModelStore：记录失败只影响可观测性，不能回滚已经提交的目录快照。
type ModelProbeRecorder interface {
	RecordModelProbe(ctx context.Context, record ModelProbeRecord) error
}

// ModelManualPolicy 表达人工维护相对上游发现结果的唯一覆盖策略。
type ModelManualPolicy string

const (
	// ModelPolicyInherit 表示有效性完全继承最近一次上游发现结果。
	ModelPolicyInherit ModelManualPolicy = "inherit"
	// ModelPolicyForceEnable 表示即使目录没有返回该模型也允许人工启用。
	ModelPolicyForceEnable ModelManualPolicy = "force_enable"
	// ModelPolicyForceDisable 表示即使目录返回该模型也禁止账号参与征召。
	ModelPolicyForceDisable ModelManualPolicy = "force_disable"
)

// ParseModelManualPolicy 严格解析管理 API 或持久化层返回的人工策略。
func ParseModelManualPolicy(value string) (ModelManualPolicy, error) {
	policy := ModelManualPolicy(value)
	if !policy.IsValid() {
		return "", ErrInvalidAccountModel
	}
	return policy, nil
}

// String 返回持久化和管理 API 使用的稳定策略文本。
func (policy ModelManualPolicy) String() string {
	return string(policy)
}

// IsValid 判断策略是否属于当前三个明确状态。
func (policy ModelManualPolicy) IsValid() bool {
	switch policy {
	case ModelPolicyInherit, ModelPolicyForceEnable, ModelPolicyForceDisable:
		return true
	default:
		return false
	}
}

// AccountModelInput 是恢复或创建账号模型关系所需的完整字段。
type AccountModelInput struct {
	// AccountRef 是模型关系所属的稳定账号身份。
	AccountRef accountcore.AccountRef
	// ModelID 是 Provider 适配器确认的真实上游模型标识。
	ModelID string
	// UpstreamAvailable 表示最近一次完整目录是否包含该模型。
	UpstreamAvailable bool
	// ManualPolicy 表示用户对自动发现结果的显式覆盖。
	ManualPolicy ModelManualPolicy
	// UpdatedAt 是该关系最后一次发现或人工维护时间。
	UpdatedAt time.Time
}

// AccountModel 是持久化账号模型关系的不可变应用值。
type AccountModel struct {
	accountRef        accountcore.AccountRef
	modelID           runtimecore.ModelID
	upstreamAvailable bool
	manualPolicy      ModelManualPolicy
	updatedAt         time.Time
}

// NewAccountModel 校验全部字段并创建不会携带凭据的模型关系。
func NewAccountModel(input AccountModelInput) (AccountModel, error) {
	modelID, err := runtimecore.NewModelID(input.ModelID)
	updatedAt, timeErr := normalizeModelTime(input.UpdatedAt)
	if !input.AccountRef.IsValid() ||
		err != nil ||
		timeErr != nil ||
		!input.ManualPolicy.IsValid() {
		return AccountModel{}, ErrInvalidAccountModel
	}
	return AccountModel{
		accountRef:        input.AccountRef,
		modelID:           modelID,
		upstreamAvailable: input.UpstreamAvailable,
		manualPolicy:      input.ManualPolicy,
		updatedAt:         updatedAt,
	}, nil
}

// AccountRef 返回模型关系所属账号。
func (model AccountModel) AccountRef() accountcore.AccountRef {
	return model.accountRef
}

// ModelID 返回未经改写的真实上游模型标识。
func (model AccountModel) ModelID() runtimecore.ModelID {
	return model.modelID
}

// UpstreamAvailable 返回最近一次上游完整发现结果。
func (model AccountModel) UpstreamAvailable() bool {
	return model.upstreamAvailable
}

// ManualPolicy 返回人工覆盖策略。
func (model AccountModel) ManualPolicy() ModelManualPolicy {
	return model.manualPolicy
}

// UpdatedAt 返回 UTC 毫秒精度的关系更新时间。
func (model AccountModel) UpdatedAt() time.Time {
	return model.updatedAt
}

// Effective 判断该关系当前是否应进入账号模型正排和倒排索引。
func (model AccountModel) Effective() bool {
	switch model.manualPolicy {
	case ModelPolicyForceEnable:
		return true
	case ModelPolicyForceDisable:
		return false
	case ModelPolicyInherit:
		return model.upstreamAvailable
	default:
		return false
	}
}

// IsValid 复核从持久化层返回的关系仍满足全部不变量。
func (model AccountModel) IsValid() bool {
	restored, err := NewAccountModel(AccountModelInput{
		AccountRef:        model.accountRef,
		ModelID:           model.modelID.String(),
		UpstreamAvailable: model.upstreamAvailable,
		ManualPolicy:      model.manualPolicy,
		UpdatedAt:         model.updatedAt,
	})
	return err == nil &&
		restored.accountRef == model.accountRef &&
		restored.modelID == model.modelID &&
		restored.updatedAt.Equal(model.updatedAt)
}

// NormalizeDiscoveredModels 校验、排序并拒绝重复的完整上游模型目录。
func NormalizeDiscoveredModels(values []string) ([]runtimecore.ModelID, error) {
	if len(values) == 0 || len(values) > MaxDiscoveredModelsPerAccount {
		return nil, ErrInvalidDiscoveredModels
	}
	models := make([]runtimecore.ModelID, 0, len(values))
	seen := make(map[runtimecore.ModelID]struct{}, len(values))
	for _, value := range values {
		modelID, err := runtimecore.NewModelID(value)
		if err != nil {
			return nil, ErrInvalidDiscoveredModels
		}
		if _, found := seen[modelID]; found {
			return nil, ErrInvalidDiscoveredModels
		}
		seen[modelID] = struct{}{}
		models = append(models, modelID)
	}
	sort.Slice(models, func(left, right int) bool {
		return models[left].String() < models[right].String()
	})
	return models, nil
}

// ValidDiscoveredModelIDs 判断模型集合已经按 ID 严格升序、去重且有界。
func ValidDiscoveredModelIDs(models []runtimecore.ModelID) bool {
	if len(models) == 0 || len(models) > MaxDiscoveredModelsPerAccount {
		return false
	}
	var previous runtimecore.ModelID
	for index, modelID := range models {
		if !modelID.IsValid() ||
			(index > 0 && modelID.String() <= previous.String()) {
			return false
		}
		previous = modelID
	}
	return true
}

// EffectiveModelIDs 从完整关系快照生成排序、去重的路由模型集合。
func EffectiveModelIDs(models []AccountModel) ([]runtimecore.ModelID, error) {
	effective := make([]runtimecore.ModelID, 0, len(models))
	var previous runtimecore.ModelID
	for index, model := range models {
		if !model.IsValid() {
			return nil, ErrInvalidAccountModel
		}
		if index > 0 && model.ModelID().String() <= previous.String() {
			return nil, ErrInvalidAccountModel
		}
		previous = model.ModelID()
		if model.Effective() {
			effective = append(effective, model.ModelID())
		}
	}
	return effective, nil
}

// normalizeModelTime 统一模型关系使用的持久化时间精度。
func normalizeModelTime(value time.Time) (time.Time, error) {
	if value.IsZero() {
		return time.Time{}, ErrInvalidAccountModel
	}
	unixMillis := value.UnixMilli()
	if unixMillis < 0 || unixMillis > maxPersistedUnixMillis {
		return time.Time{}, ErrInvalidAccountModel
	}
	return time.UnixMilli(unixMillis).UTC(), nil
}
