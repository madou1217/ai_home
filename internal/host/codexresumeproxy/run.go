// Package codexresumeproxy launches the native scoped resume transport only.
package codexresumeproxy

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
	"github.com/madou1217/ai_home/internal/transport/http/codexresumeapi"
)

type config struct {
	RemoteURL  string `json:"remoteUrl"`
	AuthToken  string `json:"authToken"`
	LocalToken string `json:"localToken"`
	Cwd        string `json:"cwd"`
}

func Run(ctx context.Context, args []string, stdin io.ReadCloser, stdout, stderr io.Writer) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := io.WriteString(stdout, "aih-codex-resume-proxy-v1\n")
		return err
	}
	flags := flag.NewFlagSet("aih-server __codex-resume-proxy", flag.ContinueOnError)
	flags.SetOutput(stderr)
	host := flags.String("host", "127.0.0.1", "loopback host")
	parent := flags.Int("parent-pid", os.Getppid(), "owner PID")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || *parent <= 0 || !platform.ProcessAlive(*parent) {
		return errors.New("resume_proxy_parent_invalid")
	}
	// Credentials enter once on a private stdin pipe, never argv/URL/env/files.
	type configRead struct {
		raw []byte
		err error
	}
	readDone := make(chan configRead, 1)
	go func() {
		raw, err := bufio.NewReaderSize(stdin, 32<<10).ReadSlice('\n')
		readDone <- configRead{raw, err}
	}()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var first configRead
	parentWatch := time.NewTicker(time.Second)
	defer parentWatch.Stop()
readLoop:
	for {
		select {
		case first = <-readDone:
			break readLoop
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return errors.New("resume_proxy_config_timeout")
		case <-parentWatch.C:
			if !platform.ProcessAlive(*parent) {
				return errors.New("resume_proxy_parent_missing")
			}
		}
	}
	raw, err := first.raw, first.err
	if err != nil || len(raw) > 32<<10 {
		return errors.New("resume_proxy_config_invalid")
	}
	var input config
	if json.Unmarshal(raw, &input) != nil {
		return errors.New("resume_proxy_config_invalid")
	}
	handler, err := codexresumeapi.New(codexresumeapi.Options{Context: ctx, RemoteURL: input.RemoteURL, UpstreamToken: input.AuthToken, LocalToken: input.LocalToken, Cwd: input.Cwd})
	if err != nil {
		return err
	}
	defer handler.Close()
	return loopbackproxy.Run(ctx, loopbackproxy.Options{Host: *host, ParentPID: *parent, Ready: func(address net.Addr) error {
		return json.NewEncoder(stdout).Encode(map[string]any{"ok": true, "host": *host, "port": address.(*net.TCPAddr).Port})
	}}, handler)
}
