package webuiwatchws

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"time"
)

var (
	errOutboundQueueClosed = errors.New("watch outbound queue closed")
	errOutboundOverflow    = errors.New("watch outbound queue overflow")
	errOutboundTooLarge    = errors.New("watch outbound frame exceeds connection budget")
	errStaleSubscription   = errors.New("watch subscription generation superseded")
)

type outboundFrame struct {
	payload []byte
	bytes   int
	subID   string
	subGen  uint64
}

// outboundQueue enforces an aggregate byte budget (default 16 MiB) and bounded
// frame counts across all subscriptions sharing a WebSocket connection, while
// tracking per-subscription minimum generations so unsubscribed or replaced
// subscriptions cannot leak queued stale frames into a newer generation.
//
// Backpressure is explicit: Enqueue blocks respecting both the caller's context
// and any live write deadline (including concurrent SetWriteDeadline updates).
// If the queue stays saturated past the slow-consumer backpressure timeout, the
// queue transitions to overflow so the connection closes and forces a clean
// client reconnect + resnapshot instead of silently dropping events.
type outboundQueue struct {
	mu              sync.Mutex
	frames          []outboundFrame
	head            int
	count           int
	totalBytes      int
	subFrames       map[string]int
	minGen          map[string]uint64
	maxBytes        int
	maxFrames       int
	maxPerSubFrames int
	overflowTimeout time.Duration
	closed          bool
	overflowed      bool
	spaceCh         chan struct{}
	notifyPush      chan struct{}
	onOverflow      func()
}

func newOutboundQueue(
	maxBytes int,
	maxFrames int,
	maxPerSubFrames int,
	overflowTimeout time.Duration,
	onOverflow func(),
) *outboundQueue {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxOutboundBytes
	}
	if maxFrames <= 0 {
		maxFrames = defaultMaxOutboundFrames
	}
	if maxPerSubFrames <= 0 {
		maxPerSubFrames = defaultMaxPerSubFrames
	}
	if overflowTimeout <= 0 {
		overflowTimeout = DefaultWriteTimeout
	}
	return &outboundQueue{
		frames:          make([]outboundFrame, 0, 32),
		subFrames:       make(map[string]int),
		minGen:          make(map[string]uint64),
		maxBytes:        maxBytes,
		maxFrames:       maxFrames,
		maxPerSubFrames: maxPerSubFrames,
		overflowTimeout: overflowTimeout,
		spaceCh:         make(chan struct{}),
		notifyPush:      make(chan struct{}, 1),
		onOverflow:      onOverflow,
	}
}

func (q *outboundQueue) Close() {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.closed = true
	q.frames = nil
	q.head = 0
	q.count = 0
	q.totalBytes = 0
	q.subFrames = nil
	q.minGen = nil
	close(q.spaceCh)
	q.mu.Unlock()
	q.signalPush()
}

func (q *outboundQueue) Overflowed() bool {
	q.mu.Lock()
	overflowed := q.overflowed
	q.mu.Unlock()
	return overflowed
}

func (q *outboundQueue) IsClosed() bool {
	q.mu.Lock()
	closed := q.closed
	q.mu.Unlock()
	return closed
}

// SetMinGenAndPurge advances the minimum accepted generation for subID and
// purges any already-queued frames belonging to older generations, freeing
// their byte budget immediately.
func (q *outboundQueue) SetMinGenAndPurge(subID string, minGen uint64) {
	if subID == "" || minGen == 0 {
		return
	}
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	if minGen > q.minGen[subID] {
		q.minGen[subID] = minGen
	}
	freed := false
	if q.count > 0 {
		kept := make([]outboundFrame, 0, q.count)
		for i := q.head; i < len(q.frames); i++ {
			frame := q.frames[i]
			if frame.subID == subID && frame.subGen > 0 && frame.subGen < q.minGen[subID] {
				q.totalBytes -= frame.bytes
				q.count--
				if next := q.subFrames[subID] - 1; next <= 0 {
					delete(q.subFrames, subID)
				} else {
					q.subFrames[subID] = next
				}
				freed = true
				continue
			}
			kept = append(kept, frame)
		}
		if freed {
			q.frames = kept
			q.head = 0
			close(q.spaceCh)
			q.spaceCh = make(chan struct{})
		}
	}
	q.mu.Unlock()
}

// PurgeAllForSub immediately removes every currently-queued frame belonging to
// subID without retaining any minGen tombstone (used on explicit unsubscribe
// after a subscription already exited naturally so no memory leaks across IDs).
func (q *outboundQueue) PurgeAllForSub(subID string) {
	if subID == "" {
		return
	}
	q.mu.Lock()
	if q.closed || q.count == 0 {
		q.mu.Unlock()
		return
	}
	freed := false
	kept := make([]outboundFrame, 0, q.count)
	for i := q.head; i < len(q.frames); i++ {
		frame := q.frames[i]
		if frame.subID == subID {
			q.totalBytes -= frame.bytes
			q.count--
			if next := q.subFrames[subID] - 1; next <= 0 {
				delete(q.subFrames, subID)
			} else {
				q.subFrames[subID] = next
			}
			freed = true
			continue
		}
		kept = append(kept, frame)
	}
	if freed {
		q.frames = kept
		q.head = 0
		close(q.spaceCh)
		q.spaceCh = make(chan struct{})
	}
	q.mu.Unlock()
}

// ClearMinGen removes the generation watermark for subID once all goroutines
// for subID have exited and no active entry exists, keeping minGen bounded.
func (q *outboundQueue) ClearMinGen(subID string) {
	if subID == "" {
		return
	}
	q.mu.Lock()
	if !q.closed && q.minGen != nil {
		delete(q.minGen, subID)
	}
	q.mu.Unlock()
}

func (q *outboundQueue) TriggerOverflow() {
	q.mu.Lock()
	alreadyClosed := q.closed
	q.overflowed = true
	if !alreadyClosed {
		q.closed = true
		q.frames = nil
		q.head = 0
		q.count = 0
		q.totalBytes = 0
		q.subFrames = nil
		q.minGen = nil
		close(q.spaceCh)
	}
	onOverflow := q.onOverflow
	q.mu.Unlock()
	q.signalPush()
	if !alreadyClosed && onOverflow != nil {
		onOverflow()
	}
}

func (q *outboundQueue) EnqueueJSON(
	ctx context.Context,
	subID string,
	subGen uint64,
	body any,
	readDeadline func() (time.Time, <-chan struct{}),
) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return q.Enqueue(ctx, outboundFrame{
		payload: encoded,
		bytes:   len(encoded),
		subID:   subID,
		subGen:  subGen,
	}, readDeadline)
}

func (q *outboundQueue) Enqueue(
	ctx context.Context,
	frame outboundFrame,
	readDeadline func() (time.Time, <-chan struct{}),
) error {
	if frame.bytes <= 0 {
		return nil
	}
	if frame.bytes > q.maxBytes {
		return errOutboundTooLarge
	}

	overflowTimer := time.NewTimer(q.overflowTimeout)
	defer overflowTimer.Stop()

	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		var (
			deadline   time.Time
			deadlineCh <-chan struct{}
		)
		if readDeadline != nil {
			deadline, deadlineCh = readDeadline()
			if !deadline.IsZero() && !deadline.After(time.Now()) {
				return os.ErrDeadlineExceeded
			}
		}

		q.mu.Lock()
		if q.closed {
			overflowed := q.overflowed
			q.mu.Unlock()
			if overflowed {
				return errOutboundOverflow
			}
			return errOutboundQueueClosed
		}
		if frame.subID != "" && frame.subGen > 0 && frame.subGen < q.minGen[frame.subID] {
			q.mu.Unlock()
			return errStaleSubscription
		}
		if q.canFitLocked(frame) {
			q.pushLocked(frame)
			q.mu.Unlock()
			q.signalPush()
			return nil
		}
		waitCh := q.spaceCh
		q.mu.Unlock()

		var (
			deadlineTimer *time.Timer
			deadlineTick  <-chan time.Time
		)
		if !deadline.IsZero() {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return os.ErrDeadlineExceeded
			}
			deadlineTimer = time.NewTimer(remaining)
			deadlineTick = deadlineTimer.C
		}

		select {
		case <-ctx.Done():
			stopTimer(deadlineTimer)
			return ctx.Err()
		case <-deadlineCh:
			stopTimer(deadlineTimer)
		case <-deadlineTick:
			stopTimer(deadlineTimer)
			return os.ErrDeadlineExceeded
		case <-overflowTimer.C:
			stopTimer(deadlineTimer)
			q.TriggerOverflow()
			return errOutboundOverflow
		case <-waitCh:
			stopTimer(deadlineTimer)
		}
	}
}

func (q *outboundQueue) TryDequeue() (outboundFrame, bool) {
	q.mu.Lock()
	if q.count > 0 {
		frame := q.popLocked()
		q.mu.Unlock()
		return frame, true
	}
	q.mu.Unlock()
	return outboundFrame{}, false
}

func (q *outboundQueue) NotifyPush() <-chan struct{} {
	return q.notifyPush
}

func (q *outboundQueue) canFitLocked(frame outboundFrame) bool {
	if q.count >= q.maxFrames || q.totalBytes+frame.bytes > q.maxBytes {
		return false
	}
	if frame.subID != "" && q.subFrames[frame.subID] >= q.maxPerSubFrames {
		return false
	}
	return true
}

func (q *outboundQueue) pushLocked(frame outboundFrame) {
	q.frames = append(q.frames, frame)
	q.count++
	q.totalBytes += frame.bytes
	if frame.subID != "" {
		q.subFrames[frame.subID]++
	}
}

func (q *outboundQueue) popLocked() outboundFrame {
	frame := q.frames[q.head]
	q.frames[q.head] = outboundFrame{}
	q.head++
	q.count--
	q.totalBytes -= frame.bytes
	if frame.subID != "" {
		next := q.subFrames[frame.subID] - 1
		if next <= 0 {
			delete(q.subFrames, frame.subID)
		} else {
			q.subFrames[frame.subID] = next
		}
	}
	if q.count == 0 {
		q.frames = q.frames[:0]
		q.head = 0
	} else if q.head >= 64 && q.head*2 >= len(q.frames) {
		remaining := append([]outboundFrame(nil), q.frames[q.head:]...)
		q.frames = remaining
		q.head = 0
	}
	close(q.spaceCh)
	q.spaceCh = make(chan struct{})
	return frame
}

func (q *outboundQueue) signalPush() {
	select {
	case q.notifyPush <- struct{}{}:
	default:
	}
}

func stopTimer(timer *time.Timer) {
	if timer == nil {
		return
	}
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}
