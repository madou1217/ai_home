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

	"github.com/madou1217/ai_home/internal/runtime/codexrollout"
)

func runCodexRolloutRead(args []string) error {
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
