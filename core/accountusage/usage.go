// Package accountusage 定义 Provider 账号当前额度快照的稳定领域合同。
//
// 该包只保存经过 Adapter 归一化的低敏额度事实，不认识 HTTP、SQLite、凭据、
// Provider 原始 JSON 或账号征召实现。
package accountusage

import (
	"errors"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// MaxEntriesPerSnapshot 限制单账号一次额度响应可以进入内存和数据库的条目数。
	MaxEntriesPerSnapshot = 64
	maxIdentifierLength   = 128
	maxDisplayNameLength  = 256
	maxWindowSeconds      = int64(10 * 366 * 24 * 60 * 60)
	maxPersistedUnixMS    = int64(253_402_300_799_999)
)

var (
	// ErrInvalidEntry 表示额度条目的维度、数值或状态互相矛盾。
	ErrInvalidEntry = errors.New("账号额度条目无效")
	// ErrInvalidSnapshot 表示额度快照身份、来源、时间或条目集合无效。
	ErrInvalidSnapshot = errors.New("账号额度快照无效")
)

// Kind 区分时间窗口额度和可追加使用的 Credits。
type Kind string

const (
	// KindWindow 表示有使用比例、窗口长度或恢复时间的额度窗口。
	KindWindow Kind = "window"
	// KindCredits 表示 Provider 提供的额外用量或 Credits 状态。
	KindCredits Kind = "credits"
)

// Scope 区分额度影响整个账号还是 Provider 模型族。
type Scope string

const (
	// ScopeAccount 表示该条目影响账号下的所有模型。
	ScopeAccount Scope = "account"
	// ScopeModelFamily 表示该条目只影响同一 Provider 模型族。
	ScopeModelFamily Scope = "model_family"
)

// Availability 是 Adapter 根据可信 Provider 字段得到的额度可用性。
type Availability string

const (
	// AvailabilityUnknown 表示上游返回了条目，但没有足够字段判断可用性。
	AvailabilityUnknown Availability = "unknown"
	// AvailabilityAvailable 表示额度仍然可用。
	AvailabilityAvailable Availability = "available"
	// AvailabilityExhausted 表示当前条目额度已经耗尽。
	AvailabilityExhausted Availability = "exhausted"
	// AvailabilityUnlimited 表示额外用量已启用且没有上限。
	AvailabilityUnlimited Availability = "unlimited"
	// AvailabilityDisabled 表示额外用量明确没有启用。
	AvailabilityDisabled Availability = "disabled"
)

// EntryInput 是 Provider Adapter 创建额度条目所需的完整字段。
type EntryInput struct {
	// LimitID 是 Provider 的可选额度组标识，例如 Codex limit_id。
	LimitID string
	// LimitName 是 Provider 的可选额度组展示名。
	LimitName string
	// Bucket 是额度组内稳定条目标识，例如 primary 或 five_hour。
	Bucket string
	// Kind 区分时间窗口和额外 Credits。
	Kind Kind
	// Scope 表达账号级或模型族级影响范围。
	Scope Scope
	// ScopeKey 只在模型族作用域下保存 Provider 内部稳定族名。
	ScopeKey string
	// HasRemaining 区分未知比例和明确为零。
	HasRemaining bool
	// RemainingBasisPoints 是 0–10000 的剩余百分比基点。
	RemainingBasisPoints uint16
	// WindowSeconds 是零或正整数窗口长度。
	WindowSeconds int64
	// ResetAt 是可选的绝对恢复时间。
	ResetAt time.Time
	// Availability 是该条目的稳定可用性。
	Availability Availability
}

// Entry 是构造后不可变的单个 Provider 额度事实。
type Entry struct {
	limitID              string
	limitName            string
	bucket               string
	kind                 Kind
	scope                Scope
	scopeKey             string
	hasRemaining         bool
	remainingBasisPoints uint16
	windowSeconds        int64
	resetAt              time.Time
	availability         Availability
}

// NewEntry 校验 Provider 维度和额度数值后创建不可变条目。
func NewEntry(input EntryInput) (Entry, error) {
	limitID := strings.TrimSpace(input.LimitID)
	limitName := strings.TrimSpace(input.LimitName)
	bucket := strings.TrimSpace(input.Bucket)
	scopeKey := strings.TrimSpace(input.ScopeKey)
	resetAt, resetValid := normalizeOptionalTime(input.ResetAt)
	if input.LimitID != limitID ||
		input.LimitName != limitName ||
		input.Bucket != bucket ||
		input.ScopeKey != scopeKey ||
		(limitID != "" && !validIdentifier(limitID)) ||
		len(limitName) > maxDisplayNameLength ||
		!utf8.ValidString(limitName) ||
		strings.IndexFunc(limitName, unicode.IsControl) >= 0 ||
		!validIdentifier(bucket) ||
		!input.Kind.IsValid() ||
		!input.Scope.IsValid() ||
		!validScopeKey(input.Scope, scopeKey) ||
		input.WindowSeconds < 0 ||
		input.WindowSeconds > maxWindowSeconds ||
		!resetValid ||
		!input.Availability.IsValid() ||
		!validRemainingAvailability(
			input.HasRemaining,
			input.RemainingBasisPoints,
			input.Availability,
		) ||
		!validKindAvailability(input.Kind, input.Availability) {
		return Entry{}, ErrInvalidEntry
	}
	return Entry{
		limitID:              limitID,
		limitName:            limitName,
		bucket:               bucket,
		kind:                 input.Kind,
		scope:                input.Scope,
		scopeKey:             scopeKey,
		hasRemaining:         input.HasRemaining,
		remainingBasisPoints: input.RemainingBasisPoints,
		windowSeconds:        input.WindowSeconds,
		resetAt:              resetAt,
		availability:         input.Availability,
	}, nil
}

// LimitID 返回 Provider 额度组标识；空值表示只有默认额度组。
func (entry Entry) LimitID() string {
	return entry.limitID
}

// LimitName 返回 Provider 额度组展示名。
func (entry Entry) LimitName() string {
	return entry.limitName
}

// Bucket 返回额度组内稳定条目标识。
func (entry Entry) Bucket() string {
	return entry.bucket
}

// Kind 返回时间窗口或 Credits 类型。
func (entry Entry) Kind() Kind {
	return entry.kind
}

// Scope 返回账号或模型族作用域。
func (entry Entry) Scope() Scope {
	return entry.scope
}

// ScopeKey 返回模型族标识；账号级条目固定为空。
func (entry Entry) ScopeKey() string {
	return entry.scopeKey
}

// RemainingBasisPoints 返回剩余基点及其是否已知。
func (entry Entry) RemainingBasisPoints() (uint16, bool) {
	return entry.remainingBasisPoints, entry.hasRemaining
}

// WindowSeconds 返回窗口秒数；零表示 Provider 未提供。
func (entry Entry) WindowSeconds() int64 {
	return entry.windowSeconds
}

// ResetAt 返回额度恢复时间；零值表示 Provider 未提供。
func (entry Entry) ResetAt() time.Time {
	return entry.resetAt
}

// Availability 返回 Adapter 已确认的稳定可用性。
func (entry Entry) Availability() Availability {
	return entry.availability
}

// IsValid 重新校验跨层传递后的不可变条目。
func (entry Entry) IsValid() bool {
	restored, err := NewEntry(EntryInput{
		LimitID:              entry.limitID,
		LimitName:            entry.limitName,
		Bucket:               entry.bucket,
		Kind:                 entry.kind,
		Scope:                entry.scope,
		ScopeKey:             entry.scopeKey,
		HasRemaining:         entry.hasRemaining,
		RemainingBasisPoints: entry.remainingBasisPoints,
		WindowSeconds:        entry.windowSeconds,
		ResetAt:              entry.resetAt,
		Availability:         entry.availability,
	})
	return err == nil && restored == entry
}

// SnapshotInput 是一个账号当前完整额度快照。
type SnapshotInput struct {
	AccountRef accountcore.AccountRef
	ProviderID string
	Source     string
	CapturedAt time.Time
	Entries    []EntryInput
}

// Snapshot 保存一个账号同一采集时刻的完整、排序、不可变额度事实。
type Snapshot struct {
	accountRef accountcore.AccountRef
	providerID string
	source     string
	capturedAt time.Time
	entries    []Entry
}

// NewSnapshot 校验身份、来源和完整条目集合后创建快照。
func NewSnapshot(input SnapshotInput) (Snapshot, error) {
	providerID := strings.TrimSpace(input.ProviderID)
	source := strings.TrimSpace(input.Source)
	capturedAt, capturedValid := normalizeRequiredTime(input.CapturedAt)
	if !input.AccountRef.IsValid() ||
		input.ProviderID != providerID ||
		!validIdentifier(providerID) ||
		input.Source != source ||
		!validIdentifier(source) ||
		!capturedValid ||
		len(input.Entries) == 0 ||
		len(input.Entries) > MaxEntriesPerSnapshot {
		return Snapshot{}, ErrInvalidSnapshot
	}
	entries := make([]Entry, 0, len(input.Entries))
	for _, entryInput := range input.Entries {
		entry, err := NewEntry(entryInput)
		if err != nil {
			return Snapshot{}, errors.Join(ErrInvalidSnapshot, err)
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(left int, right int) bool {
		if entries[left].LimitID() != entries[right].LimitID() {
			return entries[left].LimitID() < entries[right].LimitID()
		}
		return entries[left].Bucket() < entries[right].Bucket()
	})
	for index := 1; index < len(entries); index++ {
		if entries[index-1].LimitID() == entries[index].LimitID() &&
			entries[index-1].Bucket() == entries[index].Bucket() {
			return Snapshot{}, ErrInvalidSnapshot
		}
	}
	return Snapshot{
		accountRef: input.AccountRef,
		providerID: providerID,
		source:     source,
		capturedAt: capturedAt,
		entries:    entries,
	}, nil
}

// AccountRef 返回快照所属稳定账号身份。
func (snapshot Snapshot) AccountRef() accountcore.AccountRef {
	return snapshot.accountRef
}

// ProviderID 返回快照所属规范 Provider。
func (snapshot Snapshot) ProviderID() string {
	return snapshot.providerID
}

// Source 返回 Adapter 声明的稳定采集来源。
func (snapshot Snapshot) Source() string {
	return snapshot.source
}

// CapturedAt 返回整个快照的 UTC 毫秒采集时间。
func (snapshot Snapshot) CapturedAt() time.Time {
	return snapshot.capturedAt
}

// Entries 返回排序条目的副本。
func (snapshot Snapshot) Entries() []Entry {
	return append([]Entry(nil), snapshot.entries...)
}

// IsValid 重新检查快照身份、排序和条目不变量。
func (snapshot Snapshot) IsValid() bool {
	inputs := make([]EntryInput, 0, len(snapshot.entries))
	for _, entry := range snapshot.entries {
		inputs = append(inputs, EntryInput{
			LimitID:              entry.LimitID(),
			LimitName:            entry.LimitName(),
			Bucket:               entry.Bucket(),
			Kind:                 entry.Kind(),
			Scope:                entry.Scope(),
			ScopeKey:             entry.ScopeKey(),
			HasRemaining:         entry.hasRemaining,
			RemainingBasisPoints: entry.remainingBasisPoints,
			WindowSeconds:        entry.WindowSeconds(),
			ResetAt:              entry.ResetAt(),
			Availability:         entry.Availability(),
		})
	}
	restored, err := NewSnapshot(SnapshotInput{
		AccountRef: snapshot.accountRef,
		ProviderID: snapshot.providerID,
		Source:     snapshot.source,
		CapturedAt: snapshot.capturedAt,
		Entries:    inputs,
	})
	if err != nil || len(restored.entries) != len(snapshot.entries) {
		return false
	}
	for index := range restored.entries {
		if restored.entries[index] != snapshot.entries[index] {
			return false
		}
	}
	return true
}

// IsValid 判断额度条目类型是否受当前合同支持。
func (kind Kind) IsValid() bool {
	return kind == KindWindow || kind == KindCredits
}

// IsValid 判断额度作用域是否受当前合同支持。
func (scope Scope) IsValid() bool {
	return scope == ScopeAccount || scope == ScopeModelFamily
}

// IsValid 判断额度可用性是否属于稳定集合。
func (availability Availability) IsValid() bool {
	switch availability {
	case AvailabilityUnknown,
		AvailabilityAvailable,
		AvailabilityExhausted,
		AvailabilityUnlimited,
		AvailabilityDisabled:
		return true
	default:
		return false
	}
}

// validIdentifier 只允许可进入索引键和 API 的小写稳定标识符。
func validIdentifier(value string) bool {
	if value == "" || len(value) > maxIdentifierLength {
		return false
	}
	for index := range len(value) {
		current := value[index]
		if (current >= 'a' && current <= 'z') ||
			(current >= '0' && current <= '9') ||
			current == '_' ||
			current == '-' ||
			current == '.' ||
			current == ':' {
			continue
		}
		return false
	}
	return true
}

// validScopeKey 确保账号级不伪装模型族，模型族也不能缺少身份。
func validScopeKey(scope Scope, scopeKey string) bool {
	switch scope {
	case ScopeAccount:
		return scopeKey == ""
	case ScopeModelFamily:
		return validIdentifier(scopeKey)
	default:
		return false
	}
}

// validRemainingAvailability 确保明确百分比和可用性没有冲突。
func validRemainingAvailability(
	hasRemaining bool,
	remaining uint16,
	availability Availability,
) bool {
	if !hasRemaining {
		return remaining == 0
	}
	if remaining > 10_000 {
		return false
	}
	if remaining == 0 {
		return availability == AvailabilityExhausted
	}
	return availability == AvailabilityAvailable
}

// validKindAvailability 限制时间窗口不能出现 Credits 专属状态。
func validKindAvailability(kind Kind, availability Availability) bool {
	if kind == KindWindow {
		return availability == AvailabilityUnknown ||
			availability == AvailabilityAvailable ||
			availability == AvailabilityExhausted
	}
	return kind == KindCredits
}

// normalizeRequiredTime 统一持久化时间为 UTC 毫秒。
func normalizeRequiredTime(value time.Time) (time.Time, bool) {
	if value.IsZero() {
		return time.Time{}, false
	}
	unixMS := value.UnixMilli()
	if unixMS < 0 || unixMS > maxPersistedUnixMS {
		return time.Time{}, false
	}
	return time.UnixMilli(unixMS).UTC(), true
}

// normalizeOptionalTime 接受零值，否则复用持久化时间规则。
func normalizeOptionalTime(value time.Time) (time.Time, bool) {
	if value.IsZero() {
		return time.Time{}, true
	}
	return normalizeRequiredTime(value)
}
