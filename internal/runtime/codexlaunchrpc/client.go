// Package codexlaunchrpc provides bounded, serial native launch-control RPC.
// It never logs native config, responses, argv or credentials.
package codexlaunchrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

const maxLineBytes = 8 << 20

var ErrUnavailable = errors.New("codex_launch_control_unavailable")

// Client owns one private native app-server and its whole process group.
// Call is deliberately serial; callers never interleave operations or retries.
type Client struct {
	process *codexappserverws.AppServerProcess
	reader  *bufio.Reader
	stop    func() bool
	stderr  sync.WaitGroup
	nextID  int
}

func Open(ctx context.Context, command string, args, env []string, cwd string, verbatim bool) (*Client, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p, err := codexappserverws.StartAppServerProcess(codexappserverws.StartProcessOptions{Command: command, Args: args, Env: env, Dir: cwd, WindowsVerbatim: verbatim})
	if err != nil {
		return nil, ErrUnavailable
	}
	c := &Client{process: p, reader: bufio.NewReaderSize(p.Stdout(), 64<<10)}
	c.stop = context.AfterFunc(ctx, p.Close)
	c.stderr.Add(1)
	go func() { defer c.stderr.Done(); _, _ = io.Copy(io.Discard, p.Stderr()) }()
	if err := c.Call("initialize", map[string]any{"clientInfo": map[string]string{"name": "aih-exec-intent", "version": "1"}, "capabilities": map[string]bool{"experimentalApi": true}}, nil); err != nil {
		c.Close()
		return nil, err
	}
	if _, err := io.WriteString(p.Stdin(), "{\"method\":\"initialized\"}\n"); err != nil {
		c.Close()
		return nil, ErrUnavailable
	}
	return c, nil
}

// Call returns only a closed diagnostic and the native numeric error code.
func (c *Client) Call(method string, params, result any) error {
	c.nextID++
	raw, err := json.Marshal(map[string]any{"id": c.nextID, "method": method, "params": params})
	if err != nil {
		return ErrUnavailable
	}
	if _, err = c.process.Stdin().Write(append(raw, '\n')); err != nil {
		return ErrUnavailable
	}
	for {
		line, err := readLine(c.reader)
		if err != nil {
			return ErrUnavailable
		}
		var frame struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code int `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(line, &frame) != nil {
			return ErrUnavailable
		}
		if frame.Method != "" {
			continue
		}
		var id int
		if json.Unmarshal(frame.ID, &id) != nil || id != c.nextID {
			continue
		}
		if frame.Error != nil {
			return fmt.Errorf("codex_launch_control_rejected:%s:%d", method, frame.Error.Code)
		}
		if result != nil && json.Unmarshal(frame.Result, result) != nil {
			return ErrUnavailable
		}
		return nil
	}
}

func (c *Client) Close() error {
	if c == nil {
		return nil
	}
	c.stop()
	c.process.Close()
	c.stderr.Wait()
	// The process owner already escalates TERM to KILL after its fixed grace.
	// A timeout is not proof of exit and must never permit lease release.
	// In an OS-level unkillable-process condition, keep the lock and wait.
	<-c.process.Done()
	return nil
}

func readLine(reader *bufio.Reader) ([]byte, error) {
	var out []byte
	for {
		part, err := reader.ReadSlice('\n')
		if len(out)+len(part) > maxLineBytes {
			return nil, ErrUnavailable
		}
		out = append(out, part...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return out, err
	}
}
