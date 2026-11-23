package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/host/aihlogin"
	"github.com/madou1217/ai_home/internal/host/clilogin"
)

// runProviderLogin 执行原生 CLI 登录。
//
// 家族四支走临时 fake-home 投影；已迁移的非家族 CLI（agy）走通用 CLI 登录。
// 只支持裸 login（不带额外参数）；未迁移的 Provider 明确拒绝，不静默交给 Node。
func runProviderLogin(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	for _, argument := range arguments {
		if isRootHelp(argument) {
			writeProviderLoginUsage(runtime.stdout, providerID)
			return nil
		}
		if argument == "--no-browser" {
			// 登录进程本来就用 BROWSER 捕获脚本，不打开宿主浏览器；接受该旗标
			// 以保证 Node 旧用法原样可用。
			continue
		}
		if strings.TrimSpace(argument) != "" {
			writeProviderLoginUsage(runtime.stderr, providerID)
			return fmt.Errorf("%w: login 不接受参数", errInvalidCommand)
		}
	}
	family := codebuddyfamilystorage.IsFamilyProvider(providerID)
	if !family && !clilogin.Supported(providerID) {
		return fmt.Errorf("%w: %s 的 CLI 登录尚未迁移到 Go", errInvalidCommand, providerID)
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	hostHomeDir := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHomeDir == "" {
		hostHomeDir, err = runtime.userHomeDir()
		if err != nil {
			return err
		}
	}
	var account accountcore.Account
	var loginEnv map[string]string
	releaseEgress := func() {}
	if !family {
		loginEnv, releaseEgress, err = ensureLoginNetworkEnv(ctx, providerID, runtime, runtime.stderr)
		if err != nil {
			return err
		}
	}
	defer releaseEgress()
	if family {
		account, err = aihlogin.Run(ctx, aihlogin.Options{
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
			ProviderID:  providerID,
			Stdin:       runtime.stdin,
			Stdout:      runtime.stdout,
			Stderr:      runtime.stderr,
		})
	} else {
		account, err = clilogin.Run(ctx, clilogin.Options{
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
			ProviderID:  providerID,
			Stdin:       runtime.stdin,
			Stdout:      runtime.stdout,
			Stderr:      runtime.stderr,
			ExtraEnv:    loginEnv,
		})
	}
	if err != nil {
		if errors.Is(err, aihlogin.ErrCredentialMissing) {
			return fmt.Errorf(
				"%w（CodeBuddy 浏览器登录结果不会回传 CLI；可运行 aih %s detect 导入本机已登录账号）",
				err,
				providerID,
			)
		}
		if errors.Is(err, clilogin.ErrCredentialMissing) {
			return fmt.Errorf(
				"%w（浏览器授权完成后 CLI 应写出凭据文件；可运行 aih %s ls 确认账号是否入库）",
				err,
				providerID,
			)
		}
		return err
	}
	_, _ = fmt.Fprintf(runtime.stdout, "登录完成: %s #%d (%s)\n",
		account.ProviderID(), account.CLIAccountID().Int64(), account.Ref())
	return nil
}

func writeProviderLoginUsage(output io.Writer, providerID string) {
	_, _ = fmt.Fprintf(output, "用法:\n  aih %s login\n", providerID)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  用一次性运行目录启动官方 CLI 登录；退出后把凭据注册成账号。")
}

// ensureLoginNetworkEnv 在登录前探测授权域名；直连被拒时临时启用受管出口。
//
// 只对声明了 networkProbeURL 的 Provider 生效。出口租约在登录结束时释放；
// 没有可用出口时明确失败，不把 403 交给官方 CLI 变成难以理解的报错。
func ensureLoginNetworkEnv(
	ctx context.Context,
	providerID string,
	runtime commandRuntime,
	notify io.Writer,
) (map[string]string, func(), error) {
	probe := clilogin.ProbeURL(providerID)
	if probe == "" {
		return nil, func() {}, nil
	}
	status, reachable := probeLoginEndpoint(ctx, probe, "")
	if reachable {
		return nil, func() {}, nil
	}
	client, clientErr := managementProxyClient(runtime)
	if clientErr != nil {
		return nil, func() {}, fmt.Errorf(
			"直连 %s 不可用（%s），且无法启用受管出口：%v；可在可访问该站点的机器上完成授权",
			probe, status, clientErr,
		)
	}
	selector := strings.TrimSpace(lookupOrDefault(runtime.lookupEnv, "AIH_LOGIN_PROXY", "auto"))
	lease, leaseErr := client.Acquire(ctx, selector)
	if leaseErr != nil {
		return nil, func() {}, fmt.Errorf("直连 %s 不可用（%s），受管出口申请失败: %w", probe, status, leaseErr)
	}
	if proxyStatus, proxyOK := probeLoginEndpoint(ctx, probe, lease.URL); !proxyOK {
		lease.Release()
		return nil, func() {}, fmt.Errorf("受管出口「%s」仍无法访问 %s（%s）；请更换出口（AIH_LOGIN_PROXY）或改用其他机器授权", displayEgressName(lease.Name), probe, proxyStatus)
	}
	_, _ = fmt.Fprintf(notify, "[aih] 直连 %s 不可用（%s）；临时使用受管出口「%s」，登录结束后自动释放。\n",
		probe, status, displayEgressName(lease.Name))
	return map[string]string{
		"HTTPS_PROXY": lease.URL,
		"HTTP_PROXY":  lease.URL,
		"ALL_PROXY":   lease.URL,
	}, lease.Release, nil
}

// probeLoginEndpoint 直接或经代理访问探测地址，返回可读状态与是否可用。
func probeLoginEndpoint(ctx context.Context, target, proxy string) (string, bool) {
	transport := &http.Transport{
		Proxy:                 nil,
		TLSHandshakeTimeout:   6 * time.Second,
		ResponseHeaderTimeout: 6 * time.Second,
	}
	if strings.TrimSpace(proxy) != "" {
		if parsed, err := url.Parse(proxy); err == nil {
			transport.Proxy = http.ProxyURL(parsed)
		}
	}
	client := &http.Client{
		Timeout:   8 * time.Second,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "请求无效", false
	}
	response, err := client.Do(request)
	if err != nil {
		return "网络不可达", false
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return fmt.Sprintf("HTTP %d", response.StatusCode), response.StatusCode < 400
}
