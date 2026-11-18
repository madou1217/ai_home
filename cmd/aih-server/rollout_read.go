package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/host/boundedinput"
	"github.com/madou1217/ai_home/internal/runtime/codexrollout"
)

func runCodexRolloutRead(args []string) error {
	if len(args) > 0 && args[0] == "--model-response" {
		return runCodexModelResponse(args[1:])
	}
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-rollout-read-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_rollout_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var request struct {
		Operation string               `json:"operation"`
		Path      string               `json:"path"`
		Size      int64                `json:"size"`
		Options   codexrollout.Options `json:"options"`
		TurnIDs   []string             `json:"turnIds"`
	}
	decoded := make(chan error, 1)
	go func() { decoded <- json.NewDecoder(io.LimitReader(os.Stdin, 256<<10)).Decode(&request) }()
	select {
	case err := <-decoded:
		if err != nil {
			return errors.New("codex_rollout_input_invalid")
		}
	case <-ctx.Done():
		return errors.New("codex_rollout_input_timeout")
	}
	var result any
	switch request.Operation {
	case "turns":
		value, err := codexrollout.ReadRecent(ctx, request.Path, request.Size, request.Options)
		if err != nil {
			return err
		}
		result = value
	case "models":
		value, err := codexrollout.ReadModels(ctx, request.Path, request.TurnIDs)
		if err != nil {
			return err
		}
		result = map[string]any{"models": value}
	default:
		return errors.New("codex_rollout_operation_invalid")
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

// This complete-response operation is separate from the legacy turns/models
// port. It owns no upstream process and never writes vendor history.
func runCodexModelResponse(args []string) (resultErr error) {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-model-response-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_model_response_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	data, err := boundedinput.Read(ctx, os.Stdin, codexrollout.MaxModelResponseInput)
	defer clear(data)
	if errors.Is(err, boundedinput.ErrTooLarge) {
		return codexrollout.ErrReadBudget
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		return errors.New("codex_model_response_input_timeout")
	}
	if err != nil {
		return errors.New("codex_model_response_input_invalid")
	}
	result, err := codexrollout.CompileModelResponse(ctx, data)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return errors.New("codex_model_response_cancelled")
	}
	done := make(chan struct{})
	stopWrite := context.AfterFunc(ctx, func() {
		defer close(done)
		_ = os.Stdout.Close()
	})
	defer func() {
		if !stopWrite() {
			<-done
		}
		if ctx.Err() != nil {
			resultErr = errors.New("codex_model_response_cancelled")
		}
	}()
	_, err = os.Stdout.Write(append(result, '\n'))
	return err
}
