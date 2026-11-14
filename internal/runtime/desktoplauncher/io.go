package desktoplauncher

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/desktopprotocol"
)

func (l *Launcher) writeLoop(p *process) {
	for {
		select {
		case <-p.ctx.Done():
			return
		case queued := <-p.out:
			raw := queued.raw
			if queued.ctx.Err() != nil {
				p.queueMu.Lock()
				p.outBytes -= len(raw)
				p.queueMu.Unlock()
				continue
			}
			if p.ctx.Err() != nil {
				return
			}
			timer := time.AfterFunc(5*time.Second, func() { l.fail(p, "desktop_write_timeout", true) })
			n, err := p.input.Write(raw)
			timer.Stop()
			if err == nil && n != len(raw) {
				err = io.ErrShortWrite
			}
			p.queueMu.Lock()
			p.outBytes -= len(raw)
			p.queueMu.Unlock()
			if err != nil {
				l.fail(p, "desktop_write_failed", true)
				return
			}
		}
	}
}
func (l *Launcher) readLoop(p *process) {
	defer l.finished(p)
	scanner := bufio.NewScanner(p.output)
	scanner.Buffer(make([]byte, 4096), desktopprotocol.MaxFrameBytes+1)
	for scanner.Scan() {
		if p.ctx.Err() != nil {
			return
		}
		event, err := desktopprotocol.Decode(scanner.Bytes())
		if err != nil {
			if errors.Is(err, desktopprotocol.ErrVersion) {
				l.fail(p, "desktop_protocol_version_unsupported", false)
				return
			}
			continue
		}
		kind := desktopprotocol.Text(event["type"])
		if kind == "ready" {
			l.mu.Lock()
			same := l.current == p && !p.stopped && !l.closed
			if same {
				p.handshake = true
			}
			status := l.state
			if same {
				status = l.setStateLocked("running", "")
			}
			l.mu.Unlock()
			if same {
				p.readyOnce.Do(func() { close(p.ready) })
				l.publishStatus(status)
			}
		}
		// Chat command/session epochs are independent; never apply the selection watermark to them.
		if !strings.HasPrefix(kind, "chat.") {
			if epoch, ok := event["generation"].(int64); ok {
				if epoch < p.watermark {
					continue
				}
				p.watermark = epoch
			}
		}
		raw, _ := json.Marshal(event)
		p.queueMu.Lock()
		if len(raw) > 1<<20-p.inBytes {
			p.queueMu.Unlock()
			l.fail(p, "desktop_event_overflow", true)
			return
		}
		p.inBytes += len(raw)
		select {
		case p.in <- event:
			p.queueMu.Unlock()
		default:
			p.inBytes -= len(raw)
			p.queueMu.Unlock()
			l.fail(p, "desktop_event_overflow", true)
			return
		}
	}
	if scanner.Err() != nil && p.ctx.Err() == nil {
		l.fail(p, "desktop_protocol_read_failed", true)
	}
}
func (l *Launcher) eventLoop(p *process) {
	defer func() { l.mu.Lock(); l.workers--; l.mu.Unlock() }()
	for {
		select {
		case <-p.ctx.Done():
			return
		case event := <-p.in:
			if p.ctx.Err() != nil {
				return
			}
			l.mu.Lock()
			same := l.current == p && !p.stopped && !l.closed
			l.mu.Unlock()
			if same && l.options.OnEvent != nil {
				ctx, cancel := context.WithTimeout(p.ctx, 30*time.Second)
				l.options.OnEvent(ctx, event)
				cancel()
			}
			raw, _ := json.Marshal(event)
			p.queueMu.Lock()
			p.inBytes -= len(raw)
			p.queueMu.Unlock()
		}
	}
}
