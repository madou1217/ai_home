package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/madou1217/ai_home/internal/host/codexremoteproxy"
)

func runCodexRemoteControl(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return codexremoteproxy.Run(ctx, args, os.Stderr)
}
