package aihcli

// 本文件把「生效 Codex 配置如何提供受管 Provider 凭据」翻译成启动策略的端口实现。
//
// Codex ≥0.149 禁止 [model_providers.aih_server.auth] 命令表与 env_key 并存，
// 因此 Gateway 启动参数必须跟随配置事实。事实来源只有一处：子进程实际读取的
// CODEX_HOME/config.toml（宿主默认由 aih codex default / 服务端投影写入 auth 表）。

import (
	"os"

	"github.com/madou1217/ai_home/internal/adapters/codex/clilaunch"
	"github.com/madou1217/ai_home/internal/runtime/codexhostauth"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

// codexManagedProviderAuth 读取宿主 Codex 配置声明的凭据机制。
type codexManagedProviderAuth struct {
	// hostHomeDir 是启动子进程使用的主目录（CODEX_HOME 未显式指定时的配置根）。
	hostHomeDir string
	// lookupEnv 读取显式 CODEX_HOME；为空时读取进程环境。
	lookupEnv func(string) (string, bool)
}

// ManagedProviderAuth 实现 clilaunch.ManagedProviderAuthSource。
func (source codexManagedProviderAuth) ManagedProviderAuth() clilaunch.ManagedProviderAuth {
	if codexConfigDeclaresAuthCommand(source.configPath()) {
		return clilaunch.ManagedProviderAuthCommand
	}
	return clilaunch.ManagedProviderAuthEnvKey
}

// configPath 返回子进程实际读取的 config.toml。
//
// 显式 CODEX_HOME 优先（子进程环境完整继承），否则 <hostHome>/.codex。
// 该解析与启动时的受管认证命令自愈共享同一入口，避免两处对「生效配置」判断漂移。
func (source codexManagedProviderAuth) configPath() string {
	lookup := source.lookupEnv
	if lookup == nil {
		lookup = os.LookupEnv
	}
	return codexhostauth.ConfigPath(source.hostHomeDir, lookup)
}

// codexConfigDeclaresAuthCommand 判断配置是否声明了受管 Provider 的 auth 命令。
//
// 读取失败或语法不完整按「未声明」处理：此时保持 env_key 形态，与裸配置一致；
// 配置若有 auth 表但解析失败，Codex 本身也会拒绝启动，报错仍然可见。
func codexConfigDeclaresAuthCommand(configPath string) bool {
	if configPath == "" {
		return false
	}
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return false
	}
	statements, err := providerconfigs.ScanTOMLStatements(string(raw))
	if err != nil {
		return false
	}
	for _, statement := range statements {
		if declaresManagedProviderAuth(statement) {
			return true
		}
	}
	return false
}

// declaresManagedProviderAuth 识别显式子表与内联赋值两种 auth 声明形态。
func declaresManagedProviderAuth(statement providerconfigs.TOMLStatement) bool {
	path := statement.Keys
	if !statement.Table {
		path = append(append([]string(nil), statement.TablePath...), statement.Keys...)
	}
	if len(path) != 3 ||
		path[0] != "model_providers" ||
		path[1] != clilaunch.ManagedProviderKey ||
		path[2] != "auth" {
		return false
	}
	return true
}
