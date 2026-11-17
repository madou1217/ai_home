package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexconfigheal"
)

// runCodexProviderHeal compiles one existing pure text repair. No native file,
// database, account, protocol or publication owner is assembled by this port.
func runCodexProviderHeal(args []string, runtime commandRuntime) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(runtime.stdout, "aih-codex-provider-heal-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_provider_heal_arguments_invalid")
	}
	type input struct {
		data []byte
		err  error
	}
	read := make(chan input, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(runtime.stdin, codexconfigheal.MaxInput+1))
		read <- input{data, err}
	}()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
		return errors.New("codex_provider_heal_input_timeout")
	case in := <-read:
		if in.err != nil || len(in.data) > codexconfigheal.MaxInput {
			return codexconfigheal.ErrInput
		}
		result, err := codexconfigheal.DecodeAndHeal(in.data)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(runtime.stdout)
		encoder.SetEscapeHTML(false)
		return encoder.Encode(result)
	}
}
