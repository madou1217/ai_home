package accountbrowserview

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"sync/atomic"
	"time"
)

const nativeDrainTimeout = 2 * time.Second
const nativeMaxEventBytes = 2 * 1024 * 1024
const nativeShutdownTimeout = 12 * time.Second

// serveNative owns its stdout pipe instead of using Cmd.StdoutPipe: concurrent
// Wait closes StdoutPipe before a slow reader can consume the final error. It
// joins all producers before returning so no old input/output outlives cleanup.
func serveNative(ctx context.Context, binary string, pid int, started uint64, commands <-chan Command, transport Transport) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Not CommandContext: cancellation must first close the helper's stdin so it
	// can close the browser window and let Chromium flush profile data.
	command := exec.Command(binary, nativeArgs(pid, started)...)
	prepareBrowserCommand(command)
	output, writer, err := os.Pipe()
	if err != nil {
		return surfaceFailure("browser_native_helper_unavailable")
	}
	defer output.Close()
	command.Stdout = writer
	input, err := command.StdinPipe()
	if err != nil {
		writer.Close()
		return surfaceFailure("browser_native_helper_unavailable")
	}
	defer input.Close()
	if err = command.Start(); err != nil {
		writer.Close()
		return surfaceFailure("browser_native_helper_unavailable")
	}
	writer.Close()
	processDone := make(chan struct{})
	go func() {
		_ = command.Wait()
		// A helper descendant must not keep this pipe open forever after exit.
		_ = output.SetReadDeadline(time.Now().Add(nativeDrainTimeout))
		close(processDone)
	}()
	controls := make(chan Event, 8)
	frames := make(chan Event, 1)
	readDone := make(chan error, 1)
	readerDone := make(chan struct{})
	var ended atomic.Bool
	go func() {
		defer close(readerDone)
		readDone <- readNativeEvents(ctx, output, controls, frames, &ended)
	}()
	inputDone := make(chan struct{})
	inputError := make(chan error, 1)
	go func() {
		defer close(inputDone)
		encoder := json.NewEncoder(input)
		for {
			if ctx.Err() != nil || ended.Load() {
				return
			}
			select {
			case <-ctx.Done():
				return
			case c := <-commands:
				if ctx.Err() != nil || ended.Load() {
					return
				}
				if err := encoder.Encode(c); err != nil {
					inputError <- surfaceFailure("browser_native_helper_stopped")
					return
				}
			}
		}
	}()
	defer func() {
		cancel()
		_ = input.Close()
		select {
		case <-processDone:
		case <-time.After(nativeShutdownTimeout):
			if command.Process != nil {
				_ = command.Process.Kill()
			}
			<-processDone
		}
		// Closing the positively owned read end also releases a blocked scanner.
		_ = output.Close()
		<-readerDone
		<-inputDone
	}()
	draining := false
	pendingInputError := (<-chan error)(inputError)
	var drainTimer *time.Timer
	defer func() {
		if drainTimer != nil {
			drainTimer.Stop()
		}
	}()
	var timeout <-chan time.Time
	beginDrain := func() {
		if draining {
			return
		}
		draining = true
		drainTimer = time.NewTimer(nativeDrainTimeout)
		timeout = drainTimer.C
	}
	// Read completion/fatal is a terminal boundary, not a channel race with
	// queued readiness or old images. Terminal errors return through the safe
	// transport result; only nonfatal stale-frame notifications remain events.
	for {
		if ended.Load() {
			select {
			case err := <-readDone:
				return err
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-pendingInputError:
			pendingInputError = nil
			// Do not kill a helper that may still be producing its final diagnostic.
			// Stop input, discard pending frames/readiness and drain with a deadline.
			beginDrain()
		case <-timeout:
			_ = command.Process.Kill()
			return surfaceFailure("browser_native_helper_stopped")
		case err := <-readDone:
			return err
		case event := <-controls:
			if draining || ended.Load() {
				continue
			}
			if err := transport.Send(ctx, event); err != nil {
				return err
			}
		case frame := <-frames:
			if draining || ended.Load() {
				continue
			}
			if err := transport.Send(ctx, frame); err != nil {
				return err
			}
		}
	}
}
