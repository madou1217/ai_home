package codexrollout

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
)

// ReadModels walks from EOF and stops when all requested contexts are found.
// The first model seen per ID is the last assignment in forward history. One
// block plus a bounded split-line assembly replaces a full decoded file/map.
func ReadModels(ctx context.Context, path string, ids []string) (map[string]string, error) {
	if len(ids) > 1024 {
		return nil, ErrReadBudget
	}
	wanted := make(map[string]bool, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if len(id) > 4096 {
			return nil, ErrReadBudget
		}
		if id != "" {
			wanted[id] = true
		}
	}
	result := make(map[string]string, len(wanted))
	if len(wanted) == 0 {
		return result, nil
	}
	file, size, err := openRegular(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	original, err := file.Stat()
	if err != nil {
		return nil, err
	}
	block := make([]byte, 128<<10)
	var pieces [][]byte
	pieceBytes := 0
	visit := func(prefix []byte) error {
		line := prefix
		if len(pieces) > 0 {
			if len(prefix)+pieceBytes > hardMaxBytes {
				return ErrReadBudget
			}
			line = make([]byte, 0, len(prefix)+pieceBytes)
			line = append(line, prefix...)
			for i := len(pieces) - 1; i >= 0; i-- {
				line = append(line, pieces[i]...)
			}
			pieces = nil
			pieceBytes = 0
		}
		if !bytes.Contains(line, []byte(`"turn_context"`)) {
			return nil
		}
		var record struct {
			Type    string `json:"type"`
			Payload struct {
				TurnID string          `json:"turn_id"`
				Model  json.RawMessage `json:"model"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &record) != nil || record.Type != "turn_context" {
			return nil
		}
		id := strings.TrimSpace(record.Payload.TurnID)
		if !wanted[id] {
			return nil
		}
		if value := model(record.Payload.Model); value != "" {
			result[id] = value
			delete(wanted, id)
		}
		return nil
	}
	for end := size; end > 0; {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		start := max(int64(0), end-int64(len(block)))
		length := int(end - start)
		n, readErr := file.ReadAt(block[:length], start)
		if readErr != nil {
			return nil, readErr
		}
		if n != length {
			return nil, ErrReadBudget
		}
		chunk := block[:n]
		right := len(chunk)
		for right > 0 {
			index := bytes.LastIndexByte(chunk[:right], '\n')
			if index < 0 {
				break
			}
			if err = visit(chunk[index+1 : right]); err != nil {
				return nil, err
			}
			if len(wanted) == 0 {
				if err := verifySnapshot(path, file, original); err != nil {
					return nil, err
				}
				return result, nil
			}
			right = index
		}
		if right > 0 {
			pieceBytes += right
			if pieceBytes > hardMaxBytes {
				return nil, ErrReadBudget
			}
			pieces = append(pieces, bytes.Clone(chunk[:right]))
		}
		end = start
	}
	if len(pieces) > 0 {
		if err = visit(nil); err != nil {
			return nil, err
		}
	}
	if err := verifySnapshot(path, file, original); err != nil {
		return nil, err
	}
	return result, nil
}
