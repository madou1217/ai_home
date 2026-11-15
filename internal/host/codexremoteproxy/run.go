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
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/host/loopbackproxy"
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
	return loopbackproxy.Run(ctx, loopbackproxy.Options{Host: *host, Port: *port, ParentPID: *parentPID, Ready: func(address net.Addr) error {
		return writeReady(*ready, map[string]any{"ok": true, "host": *host, "port": address.(*net.TCPAddr).Port})
	}}, handler)

}
