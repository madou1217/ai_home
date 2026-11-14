package chatruntime

import (
	"context"
	"net/http"
	"os/exec"
	"strings"
)

type codexScopedTurnClient interface {
	BindTurnScoped(context.Context, string, CodexTurnBinding) (*CodexTurnHandle, error)
}

// CodexTurnHandle 精确定位一代绑定。断连后仍能撤销旧队列事件，不误伤同名新绑定。
type CodexTurnHandle struct {
	client       *CodexAppServerClient
	cmd          *exec.Cmd
	threadID     string
	registration *codexTurnRegistration
}

func (handle *CodexTurnHandle) Unbind() {
	if handle == nil {
		return
	}
	handle.registration.active.Store(false)
	c := handle.client
	c.mu.Lock()
	if c.bindings[handle.threadID] == handle.registration {
		delete(c.bindings, handle.threadID)
	}
	idle := c.idleObserverLocked()
	c.mu.Unlock()
	if idle != nil {
		idle()
	}
}

func (handle *CodexTurnHandle) Release(ctx context.Context) error {
	if handle == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		// 未发起上游释放仍必须完成本地精确清理，不能留下 inactive 的池所有者。
		handle.Unbind()
		return err
	}
	handle.registration.active.Store(false)
	handle.client.mu.Lock()
	cmd := handle.registration.cmd
	handle.client.mu.Unlock()
	ctx = context.WithValue(ctx, codexRPCConnectionKey{}, cmd)
	err := handle.client.releaseThread(ctx, handle.threadID, true, handle.registration)
	if err != nil {
		handle.Unbind()
	}
	return err
}

// BindTurnScoped 只绑定已就绪的连接；release-in-progress 先在锁外有界等待。
func (c *CodexAppServerClient) BindTurnScoped(ctx context.Context, threadID string, binding CodexTurnBinding) (*CodexTurnHandle, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()
	cmd, scoped := ctx.Value(codexRPCConnectionKey{}).(*exec.Cmd)
	if !scoped {
		if err := c.EnsureConnected(ctx); err != nil {
			return nil, err
		}
		c.mu.Lock()
		if !c.ready || !c.connected || c.closed || c.retiring {
			c.mu.Unlock()
			return nil, NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
		}
		cmd = c.cmd
		c.mu.Unlock()
	}
	return c.bindTurn(ctx, cmd, threadID, binding)
}

// BindTurn 保留旧接口；新 driver 必须保留 scoped handle 才能精确解绑旧代次。
func (c *CodexAppServerClient) BindTurn(threadID string, binding CodexTurnBinding) {
	_, err := c.BindTurnScoped(context.Background(), threadID, binding)
	if err != nil && binding.OnDisconnected != nil {
		binding.OnDisconnected(err)
	}
}

func (c *CodexAppServerClient) bindTurn(ctx context.Context, cmd *exec.Cmd, threadID string, binding CodexTurnBinding) (*CodexTurnHandle, error) {
	id := strings.TrimSpace(threadID)
	if id == "" {
		return nil, NewError("codex_thread_id_required", http.StatusBadRequest, nil)
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		if c.closed || c.retiring || !c.ready || c.cmd != cmd {
			c.mu.Unlock()
			return nil, NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
		}
		if release := c.releases[id]; release != nil {
			c.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release.done:
			}
			if release.err != nil {
				return nil, release.err
			}
			continue
		}
		if old := c.bindings[id]; old != nil {
			old.active.Store(false)
		}
		registration := &codexTurnRegistration{binding: binding, cmd: cmd}
		registration.active.Store(true)
		c.bindings[id] = registration
		c.mu.Unlock()
		return &CodexTurnHandle{client: c, cmd: cmd, threadID: id, registration: registration}, nil
	}
}

// UnbindTurn 为旧调用方保留当前绑定的清理；跨代 cleanup 使用 handle.Unbind。
func (c *CodexAppServerClient) UnbindTurn(threadID string) {
	id := strings.TrimSpace(threadID)
	c.mu.Lock()
	if binding := c.bindings[id]; binding != nil {
		binding.active.Store(false)
		delete(c.bindings, id)
	}
	idle := c.idleObserverLocked()
	c.mu.Unlock()
	if idle != nil {
		idle()
	}
}
