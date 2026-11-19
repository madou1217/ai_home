// Package backgroundsupervisor 承载旧版 `aih __background run` 入口。
//
// 新安装由 Go server 的 --front-door --supervise-node 持有常驻进程；这个入口只为
// 仍写入 background-supervisor.json 的兼容状态服务。它读取受管组件并按退避重启，
// 空状态与历史行为一致：立即正常退出。
package backgroundsupervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	stateFileName   = "background-supervisor.json"
	schemaVersion   = 1
	restartDelay    = time.Second
	restartMaxDelay = 30 * time.Second
)

type component struct {
	ID   string   `json:"id"`
	Args []string `json:"args"`
}

type stateDocument struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Components    map[string]component `json:"components"`
}

// Run 读取状态并监督组件；无组件时返回 0。
func Run(aiHomeDir, executable string, stdout, stderr io.Writer) int {
	state, err := readState(aiHomeDir)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "[aih:background] %v\n", err)
		return 1
	}
	components := effectiveComponents(state)
	if len(components) == 0 {
		return 0
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	var waitGroup sync.WaitGroup
	for _, item := range components {
		waitGroup.Add(1)
		go func(component component) {
			defer waitGroup.Done()
			supervise(ctx, component, executable, stdout, stderr)
		}(item)
	}
	waitGroup.Wait()
	return 0
}

func readState(aiHomeDir string) (stateDocument, error) {
	path := filepath.Join(strings.TrimSpace(aiHomeDir), "run", stateFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return stateDocument{SchemaVersion: schemaVersion, Components: map[string]component{}}, nil
		}
		return stateDocument{}, errors.New("background_supervisor_state_read_failed")
	}
	var state stateDocument
	if err := json.Unmarshal(raw, &state); err != nil || state.SchemaVersion != schemaVersion {
		return stateDocument{}, errors.New("background_supervisor_state_invalid")
	}
	if state.Components == nil {
		state.Components = map[string]component{}
	}
	for key, item := range state.Components {
		if strings.TrimSpace(key) == "" || item.ID != key || !validArgs(item.Args) {
			return stateDocument{}, errors.New("background_supervisor_state_invalid")
		}
	}
	return state, nil
}

func effectiveComponents(state stateDocument) []component {
	if len(state.Components) == 0 {
		return nil
	}
	components := []component{{ID: "server", Args: []string{"server", "serve"}}}
	for _, item := range state.Components {
		if item.ID != "server" {
			components = append(components, item)
		}
	}
	return components
}

func validArgs(args []string) bool {
	if len(args) == 0 {
		return false
	}
	for _, argument := range args {
		lower := strings.ToLower(strings.TrimSpace(argument))
		for _, secret := range []string{"token", "secret", "password", "credential", "authorization", "api-key", "apikey", "management-key"} {
			if strings.Contains(lower, secret) {
				return false
			}
		}
	}
	return true
}

func supervise(ctx context.Context, component component, executable string, stdout, stderr io.Writer) {
	delay := restartDelay
	for {
		if ctx.Err() != nil {
			return
		}
		started := time.Now()
		command := exec.CommandContext(ctx, executable, component.Args...)
		command.Stdout = stdout
		command.Stderr = stderr
		command.Env = os.Environ()
		err := command.Run()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "[aih:background:%s] runtime stopped: %v; restarting in %s\n", component.ID, err, delay)
		} else {
			_, _ = fmt.Fprintf(stderr, "[aih:background:%s] runtime stopped; restarting in %s\n", component.ID, delay)
		}
		if time.Since(started) >= time.Minute {
			delay = restartDelay
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if delay < restartMaxDelay {
			delay *= 2
			if delay > restartMaxDelay {
				delay = restartMaxDelay
			}
		}
	}
}
