package codexrollout

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
)

var ErrNativeHistoryRequired = errors.New("codex_native_paginated_history_required")

type ReadResult struct {
	Eligible     bool    `json:"eligible"`
	Reason       string  `json:"reason,omitempty"`
	Turns        []*Turn `json:"turns"`
	BytesScanned int64   `json:"bytesScanned"`
	WindowBytes  int64   `json:"windowBytes"`
}

func openRegular(path string) (*os.File, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, err
	}
	if !info.Mode().IsRegular() {
		return nil, 0, errors.New("codex_rollout_regular_file_required")
	}
	file, err := openHistoryFile(path)
	if err != nil {
		return nil, 0, err
	}
	actual, err := file.Stat()
	if err != nil || !actual.Mode().IsRegular() {
		file.Close()
		return nil, 0, errors.New("codex_rollout_regular_file_required")
	}
	return file, actual.Size(), nil
}

// scanLines bounds working memory by one line. A projection must not silently
// omit a record, so exceeding the window ceiling explicitly delegates reading
// to the official app-server rather than returning an incomplete success.
func scanLines(ctx context.Context, reader io.Reader, limit int, visit func([]byte) error) error {
	buffer := bufio.NewReaderSize(reader, 64<<10)
	var line []byte
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		fragment, err := buffer.ReadSlice('\n')
		if len(line)+len(fragment) > limit {
			return ErrReadBudget
		}
		if len(line) > 0 || err == bufio.ErrBufferFull {
			line = append(line, fragment...)
		} else {
			line = fragment
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if len(line) > 0 {
			if visitErr := visit(line); visitErr != nil {
				return visitErr
			}
		}
		line = nil
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}

func parseWindow(ctx context.Context, file *os.File, start, size int64, options Options) (*parser, error) {
	section := io.NewSectionReader(file, start, size-start)
	reader := bufio.NewReaderSize(section, 64<<10)
	if start > 0 {
		for {
			_, err := reader.ReadSlice('\n')
			if err == bufio.ErrBufferFull {
				continue
			}
			if err == io.EOF {
				return newParser(options), nil
			}
			if err != nil {
				return nil, err
			}
			break
		}
	}
	parser := newParser(options)
	err := scanLines(ctx, reader, int(size-start)+1, func(line []byte) error {
		if !bytes.Contains(line, []byte(`"event_msg"`)) && !bytes.Contains(line, []byte(`"turn_context"`)) {
			return nil
		}
		var record historyEntry
		if json.Unmarshal(line, &record) != nil || (record.Type != "event_msg" && record.Type != "turn_context") {
			return nil
		}
		if record.Type == "event_msg" && (record.Payload.Type == "item_completed" || record.Payload.Type == "item_started") {
			return ErrNativeHistoryRequired
		}
		return parser.apply(record.Type, timestamp(record.Timestamp), record.Payload)
	})
	return parser, err
}

// ReadRecent preserves the legacy 2/4/8 MiB window choice and item IDs without
// retaining the entire decoded rollout: a rank heap holds only returned items.
func ReadRecent(ctx context.Context, path string, sizeHint int64, options Options) (ReadResult, error) {
	options, err := normalized(options)
	if err != nil {
		return ReadResult{}, err
	}
	file, size, err := openRegular(path)
	if err != nil {
		return ReadResult{}, err
	}
	defer file.Close()
	original, err := file.Stat()
	if err != nil {
		return ReadResult{}, err
	}
	if native, err := isPaginated(file); err != nil {
		return ReadResult{}, err
	} else if native {
		// 分页历史：消息在 .codex/thread_history_1.sqlite，rollout 只剩元数据。
		if result, nativeErr := readPaginatedTurns(ctx, path, options); nativeErr == nil {
			return result, nil
		}
		return ReadResult{Eligible: false, Reason: "native_paginated_history", Turns: []*Turn{}}, nil
	}
	if sizeHint > 0 && sizeHint < size {
		size = sizeHint
	}
	window := min(size, options.InitialBytes)
	var scanned int64
	if window == 0 {
		return ReadResult{Eligible: true, Turns: []*Turn{}}, nil
	}
	for {
		start := max(int64(0), size-window)
		parser, err := parseWindow(ctx, file, start, size, options)
		scanned += window
		if errors.Is(err, ErrNativeHistoryRequired) {
			if result, nativeErr := readPaginatedTurns(ctx, path, options); nativeErr == nil {
				return result, nil
			}
			return ReadResult{Eligible: false, Reason: "native_item_history", Turns: []*Turn{}}, nil
		}
		if err != nil {
			return ReadResult{}, err
		}
		if parser.nonempty >= options.TurnLimit || start == 0 || window >= options.MaxBytes {
			if err := verifySnapshot(path, file, original); err != nil {
				return ReadResult{}, err
			}
			return ReadResult{Eligible: true, Turns: parser.finish(), BytesScanned: scanned, WindowBytes: window}, nil
		}
		window = min(size, window*2, options.MaxBytes)
	}
}

func isPaginated(file *os.File) (bool, error) {
	reader := bufio.NewReaderSize(io.NewSectionReader(file, 0, 1<<20), 64<<10)
	var first []byte
	for {
		part, err := reader.ReadSlice('\n')
		first = append(first, part...)
		if len(first) >= 1<<20 && err == bufio.ErrBufferFull {
			return false, ErrReadBudget
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil && err != io.EOF {
			return false, err
		}
		break
	}
	var header struct {
		Type    string `json:"type"`
		Payload struct {
			HistoryMode string `json:"history_mode"`
		} `json:"payload"`
	}
	if !bytes.Contains(first, []byte{'\n'}) && len(first) >= 1<<20 {
		return false, ErrReadBudget
	}
	if json.Unmarshal(first, &header) != nil {
		return false, nil
	}
	return header.Type == "session_meta" && header.Payload.HistoryMode == "paginated", nil
}

// Append-only growth leaves the captured prefix valid. Shrink, same-size
// rewrite, and path replacement do not: decline rather than mix generations.
func verifySnapshot(path string, file *os.File, before os.FileInfo) error {
	after, err := file.Stat()
	if err != nil {
		return err
	}
	current, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !os.SameFile(before, current) || after.Size() < before.Size() || (after.Size() == before.Size() && !after.ModTime().Equal(before.ModTime())) {
		return errors.New("codex_rollout_changed_during_read")
	}
	return nil
}
