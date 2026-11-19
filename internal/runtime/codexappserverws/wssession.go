package codexappserverws

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// BackendSession 把一个共享 app-server 的 WebSocket 连接适配成
// StdioBridgeSession，使既有的帧桥接、重写与流控逻辑无需改动即可复用。
type BackendSession struct {
	Stdin  io.WriteCloser
	Stdout io.ReadCloser
	Wait   func() error
	Close  func() error
}

// DialSharedBackend 连接到共享后端，并返回可直接交给 BridgeStdio 的会话。
func DialSharedBackend(ctx context.Context, url string, maxFrameBytes int) (*BackendSession, error) {
	clock := 10 * time.Second
	dialCtx, cancel := context.WithTimeout(ctx, clock)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, url, nil)
	if err != nil {
		return nil, err
	}
	if maxFrameBytes <= 0 {
		// coder/websocket 默认 32KB；app-server 的单帧可能远大于此。
		maxFrameBytes = 16 * 1024 * 1024
	}
	conn.SetReadLimit(int64(maxFrameBytes))
	reader, writer := io.Pipe()
	sessionCtx, stopSession := context.WithCancel(ctx)
	var closeOnce sync.Once
	closeAll := func() {
		closeOnce.Do(func() {
			stopSession()
			_ = conn.CloseNow()
			_ = writer.Close()
		})
	}
	go func() {
		defer closeAll()
		for {
			_, data, err := conn.Read(sessionCtx)
			if err != nil {
				return
			}
			frame := make([]byte, 0, len(data)+1)
			frame = append(frame, data...)
			frame = append(frame, '\n')
			if _, err := writer.Write(frame); err != nil {
				return
			}
		}
	}()
	stdin := &backendWriter{ctx: sessionCtx, conn: conn}
	return &BackendSession{
		Stdin:  stdin,
		Stdout: reader,
		Wait:   nil,
		Close:  func() error { closeAll(); return nil },
	}, nil
}

type backendWriter struct {
	ctx  context.Context
	conn *websocket.Conn
	mu   sync.Mutex
	buf  []byte
	dead bool
}

func (w *backendWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.dead {
		return 0, io.ErrClosedPipe
	}
	w.buf = append(w.buf, p...)
	for {
		index := -1
		for i, b := range w.buf {
			if b == '\n' {
				index = i
				break
			}
		}
		if index < 0 {
			return len(p), nil
		}
		frame := make([]byte, index)
		copy(frame, w.buf[:index])
		w.buf = w.buf[index+1:]
		if len(frame) == 0 {
			continue
		}
		if err := w.conn.Write(w.ctx, websocket.MessageText, frame); err != nil {
			w.dead = true
			return 0, errors.New("codex_shared_backend_write_failed")
		}
	}
}

func (w *backendWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.dead = true
	return nil
}
