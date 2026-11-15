package main

import (
	"context"
	"github.com/madou1217/ai_home/internal/host/codexnotifications"
	"os"
	"os/signal"
	"syscall"
)

func runCodexNotifications(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return codexnotifications.Run(ctx, args, os.Stdin, os.Stdout, os.Stderr)
}
