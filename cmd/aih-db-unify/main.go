// aih-db-unify is an offline operator command, never a service startup hook.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/dbunify"
)

func main() {
	var opts dbunify.Options
	flag.StringVar(&opts.Root, "home", "", "explicit AIH data directory; never inferred from HOME")
	flag.StringVar(&opts.BackupDir, "backup-dir", "", "existing private directory for immutable pre-cutover snapshots")
	flag.BoolVar(&opts.Apply, "apply", false, "apply cutover; default is read-only plan")
	flag.BoolVar(&opts.Offline, "offline", false, "confirm every consumer of both databases is stopped")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	report, err := dbunify.Run(ctx, opts)
	if err != nil {
		report.State = "failed"
	}
	if encodeErr := json.NewEncoder(os.Stdout).Encode(report); encodeErr != nil {
		fmt.Fprintln(os.Stderr, encodeErr)
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
