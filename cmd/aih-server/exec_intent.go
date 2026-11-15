package main

import (
	"context"
	"github.com/madou1217/ai_home/internal/host/codexexecpreflight"
	"os"
	"os/signal"
	"syscall"
)

func runCodexExecIntent(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return codexexecpreflight.Run(ctx, args, os.Stdin, os.Stdout, os.Stderr)
}
