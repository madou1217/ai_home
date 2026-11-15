package codexappserverapi

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

type StdioBridgeOptions struct {
	Rewrite       codexappserverws.RewriteOptions
	MaxFrameBytes int
	LogDebug      func(string)
	LogError      func(error)
}

// BridgeAppServerStdio is the single native transport owner used by gateway and
// caller-owned TUI hosts. Each direction blocks at the next I/O boundary: no
// unbounded frame/string queue or detached writes can outrun the consumer.
func BridgeAppServerStdio(parent context.Context, conn *websocket.Conn, stdio *StdioSession, options StdioBridgeOptions) {
	limit := options.MaxFrameBytes
	if limit <= 0 {
		limit = maxAppServerLineBytes
	}
	conn.SetReadLimit(int64(limit))
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			_ = conn.CloseNow()
			if stdio.Close != nil {
				_ = stdio.Close()
			}
		})
	}
	defer stop()
	stopParent := context.AfterFunc(parent, stop)
	defer stopParent()
	tracker := codexappserverws.NewResumeTracker()
	defer tracker.Close()
	scopes := codexappserverws.NewThreadListScopeTracker()
	defer scopes.Close()
	var workers sync.WaitGroup
	stdoutDone := make(chan struct{})
	logError := func(err error) {
		if options.LogError != nil && err != nil && ctx.Err() == nil {
			options.LogError(err)
		}
	}
	workers.Add(1)
	go func() {
		defer workers.Done()
		defer close(stdoutDone)
		defer stop()
		if stdio.Stdout == nil {
			return
		}
		reader := bufio.NewReaderSize(stdio.Stdout, 64<<10)
		for {
			raw, err := readAppServerLine(reader, limit)
			line := bytes.TrimSuffix(bytes.TrimSuffix(raw, []byte("\n")), []byte("\r"))
			if len(line) > limit {
				logError(errAppServerLineTooLarge)
				return
			}
			if len(line) > 0 {
				patched := scopes.Patch(tracker.PatchResponse(line))
				writeCtx, stopWrite := context.WithTimeout(ctx, 15*time.Second)
				writeErr := conn.Write(writeCtx, websocket.MessageText, patched)
				stopWrite()
				if writeErr != nil {
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					logError(err)
				}
				return
			}
		}
	}()
	if stdio.Stderr != nil {
		workers.Add(1)
		go func() { defer workers.Done(); drainAppServerStderr(stdio.Stderr, options.LogDebug) }()
	}
	if stdio.Wait != nil {
		workers.Add(1)
		go func() {
			defer workers.Done()
			_ = stdio.Wait()
			// Wait must not close stdout before its final frame is drained. Bound a
			// descendant holding the inherited pipe after the direct child exits.
			timer := time.NewTimer(2 * time.Second)
			defer timer.Stop()
			select {
			case <-stdoutDone:
			case <-ctx.Done():
			case <-timer.C:
				stop()
			}
		}()
	}
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if err = scopes.TryRemember(raw, options.Rewrite); err != nil {
			logError(err)
			break
		}
		rewritten := codexappserverws.RewriteClientMessage(raw, options.Rewrite)
		if _, err = tracker.TryRememberRequest(rewritten); err != nil {
			logError(err)
			break
		}
		if stdio.Stdin == nil {
			break
		}
		// os.Pipe supports a write deadline; other adapters still get a bounded
		// cancellation callback that closes their owner if they stop consuming.
		writeCtx, writeCancel := context.WithTimeout(ctx, 15*time.Second)
		stopOnDeadline := context.AfterFunc(writeCtx, stop)
		_, err = stdio.Stdin.Write(rewritten)
		if err == nil {
			_, err = stdio.Stdin.Write([]byte{'\n'})
		}
		stopOnDeadline()
		writeCancel()
		if err != nil {
			logError(err)
			break
		}
	}
	stop()
	workers.Wait()
}
