package aihserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/claude"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/kimi"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/opencode"
	"github.com/madou1217/ai_home/internal/transport/http/webuisetdefaultapi"
)

// hostProjectionDBTimeout 限制 set-default 装配时的只读查询等待。
// 装配发生在管理请求内，不能因为库被占用而无限阻塞。
const hostProjectionDBTimeout = 1500 * time.Millisecond

// buildSetDefaultHostProjection 把 config:server 与宿主目录组成 set-default 的
// HostFileProjection。没有内容构造器的 Provider 保持缺省，路由会显式 501。
func buildSetDefaultHostProjection(aiHomeDir, hostHomeDir string) webuisetdefaultapi.HostProjection {
	config := readHostProjectionServerConfig(aiHomeDir)
	targets := map[string]webuisetdefaultapi.HostFileTarget{}

	claudeTarget := webuisetdefaultapi.HostFileTarget{
		Target: aihdefault.Target{Directory: filepath.Join(hostHomeDir, providerroot.ConfigDir("claude")), FileName: "settings.json", Ownership: aihdefault.OwnershipClaudeEnv},
	}
	claudeTarget.BuildAccount = func(ref accountcore.AccountRef) aihdefault.BuildContent {
		return func(current string, _ bool) (string, error) {
			out, err := claude.DefaultLandingPayload(claude.ServerConfig{
				Host: config.Host, Port: config.Port, APIKey: config.APIKey, ClientKey: config.ClientKey,
			}, ref.String(), []byte(current))
			return string(out), err
		}
	}
	claudeTarget.BuildGateway = func(current string, _ bool) (string, error) {
		out, err := claude.DefaultLandingPayload(claude.ServerConfig{
			Host: config.Host, Port: config.Port, APIKey: config.APIKey, ClientKey: config.ClientKey,
		}, "", []byte(current))
		return string(out), err
	}
	targets["claude"] = claudeTarget

	// Codex uses the transactional Host adapter below; never a config-only projection.

	opencodeDir := filepath.Join(hostHomeDir, ".config", "opencode")
	opencodeFile := "opencode.json"
	if info, err := os.Stat(filepath.Join(opencodeDir, "opencode.jsonc")); err == nil && !info.IsDir() {
		opencodeFile = "opencode.jsonc"
	}
	opencodeModels := readHostProjectionModels(aiHomeDir)
	opencodeTarget := webuisetdefaultapi.HostFileTarget{
		Target: aihdefault.Target{Directory: opencodeDir, FileName: opencodeFile, Ownership: aihdefault.OwnershipFile},
	}
	opencodeTarget.BuildGateway = opencode.BuildGatewayContent(opencode.Gateway{
		Server: opencode.ServerConfig{Host: config.Host, Port: config.Port, APIKey: config.APIKey, ClientKey: config.ClientKey},
		Models: opencodeModels,
	})
	targets["opencode"] = opencodeTarget

	kimiTarget := webuisetdefaultapi.HostFileTarget{
		Target: aihdefault.Target{Directory: filepath.Join(hostHomeDir, providerroot.ConfigDir("kimi")), FileName: "config.toml", Ownership: aihdefault.OwnershipFile},
	}
	kimiBuild := kimi.BuildGatewayContent(kimi.ServerConfig{Host: config.Host, Port: config.Port, APIKey: config.APIKey, ClientKey: config.ClientKey})
	kimiTarget.BuildGateway = kimiBuild
	targets["kimi"] = kimiTarget

	projection := webuisetdefaultapi.HostFileProjection{Targets: targets}
	return webuisetdefaultapi.HostProjection{SelectAccount: projection.SelectAccount, LandGateway: projection.LandGateway, Transaction: codexDefaultProjection{aiHome: aiHomeDir, hostHome: hostHomeDir}}
}

type hostProjectionServerConfig struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	APIKey    string `json:"apiKey"`
	ClientKey string `json:"clientKey"`
}

func readHostProjectionServerConfig(aiHomeDir string) hostProjectionServerConfig {
	config := hostProjectionServerConfig{Host: serverconfig.DefaultHost, Port: serverconfig.DefaultPort}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return config
	}
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, appstate.KeyServerConfig)
	if err != nil || !found {
		return config
	}
	var stored hostProjectionServerConfig
	if json.Unmarshal([]byte(raw), &stored) != nil {
		return config
	}
	if stored.Host != "" {
		config.Host = stored.Host
	}
	if stored.Port > 0 {
		config.Port = stored.Port
	}
	config.APIKey = stored.APIKey
	config.ClientKey = stored.ClientKey
	return config
}

// readHostProjectionModels 返回网关可路由的全部模型，供 opencode 网关档的
// models 列表使用。
//
// 来源是 account_models 的有效行（与 /v1/management/webui/openai-models/catalog
// 同源）。曾经这里读 app_kv 的 cache:webui-models-snapshot.json——那是 Node 时代
// 遗留的缓存键，Go 侧只有 reader 没有 writer，实测停更在 11-19，比 account_models
// 落后两天，会漏掉新探测到的模型。
//
// opencode 的网关内容构造器在模型列表为空时失败关闭（ErrModelsUnavailable），
// 因此这里宁可返回空也不要返回过期列表：过期列表会让用户选到已经被上游移除的模型。
func readHostProjectionModels(aiHomeDir string) []string {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), hostProjectionDBTimeout)
	defer cancel()
	database, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return nil
	}
	defer func() { _ = database.Close() }()
	rows, err := database.QueryContext(ctx, `
		SELECT DISTINCT m.model_id AS model_id
		  FROM account_models m
		  JOIN accounts a ON a.account_ref = m.account_ref
		 WHERE a.enabled = 1
		   AND (m.manual_policy = 'force_enable'
		        OR (m.manual_policy = 'inherit' AND m.upstream_available = 1))`)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	seen := map[string]bool{}
	models := make([]string, 0, 256)
	for rows.Next() {
		var modelID string
		if scanErr := rows.Scan(&modelID); scanErr != nil {
			continue
		}
		trimmed := strings.TrimSpace(modelID)
		if trimmed != "" && !seen[trimmed] {
			seen[trimmed] = true
			models = append(models, trimmed)
		}
	}
	sort.Strings(models)
	return models
}

func hostWithPort(host string, port int) string {
	// 主机与端口的归一规则只在 application/serverconfig 定义一次。
	return serverconfig.NormalizeHost(host) + ":" + strconv.Itoa(serverconfig.NormalizePort(port))
}
