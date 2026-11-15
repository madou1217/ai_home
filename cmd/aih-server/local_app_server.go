package main

import (
	"context"
	"github.com/madou1217/ai_home/internal/host/codexlocalappserver"
	"os"
	"os/signal"
	"syscall"
)

func runCodexLocalAppServer(args []string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return codexlocalappserver.Run(ctx, args, os.Stdin, os.Stdout, os.Stderr)
}
