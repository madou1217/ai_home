// Package loopbackproxy owns standalone local HTTP/WS listener lifetimes.
package loopbackproxy

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/platform"
)

type Options struct {
	Host            string
	Port, ParentPID int
	Ready           func(net.Addr) error
}

func Run(parent context.Context, options Options, handler http.Handler) error {
	ip := net.ParseIP(options.Host)
	if ip == nil || !ip.IsLoopback() || options.Port < 0 || options.Port > 65535 || handler == nil {
		return errors.New("loopback_proxy_options_invalid")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	listener, err := net.Listen("tcp", net.JoinHostPort(options.Host, strconv.Itoa(options.Port)))
	if err != nil {
		return err
	}
	defer listener.Close()
	var active sync.WaitGroup
	owned := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		active.Add(1)
		defer active.Done()
		handler.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: owned, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 64 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	defer server.Close()
	if options.Ready != nil {
		if err = options.Ready(listener.Addr()); err != nil {
			return err
		}
	}
	failed := make(chan error, 1)
	go func() { failed <- server.Serve(listener) }()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case err := <-failed:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-ticker.C:
			if options.ParentPID > 0 && !platform.ProcessAlive(options.ParentPID) {
				cancel()
			}
		case <-ctx.Done():
			shutdown, stop := context.WithTimeout(context.Background(), 3*time.Second)
			err := server.Shutdown(shutdown)
			stop()
			if err != nil {
				_ = server.Close()
			}
			serveErr := <-failed
			if errors.Is(serveErr, http.ErrServerClosed) {
				serveErr = nil
			}
			done := make(chan struct{})
			go func() { active.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				return errors.New("loopback_proxy_connections_not_closed")
			}
			return errors.Join(err, serveErr)
		}
	}
}
