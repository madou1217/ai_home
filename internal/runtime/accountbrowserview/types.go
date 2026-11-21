// Package accountbrowserview bridges a task-owned ordinary stable browser
// window to one user-controlled surface. It does not provide account isolation.
package accountbrowserview

import (
	"context"
	"encoding/json"
	"errors"
)

var ErrBusy = errors.New("browser_surface_already_controlled")
var ErrUnsupported = errors.New("browser_surface_platform_unsupported")

type Options struct{ AIHomeDir string }
type Command struct {
	Frame  int64   `json:"frame,omitempty"`
	Type   string  `json:"type"`
	URL    string  `json:"url,omitempty"`
	Text   string  `json:"text,omitempty"`
	Key    string  `json:"key,omitempty"`
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	DeltaX float64 `json:"deltaX,omitempty"`
	DeltaY float64 `json:"deltaY,omitempty"`
	Button int     `json:"button,omitempty"`
}
type Event struct {
	Frame  int64  `json:"frame,omitempty"`
	Type   string `json:"type"`
	Data   string `json:"data,omitempty"`
	Error  string `json:"error,omitempty"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

// Transport keeps authorization and WebSocket mechanics outside runtime.
type Transport interface {
	Receive(context.Context) (Command, error)
	Send(context.Context, Event) error
}

func decodeEvent(raw []byte) (Event, error) {
	var e Event
	err := json.Unmarshal(raw, &e)
	return e, err
}
