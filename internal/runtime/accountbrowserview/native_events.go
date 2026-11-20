package accountbrowserview

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"sync/atomic"
)

func readNativeEvents(ctx context.Context, output io.Reader, controls chan<- Event, frames chan Event, ended *atomic.Bool) error {
	defer ended.Store(true)
	scan := bufio.NewScanner(output)
	scan.Buffer(make([]byte, 65536), nativeMaxEventBytes)
	ready := false
	for scan.Scan() {
		event, err := decodeEvent(scan.Bytes())
		if err != nil {
			return surfaceFailure("browser_native_event_invalid")
		}
		switch event.Type {
		case "error":
			err = nativeError(event.Error)
			event = Event{Type: "error", Error: PublicErrorCode(err)}
			if event.Error != "browser_frame_stale" {
				ended.Store(true)
				// Fatal state replaces pending readiness. No input is usable afterwards.
				return err
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case controls <- event:
			}
		case "ready":
			if ready || event.Width <= 0 || event.Height <= 0 || event.Width > 4096 || event.Height > 4096 {
				return surfaceFailure("browser_native_protocol_invalid")
			}
			ready = true
			select {
			case <-ctx.Done():
				return ctx.Err()
			case controls <- event:
			}
		case "frame":
			if !ready || event.Frame <= 0 || event.Width <= 0 || event.Height <= 0 || event.Width > 4096 || event.Height > 4096 || len(event.Data) > 1400000 {
				return surfaceFailure("browser_native_protocol_invalid")
			}
			raw, err := base64.StdEncoding.DecodeString(event.Data)
			if err != nil || len(raw) < 3 || raw[0] != 0xff || raw[1] != 0xd8 || raw[2] != 0xff {
				return surfaceFailure("browser_native_event_invalid")
			}
			select {
			case frames <- event:
			default:
				select {
				case <-frames:
				default:
				}
				select {
				case frames <- event:
				default:
				}
			}
		default:
			return surfaceFailure("browser_native_protocol_invalid")
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if scan.Err() != nil {
		return surfaceFailure("browser_native_event_invalid")
	}
	return surfaceFailure("browser_native_helper_stopped")
}
