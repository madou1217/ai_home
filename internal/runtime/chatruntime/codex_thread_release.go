package chatruntime

import (
	"context"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

const codexThreadReleaseTimeout = 12 * time.Second

type codexThreadRelease struct {
	done     chan struct{}
	closed   chan struct{}
	observed bool
	err      error
}

// ReleaseThread 仅释放空闲线程；活跃绑定必须先明确结束，不能静默中止进行中的 turn。
func (c *CodexAppServerClient) ReleaseThread(ctx context.Context, threadID string) error {
	return c.releaseThread(ctx, threadID, false, nil)
}

// UnbindAndReleaseThread 原子交接绑定与释放操作所有权，池不会在两者之间关掉连接。
func (c *CodexAppServerClient) UnbindAndReleaseThread(ctx context.Context, threadID string) error {
	return c.releaseThread(ctx, threadID, true, nil)
}

func (c *CodexAppServerClient) releaseThread(ctx context.Context, threadID string, unbind bool, expected *codexTurnRegistration) error {
	id := strings.TrimSpace(threadID)
	if id == "" {
		return NewError("codex_thread_id_required", http.StatusBadRequest, nil)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	scoped, hasScope := ctx.Value(codexRPCConnectionKey{}).(*exec.Cmd)
	if hasScope && scoped != c.cmd {
		c.mu.Unlock()
		return NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	if binding := c.bindings[id]; binding != nil {
		if expected != nil && binding != expected {
			c.mu.Unlock()
			return NewError("codex_thread_binding_superseded", http.StatusConflict, nil)
		}
		if !unbind {
			c.mu.Unlock()
			return NewError("codex_thread_release_not_idle", http.StatusConflict, nil)
		}
		binding.active.Store(false)
		delete(c.bindings, id)
	}
	release := c.releases[id]
	if release == nil {
		if !c.connected || !c.ready || c.closed || c.retiring {
			c.mu.Unlock()
			return NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
		}
		if len(c.releases) >= maxCodexPendingRequests {
			c.mu.Unlock()
			return NewError("codex_thread_releases_full", http.StatusTooManyRequests, nil)
		}
		release = &codexThreadRelease{done: make(chan struct{}), closed: make(chan struct{})}
		c.releases[id] = release
		cmd, disconnected := c.cmd, c.connectionDone
		// 一个活动线程最多一个有限时释放任务；调用方取消不取消其他释放等待者。
		go c.completeThreadRelease(cmd, disconnected, id, release)
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-release.done:
		return release.err
	}
}

func (c *CodexAppServerClient) completeThreadRelease(cmd *exec.Cmd, disconnected <-chan struct{}, id string, release *codexThreadRelease) {
	ctx, cancel := context.WithTimeout(context.Background(), codexThreadReleaseTimeout)
	defer cancel()
	response, err := c.requestConnected(ctx, cmd, "thread/unsubscribe", map[string]any{"threadId": id})
	if err == nil {
		switch asString(response["status"]) {
		case "notLoaded", "notSubscribed":
		case "unsubscribed":
			select {
			case <-release.closed:
			case <-disconnected:
				err = NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
			case <-ctx.Done():
				err = ctx.Err()
			}
		default:
			err = NewError("codex_thread_release_invalid_response", http.StatusBadGateway, nil)
		}
	}
	// 超时后 unsubscribe 是否执行已不确定，不能放行同连接的重新绑定。
	// 关闭这一代连接，把未知释放结果变成明确终态，而不是重用可能仍有写锁的线程。
	if err != nil {
		_ = c.disconnectConnection(cmd, err, false)
	}
	c.mu.Lock()
	if c.releases[id] == release {
		delete(c.releases, id)
		release.err = err
		close(release.done)
	}
	err = release.err
	idle := c.idleObserverLocked()
	c.mu.Unlock()
	if err != nil && c.opts.DiagnosticSink != nil {
		c.opts.DiagnosticSink(map[string]any{"code": "codex_thread_release_failed", "threadId": id})
	}
	if idle != nil {
		idle()
	}
}

func (c *CodexAppServerClient) observeThreadClosedLocked(threadID string) {
	if release := c.releases[threadID]; release != nil && !release.observed {
		release.observed = true
		close(release.closed)
	}
}

func (c *CodexAppServerClient) failThreadReleasesLocked(reason error) {
	for id, release := range c.releases {
		release.err = reason
		delete(c.releases, id)
		close(release.done)
	}
}

// retireIfIdle 与 Bind/连接发布共用状态锁：回收决策后不能再登记新所有者。
// 这里只关闸，实际 Close/Wait 由池在锁外执行。
func (c *CodexAppServerClient) retireIfIdle() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.bindings) > 0 || len(c.releases) > 0 || c.connecting != nil || c.recovery != nil {
		return false
	}
	c.retiring = true
	return true
}

func (c *CodexAppServerClient) setIdleObserver(observer func()) {
	c.mu.Lock()
	c.onIdle = observer
	c.mu.Unlock()
}

func (c *CodexAppServerClient) idleObserverLocked() func() {
	if len(c.bindings) == 0 && c.recovery != nil {
		c.recovery.cancel()
	}
	if len(c.bindings) == 0 && len(c.releases) == 0 && c.connecting == nil && c.recovery == nil {
		return c.onIdle
	}
	return nil
}
