package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/proxyingress"
)

// serveLease 把远端 AIH 代理租约变成本机 HTTP/SOCKS5 入口。
// 入口凭据沿用租约令牌；上游认证由 proxyingress 写入 CONNECT/绝对形式请求。
type serveLease struct {
	id            string
	name          string
	username      string
	password      string
	httpURL       string
	socksURL      string
	ingress       *proxyingress.Ingress
	systemIngress *proxyingress.Ingress
	dial          proxyingress.Dial
	client        *providerProxyClient
	once          sync.Once
	closeErr      error
}

func acquireServeLease(ctx context.Context, runtime commandRuntime, selector string, socks5 bool) (*serveLease, error) {
	client, err := newProviderProxyClient(runtime)
	if err != nil {
		return nil, err
	}
	resolved, err := client.selector(ctx, selector)
	if err != nil {
		return nil, err
	}
	var response struct {
		OK       bool   `json:"ok"`
		ID       string `json:"id"`
		Name     string `json:"name"`
		ProxyURL string `json:"proxyUrl"`
	}
	if err := client.call(ctx, http.MethodPost, providerProxyAPI, map[string]string{"selector": resolved}, &response); err != nil {
		return nil, err
	}
	if !response.OK || response.ID == "" || len(response.ID) > 256 || strings.ContainsAny(response.ID, "/\\\r\n\x00") {
		return nil, errors.New("代理 lease 响应无效")
	}
	proxy, parseErr := url.Parse(response.ProxyURL)
	if parseErr != nil || proxy == nil || proxy.Scheme != "http" || proxy.User == nil {
		return nil, errors.New("代理 lease 未返回有效的认证入口")
	}
	username := proxy.User.Username()
	password, hasPassword := proxy.User.Password()
	if username == "" || !hasPassword || password == "" {
		return nil, errors.New("代理 lease 未返回有效的认证入口")
	}
	lease := &serveLease{id: response.ID, name: response.Name, username: username, password: password, client: client}
	lease.dial = func(dialCtx context.Context) (io.ReadWriteCloser, error) {
		return client.connect(dialCtx, lease.id)
	}
	ingress, ingressErr := proxyingress.Start(ctx, proxyingress.Config{
		Credentials: proxyingress.Credentials{Username: username, Password: password},
		HTTP:        true,
		SOCKS5:      socks5,
		Dial:        lease.dial,
	})
	if ingressErr != nil {
		_ = lease.releaseRemote()
		return nil, fmt.Errorf("无法建立本机代理入口: %w", ingressErr)
	}
	lease.ingress = ingress
	lease.httpURL = ingress.HTTPURL()
	lease.socksURL = ingress.SOCKS5URL()
	return lease, nil
}

func (lease *serveLease) HTTPAddress() string {
	if lease == nil || lease.ingress == nil {
		return ""
	}
	return lease.ingress.HTTPAddress()
}

// startSystemIngress 为系统代理启动一个仅 loopback、匿名 HTTP 入口。
// 系统代理无法可靠保存每个应用的凭据；上游仍使用租约令牌认证。
func (lease *serveLease) startSystemIngress(ctx context.Context) (string, error) {
	if lease == nil {
		return "", errors.New("代理 lease 不可用")
	}
	if lease.systemIngress == nil {
		ingress, err := proxyingress.Start(ctx, proxyingress.Config{
			Credentials:    proxyingress.Credentials{Username: lease.username, Password: lease.password},
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

func (lease *serveLease) releaseRemote() error {
	if lease == nil || lease.client == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return lease.client.call(ctx, http.MethodDelete, providerProxyAPI+"/"+url.PathEscape(lease.id), nil, nil)
}
