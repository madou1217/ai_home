package accountremoval

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// 删除占用者清单里的固定文案。与 Node 的 account-deletion-occupancy.js 保持同一
// 字面量：前端直接把 label 渲染进确认框，换一份文案就等于换了一次产品行为。
const (
	persistentSessionKind  = "persistent_session"
	persistentSessionLabel = "挂起的持久会话（tmux）"
	// killTimeout 与 Node 的 kill 调用一样按秒级超时处理：卡住的 tmux 不能拖死删除。
	killTimeout = 1500 * time.Millisecond
)

// SessionKiller 终止某个 socket 上点名的一个会话。
//
// 抽成端口是为了让「探测 → 释放 → 复探」这段可以在没有 tmux 的机器上测：生产用
// hostTmuxKiller，测试注入假实现并让假探测器跟着变状态。
type SessionKiller interface {
	KillSession(ctx context.Context, socket string, session string) error
}

// hostTmuxKiller 用宿主 tmux/psmux 杀会话。
type hostTmuxKiller struct{}

// InspectAccountDeletion 列出仍攥着目标账号凭据的持久会话。
//
// 判定逐条对齐 Node 的 PERSISTENT_SESSION 描述符：
//   - 精确会话在服务端还活着 → 占用者；
//   - 服务端不存在，或服务端活着但这份会话已经退出 → 陈旧登记，当场清掉再放行；
//   - 探测无法确认 → uncertain 占用者（不是「没人」）；
//   - 账号 socket（aih-<provider>-<acct_ref>）上还有没登记的会话 → 占用者。
//     登记漏一条不等于没人，这条比登记本身更接近事实。
func (service *Service) InspectAccountDeletion(
	ctx context.Context,
	account accountcore.Account,
) ([]accountapp.DeletionBlocker, error) {
	if service == nil || service.aiHomeDir == "" || ctx == nil || !account.IsValid() {
		return nil, ErrInvalidRequest
	}
	// 删除路由的判定要连账号 socket 上的孤儿会话一起看：登记漏一条不等于没人。
	return service.inspectAccountDeletion(ctx, account.ProviderID(), account.Ref().String(), true)
}

// ReleaseAccountDeletion 终止给定的持久会话，返回仍没释放干净的占用者。
//
// 只认「复探确认会话已经不在」为成功：kill-session 返回 0 不等于会话真的走了。
// 未释放干净的调用方必须以 409 中止删除，账号事实保持不动。
func (service *Service) ReleaseAccountDeletion(
	ctx context.Context,
	account accountcore.Account,
	blockers []accountapp.DeletionBlocker,
) error {
	if service == nil || service.aiHomeDir == "" || ctx == nil || !account.IsValid() {
		return ErrInvalidRequest
	}
	if len(blockers) == 0 {
		return nil
	}
	entries, err := service.readRegistryEntries()
	if err != nil {
		// 登记读不到就无法判断哪些条目要跟着删；会话已经杀掉了，登记留着
		// 最多让下一次删除再判一次，不能因此把删除判成「有会话在跑」。
		entries = nil
	}
	killer := service.killer
	if killer == nil {
		killer = hostTmuxKiller{}
	}
	failed := make([]accountapp.DeletionBlocker, 0, len(blockers))
	for _, blocker := range blockers {
		if err := ctx.Err(); err != nil {
			return err
		}
		// 探测不确定时不做破坏性动作：宁可如实报原因，也不要猜一个会话去杀。
		if blocker.Uncertain || !safeRegistryKey(blocker.Socket) || !safeRegistryKey(blocker.Session) {
			failed = append(failed, blocker)
			continue
		}
		_ = killer.KillSession(ctx, blocker.Socket, blocker.Session)
		// 复探以事实为准：还在就继续 fail-closed。
		snapshot, probeErr := service.probe.Probe(ctx, blocker.Socket)
		if probeErr != nil {
			failed = append(failed, blocker)
			continue
		}
		if snapshot.ServerAlive && containsName(snapshot.Sessions, blocker.Session) {
			failed = append(failed, blocker)
			continue
		}
		removeSessionEntries(entries, blocker.Socket, blocker.Session)
	}
	if len(failed) > 0 {
		return &accountapp.RuntimeActiveError{Blockers: failed}
	}
	return nil
}

// inspectAccountDeletion 是探测的唯一实现：provider 为空表示只按账号引用匹配。
//
// includeAccountSocket 区分两份语义不同的 Node 合同：
//   - 删除路由的占用者上报要连账号 socket 上的孤儿会话一起看（Node 的
//     account-deletion-occupancy.js）；
//   - 删库前的会话写者校验只看登记（Node 的 account-removal.js），
//     不看账号 socket 上有没有别的会话。
func (service *Service) inspectAccountDeletion(
	ctx context.Context,
	provider string,
	accountRef string,
	includeAccountSocket bool,
) ([]accountapp.DeletionBlocker, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := service.readRegistryEntries()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", accountapp.ErrAccountRuntimeUnverifiable, err)
	}
	matching := make([]sessionEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Gateway || entry.AccountRef != accountRef {
			continue
		}
		if provider != "" && entry.Provider != provider {
			continue
		}
		matching = append(matching, entry)
	}

	probes := make(map[string]probeState, len(matching)+1)
	blockers := make([]accountapp.DeletionBlocker, 0, len(matching))
	for _, entry := range matching {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		state, cached := probes[entry.Socket]
		if !cached {
			state = service.probeSocket(ctx, entry.Socket)
			probes[entry.Socket] = state
		}
		if state.err != nil {
			// 探测失败是「不知道」，与「有人在跑」同样阻塞删除，但原因不同：
			// uncertain 让调用方如实上报，而不是提示用户去强杀。
			blockers = append(blockers, accountapp.DeletionBlocker{
				Kind:       persistentSessionKind,
				Label:      persistentSessionLabel,
				Provider:   entry.Provider,
				AccountRef: entry.AccountRef,
				Session:    entry.Session,
				Socket:     entry.Socket,
				Detail:     state.err.Error(),
				Uncertain:  true,
			})
			continue
		}
		if state.serverAlive && containsSession(state.names, entry.Session) {
			blockers = append(blockers, accountapp.DeletionBlocker{
				Kind:       persistentSessionKind,
				Label:      persistentSessionLabel,
				Provider:   entry.Provider,
				AccountRef: entry.AccountRef,
				Session:    entry.Session,
				Socket:     entry.Socket,
			})
			continue
		}
		// 陈旧登记：服务端不存在，或服务端存活但这份会话已经退出。
		// 删除失败不阻塞账号删除（与 Node 的 removeEntry 一致），最坏只是下次再判一次。
		_ = os.Remove(entry.filePath)
	}

	if includeAccountSocket {
		blockers = append(
			blockers,
			service.inspectAccountSocket(ctx, provider, accountRef, matching, probes)...,
		)
	}
	if len(blockers) == 0 {
		return nil, nil
	}
	return blockers, nil
}

// inspectAccountSocket 检查账号 socket 上有没有登记之外的会话。
//
// 账号 socket 是账号私有的；登记漏一条不能当成「没有占用」，否则删除会漏掉一个
// 攥着凭据的进程，而用户带 force 重试也永远杀不掉它——所以这里必须和宿主清理
// 看到同一份事实。
func (service *Service) inspectAccountSocket(
	ctx context.Context,
	provider string,
	accountRef string,
	matching []sessionEntry,
	probes map[string]probeState,
) []accountapp.DeletionBlocker {
	socket := canonicalSocket(provider, accountRef)
	if socket == "" {
		return nil
	}
	state, cached := probes[socket]
	if !cached {
		state = service.probeSocket(ctx, socket)
		probes[socket] = state
	}
	// 没有 tmux 引擎就没有服务端，也就没有可核对的会话（与 Node 的
	// 「if (canonical && tmux.available)」一致）：这里只核对登记，不报 uncertain。
	if state.err != nil || !state.serverAlive {
		return nil
	}
	blockers := make([]accountapp.DeletionBlocker, 0, len(state.names))
	for session := range state.names {
		registered := false
		for _, entry := range matching {
			if entry.Socket == socket && entry.Session == session {
				registered = true
				break
			}
		}
		if registered {
			continue
		}
		blockers = append(blockers, accountapp.DeletionBlocker{
			Kind:         persistentSessionKind,
			Label:        persistentSessionLabel,
			Provider:     provider,
			AccountRef:   accountRef,
			Session:      session,
			Socket:       socket,
			Unregistered: true,
		})
	}
	return blockers
}

// probeSocket 缓存一次探测结果。探测失败把 error 留在状态里，调用方按「不知道」处理。
func (service *Service) probeSocket(ctx context.Context, socket string) probeState {
	snapshot, err := service.probe.Probe(ctx, socket)
	state := probeState{err: err}
	if err != nil {
		return state
	}
	state.serverAlive = snapshot.ServerAlive
	state.names = make(map[string]struct{}, len(snapshot.Sessions))
	for _, name := range snapshot.Sessions {
		state.names[name] = struct{}{}
	}
	return state
}

// canonicalSocket 复刻 Node 的 deriveSocket：一个账号一个 socket。
// 只接受安全字符集，非法输入返回空串（调用方跳过 socket 核对）。
func canonicalSocket(provider string, accountRef string) string {
	if !safeRegistryKey(provider) || !safeRegistryKey(accountRef) {
		return ""
	}
	return "aih-" + provider + "-" + accountRef
}

// removeSessionEntries 删掉 (socket, session) 对应的全部登记文件。
func removeSessionEntries(entries []sessionEntry, socket string, session string) {
	for _, entry := range entries {
		if entry.Socket != socket || entry.Session != session {
			continue
		}
		if strings.TrimSpace(entry.filePath) == "" {
			continue
		}
		_ = os.Remove(entry.filePath)
	}
}

func containsSession(names map[string]struct{}, session string) bool {
	if names == nil {
		return false
	}
	_, found := names[session]
	return found
}

// containsName 判断探测结果里有没有点名会话。
func containsName(names []string, session string) bool {
	for _, name := range names {
		if name == session {
			return true
		}
	}
	return false
}

// KillSession 用宿主 tmux/psmux 杀掉点名会话；调用方以复探结果为准。
func (hostTmuxKiller) KillSession(ctx context.Context, socket string, session string) error {
	if !safeRegistryKey(socket) || !safeRegistryKey(session) {
		return errors.New("持久会话 socket 或会话名不安全")
	}
	command, err := lookTmux()
	if err != nil {
		return err
	}
	killCtx, cancel := context.WithTimeout(ctx, killTimeout)
	defer cancel()
	return exec.CommandContext(
		killCtx,
		command,
		"-u",
		"-L",
		socket,
		"kill-session",
		"-t",
		session,
	).Run()
}

var (
	_ accountapp.DeletionOccupancy = (*Service)(nil)
	_ SessionKiller                = hostTmuxKiller{}
)
