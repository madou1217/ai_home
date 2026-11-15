package codexhooks

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

const notificationAnchorBytes = 64

// NotificationCursor binds an offset to a file identity and preceding bytes.
// It consumes complete JSONL records only; partial writes stay pending, while
// malformed over-budget lines are discarded with explicit diagnostic counts.
type NotificationCursor struct {
	mu       sync.Mutex
	path     string
	identity os.FileInfo
	offset   int64
	anchor   []byte
	discard  bool
	now      func() time.Time
}

type NotificationCursorResult struct {
	Offset       int64
	Events       []NotificationEvent
	Reset        bool
	SkippedLines int
}

func NewNotificationCursor(path string, startAtEnd bool, now func() time.Time) *NotificationCursor {
	if now == nil {
		now = time.Now
	}
	cursor := &NotificationCursor{path: strings.TrimSpace(path), now: now}
	if startAtEnd {
		if file, info, err := openNotificationFile(cursor.path); err == nil {
			cursor.identity = info
			cursor.offset = info.Size()
			// Start after the last complete line, not in a writer's partial
			// record: its eventual newline must still deliver that new event.
			if info.Size() > 0 {
				length := min(info.Size(), int64(DefaultNotificationMaxReadBytes))
				tail := make([]byte, length)
				n, _ := file.ReadAt(tail, info.Size()-length)
				tail = tail[:n]
				if n > 0 && tail[n-1] != '\n' {
					if last := bytes.LastIndexByte(tail, '\n'); last >= 0 {
						cursor.offset = info.Size() - length + int64(last+1)
					} else if length == info.Size() {
						cursor.offset = 0
					} else {
						cursor.discard = true
					}
				}
			}
			cursor.anchor = notificationAnchor(file, cursor.offset)
			file.Close()
		}
	}
	return cursor
}

func openNotificationFile(path string) (*os.File, os.FileInfo, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, errors.New("notification_queue_regular_file_required")
	}
	file, err := openNotificationDescriptor(path)
	if err != nil {
		return nil, nil, err
	}
	actual, err := file.Stat()
	if err != nil || !actual.Mode().IsRegular() {
		file.Close()
		return nil, nil, errors.New("notification_queue_regular_file_required")
	}
	return file, actual, nil
}

func notificationAnchor(file *os.File, offset int64) []byte {
	length := min(offset, int64(notificationAnchorBytes))
	if length <= 0 {
		return nil
	}
	buffer := make([]byte, length)
	n, err := file.ReadAt(buffer, offset-length)
	if err != nil && err != io.EOF {
		return nil
	}
	return buffer[:n]
}

func (cursor *NotificationCursor) Poll(maxReadBytes int) (NotificationCursorResult, error) {
	cursor.mu.Lock()
	defer cursor.mu.Unlock()
	result := NotificationCursorResult{Offset: cursor.offset, Events: []NotificationEvent{}}
	if cursor.path == "" {
		return result, nil
	}
	file, info, err := openNotificationFile(cursor.path)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer file.Close()
	if cursor.identity != nil && (!os.SameFile(cursor.identity, info) || cursor.offset > info.Size() || (cursor.identity.Size() == info.Size() && !cursor.identity.ModTime().Equal(info.ModTime())) || !bytes.Equal(cursor.anchor, notificationAnchor(file, cursor.offset))) {
		cursor.offset = 0
		cursor.anchor = nil
		cursor.discard = false
		result.Reset = true
	}
	cursor.identity = info
	budget := maxReadBytes
	if budget < 1024 {
		budget = DefaultNotificationMaxReadBytes
	}
	budget = min(budget, 1<<20)
	length := min(int64(budget), info.Size()-cursor.offset)
	if length <= 0 {
		result.Offset = cursor.offset
		return result, nil
	}
	buffer := make([]byte, length)
	n, readErr := file.ReadAt(buffer, cursor.offset)
	if readErr != nil && readErr != io.EOF {
		return result, readErr
	}
	buffer = buffer[:n]
	// A replacement during read must not attach this old descriptor's offset
	// to its successor. The next poll restarts on the current path.
	current, statErr := os.Stat(cursor.path)
	if statErr != nil || !os.SameFile(info, current) || current.Size() < info.Size() || (current.Size() == info.Size() && !current.ModTime().Equal(info.ModTime())) {
		return result, errors.New("notification_queue_changed_during_read")
	}
	consumed := 0
	if cursor.discard {
		end := bytes.IndexByte(buffer, '\n')
		if end < 0 {
			cursor.offset += int64(n)
			cursor.anchor = cursor.advanceAnchor(buffer)
			result.Offset = cursor.offset
			return result, nil
		}
		consumed = end + 1
		cursor.discard = false
	}
	for consumed < len(buffer) {
		end := bytes.IndexByte(buffer[consumed:], '\n')
		if end < 0 {
			break
		}
		line := bytes.TrimSpace(buffer[consumed : consumed+end])
		consumed += end + 1
		if len(line) == 0 {
			continue
		}
		var raw rawNotificationLine
		if json.Unmarshal(line, &raw) != nil {
			result.SkippedLines++
			continue
		}
		event, ok := SanitizeNotificationEvent(raw.toEvent(), cursor.now)
		if !ok || len(event.SessionID) > 4096 || len(event.Source) > 4096 || len(event.Reason) > 16<<10 || len(event.EventName) > 4096 || len(event.Phase) > 4096 {
			result.SkippedLines++
			continue
		}
		result.Events = append(result.Events, event)
	}
	if consumed == 0 && n == budget {
		cursor.discard = true
		consumed = n
		result.SkippedLines++
	}
	cursor.offset += int64(consumed)
	cursor.anchor = cursor.advanceAnchor(buffer[:consumed])
	result.Offset = cursor.offset
	return result, nil
}

// The anchor must describe bytes actually consumed, not bytes reread after a
// concurrent replacement. A later poll can then detect that generation change.
func (cursor *NotificationCursor) advanceAnchor(consumed []byte) []byte {
	if len(consumed) == 0 {
		return cursor.anchor
	}
	if len(consumed) >= notificationAnchorBytes {
		return bytes.Clone(consumed[len(consumed)-notificationAnchorBytes:])
	}
	combined := make([]byte, 0, notificationAnchorBytes+len(consumed))
	combined = append(combined, cursor.anchor...)
	combined = append(combined, consumed...)
	if len(combined) > notificationAnchorBytes {
		combined = combined[len(combined)-notificationAnchorBytes:]
	}
	return combined
}
