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
	"github.com/madou1217/ai_home/internal/runtime/codexstatepage"
)

func runCodexMetadata(args []string) error {
	if len(args) > 0 && args[0] == "--thread-config-reconcile" {
		return runCodexThreadConfigReconcile(args[1:])
	}
	if len(args) > 0 && args[0] == "--config-response" {
		return runCodexConfigResponse(args[1:])
	}
	if len(args) > 0 && args[0] == "--title-response" {
		return runCodexTitleResponse(args[1:])
	}
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

// The title-response operation consumes an existing upstream frame. It does
// not own the upstream process, database writes or other metadata operations.
func runCodexTitleResponse(args []string) (resultErr error) {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-title-response-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_title_response_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	data, err := boundedinput.Read(ctx, os.Stdin, codexstatepage.MaxTitleResponseInput)
	defer clear(data)
	if errors.Is(err, boundedinput.ErrTooLarge) {
		return codexstatepage.ErrBudget
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		return errors.New("codex_title_response_input_timeout")
	}
	if err != nil {
		return errors.New("codex_title_response_input_invalid")
	}
	if len(data) > codexstatepage.MaxTitleResponseInput {
		return codexstatepage.ErrBudget
	}
	if ctx.Err() != nil {
		return errors.New("codex_title_response_cancelled")
	}
	result, err := codexstatepage.CompileTitleResponse(ctx, data)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return errors.New("codex_title_response_cancelled")
	}
	writeDone := make(chan struct{})
	stopWrite := context.AfterFunc(ctx, func() {
		defer close(writeDone)
		_ = os.Stdout.Close()
	})
	defer func() {
		// A false stop means the callback started; it must finish before return.
		if !stopWrite() {
			<-writeDone
		}
		if ctx.Err() != nil {
			resultErr = errors.New("codex_title_response_cancelled")
		}
	}()
	_, err = os.Stdout.Write(append(result, '\n'))
	return err
}

// Config response consumes only the already reconciled context and upstream wire.
func runCodexConfigResponse(args []string) (resultErr error) {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-config-response-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_config_response_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	data, err := boundedinput.Read(ctx, os.Stdin, codexstatepage.MaxConfigResponseInput)
	defer clear(data)
	if errors.Is(err, boundedinput.ErrTooLarge) {
		return codexstatepage.ErrBudget
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		return errors.New("codex_config_response_input_timeout")
	}
	if err != nil {
		return errors.New("codex_config_response_input_invalid")
	}
	if len(data) > codexstatepage.MaxConfigResponseInput {
		return codexstatepage.ErrBudget
	}
	if ctx.Err() != nil {
		return errors.New("codex_config_response_cancelled")
	}
	result, err := codexstatepage.CompileConfigResponse(ctx, data)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return errors.New("codex_config_response_cancelled")
	}
	writeDone := make(chan struct{})
	stopWrite := context.AfterFunc(ctx, func() {
		defer close(writeDone)
		_ = os.Stdout.Close()
	})
	defer func() {
		// A false stop means the callback started; it must finish before return.
		if !stopWrite() {
			<-writeDone
		}
		if ctx.Err() != nil {
			resultErr = errors.New("codex_config_response_cancelled")
		}
	}()
	_, err = os.Stdout.Write(append(result, '\n'))
	return err
}

// Managed reconciliation consumes an already resolved runtime config and reads
// vendor state only. It never repairs history or starts a service.
func runCodexThreadConfigReconcile(args []string) (resultErr error) {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-thread-config-reconcile-v1")
		return err
	}
	if len(args) != 0 {
		return errors.New("codex_thread_config_reconcile_arguments_invalid")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	data, err := boundedinput.Read(ctx, os.Stdin, codexstatepage.MaxThreadConfigReconcileInput)
	defer clear(data)
	if errors.Is(err, boundedinput.ErrTooLarge) {
		return codexstatepage.ErrBudget
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		return errors.New("codex_thread_config_reconcile_input_timeout")
	}
	if err != nil {
		return errors.New("codex_thread_config_reconcile_input_invalid")
	}
	if ctx.Err() != nil {
		return errors.New("codex_thread_config_reconcile_cancelled")
	}
	result, err := codexstatepage.CompileThreadConfigReconcile(ctx, data)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return errors.New("codex_thread_config_reconcile_cancelled")
	}
	writeDone := make(chan struct{})
	stopWrite := context.AfterFunc(ctx, func() {
		defer close(writeDone)
		_ = os.Stdout.Close()
	})
	defer func() {
		if !stopWrite() {
			<-writeDone
		}
		if ctx.Err() != nil {
			resultErr = errors.New("codex_thread_config_reconcile_cancelled")
		}
	}()
	_, err = os.Stdout.Write(append(result, '\n'))
	return err
}
