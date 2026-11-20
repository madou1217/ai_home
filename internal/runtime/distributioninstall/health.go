package distributioninstall

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/runtime/platform"
)

// serverConfigKey 是服务端配置在 aih.db KV 里的键（与 Node 同键）。
const serverConfigKey = "config:server"

type config struct {
	Port          int    `json:"port"`
	Host          string `json:"host"`
	APIKey        string `json:"apiKey"`
	ManagementKey string `json:"managementKey"`
	readError     error
}

func readConfig(home string) config {
	c := config{Port: serverconfig.DefaultPort, Host: serverconfig.DefaultHost}
	database := businessdb.Path(home)
	if _, err := os.Stat(database); err != nil {
		c.readError = fmt.Errorf("installation_config_unavailable: stat canonical database: %w", err)
		return c
	}
	raw, found, err := appstate.ReadKV(context.Background(), database, serverConfigKey)
	if err != nil {
		c.readError = fmt.Errorf("installation_config_unavailable: read canonical server configuration: %w", err)
		return c
	}
	if !found {
		// 键缺失与读库失败对安装健康检查是同一件事：没有可用的服务配置。
		c.readError = fmt.Errorf("installation_config_unavailable: read canonical server configuration: %w", sql.ErrNoRows)
		return c
	}
	candidate := c
	if json.Unmarshal([]byte(raw), &candidate) != nil {
		c.readError = fmt.Errorf("installation_config_unavailable: read canonical server configuration: %w", errors.New("installation_config_invalid"))
		return c
	}
	if strings.TrimSpace(candidate.ManagementKey) == "" {
		c.readError = fmt.Errorf("installation_config_unavailable: read canonical server configuration: %w", errors.New("management_key_missing"))
		return c
	}
	if !serverconfig.IsValidPort(candidate.Port) {
		c.readError = fmt.Errorf("installation_config_unavailable: read canonical server configuration: %w", errors.New("installation_config_port_invalid"))
		return c
	}
	candidate.Port = serverconfig.NormalizePort(candidate.Port)
	return candidate
}

func listenerPresent(port int) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err == nil {
		c.Close()
		return true
	}
	return false
}
func getLocal(ctx context.Context, c config, path string) (map[string]any, int, error) {
	client := &http.Client{Timeout: 4 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:"+strconv.Itoa(c.Port)+path, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.ManagementKey)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	var result map[string]any
	err = json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&result)
	return result, resp.StatusCode, err
}

// Busy checks running work without treating retained idle sessions as jobs.
// Unknown state on a reachable current management plane refuses an update.
func Busy(ctx context.Context, home string) (bool, string, error) {
	c := readConfig(home)
	if c.readError != nil {
		return true, "无法读取权威服务配置", c.readError
	}
	if !listenerPresent(c.Port) {
		return false, "", nil
	}
	if c.ManagementKey == "" {
		return true, "服务正在运行，无法验证是否空闲", nil
	}
	for _, endpoint := range []struct{ path, key string }{{"/v1/management/webui/tasks", "tasks"}, {"/v1/management/webui/chat/runs", "runs"}} {
		j, status, err := getLocal(ctx, c, endpoint.path)
		if err != nil {
			return true, "无法确认活跃任务", err
		}
		if status == 404 {
			continue
		}
		if status != 200 {
			return true, "无法确认活跃任务", nil
		}
		if rows, ok := j[endpoint.key].([]any); ok && len(rows) > 0 {
			return true, "仍有活跃任务或会话", nil
		}
	}
	return false, "", nil
}

func verifyStarted(ctx context.Context, o Options, b Build) error {
	c := readConfig(o.Home)
	if c.readError != nil {
		return c.readError
	}
	deadline := time.Now().Add(90 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		j, status, err := getLocal(ctx, c, "/readyz")
		if err == nil && status == 200 && j["ok"] == true {
			var id struct {
				PID          int    `json:"pid"`
				Executable   string `json:"executable"`
				BinarySHA256 string `json:"binarySha256"`
				AIHomeDir    string `json:"aiHomeDir"`
			}
			raw, e := os.ReadFile(filepath.Join(o.Home, "run", "go-server-runtime.json"))
			if e == nil && json.Unmarshal(raw, &id) == nil && id.BinarySHA256 == b.GoCore.SHA256 && filepath.Clean(id.Executable) == filepath.Clean(bundleServer(o.PackageRoot)) && filepath.Clean(id.AIHomeDir) == filepath.Clean(o.Home) && platform.ProcessAlive(id.PID) {
				if j["installation"] == "awaiting_commit" {
					return nil
				}
				a, code, e := getLocal(ctx, c, "/v0/webui/accounts")
				if e == nil && code == 200 && a["ok"] == true {
					return nil
				}
			}
		}
		last = err
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(600 * time.Millisecond):
		}
	}
	return fmt.Errorf("新版本未完成启动验证，准备恢复旧版本: %v", last)
}

func verifyRunningCommitted(ctx context.Context, o Options, b Build) error {
	c := readConfig(o.Home)
	if c.readError != nil {
		return c.readError
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		j, status, err := getLocal(ctx, c, "/v0/webui/accounts")
		if err == nil && status == 200 && j["ok"] == true {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(600 * time.Millisecond):
		}
	}
	return errors.New("更新已提交，但服务未完成业务启动；已保留当前数据和完整旧版备份，不会回退已接受的写入")
}
