package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexclistartup"
)

// runCodexCLIStartup is a bounded private compilation port, not an account
// selector, daemon composition root, provider launcher or second RPC transport.
func runCodexCLIStartup(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(runtime.stdout, "aih-codex-cli-startup-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_cli_startup_arguments_invalid")
	}
	type input struct {
		data []byte
		err  error
	}
	read := make(chan input, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(runtime.stdin, codexclistartup.MaxInput+1))
		read <- input{data, err}
	}()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return errors.New("codex_cli_startup_cancelled")
	case <-timer.C:
		return errors.New("codex_cli_startup_input_timeout")
	case in := <-read:
		if in.err != nil || len(in.data) > codexclistartup.MaxInput {
			return errors.New("codex_cli_startup_input_invalid")
		}
		result, err := codexclistartup.Compile(ctx, in.data)
		if err != nil {
			return err
		}
		return json.NewEncoder(runtime.stdout).Encode(result)
	}
}
