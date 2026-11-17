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
	if len(args) > 0 && args[0] == "--thread-list-visibility" {
		return runCodexThreadListVisibility(args[1:])
	}
	if len(args) > 0 && args[0] == "--thread-list-response" {
		return runCodexThreadListResponse(args[1:])
	}
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

// runCodexThreadListResponse is a bounded operation of the existing state port,
// not a new server, writer, native process supervisor or network endpoint.
func runCodexThreadListResponse(args []string) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-thread-list-response-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_state_response_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	type input struct {
		data []byte
		err  error
	}
	read := make(chan input, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, codexstatepage.MaxResponseInput+1))
		read <- input{data, err}
	}()
	select {
	case in := <-read:
		if in.err != nil || len(in.data) > codexstatepage.MaxResponseInput {
			return errors.New("codex_state_response_input_invalid")
		}
		result, err := codexstatepage.CompileThreadListResponse(ctx, in.data)
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return errors.New("codex_state_response_cancelled")
		}
		stopWrite := context.AfterFunc(ctx, func() { _ = os.Stdout.Close() })
		defer stopWrite()
		_, err = os.Stdout.Write(append(result, '\n'))
		return err
	case <-ctx.Done():
		return errors.New("codex_state_response_input_timeout")
	}
}

// Visibility consumes only an existing enabled thread/list response. It does
// not start a host, mutate state or own the upstream stdio process.
func runCodexThreadListVisibility(args []string) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-thread-list-visibility-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_state_visibility_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	type input struct {
		data []byte
		err  error
	}
	read := make(chan input, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, codexstatepage.MaxVisibilityInput+1))
		read <- input{data, err}
	}()
	select {
	case in := <-read:
		if in.err != nil || len(in.data) > codexstatepage.MaxVisibilityInput {
			return errors.New("codex_state_visibility_input_invalid")
		}
		result, err := codexstatepage.CompileThreadListVisibility(ctx, in.data)
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return errors.New("codex_state_visibility_cancelled")
		}
		stopWrite := context.AfterFunc(ctx, func() { _ = os.Stdout.Close() })
		defer stopWrite()
		_, err = os.Stdout.Write(append(result, '\n'))
		return err
	case <-ctx.Done():
		return errors.New("codex_state_visibility_input_timeout")
	}
}
