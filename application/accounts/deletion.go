package accounts

import (
	"context"
	"errors"
	"fmt"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidDeletionDependencies 表示删除用例缺少持久化或派生状态清理端口。
	ErrInvalidDeletionDependencies = errors.New("账号删除依赖无效")
	// ErrInvalidDeletionRequest 表示删除上下文或稳定账号身份无效。
	ErrInvalidDeletionRequest = errors.New("账号删除请求无效")
	// ErrAccountRuntimeActive 表示精确持久会话仍在使用目标账号。
	ErrAccountRuntimeActive = errors.New("账号存在活跃运行时")
	// ErrAccountRuntimeUnverifiable 表示存在会话登记但无法可靠确认写入者已经退出。
	ErrAccountRuntimeUnverifiable = errors.New("账号运行时状态无法确认")
	// ErrAccountDeletionPreparationFailed 表示 Provider 资源或敏感投影无法安全收敛。
	ErrAccountDeletionPreparationFailed = errors.New("账号删除前资源无法安全收敛")
	// ErrAccountHostCleanupFailed 表示宿主清理通道不可用或拒绝执行。
	// 与 ErrAccountRuntimeActive 区分：这不是「有会话在跑」，而是「没问到/问不了」。
	ErrAccountHostCleanupFailed = errors.New("账号宿主清理失败")
)

// DeletionBlocker 描述一个仍攥着目标账号凭据的运行时占用者。
//
// 字段名与 Node 的占用者描述符一致（occupants[]）：Node 的删除路由原本在
// lib/server/account-deletion-occupancy.js 里产出这份形状，前端按 kind/label/
// session/detail 渲染「谁在占用、强杀会终止什么」。Go 承接后必须逐字段保持同一
// 形状，否则前端的确认框会退化成一行没有信息的「该账号仍被占用」。
type DeletionBlocker struct {
	Kind       string `json:"kind"`
	Label      string `json:"label"`
	Provider   string `json:"provider,omitempty"`
	AccountRef string `json:"accountRef,omitempty"`
	Session    string `json:"session,omitempty"`
	Socket     string `json:"socket,omitempty"`
	Detail     string `json:"detail,omitempty"`
	// Uncertain 表示探测本身失败（不是「探测到有人」）：调用方只能如实上报，
	// 不能当成可强杀的占用者。
	Uncertain bool `json:"uncertain,omitempty"`
	// Unregistered 表示会话只出现在账号 socket 上、没有对应登记。
	Unregistered bool `json:"unregistered,omitempty"`
}

// RuntimeActiveError 是「账号仍被占用」的结构化错误。
//
// 它必须能被 errors.Is 判成 ErrAccountRuntimeActive：管理面 HTTP 映射与 CLI
// 仍按 ErrAccountRuntimeActive 决定 409，额外的占用者清单只用于把原因说清楚。
type RuntimeActiveError struct {
	// Blockers 是本次探测到的全部占用者；Release 失败时是没杀掉的子集。
	Blockers []DeletionBlocker
}

// Error 只描述数量；具体占用者由 HTTP 层写进 occupants。
func (err *RuntimeActiveError) Error() string {
	if err == nil {
		return ErrAccountRuntimeActive.Error()
	}
	return fmt.Sprintf("%s: %d 个占用者", ErrAccountRuntimeActive, len(err.Blockers))
}

// Unwrap 让 errors.Is(err, ErrAccountRuntimeActive) 继续成立。
func (err *RuntimeActiveError) Unwrap() error {
	return ErrAccountRuntimeActive
}

// DeletionStore 是账号删除用例需要的最小持久化端口。
type DeletionStore interface {
	// GetByRef 读取删除准备阶段需要的稳定 Provider 身份。
	GetByRef(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.Account, error)
	// DeleteAccount 删除账号主记录及其持久化从属数据。
	DeleteAccount(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) error
}

// DeletionPreparation 在账号事实仍可读取时收敛 Provider 资源并清理敏感凭据投影。
//
// 实现必须幂等；任何不能证明安全完成的情况都应返回错误，使数据库删除失败关闭。
type DeletionPreparation interface {
	PrepareAccountDeletion(
		ctx context.Context,
		account accountcore.Account,
	) error
}

// DeletionOccupancy 探测并释放仍持有目标账号的运行时。
//
// 两段的语义必须分开：
//   - Inspect 只读，返回全部占用者；探测无法确认时返回错误（fail-closed）；
//   - Release 只在调用方明确要求强制删除时执行，返回错误表示仍没释放干净。
//
// 实现必须把「探测不到」与「探测到没人」分开：前者不能返回空清单，否则删除
// 会在状态未知时静默放行。
type DeletionOccupancy interface {
	InspectAccountDeletion(
		ctx context.Context,
		account accountcore.Account,
	) ([]DeletionBlocker, error)
	ReleaseAccountDeletion(
		ctx context.Context,
		account accountcore.Account,
		blockers []DeletionBlocker,
	) error
}

// DeletionCleanup 遗忘删除账号派生出的非持久化状态。
//
// 实现必须幂等且不失败，避免账号事实已提交后返回伪失败。
type DeletionCleanup interface {
	ForgetAccount(accountRef accountcore.AccountRef)
}

// DeletionHostCleanup 在账号删除事务前后调用只有宿主进程具备的清理能力。
//
// 这条通道只服务「宿主语义仍在 Node」的部署（管理面 DELETE 与 Node 同步链路）。
// WebUI 删除已由 Go 自己探测并释放宿主运行时，装配的是 nil：它不该再为了
// tmux/socket 反向调用 Node。
//
// 两段的语义必须分开：
//   - BeforeDelete 在提交前跑，失败即中止删除（账号事实还在，可原样重试）；
//   - AfterDelete 在提交后跑，实现必须幂等且不得重建账号；它的错误只用于诊断，
//     不能覆盖已经提交的删除事实。
type DeletionHostCleanup interface {
	BeforeDelete(ctx context.Context, account accountcore.Account) error
	AfterDelete(ctx context.Context, account accountcore.Account) error
}

// GrantRevocation 是回收宿主直连授权的结果，字段与 Node 的 hostGrantRevoke 一致。
type GrantRevocation struct {
	OK bool `json:"ok"`
	// Revoked 表示宿主上确实存在本账号的直连授权并被回收。
	Revoked bool `json:"revoked"`
	// DefaultProfileUpdated 表示这条回收链已经把默认档位落到 AIH Server。
	DefaultProfileUpdated bool   `json:"defaultProfileUpdated"`
	Reason                string `json:"reason,omitempty"`
	Message               string `json:"message,omitempty"`
}

// DeletionHostGrant 回收账号在宿主上的直连授权（Node: revokeHostGrant 钩子）。
//
// 返回错误表示「回收不完整」；调用方只记录、不因此判定删除失败——账号事实
// 删除后重试只会得到 404，把残留当成失败会让用户永远删不掉。
type DeletionHostGrant interface {
	RevokeHostGrant(
		ctx context.Context,
		account accountcore.Account,
	) (GrantRevocation, error)
}

// ServerDefaultLanding 是「默认账号未指定 ⇒ 落回 AIH Server」的结果。
type ServerDefaultLanding struct {
	OK            bool   `json:"ok"`
	Landed        bool   `json:"landed"`
	AlreadyLanded bool   `json:"alreadyLanded,omitempty"`
	Provider      string `json:"provider,omitempty"`
	Profile       string `json:"profile,omitempty"`
	Reason        string `json:"reason,omitempty"`
}

// DeletionServerDefault 读写 Provider 的默认账号与 AIH Server 档位。
//
// IsDefaultAccount 必须在删除提交前调用：账号行删掉之后无法再判断它是不是默认。
type DeletionServerDefault interface {
	IsDefaultAccount(
		ctx context.Context,
		providerID string,
		accountRef accountcore.AccountRef,
	) (bool, error)
	LandServerDefault(
		ctx context.Context,
		providerID string,
	) (ServerDefaultLanding, error)
}

// DeletionOptions 是单次删除的调用选项。
type DeletionOptions struct {
	// Force 表示调用方已确认终止占用者：探测到占用时先释放再删除。
	Force bool
}

// DeletionOutcome 是一次删除的可观测结果。
//
// HostGrantRevoke 为 nil 表示该 Provider 没有宿主授权钩子（Node 侧同样返回
// null 而不是空对象）；ServerDefault 始终有值，形状与 Node 的 aihServerDefault 一致。
type DeletionOutcome struct {
	Account         accountcore.Account
	HostGrantRevoke *GrantRevocation
	ServerDefault   ServerDefaultLanding
}

// Deleter 编排账号持久化删除、宿主授权回收与派生状态清理。
type Deleter struct {
	store         DeletionStore
	occupancy     DeletionOccupancy
	prepare       DeletionPreparation
	hostCleanup   DeletionHostCleanup
	hostGrant     DeletionHostGrant
	serverDefault DeletionServerDefault
	cleanups      []DeletionCleanup
}

// NewDeleter 创建不装配宿主清理与宿主投影的账号删除用例。
func NewDeleter(
	store DeletionStore,
	occupancy DeletionOccupancy,
	preparation DeletionPreparation,
	cleanups ...DeletionCleanup,
) (*Deleter, error) {
	return NewDeleterWithHostCleanup(store, occupancy, preparation, nil, cleanups...)
}

// NewDeleterWithHostCleanup 在 NewDeleter 之上装配宿主清理通道。
//
// hostCleanup 允许为 nil：WebUI 删除（Go 自己探测并释放宿主运行时）与没有
// Node 宿主的独立部署都属于这种装配。
func NewDeleterWithHostCleanup(
	store DeletionStore,
	occupancy DeletionOccupancy,
	preparation DeletionPreparation,
	hostCleanup DeletionHostCleanup,
	cleanups ...DeletionCleanup,
) (*Deleter, error) {
	if store == nil || occupancy == nil || preparation == nil || len(cleanups) == 0 {
		return nil, ErrInvalidDeletionDependencies
	}
	for _, cleanup := range cleanups {
		if cleanup == nil {
			return nil, ErrInvalidDeletionDependencies
		}
	}
	return &Deleter{
		store:       store,
		occupancy:   occupancy,
		prepare:     preparation,
		hostCleanup: hostCleanup,
		cleanups:    append([]DeletionCleanup(nil), cleanups...),
	}, nil
}

// WithHostProjection 装配「回收宿主直连授权」与「默认账号落点」两个端口。
//
// 两者都允许缺省：没有该能力的 Provider 保持 nil，删除照常进行；缺省的含义是
// 「这个部署没有宿主投影」，不是「投影失败」。
func (deleter *Deleter) WithHostProjection(
	hostGrant DeletionHostGrant,
	serverDefault DeletionServerDefault,
) *Deleter {
	if deleter == nil {
		return deleter
	}
	deleter.hostGrant = hostGrant
	deleter.serverDefault = serverDefault
	return deleter
}

// DeleteAccount 是管理面 DELETE 的入口：不接受强制删除，只返回错误。
func (deleter *Deleter) DeleteAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	_, err := deleter.DeleteAccountWithOptions(ctx, accountRef, DeletionOptions{})
	return err
}

// DeleteAccountWithOptions 先确认账号可删，再提交唯一持久化事实，最后清理派生状态。
//
// 顺序是这份实现的核心不变量：
//  1. 探测占用者（只读）。有占用且调用方未确认强制删除 → RuntimeActiveError，
//     账号事实**完全没动**，用户可以关掉会话再试；
//  2. 强制删除时先释放占用者。释放不掉就中止，绝不带着写入者删库；
//  3. 回收宿主直连授权。必须早于删库：此时账号凭据记录还在，能按上游地址判定
//     宿主上到底有没有本账号的授权；
//  4. 宿主写入者必须先停下（BeforeDelete）。此刻账号事实还在，失败可以原样重试；
//     反过来先删库再发现停不下进程，就只剩下攥着已删凭据的孤儿了；
//  5. 收敛 Provider 资源与敏感投影，然后才删库；
//  6. 删库成功后再遗忘内存派生状态。提交后的失败只能是残留，不能返回伪失败；
//  7. 默认账号落点。删掉的是默认账号时必须落到 AIH Server，否则裸跑 CLI 会
//     回落到「没有默认」的直连态。
func (deleter *Deleter) DeleteAccountWithOptions(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	options DeletionOptions,
) (DeletionOutcome, error) {
	var outcome DeletionOutcome
	if deleter == nil ||
		deleter.store == nil ||
		deleter.occupancy == nil ||
		deleter.prepare == nil ||
		len(deleter.cleanups) == 0 ||
		ctx == nil ||
		!accountRef.IsValid() {
		return outcome, ErrInvalidDeletionRequest
	}
	if err := ctx.Err(); err != nil {
		return outcome, err
	}
	account, err := deleter.store.GetByRef(ctx, accountRef)
	if err != nil {
		return outcome, err
	}
	if !account.IsValid() || account.Ref() != accountRef {
		return outcome, ErrInvalidDeletionRequest
	}
	outcome.Account = account

	blockers, err := deleter.occupancy.InspectAccountDeletion(ctx, account)
	if err != nil {
		return outcome, err
	}
	if len(blockers) > 0 {
		if !options.Force {
			return outcome, &RuntimeActiveError{Blockers: blockers}
		}
		if err := deleter.occupancy.ReleaseAccountDeletion(ctx, account, blockers); err != nil {
			return outcome, err
		}
	}

	// 默认账号判定必须早于删库：账号行消失之后就无从判断「删掉的是不是默认」。
	wasDefault := false
	if deleter.serverDefault != nil {
		// 读失败不阻断删除：与 Node 一致，最坏只是不落 AIH Server 档位。
		if isDefault, readErr := deleter.serverDefault.IsDefaultAccount(
			ctx,
			account.ProviderID(),
			account.Ref(),
		); readErr == nil {
			wasDefault = isDefault
		}
	}

	if deleter.hostGrant != nil {
		revocation, revokeErr := deleter.hostGrant.RevokeHostGrant(ctx, account)
		if revokeErr != nil {
			// 回收不完整不阻断删除：账号事实删掉之后重试只会得到 404，
			// 把残留当成失败会让这个账号永远删不掉。
			revocation = GrantRevocation{
				OK:      false,
				Revoked: false,
				Reason:  "host_grant_revoke_failed",
				Message: revokeErr.Error(),
			}
		}
		outcome.HostGrantRevoke = &revocation
	}

	if deleter.hostCleanup != nil {
		if err := deleter.hostCleanup.BeforeDelete(ctx, account); err != nil {
			return outcome, err
		}
	}
	if err := deleter.prepare.PrepareAccountDeletion(ctx, account); err != nil {
		return outcome, err
	}
	if err := deleter.store.DeleteAccount(ctx, accountRef); err != nil {
		return outcome, err
	}
	for _, cleanup := range deleter.cleanups {
		cleanup.ForgetAccount(accountRef)
	}
	outcome.ServerDefault = deleter.landServerDefault(ctx, account, wasDefault, outcome.HostGrantRevoke)
	if deleter.hostCleanup != nil {
		// 账号事实已经提交：这里的失败只能是「宿主残留没清干净」，不能返回错误
		// 让调用方以为删除失败（重试只会得到 404，还会把已删账号当成待处理对象）。
		// 用 WithoutCancel 保住清理机会：客户端断连不该让残留留在机器上。
		_ = deleter.hostCleanup.AfterDelete(context.WithoutCancel(ctx), account)
	}
	return outcome, nil
}

// landServerDefault 复刻 Node 删除路由的落点判定，语义逐条对齐：
//
//   - 宿主授权回收链已经把档位写成功（revoked 且 defaultProfileUpdated）→ 不重复落点；
//   - 删掉的不是默认账号 → 不动档位；
//   - 删掉的是默认账号 → 落到 AIH Server。
func (deleter *Deleter) landServerDefault(
	ctx context.Context,
	account accountcore.Account,
	wasDefault bool,
	revocation *GrantRevocation,
) ServerDefaultLanding {
	if landedByRevoke(revocation) {
		return ServerDefaultLanding{
			OK:     true,
			Landed: false,
			Reason: "landed_with_host_grant_revoke",
		}
	}
	if !wasDefault || deleter.serverDefault == nil {
		return ServerDefaultLanding{
			OK:     true,
			Landed: false,
			Reason: "no_default_change",
		}
	}
	landing, err := deleter.serverDefault.LandServerDefault(
		context.WithoutCancel(ctx),
		account.ProviderID(),
	)
	if err != nil {
		return ServerDefaultLanding{
			OK:     false,
			Landed: false,
			Reason: "server_default_landing_failed",
		}
	}
	return landing
}

// landedByRevoke 与 Node 的 landedByRevoke 同义：授权回收链已经落过档位。
func landedByRevoke(revocation *GrantRevocation) bool {
	if revocation == nil {
		return false
	}
	return revocation.Revoked && revocation.DefaultProfileUpdated
}
