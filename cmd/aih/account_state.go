package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountSetEnabled 通过 Go Server 管理面提交账号启停和内存路由变化。
func runAccountSetEnabled(
	ctx context.Context,
	target aihaccount.AccountTarget,
	enabled bool,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	accountRef, err := resolveManagementAccountRef(ctx, client, target)
	if err != nil {
		return fmt.Errorf("解析 Server 账号目标失败: %w", err)
	}
	result, err := client.SetEnabled(ctx, accountRef, enabled)
	if err != nil {
		return fmt.Errorf("更新 Server 账号状态失败: %w", err)
	}
	writeAccountStateResult(runtime.stdout, result)
	return nil
}

// newAccountManagementClient 使用统一 Server 根地址和管理凭据创建出站适配器。
func newAccountManagementClient(
	runtime commandRuntime,
) (*managementapi.Client, error) {
	return newAccountManagementClientWithTimeout(runtime, 0)
}

// newAccountManagementClientWithTimeout 为慢接口（额度刷新要打上游）放宽超时；
// 0 表示沿用组合根的默认客户端。
func newAccountManagementClientWithTimeout(
	runtime commandRuntime,
	timeout time.Duration,
) (*managementapi.Client, error) {
	managementKey, found := runtime.lookupEnv("AIH_SERVER_MANAGEMENT_KEY")
	if !found || strings.TrimSpace(managementKey) == "" {
		return nil, fmt.Errorf(
			"%w: Go 账号管理命令需要 AIH_SERVER_MANAGEMENT_KEY",
			errInvalidCommand,
		)
	}
	httpClient := runtime.managementAPI
	if timeout > 0 {
		httpClient = &http.Client{Timeout: timeout}
	}
	client, err := managementapi.New(
		httpClient,
		managementapi.Config{
			BaseURL:       resolveManagementBaseURL(runtime),
			ManagementKey: managementKey,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("初始化账号管理 API 失败: %w", err)
	}
	return client, nil
}

// resolveManagementAccountRef 保持 AccountRef 直达，数字别名只在目标 Server 解析。
func resolveManagementAccountRef(
	ctx context.Context,
	client *managementapi.Client,
	target aihaccount.AccountTarget,
) (accountcore.AccountRef, error) {
	if target.AccountRef != "" {
		return accountcore.ParseAccountRef(target.AccountRef)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(target.CLIAccountID)
	if err != nil {
		return "", err
	}
	result, err := client.ResolveAlias(ctx, target.ProviderID, cliAccountID)
	if err != nil {
		return "", err
	}
	return result.AccountRef, nil
}

// writeAccountStateResult 输出 Server 已提交的最小无敏感账号状态。
func writeAccountStateResult(
	output io.Writer,
	result managementapi.AccountSnapshot,
) {
	if result.Enabled {
		_, _ = fmt.Fprintln(output, "账号已启用。")
	} else {
		_, _ = fmt.Fprintln(output, "账号已停用。")
	}
	writeAccountDetailField(output, "Provider", result.ProviderID)
	writeAccountDetailField(output, "账号别名", result.CLIAccountID.String())
	writeAccountDetailField(output, "AccountRef", result.AccountRef.String())
	writeAccountDetailField(output, "用户状态", accountEnabledLabel(result.Enabled))
	writeAccountDetailField(output, "更新时间", accountTimeLabel(result.UpdatedAt))
}

// writeAccountStateUsage 说明启停命令必须和运行中 Server 共用一个账号事实。
func writeAccountStateUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account enable <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output, "  aih account disable <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  通过运行中的 Go Server Management API 原子更新 accounts.enabled。")
	_, _ = fmt.Fprintln(output, "  Server 在同一进程立即维护账号模型正排、倒排和 /v1/models 快照。")
	_, _ = fmt.Fprintln(output, "  重复 enable/disable 是幂等操作；不访问 Provider、不读取或输出凭据正文。")
	_, _ = fmt.Fprintln(output, "  provider:id 由目标 Server 解析，不使用本地数据库猜测远程账号身份。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_BASE_URL（默认 http://127.0.0.1:9527）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（必填）")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "API:")
	_, _ = fmt.Fprintln(output, "  GET   /v1/management/account-aliases/{provider}/{id}")
	_, _ = fmt.Fprintln(output, "  PATCH /v1/management/accounts/{account_ref}  {\"enabled\":true|false}")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih account disable claude:1")
	_, _ = fmt.Fprintln(output, "  aih account enable acct_0123456789abcdef0123")
}

// resolveManagementBaseURL 选择本次管理请求真正可达的 Server 地址。
//
// 历史上 Go Core 在 19550，Node 公开面在 9527；切到前置门后 Go 直接持有公开
// 端口，19550 不再监听。AIH_SERVER_ALT_BASE_URL 由 bin 按 Server 配置的公开端口
// 填入，只在主地址连不上时才启用，避免多探一次网络影响正常路径。
func resolveManagementBaseURL(runtime commandRuntime) string {
	primary := lookupOrDefault(
		runtime.lookupEnv,
		"AIH_SERVER_BASE_URL",
		defaultGatewayBaseURL,
	)
	alternate := strings.TrimSpace(lookupOrDefault(
		runtime.lookupEnv,
		"AIH_SERVER_ALT_BASE_URL",
		"",
	))
	if alternate == "" || managementEndpointReachable(primary) {
		return primary
	}
	if managementEndpointReachable(alternate) {
		return alternate
	}
	return primary
}

// managementEndpointReachable 只做一次短超时 TCP 探测，不发送管理请求。
func managementEndpointReachable(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Host == "" {
		return false
	}
	host := parsed.Host
	if !strings.Contains(host, ":") {
		host += ":80"
		if parsed.Scheme == "https" {
			host = parsed.Host + ":443"
		}
	}
	connection, err := net.DialTimeout("tcp", host, 250*time.Millisecond)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}
