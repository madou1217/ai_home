package accountruntime

import (
	"errors"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ErrInvalidAccountBlock 表示账号级阻塞的账号、类型、作用域或时间无效。
var ErrInvalidAccountBlock = errors.New("账号运行态阻塞无效")

const maxAccountBlockReasonLength = 500

// AccountBlockInput 是一条账号级失败阻塞的完整输入。
type AccountBlockInput struct {
	AccountRef accountcore.AccountRef
	Kind       FailureKind
	Scope      BlockScope
	Reason     string
	ObservedAt time.Time
	Until      time.Time
}

// AccountBlock 是构造后不可变的账号级阻塞事实。
type AccountBlock struct {
	accountRef accountcore.AccountRef
	kind       FailureKind
	scope      BlockScope
	reason     string
	observedAt time.Time
	until      time.Time
}

// NewAccountBlock 复用 BlockDirective 校验失败类型与作用域的合法组合。
func NewAccountBlock(input AccountBlockInput) (AccountBlock, error) {
	if !input.AccountRef.IsValid() {
		return AccountBlock{}, ErrInvalidAccountBlock
	}
	policy, err := PolicyFor(input.Kind)
	if err != nil {
		return AccountBlock{}, ErrInvalidAccountBlock
	}
	if input.Scope != BlockScopeAccount && input.Scope != BlockScopeAccountModel {
		return AccountBlock{}, ErrInvalidAccountBlock
	}
	// 硬阻塞必须能绑定解除信号；限流这类冷却只要求类型与作用域合法。
	if policy.BlocksRouting() {
		if _, err := NewBlockDirective(input.Kind, input.Scope); err != nil {
			return AccountBlock{}, ErrInvalidAccountBlock
		}
	}
	reason := strings.TrimSpace(input.Reason)
	if len(reason) > maxAccountBlockReasonLength {
		return AccountBlock{}, ErrInvalidAccountBlock
	}
	observedAt, observedValid := normalizeBlockTime(input.ObservedAt)
	until, untilValid := normalizeBlockTime(input.Until)
	if !observedValid || !untilValid || !until.After(observedAt) {
		return AccountBlock{}, ErrInvalidAccountBlock
	}
	return AccountBlock{
		accountRef: input.AccountRef,
		kind:       input.Kind,
		scope:      input.Scope,
		reason:     reason,
		observedAt: observedAt,
		until:      until,
	}, nil
}

// AccountRef 返回阻塞所属账号。
func (block AccountBlock) AccountRef() accountcore.AccountRef { return block.accountRef }

// Kind 返回失败类型。
func (block AccountBlock) Kind() FailureKind { return block.kind }

// Scope 返回阻塞作用域。
func (block AccountBlock) Scope() BlockScope { return block.scope }

// Reason 返回阻塞原因。
func (block AccountBlock) Reason() string { return block.reason }

// ObservedAt 返回观察时间。
func (block AccountBlock) ObservedAt() time.Time { return block.observedAt }

// Until 返回冷却截止时间。
func (block AccountBlock) Until() time.Time { return block.until }

// IsValid 重新校验跨层传递后的不可变阻塞。
func (block AccountBlock) IsValid() bool {
	restored, err := NewAccountBlock(AccountBlockInput{
		AccountRef: block.accountRef,
		Kind:       block.kind,
		Scope:      block.scope,
		Reason:     block.reason,
		ObservedAt: block.observedAt,
		Until:      block.until,
	})
	return err == nil && restored == block
}

func normalizeBlockTime(value time.Time) (time.Time, bool) {
	if value.IsZero() {
		return time.Time{}, false
	}
	unixMS := value.UnixMilli()
	if unixMS < 0 || unixMS > 253_402_300_799_999 {
		return time.Time{}, false
	}
	return time.UnixMilli(unixMS).UTC(), true
}
