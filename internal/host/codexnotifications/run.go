// Package codexnotifications owns the stdio hook's incremental queue reader and
// bounded notification scheduling. It neither writes the queue nor opens a DB.
package codexnotifications

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
	"github.com/madou1217/ai_home/internal/runtime/platform"
)

type config struct {
	QueueFile  string   `json:"queueFile"`
	ThreadIDs  []string `json:"threadIds"`
	PollMS     int      `json:"pollIntervalMs"`
	DebounceMS *int     `json:"debounceMs"`
	StartAtEnd *bool    `json:"startAtEnd"`
}
type command struct {
	Operation string   `json:"operation"`
	ThreadID  string   `json:"threadId"`
	ThreadIDs []string `json:"threadIds"`
}

func Run(parent context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := io.WriteString(stdout, "aih-codex-notifications-v1\n")
		return err
	}
	flags := flag.NewFlagSet("aih-server __codex-notifications", flag.ContinueOnError)
	flags.SetOutput(stderr)
	pid := flags.Int("parent-pid", os.Getppid(), "owning hook PID")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 || *pid <= 0 || !platform.ProcessAlive(*pid) {
		return errors.New("notification_parent_invalid")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	input := readLines(ctx, stdin)
	startup := time.NewTimer(5 * time.Second)
	defer startup.Stop()
	parentTick := time.NewTicker(time.Second)
	defer parentTick.Stop()
	var first inputLine
firstLine:
	for {
		select {
		case line, ok := <-input:
			if !ok {
				return errors.New("notification_config_missing")
			}
			first = line
			break firstLine
		case <-startup.C:
			return errors.New("notification_config_timeout")
		case <-ctx.Done():
			return nil
		case <-parentTick.C:
			if !platform.ProcessAlive(*pid) {
				return nil
			}
		}
	}
	var settings config
	if first.err != nil || json.Unmarshal(first.raw, &settings) != nil || strings.TrimSpace(settings.QueueFile) == "" {
		return errors.New("notification_config_invalid")
	}
	poll := settings.PollMS
	if poll == 0 {
		poll = 500
	}
	if poll < 100 || poll > 60000 {
		return errors.New("notification_poll_interval_invalid")
	}
	debounce := 500
	if settings.DebounceMS != nil {
		debounce = *settings.DebounceMS
	}
	if debounce < 0 || debounce > 60000 {
		return errors.New("notification_debounce_invalid")
	}
	scheduler := newScheduler(time.Duration(debounce) * time.Millisecond)
	if len(settings.ThreadIDs) > maxLiveThreads {
		return errors.New("notification_thread_capacity_exceeded")
	}
	for _, id := range settings.ThreadIDs {
		if err := scheduler.add(id); err != nil {
			return err
		}
	}
	startAtEnd := settings.StartAtEnd == nil || *settings.StartAtEnd
	cursor := codexhooks.NewNotificationCursor(settings.QueueFile, startAtEnd, time.Now)
	output := newOutput(ctx, stdout)
	if err := output.message(ctx, map[string]any{"type": "ready"}); err != nil {
		return err
	}
	poller := time.NewTicker(time.Duration(poll) * time.Millisecond)
	defer poller.Stop()
	dueTimer := time.NewTimer(time.Hour)
	if !dueTimer.Stop() {
		<-dueTimer.C
	}
	defer dueTimer.Stop()
	var due <-chan time.Time
	resetDue := func() {
		if !dueTimer.Stop() {
			select {
			case <-dueTimer.C:
			default:
			}
		}
		due = nil
		if len(scheduler.queue) > 0 {
			dueTimer.Reset(max(time.Duration(0), time.Until(scheduler.queue[0].due)))
			due = dueTimer.C
		}
	}
	lastReadError := ""
	pollOnce := func() error {
		result, err := cursor.Poll(codexhooks.DefaultNotificationMaxReadBytes)
		if err != nil {
			if lastReadError != err.Error() {
				lastReadError = err.Error()
				return output.message(ctx, map[string]any{"type": "diagnostic", "code": "notification_queue_read_failed"})
			}
			return nil
		}
		lastReadError = ""
		if result.Reset || result.SkippedLines > 0 {
			if err := output.message(ctx, map[string]any{"type": "diagnostic", "code": "notification_queue_boundary", "reset": result.Reset, "skippedLines": result.SkippedLines}); err != nil {
				return err
			}
		}
		now := time.Now()
		for _, event := range result.Events {
			scheduler.schedule(event, now)
		}
		resetDue()
		return nil
	}
	if err := pollOnce(); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-output.failed:
			return err
		case <-parentTick.C:
			if !platform.ProcessAlive(*pid) {
				return nil
			}
			if started := output.pendingAt.Load(); started > 0 && time.Since(time.Unix(0, started)) > 3*time.Second {
				return errors.New("notification_output_backpressure")
			}
		case <-poller.C:
			if err := pollOnce(); err != nil {
				return err
			}
		case now := <-due:
			for frame := scheduler.nextDue(now); frame != nil; frame = scheduler.nextDue(now) {
				if err := output.send(ctx, frame); err != nil {
					return err
				}
			}
			resetDue()
		case line, ok := <-input:
			if !ok || errors.Is(line.err, io.EOF) {
				return nil
			}
			if line.err != nil {
				return errors.New("notification_control_line_invalid")
			}
			var request command
			if json.Unmarshal(line.raw, &request) != nil {
				return errors.New("notification_control_invalid")
			}
			switch request.Operation {
			case "add":
				if err := scheduler.add(request.ThreadID); err != nil {
					return err
				}
			case "remove":
				scheduler.remove(strings.TrimSpace(request.ThreadID))
				resetDue()
			case "poll":
				if err := pollOnce(); err != nil {
					return err
				}
			case "replace":
				if len(request.ThreadIDs) > maxLiveThreads {
					return errors.New("notification_thread_capacity_exceeded")
				}
				keep := make(map[string]bool, len(request.ThreadIDs))
				for _, id := range request.ThreadIDs {
					id = strings.TrimSpace(id)
					if id == "" || len(id) > 4096 {
						return errors.New("notification_thread_invalid")
					}
					keep[id] = true
				}
				for id := range scheduler.live {
					if !keep[id] {
						scheduler.remove(id)
					}
				}
				for id := range keep {
					if err := scheduler.add(id); err != nil {
						return err
					}
				}
				resetDue()
			case "stop":
				return nil
			default:
				return errors.New("notification_control_invalid")
			}
		}
	}
}
