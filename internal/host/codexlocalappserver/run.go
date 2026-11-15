// Package codexlocalappserver owns the interactive TUI's caller-scoped appserver.
// It never resolves a gateway default account or assembles the shared database.
package codexlocalappserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"os"
	"time"

	"github.com/madou1217/ai_home/internal/host/loopbackproxy"
	"github.com/madou1217/ai_home/internal/runtime/platform"
)

type Config struct {
	Command         string   `json:"command"`
	Args            []string `json:"args"`
	Cwd             string   `json:"cwd"`
	AuthToken       string   `json:"authToken"`
	InjectCwd       bool     `json:"injectCwd"`
	WindowsVerbatim bool     `json:"windowsVerbatim"`
}

func Run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := io.WriteString(stdout, "aih-codex-local-app-server-v1\n")
		return err
	}
	flags := flag.NewFlagSet("aih-server __codex-local-app-server", flag.ContinueOnError)
	flags.SetOutput(stderr)
	parent := flags.Int("parent-pid", os.Getppid(), "owning launcher PID")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || *parent <= 0 || !platform.ProcessAlive(*parent) {
		return errors.New("local_app_server_parent_invalid")
	}
	type result struct {
		raw []byte
		err error
	}
	read := make(chan result, 1)
	go func() { data, err := bufio.NewReaderSize(stdin, 256<<10).ReadSlice('\n'); read <- result{data, err} }()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	var input result
readConfig:
	for {
		select {
		case input = <-read:
			break readConfig
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return errors.New("local_app_server_config_timeout")
		case <-poll.C:
			if !platform.ProcessAlive(*parent) {
				return errors.New("local_app_server_parent_missing")
			}
		}
	}
	if input.err != nil || len(input.raw) > 256<<10 {
		return errors.New("local_app_server_config_invalid")
	}
	var config Config
	if json.Unmarshal(input.raw, &config) != nil {
		return errors.New("local_app_server_config_invalid")
	}
	handler, err := newHandler(ctx, config, os.Environ())
	if err != nil {
		return err
	}
	return loopbackproxy.Run(ctx, loopbackproxy.Options{Host: "127.0.0.1", ParentPID: *parent, Ready: func(address net.Addr) error {
		return json.NewEncoder(stdout).Encode(map[string]any{"ok": true, "host": "127.0.0.1", "port": address.(*net.TCPAddr).Port})
	}}, handler)
}
