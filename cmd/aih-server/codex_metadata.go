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

	"github.com/madou1217/ai_home/internal/runtime/codexstatepage"
)

func runCodexMetadata(args []string) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-metadata-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_metadata_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var input struct {
		Operation string   `json:"operation"`
		Home      string   `json:"codexHome"`
		ThreadID  string   `json:"threadId"`
		ThreadIDs []string `json:"threadIds"`
	}
	done := make(chan error, 1)
	go func() { done <- json.NewDecoder(io.LimitReader(os.Stdin, 256<<10)).Decode(&input) }()
	select {
	case err := <-done:
		if err != nil {
			return errors.New("codex_metadata_input_invalid")
		}
	case <-ctx.Done():
		return errors.New("codex_metadata_input_timeout")
	}
	var value any
	switch input.Operation {
	case "titles":
		titles, err := codexstatepage.ReadTitles(ctx, input.Home, input.ThreadIDs)
		if err != nil {
			return err
		}
		value = map[string]any{"titles": titles}
	case "goal":
		goal, err := codexstatepage.ReadGoal(ctx, input.Home, input.ThreadID)
		if err != nil {
			return err
		}
		value = goal
	default:
		return errors.New("codex_metadata_operation_invalid")
	}
	return json.NewEncoder(os.Stdout).Encode(value)
}
