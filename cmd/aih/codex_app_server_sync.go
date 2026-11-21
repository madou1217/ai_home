package main

import (
	"bufio"
	"context"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexappconfig"
)

// lockedWriteCloser 让 bridge 与 desktop account sync 共享同一根上游 stdin。
type lockedWriteCloser struct {
	mu     sync.Mutex
	writer io.Writer
	closer io.Closer
}

func (writer *lockedWriteCloser) Write(payload []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.writer.Write(payload)
}

func (writer *lockedWriteCloser) Close() error {
	if writer.closer == nil {
		return nil
	}
	return writer.closer.Close()
}

func syncIdentityResolver(store *codexappconfig.AccountStore) func(string) *codexappconfig.DesktopIdentity {
	return func(accountRef string) *codexappconfig.DesktopIdentity {
		if store == nil {
			return nil
		}
		artifacts, ok, err := store.ReadDesktopArtifacts(context.Background(), accountRef)
		if err != nil || !ok {
			return nil
		}
		return codexappconfig.BuildDesktopIdentity(artifacts, codexappconfig.IdentityOptions{RequireAccessToken: true})
	}
}

func startDesktopAccountSync(stateFile string, store *codexappconfig.AccountStore, initialRef string, writeUpstream func([]byte) error) *codexappconfig.DesktopSyncController {
	if strings.TrimSpace(stateFile) == "" || store == nil {
		return nil
	}
	controller := codexappconfig.NewDesktopSyncController(codexappconfig.DesktopSyncOptions{
		ReadState: func() codexappconfig.DesktopAccountState {
			return codexappconfig.ReadDesktopStateFile(stateFile)
		},
		ResolveIdentity: syncIdentityResolver(store),
		WriteUpstream:   writeUpstream,
		InitialRef:      initialRef,
	})
	controller.Refresh()
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			controller.Refresh()
		}
	}()
	return controller
}

// filterUpstreamResponses 丢弃同步请求的响应，其余帧原样交给 bridge。
func filterUpstreamResponses(stdout io.Reader, controller *codexappconfig.DesktopSyncController) io.Reader {
	if controller == nil || stdout == nil {
		return stdout
	}
	reader, writer := io.Pipe()
	go func() {
		defer writer.Close()
		buffered := bufio.NewReader(stdout)
		for {
			line, err := buffered.ReadBytes('\n')
			trimmed := strings.TrimSuffix(strings.TrimSuffix(string(line), "\n"), "\r")
			if trimmed != "" {
				if !controller.HandleResponse([]byte(trimmed)) {
					if _, writeErr := writer.Write(append([]byte(trimmed), '\n')); writeErr != nil {
						return
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return reader
}
