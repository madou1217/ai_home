package pluginruntime

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
)

const dialTimeout = 3 * time.Second

// HostInvoker 按注册表里的宿主地址与令牌懒连接 Plugin Host，实现应用层的 Invoker 端口。
//
// 宿主重启或连接断开后，下一次调用重新拨号；宿主地址或令牌变化（Node 推送了新的接入信息）
// 时关闭旧连接。已经发出的调用失败不重试——插件可能已经执行过。
type HostInvoker struct {
	registry *appplugins.Registry
	mu       sync.Mutex
	client   *Client
	host     appplugins.HostAccess
}

// NewHostInvoker 创建共享一条连接的调用器（客户端本身支持并发调用）。
func NewHostInvoker(registry *appplugins.Registry) *HostInvoker {
	return &HostInvoker{registry: registry}
}

func (invoker *HostInvoker) connection(ctx context.Context) (*Client, error) {
	host := invoker.registry.Host()
	if host.Address == "" || host.Token == "" {
		return nil, &Error{Code: "plugin_runtime_inactive", Message: "没有可用的插件宿主"}
	}
	invoker.mu.Lock()
	defer invoker.mu.Unlock()
	if invoker.client != nil && !invoker.client.Closed() && invoker.host == host {
		return invoker.client, nil
	}
	if invoker.client != nil {
		_ = invoker.client.Close()
		invoker.client = nil
	}
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	client, err := Dial(dialCtx, host.Address, DialOptions{Token: host.Token})
	if err != nil {
		return nil, err
	}
	invoker.client, invoker.host = client, host
	return client, nil
}

// Invoke 调用指定代次的一个贡献项，返回 handler 的 JSON 结果。
func (invoker *HostInvoker) Invoke(
	ctx context.Context,
	generation int64,
	contributionID string,
	value any,
	timeout time.Duration,
) (json.RawMessage, error) {
	client, err := invoker.connection(ctx)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := client.Call(callCtx, "invoke", map[string]any{
		"generation":     generation,
		"contributionId": contributionID,
		"value":          value,
	}, nil)
	if err != nil {
		return nil, err
	}
	return result.Value, nil
}

// Close 关闭当前连接。
func (invoker *HostInvoker) Close() error {
	invoker.mu.Lock()
	defer invoker.mu.Unlock()
	if invoker.client == nil {
		return nil
	}
	err := invoker.client.Close()
	invoker.client = nil
	return err
}
