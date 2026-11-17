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

	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"github.com/madou1217/ai_home/internal/runtime/platform"
	_ "modernc.org/sqlite"
)

type config struct {
	Port          int    `json:"port"`
	Host          string `json:"host"`
	APIKey        string `json:"apiKey"`
	ManagementKey string `json:"managementKey"`
	readError     error
}

func readConfig(home string) config {
	c := config{Port: 9527, Host: "127.0.0.1"}
	// A retained legacy seal is never a fallback for an existing canonical store.
	// Only installations that have not created aih.db may use pre-cutover config.
	_, canonicalErr := os.Lstat(businessdb.Path(home))
	legacyInstallation := errors.Is(canonicalErr, os.ErrNotExist)
	if canonicalErr != nil && !legacyInstallation {
		c.readError = fmt.Errorf("installation_config_unavailable: stat canonical database: %w", canonicalErr)
		return c
	}
	names := []string{businessdb.FileName}
	if legacyInstallation {
		names = []string{businessdb.LegacyFileName}
	}
	for _, name := range names {
		if _, err := os.Stat(filepath.Join(home, name)); err != nil {
			if !legacyInstallation {
				c.readError = fmt.Errorf("installation_config_unavailable: stat canonical database: %w", err)
				return c
			}
			continue
		}
		u := sqlitefile.URL(filepath.Join(home, name))
		query := u.Query()
		query.Set("mode", "ro")
		u.RawQuery = query.Encode()
		db, err := sql.Open("sqlite", u.String())
		if err != nil {
			if !legacyInstallation {
				c.readError = fmt.Errorf("installation_config_unavailable: open canonical database: %w", err)
				return c
			}
			continue
		}
		var raw string
		err = db.QueryRow(`SELECT value FROM app_kv WHERE key='config:server'`).Scan(&raw)
		err = errors.Join(err, db.Close())
		candidate := c
		if err == nil {
			if json.Unmarshal([]byte(raw), &candidate) != nil {
				err = errors.New("installation_config_invalid")
			}
		}
		if err == nil && !legacyInstallation && strings.TrimSpace(candidate.ManagementKey) == "" {
			err = errors.New("management_key_missing")
		}
		if err == nil && !legacyInstallation && (candidate.Port < 1 || candidate.Port > 65535) {
			err = errors.New("installation_config_port_invalid")
		}
		if err == nil {
			c = candidate
			break
		}
		if !legacyInstallation {
			c.readError = fmt.Errorf("installation_config_unavailable: read canonical server configuration: %w", err)
			return c
		}
	}
	if legacyInstallation && c.ManagementKey == "" {
		if raw, err := os.ReadFile(filepath.Join(home, "server-config.json")); err == nil {
			_ = json.Unmarshal(raw, &c)
		}
	}
	if c.Port < 1 || c.Port > 65535 {
		c.Port = 9527
	}
	return c
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
			if status == 503 && j["error"] == "no_available_account" {
				if idle, err := legacyEmptyGatewayIdle(ctx, home, c); err == nil && idle {
					return false, "", nil
				}
			}
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
