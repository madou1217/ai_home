// Package codexexecpreflight is the Node launcher's thin native-intent bridge.
package codexexecpreflight

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexexecintent"
	"github.com/madou1217/ai_home/internal/runtime/platform"
)

type config struct {
	Command         string   `json:"command"`
	Args            []string `json:"args"`
	Prefix          []string `json:"prefix"`
	WindowsVerbatim bool     `json:"windowsVerbatim"`
}

// Run keeps the per-thread lease until its owning Node launcher closes stdin or
// exits. Arguments arrive over a private pipe; stdout is one bounded reply.
func Run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := io.WriteString(stdout, "aih-codex-exec-intent-v1\n")
		return err
	}
	flags := flag.NewFlagSet("aih-server __codex-exec-intent", flag.ContinueOnError)
	flags.SetOutput(stderr)
	parent := flags.Int("parent-pid", os.Getppid(), "owning launcher PID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *parent <= 0 || !platform.ProcessAlive(*parent) {
		return errors.New("codex_exec_intent_parent_invalid")
	}
	reader := bufio.NewReaderSize(stdin, 256<<10)
	type input struct {
		raw []byte
		err error
	}
	first := make(chan input, 1)
	go func() { raw, err := reader.ReadSlice('\n'); first <- input{raw, err} }()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	var value input
	select {
	case value = <-first:
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("codex_exec_intent_config_timeout")
	}
	var c config
	if value.err != nil || len(value.raw) > 256<<10 || json.Unmarshal(value.raw, &c) != nil || c.Command == "" {
		return errors.New("codex_exec_intent_config_invalid")
	}
	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, reader); cancel(); close(done) }()
	watch := time.NewTicker(time.Second)
	defer watch.Stop()
	parentDone := make(chan struct{})
	defer close(parentDone)
	go func() {
		for {
			select {
			case <-parentDone:
				return
			case <-childCtx.Done():
				return
			case <-watch.C:
				if !platform.ProcessAlive(*parent) {
					cancel()
					return
				}
			}
		}
	}()
	prepared, release, err := codexexecintent.PrepareWithLauncher(childCtx, "codex", c.Command, c.Prefix, c.WindowsVerbatim, c.Args, os.Environ())
	if err != nil {
		return err
	}
	defer release()
	if err := json.NewEncoder(stdout).Encode(map[string]any{"ok": true, "args": prepared}); err != nil {
		return err
	}
	select {
	case <-done:
		return nil
	case <-childCtx.Done():
		return nil
	}
}
