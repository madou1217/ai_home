package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/madou1217/ai_home/internal/host/codexresumeproxy"
)

func runCodexResumeProxy(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return codexresumeproxy.Run(ctx, args, os.Stdin, os.Stdout, os.Stderr)
}
