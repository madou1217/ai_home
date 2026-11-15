// Package codexremoteproxy owns the standalone Codex remote-control listener.
// It deliberately does not assemble accounts, databases, desktop hooks or Node.
package codexremoteproxy

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/platform"
	"github.com/madou1217/ai_home/internal/transport/http/codexappserverapi"
)

func Run(parent context.Context, args []string, stderr io.Writer) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(os.Stdout, "aih-codex-remote-control-v1")
		return err
	}
	flags := flag.NewFlagSet("aih-server __codex-remote-control", flag.ContinueOnError)
	flags.SetOutput(stderr)
	host := flags.String("host", "127.0.0.1", "loopback bind address")
	port := flags.Int("port", 0, "loopback port (0 allocates one)")
	ready := flags.String("ready-file", "", "private ready JSON path")
	trace := flags.String("trace-file", "", "bounded diagnostic log")
	suppress := flags.String("suppress-state-file", "", "hydration suppression metadata")
	upstream := flags.String("upstream-origin", codexappserverapi.DefaultRemoteControlOrigin, "upstream origin")
	parentPID := flags.Int("parent-pid", 0, "exit when original owner disappears")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || *port < 0 || *port > 65535 || *parentPID < 0 {
		return errors.New("remote_proxy_arguments_invalid")
	}
	ip := net.ParseIP(strings.Trim(*host, "[]"))
	if ip == nil || !ip.IsLoopback() {
		return errors.New("remote_proxy_loopback_required")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if *parentPID > 0 && !platform.ProcessAlive(*parentPID) {
		return errors.New("remote_proxy_parent_missing")
	}
	handler, err := codexappserverapi.NewRemoteControlHandler(codexappserverapi.RemoteControlDependencies{Context: ctx, UpstreamOrigin: *upstream, SuppressStateFile: *suppress, WriteTrace: traceWriter(*trace)})
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(*host, strconv.Itoa(*port)))
	if err != nil {
		return err
	}
	defer listener.Close()
	var active sync.WaitGroup
	owned := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		active.Add(1)
		defer active.Done()
		handler.ServeHTTP(response, request)
	})
	server := &http.Server{Handler: owned, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 64 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	defer server.Close()
	actualPort := listener.Addr().(*net.TCPAddr).Port
	if err = writeReady(*ready, map[string]any{"ok": true, "host": *host, "port": actualPort}); err != nil {
		return fmt.Errorf("remote_proxy_ready: %w", err)
	}
	errorsCh := make(chan error, 1)
	go func() { errorsCh <- server.Serve(listener) }()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case err := <-errorsCh:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-ticker.C:
			if *parentPID > 0 && !platform.ProcessAlive(*parentPID) {
				cancel()
			}
		case <-ctx.Done():
			shutdown, stop := context.WithTimeout(context.Background(), 3*time.Second)
			err := server.Shutdown(shutdown)
			stop()
			if err != nil {
				_ = server.Close()
			}
			serveErr := <-errorsCh
			closed := make(chan struct{})
			go func() { active.Wait(); close(closed) }()
			select {
			case <-closed:
			case <-time.After(3 * time.Second):
				return errors.New("remote_proxy_connections_not_closed")
			}
			if errors.Is(serveErr, http.ErrServerClosed) {
				serveErr = nil
			}
			return errors.Join(err, serveErr)
		}
	}
}
