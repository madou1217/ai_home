package aihserver

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/claude"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/kimi"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/opencode"
	"github.com/madou1217/ai_home/internal/transport/http/webuisetdefaultapi"
)

// buildSetDefaultHostProjection 把 config:server 与宿主目录组成 set-default 的
// HostFileProjection。没有内容构造器的 Provider 保持缺省，路由会显式 501。
func buildSetDefaultHostProjection(aiHomeDir, hostHomeDir string) webuisetdefaultapi.HostProjection {
	config := readHostProjectionServerConfig(aiHomeDir)
	targets := map[string]webuisetdefaultapi.HostFileTarget{}

	claudeTarget := webuisetdefaultapi.HostFileTarget{
		Target: aihdefault.Target{Directory: filepath.Join(hostHomeDir, ".claude"), FileName: "settings.json", Ownership: aihdefault.OwnershipClaudeEnv},
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
		Target: aihdefault.Target{Directory: filepath.Join(hostHomeDir, ".kimi-code"), FileName: "config.toml", Ownership: aihdefault.OwnershipFile},
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

func readHostProjectionModels(aiHomeDir string) []string {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil
	}
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, webuimodelssnapshot.CacheKey)
	if err != nil || !found || raw == "" {
		return nil
	}
	var snapshot struct {
		ByProvider map[string][]string `json:"byProvider"`
	}
	if json.Unmarshal([]byte(raw), &snapshot) != nil {
		return nil
	}
	seen := map[string]bool{}
	models := make([]string, 0, len(snapshot.ByProvider))
	for _, list := range snapshot.ByProvider {
		for _, model := range list {
			trimmed := strings.TrimSpace(model)
			if trimmed != "" && !seen[trimmed] {
				seen[trimmed] = true
				models = append(models, trimmed)
			}
		}
	}
	sort.Strings(models)
	return models
}

func hostWithPort(host string, port int) string {
	// 主机与端口的归一规则只在 application/serverconfig 定义一次。
	return serverconfig.NormalizeHost(host) + ":" + strconv.Itoa(serverconfig.NormalizePort(port))
}
