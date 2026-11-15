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

func runCodexStatePage(args []string) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-state-page-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_state_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var request struct {
		Operation string                     `json:"operation"`
		Home      string                     `json:"codexHome"`
		Params    codexstatepage.Params      `json:"params"`
		Options   codexstatepage.ReadOptions `json:"options"`
	}
	done := make(chan error, 1)
	go func() { done <- json.NewDecoder(io.LimitReader(os.Stdin, 256<<10)).Decode(&request) }()
	select {
	case err := <-done:
		if err != nil {
			return errors.New("codex_state_input_invalid")
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	var result any
	switch request.Operation {
	case "page":
		page, err := codexstatepage.ReadPage(ctx, request.Home, request.Params, request.Options)
		if err != nil {
			return err
		}
		result = page
	case "hidden":
		ids, err := codexstatepage.ReadHidden(ctx, request.Home)
		if err != nil {
			return err
		}
		result = map[string]any{"ids": ids}
	default:
		return errors.New("codex_state_operation_invalid")
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}
