package codexlocalappserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

const launchConfigTimeout = 4 * time.Second

var errLaunchConfig = errors.New("local_app_server_effective_config_unavailable")

// effectiveServiceTier delegates layers, TOML syntax, -c precedence, project
// trust and CODEX_HOME resolution to the actual native app-server. No native
// thread is loaded or written. The probe is private and has bounded lifetime.
func effectiveServiceTier(parent context.Context, config Config, env []string) (*string, error) {
	ctx, cancel := context.WithTimeout(parent, launchConfigTimeout)
	defer cancel()
	process, err := codexappserverws.StartAppServerProcess(codexappserverws.StartProcessOptions{
		Command: config.Command, Args: config.Args, Env: env, Dir: config.Cwd, WindowsVerbatim: config.WindowsVerbatim,
	})
	if err != nil {
		return nil, errLaunchConfig
	}
	stop := context.AfterFunc(ctx, process.Close)
	var stderr sync.WaitGroup
	stderr.Add(1)
	go func() { defer stderr.Done(); _, _ = io.Copy(io.Discard, process.Stderr()) }()
	defer func() { stop(); process.Close(); stderr.Wait() }()
	reader := bufio.NewReaderSize(process.Stdout(), 64<<10)
	call := func(id int, method string, params any) (json.RawMessage, error) {
		request, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
		if err != nil {
			return nil, errLaunchConfig
		}
		if _, err = process.Stdin().Write(append(request, '\n')); err != nil {
			return nil, errLaunchConfig
		}
		for {
			line, err := readConfigLine(reader)
			if err != nil {
				return nil, errLaunchConfig
			}
			var response struct {
				Method string          `json:"method"`
				ID     json.RawMessage `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(line, &response) != nil {
				return nil, errLaunchConfig
			}
			// A server-initiated request lives in the opposite RPC ID namespace.
			// Never mistake it for the response to our private probe.
			if response.Method != "" {
				continue
			}
			var responseID int
			if json.Unmarshal(response.ID, &responseID) != nil || responseID != id {
				continue
			}
			if len(response.Error) > 0 && string(response.Error) != "null" {
				return nil, errLaunchConfig
			}
			return response.Result, nil
		}
	}
	_, err = call(1, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "aih-launch-config", "version": "1"},
		"capabilities": map[string]bool{"experimentalApi": true},
	})
	if err != nil {
		return nil, err
	}
	if _, err := io.WriteString(process.Stdin(), "{\"method\":\"initialized\"}\n"); err != nil {
		return nil, errLaunchConfig
	}
	raw, err := call(2, "config/read", map[string]any{"cwd": config.Cwd, "includeLayers": false})
	if err != nil {
		return nil, err
	}
	var response struct {
		Config map[string]json.RawMessage `json:"config"`
	}
	if json.Unmarshal(raw, &response) != nil || response.Config == nil {
		return nil, errLaunchConfig
	}
	value, known := response.Config["service_tier"]
	if !known || string(value) == "null" {
		return nil, nil
	}
	var tier string
	if json.Unmarshal(value, &tier) != nil || tier == "" || len(tier) > 256 || strings.TrimSpace(tier) != tier {
		return nil, errLaunchConfig
	}
	for _, character := range tier {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return nil, errLaunchConfig
		}
	}
	return &tier, nil
}

// Bound memory independently of the native schema; raw config may contain
// secrets and is never logged. Notifications are discarded, not accumulated.
func readConfigLine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		part, err := reader.ReadSlice('\n')
		if len(line)+len(part) > 4<<20 {
			return nil, errLaunchConfig
		}
		line = append(line, part...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return line, err
	}
}
