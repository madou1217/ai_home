package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/host/boundedinput"
	"github.com/madou1217/ai_home/internal/host/usagefacts"
)

// Independent early mode: never starts a server, opens a DB, or consumes a
// backup capability. Pipe EOF, size and signal cancellation share one deadline.
func runUsageFacts(args []string) (resultErr error) {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, usagefacts.Capability)
		return err
	}
	if len(args) != 0 {
		return errors.New("usage_facts_arguments_invalid")
	}
	signals, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(signals, 6*time.Second)
	defer cancel()
	raw, err := boundedinput.Read(ctx, os.Stdin, usagefacts.MaxInput)
	if err != nil {
		return errors.New("usage_facts_input_unavailable")
	}
	defer clear(raw)
	output, err := usagefacts.Compile(ctx, raw)
	if err != nil {
		return err
	}
	defer clear(output)
	if err := ctx.Err(); err != nil {
		return errors.New("usage_facts_cancelled")
	}
	joined := make(chan struct{})
	stopWrite := context.AfterFunc(ctx, func() { defer close(joined); _ = os.Stdout.Close() })
	defer func() {
		if !stopWrite() {
			<-joined
		}
		if ctx.Err() != nil {
			resultErr = errors.New("usage_facts_cancelled")
		}
	}()
	_, err = os.Stdout.Write(output)
	if err != nil {
		return errors.New("usage_facts_output_unavailable")
	}
	return nil
}
