package webuiopenappapi

import (
	"context"
	"encoding/json"
	"net"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// prepareGoCLIInvocation 保持身份 Provider 与 CLI harness 分离。Go 的账号位只接受
// 数字别名，跨 Provider 必须显式 relay <identity-provider> <id>，不能把 acct_* 当
// 原生 prompt 透传，否则会误跑账号池。环境只交给子进程，不写入命令或响应。
func prepareGoCLIInvocation(ctx context.Context, deps NativeLauncherDependencies, req Request,
	snapshot AccountSnapshot, harness, model, hostHome string, environ []string,
) ([]string, []string, *Result) {
	failure := func(code, message string) ([]string, []string, *Result) {
		return nil, nil, &Result{OK: false, Error: code, Message: message}
	}
	catalog := deps.Catalog
	if catalog == nil {
		var err error
		catalog, err = providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return failure("aih_cli_contract_unavailable", "Go CLI 合同不可用")
		}
	}
	definition, known := catalog.Get(harness)
	if !known || !definition.Clients.CLI || !webUICLIIsGoOwned(req, harness) {
		// 分流应在调用之前完成；这里仅防止内部调用绕过能力边界。
		return failure("aih_cli_contract_unavailable", "启动请求不属于当前 Go CLI 能力范围")
	}
	if snapshot.CLIAccountID <= 0 || snapshot.AccountRef.String() != strings.TrimSpace(req.AccountRef) ||
		snapshot.Provider != strings.ToLower(strings.TrimSpace(req.Provider)) {
		return failure("account_not_found", launchErrorMessage("account_not_found"))
	}
	arguments := []string{strconv.FormatInt(snapshot.CLIAccountID, 10)}
	crossProvider := harness != snapshot.Provider
	if crossProvider {
		arguments = append([]string{"relay", snapshot.Provider}, arguments...)
	}
	if model != "" {
		arguments = append(arguments, "--model", model)
	}
	intent, err := providerlaunch.ParseLaunchIntent(catalog, harness, arguments)
	if err != nil || !intent.HasPinnedAccount() || intent.RelayProviderID() != snapshot.Provider ||
		(crossProvider && intent.Mode() != providerlaunch.LaunchModeGatewayRelay) ||
		(!crossProvider && intent.Mode() != providerlaunch.LaunchModeNativeDirect) {
		return failure("aih_cli_contract_unavailable", "账号启动参数无法安全映射到 Go CLI")
	}
	environment := append([]string(nil), environ...)
	if hostHome != "" {
		environment = upsertEnvKey(environment, "AIH_HOST_HOME", hostHome)
	}
	if crossProvider {
		var configured bool
		environment, configured = populateGoCLIGatewayEnvironment(ctx, deps.AIHomeDir, environment)
		if !configured {
			return failure("aih_cli_gateway_unavailable", "跨 Provider Go CLI 需要当前 Server 的公开地址、API Key 和 Management Key")
		}
	}
	return append([]string{harness}, arguments...), environment, nil
}

// populateGoCLIGatewayEnvironment 补上旧 Node CLI 从 config:server 读取的启动环境；
// 使用既有 appstate 只读入口，绝不创建另一份配置或把密钥放到 argv。
func populateGoCLIGatewayEnvironment(ctx context.Context, aiHomeDir string, environment []string) ([]string, bool) {
	var stored struct {
		Port          int    `json:"port"`
		APIKey        string `json:"apiKey"`
		ManagementKey string `json:"managementKey"`
	}
	if path, err := appstate.DatabasePath(aiHomeDir); err == nil {
		if raw, found, readErr := appstate.ReadKV(ctx, path, "config:server"); readErr == nil && found {
			_ = json.Unmarshal([]byte(raw), &stored)
		}
	}
	// 启动环境只索引一次，避免每读一个配置键都复制整份环境 map。
	values := envSliceToMap(environment)
	get := func(name string) string { return strings.TrimSpace(firstEnvValue(values, name)) }
	set := func(name, value string) {
		environment = upsertEnvKey(environment, name, value)
		setEnvKey(values, name, value)
	}
	if get("AIH_SERVER_BASE_URL") == "" {
		port := stored.Port
		if port <= 0 || port > 65535 {
			port = 9527
		}
		set("AIH_SERVER_BASE_URL", "http://"+net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	}
	if get("AIH_SERVER_API_KEY") == "" && strings.TrimSpace(stored.APIKey) != "" {
		set("AIH_SERVER_API_KEY", stored.APIKey)
	}
	if get("AIH_SERVER_MANAGEMENT_KEY") == "" && strings.TrimSpace(stored.ManagementKey) != "" {
		set("AIH_SERVER_MANAGEMENT_KEY", stored.ManagementKey)
	}
	_, err := providerlaunch.NewGatewayEndpoint(get("AIH_SERVER_BASE_URL"), get("AIH_SERVER_API_KEY"))
	return environment, err == nil && get("AIH_SERVER_MANAGEMENT_KEY") != ""
}
