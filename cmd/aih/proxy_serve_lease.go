package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/managementproxy"
	"github.com/madou1217/ai_home/internal/runtime/proxyingress"
)

// serveLease 把远端 AIH 代理租约变成本机 HTTP/SOCKS5 入口。
// 入口凭据沿用租约令牌；上游认证由 proxyingress 写入 CONNECT/绝对形式请求。
type serveLease struct {
	mu            sync.Mutex
	id            string
	name          string
	username      string
	password      string
	httpURL       string
	socksURL      string
	ingress       *proxyingress.Ingress
	systemIngress *proxyingress.Ingress
	anonymous     bool
	dial          proxyingress.Dial
	client        *managementproxy.Client
	// inPlace means this entry can swap upstream credentials/dial without
	// closing listeners; the failing dial waits for that swap and retries once.
	inPlace bool
	// lost 由 dial 在 Server 明确丢弃租约（404/410）时投递一次，主循环立即
	// 换出口；否则要等到下一次 30 分钟续期，浏览器会持续看到 502。
	lost chan error
	// 单条失败连接的重试协调：同一轮失效只触发一次换出口，所有等待者共享
	// 同一个完成信号。
	recoverMu  sync.Mutex
	recoverCh  chan struct{}
	recoverErr error
	once       sync.Once
	closeErr   error
}

func acquireServeLease(ctx context.Context, runtime commandRuntime, selector string, socks5 bool, httpPort, socksPort int, anonymous, httpPortSet, socksPortSet bool, inPlace bool) (*serveLease, error) {
	client, err := managementProxyClient(runtime)
	if err != nil {
		return nil, err
	}
	raw, err := client.LeaseWorking(ctx, selector, 8)
	if err != nil {
		return nil, err
	}
	proxy, parseErr := url.Parse(raw.ProxyURL)
	if parseErr != nil || proxy == nil || proxy.Scheme != "http" || proxy.User == nil {
		return nil, errors.New("代理 lease 未返回有效的认证入口")
	}
	username := proxy.User.Username()
	password, hasPassword := proxy.User.Password()
	if username == "" || !hasPassword || password == "" {
		return nil, errors.New("代理 lease 未返回有效的认证入口")
	}
	lease := &serveLease{
		id: raw.ID, name: raw.Name, username: username, password: password,
		anonymous: anonymous, client: client, inPlace: inPlace,
		lost: make(chan error, 1),
	}
	lease.dial = func(dialCtx context.Context) (io.ReadWriteCloser, error) {
		stream, dialErr := client.Connect(dialCtx, lease.leaseID())
		if dialErr == nil {
			return stream, nil
		}
		if dialCtx.Err() != nil {
			// The caller went away; this is not an upstream failure.
			return nil, dialErr
		}
		// Any failure to establish the upstream stream means the bridge is
		// down. Notify the main loop immediately: with hot swap off it closes
		// the listeners (fail closed); with hot swap on it retries the same
		// selector in place and this request waits once for that recovery.
		select {
		case lease.lost <- dialErr:
		default:
		}
		if !lease.inPlace {
			return nil, dialErr
		}
		if waitErr := lease.waitRecovered(dialCtx); waitErr != nil {
			return nil, dialErr
		}
		return client.Connect(dialCtx, lease.leaseID())
	}
	startIngress := func(httpListen, socksListen string) (*proxyingress.Ingress, error) {
		return proxyingress.Start(ctx, proxyingress.Config{
			Credentials:        proxyingress.Credentials{Username: username, Password: password},
			HTTP:               true,
			SOCKS5:             socks5,
			AllowAnonymous:     anonymous,
			HTTPListenAddress:  httpListen,
			SOCKSListenAddress: socksListen,
			Dial:               lease.dial,
		})
	}
	listenAddress := func(port int) string {
		if port <= 0 {
			return ""
		}
		return fmt.Sprintf("127.0.0.1:%d", port)
	}
	ingress, ingressErr := startIngress(listenAddress(httpPort), listenAddress(socksPort))
	if ingressErr != nil {
		// 默认端口被别的程序占用时回退随机端口；显式指定的端口必须让用户看到冲突。
		if httpPortSet || socksPortSet {
			_ = lease.releaseRemote()
			return nil, fmt.Errorf("代理入口端口不可用（请换端口或停止占用进程）: %w", ingressErr)
		}
		httpPort, socksPort = 0, 0
		ingress, ingressErr = startIngress("", "")
	}
	if ingressErr != nil {
		_ = lease.releaseRemote()
		return nil, fmt.Errorf("无法建立本机代理入口: %w", ingressErr)
	}
	lease.ingress = ingress
	lease.httpURL = ingress.HTTPURL()
	lease.socksURL = ingress.SOCKS5URL()
	return lease, nil
}

func (lease *serveLease) leaseID() string {
	lease.mu.Lock()
	defer lease.mu.Unlock()
	return lease.id
}

func (lease *serveLease) leaseName() string {
	lease.mu.Lock()
	defer lease.mu.Unlock()
	return lease.name
}

// refresh acquires a new lease for the same selector and swaps the ingress
// upstream in place. Listeners, ports, TUN and published URLs stay unchanged.
func (lease *serveLease) refresh(ctx context.Context, selector string) error {
	if lease == nil || lease.client == nil || lease.ingress == nil {
		return errors.New("代理 lease 不可用")
	}
	raw, err := lease.client.Lease(ctx, selector)
	if err != nil {
		return err
	}
	username, password, err := credentialsFromProxyURL(raw.ProxyURL)
	if err != nil {
		lease.client.Release(raw.ID)
		return err
	}
	credentials := proxyingress.Credentials{Username: username, Password: password}
	if err := lease.ingress.UpdateUpstream(credentials, lease.dial); err != nil {
		lease.client.Release(raw.ID)
		return err
	}
	if lease.systemIngress != nil {
		if err := lease.systemIngress.UpdateUpstream(credentials, lease.dial); err != nil {
			lease.client.Release(raw.ID)
			return err
		}
	}
	lease.mu.Lock()
	oldID := lease.id
	lease.id = raw.ID
	lease.name = raw.Name
	lease.username = username
	lease.password = password
	lease.mu.Unlock()
	if oldID != "" && oldID != raw.ID {
		go lease.client.Release(oldID)
	}
	return nil
}

// waitRecovered blocks until the current recovery round finishes. Concurrent
// failing connections share one round, so a burst does not rotate repeatedly.
func (lease *serveLease) waitRecovered(ctx context.Context) error {
	lease.recoverMu.Lock()
	if lease.recoverCh == nil {
		lease.recoverCh = make(chan struct{})
		lease.recoverErr = nil
	}
	done := lease.recoverCh
	lease.recoverMu.Unlock()
	select {
	case <-done:
		lease.recoverMu.Lock()
		err := lease.recoverErr
		lease.recoverMu.Unlock()
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(15 * time.Second):
		return errors.New("上游切换超时")
	}
}

// finishRecovery completes the current round. A nil error means the new
// upstream is ready and waiting dials may retry.
func (lease *serveLease) finishRecovery(err error) {
	lease.recoverMu.Lock()
	defer lease.recoverMu.Unlock()
	if lease.recoverCh == nil {
		return
	}
	lease.recoverErr = err
	close(lease.recoverCh)
	lease.recoverCh = nil
}

func credentialsFromProxyURL(raw string) (string, string, error) {
	proxy, err := url.Parse(raw)
	if err != nil || proxy == nil || proxy.Scheme != "http" || proxy.User == nil {
		return "", "", errors.New("代理 lease 未返回有效的认证入口")
	}
	username := proxy.User.Username()
	password, hasPassword := proxy.User.Password()
	if username == "" || !hasPassword || password == "" {
		return "", "", errors.New("代理 lease 未返回有效的认证入口")
	}
	return username, password, nil
}

// keepAlive 在租约到期前续租；失败时通过 onError 通知主命令退出。
func (lease *serveLease) keepAlive(ctx context.Context, interval time.Duration, onError func(error)) {
	if interval <= 0 {
		interval = 30 * time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			renewCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := lease.client.Renew(renewCtx, lease.leaseID())
			cancel()
			if err != nil {
				onError(err)
				return
			}
		}
	}
}

func (lease *serveLease) HTTPAddress() string {
	if lease == nil || lease.ingress == nil {
		return ""
	}
	return lease.ingress.HTTPAddress()
}

// watchLeaseLoss forwards the first explicit lease-loss signal to the main
// loop. It is independent of the renewal interval: a browser request can
// discover the loss at any time.
func (lease *serveLease) watchLeaseLoss(ctx context.Context, onError func(error)) {
	select {
	case <-ctx.Done():
		return
	case err := <-lease.lost:
		if err != nil {
			onError(err)
		}
	}
}

func (lease *serveLease) credentials() proxyingress.Credentials {
	lease.mu.Lock()
	defer lease.mu.Unlock()
	return proxyingress.Credentials{Username: lease.username, Password: lease.password}
}

// startSystemIngress 为系统代理启动一个仅 loopback、匿名 HTTP 入口。
// 系统代理无法可靠保存每个应用的凭据；上游仍使用租约令牌认证。
func (lease *serveLease) startSystemIngress(ctx context.Context) (string, error) {
	if lease == nil {
		return "", errors.New("代理 lease 不可用")
	}
	// 匿名入口本身就是 loopback 无凭据的，系统代理直接复用同一入口。
	if lease.anonymous {
		return lease.HTTPAddress(), nil
	}
	if lease.systemIngress == nil {
		ingress, err := proxyingress.Start(ctx, proxyingress.Config{
			Credentials:    lease.credentials(),
			HTTP:           true,
			AllowAnonymous: true,
			Dial:           lease.dial,
		})
		if err != nil {
			return "", err
		}
		lease.systemIngress = ingress
	}
	return lease.systemIngress.HTTPAddress(), nil
}

func (lease *serveLease) Close() error {
	if lease == nil {
		return nil
	}
	lease.once.Do(func() {
		var errs []error
		if lease.systemIngress != nil {
			if err := lease.systemIngress.Close(); err != nil {
				errs = append(errs, err)
			}
		}
		if lease.ingress != nil {
			if err := lease.ingress.Close(); err != nil {
				errs = append(errs, err)
			}
		}
		if err := lease.releaseRemote(); err != nil {
			errs = append(errs, err)
		}
		lease.closeErr = errors.Join(errs...)
	})
	return lease.closeErr
}

// releaseRemote 释放远端租约。managementproxy.Release 自带独立超时，
// 因此调用方的取消不会把释放漏掉。
func (lease *serveLease) releaseRemote() error {
	if lease == nil || lease.client == nil {
		return nil
	}
	lease.client.Release(lease.leaseID())
	return nil
}
