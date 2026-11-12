package aihserver

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strconv"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/claude"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/codex"
	"github.com/madou1217/ai_home/internal/host/aihdefault/content/kimi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisetdefaultapi"
)

// buildSetDefaultHostProjection 把 config:server 与宿主目录组成 set-default 的
// HostFileProjection。没有内容构造器的 Provider 保持缺省，路由会显式 501。
func buildSetDefaultHostProjection(aiHomeDir, hostHomeDir string) webuisetdefaultapi.HostProjection {
	config := readHostProjectionServerConfig(aiHomeDir)
	targets := map[string]webuisetdefaultapi.HostFileTarget{}

	claudeTarget := webuisetdefaultapi.HostFileTarget{
		Target: aihdefault.Target{Directory: filepath.Join(hostHomeDir, ".claude"), FileName: "settings.json", Ownership: aihdefault.OwnershipFile},
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

	baseURL := "http://" + hostWithPort(config.Host, config.Port) + "/v1"
	codexTarget := webuisetdefaultapi.HostFileTarget{
		Target: aihdefault.Target{Directory: filepath.Join(hostHomeDir, ".codex"), FileName: "config.toml", Ownership: aihdefault.OwnershipFile},
	}
	codexBuild := func(current string, _ bool) (string, error) {
		return codex.Patch(current, codex.Spec{BaseURL: baseURL})
	}
	codexTarget.BuildAccount = func(accountcore.AccountRef) aihdefault.BuildContent { return codexBuild }
	codexTarget.BuildGateway = codexBuild
	targets["codex"] = codexTarget

	kimiTarget := webuisetdefaultapi.HostFileTarget{
		Target: aihdefault.Target{Directory: filepath.Join(hostHomeDir, ".kimi-code"), FileName: "config.toml", Ownership: aihdefault.OwnershipFile},
	}
	kimiBuild := kimi.BuildGatewayContent(kimi.ServerConfig{Host: config.Host, Port: config.Port, APIKey: config.APIKey, ClientKey: config.ClientKey})
	kimiTarget.BuildGateway = kimiBuild
	targets["kimi"] = kimiTarget

	projection := webuisetdefaultapi.HostFileProjection{Targets: targets}
	return webuisetdefaultapi.HostProjection{SelectAccount: projection.SelectAccount, LandGateway: projection.LandGateway}
}

type hostProjectionServerConfig struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	APIKey    string `json:"apiKey"`
	ClientKey string `json:"clientKey"`
}

func readHostProjectionServerConfig(aiHomeDir string) hostProjectionServerConfig {
	config := hostProjectionServerConfig{Host: "127.0.0.1", Port: 9527}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return config
	}
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, "config:server")
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

func hostWithPort(host string, port int) string {
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if port <= 0 || port > 65535 {
		port = 9527
	}
	return host + ":" + strconv.Itoa(port)
}
