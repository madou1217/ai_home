package nativeterminal

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// runTitles consumes existing read models only: no quota refresh or network calls.
// The mux pane title survives attach/detach and is visible to existing collectors.
func runTitles(ctx context.Context, home string, entry Entry, output io.Writer) {
	if intentField(os.Getenv("AIH_RUNTIME_USAGE"), "show") == "0" {
		return
	}
	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()
	index := 0
	cache := titleCache{}
	lastWritten := ""
	for {
		current, _, err := readEntryPath(home, entry)
		if err == nil {
			entry = current
		}
		frames := cache.frames(ctx, home, entry)
		if len(frames) > 0 {
			title := frames[index%len(frames)]
			index++
			if title != lastWritten && entry.Mux != "" {
				mux := &multiplexer{path: entry.Mux, env: os.Environ()}
				_, _ = mux.command(ctx, entry.Socket, "select-pane", "-t", entry.Session, "-T", title)
			} else if title != lastWritten {
				_, _ = fmt.Fprintf(output, "\x1b]0;%s\x07", title)
			}
			lastWritten = title
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func readEntryPath(home string, entry Entry) (Entry, map[string]json.RawMessage, error) {
	path, err := entryPath(home, entry.Socket, entry.Session)
	if err != nil {
		return Entry{}, nil, err
	}
	return readEntry(path)
}
func cleanTitle(value string) string {
	out := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == 0x1b {
			return -1
		}
		return r
	}, value)
	runes := []rune(strings.TrimSpace(out))
	if len(runes) > 140 {
		runes = runes[:140]
	}
	return string(runes)
}
func usageTitleFrames(ctx context.Context, home, accountRef string) ([]string, error) {
	readCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	db, err := appstate.OpenReadOnly(readCtx, filepath.Join(home, "aih.db"))
	if err != nil {
		if missingUsage(err) {
			return nil, nil
		}
		return nil, err
	}
	defer db.Close()
	var raw string
	if err = db.QueryRowContext(readCtx, `SELECT payload_json FROM account_usage_snapshots WHERE account_ref = ? ORDER BY captured_at_ms DESC LIMIT 1`, accountRef).Scan(&raw); err != nil {
		if missingUsage(err) {
			return nil, nil
		}
		return nil, err
	}
	var doc map[string]any
	if err = json.Unmarshal([]byte(raw), &doc); err != nil {
		return nil, err
	}
	frames := []string{}
	for _, name := range []string{"windows", "entries", "models"} {
		if values, ok := doc[name].([]any); ok {
			for _, value := range values {
				entry, ok := value.(map[string]any)
				if !ok {
					continue
				}
				pct, known := entry["remainingPct"].(float64)
				if !known {
					continue
				}
				label, _ := entry["label"].(string)
				if label == "" {
					label, _ = entry["window"].(string)
				}
				reset, _ := entry["resetIn"].(string)
				frame := fmt.Sprintf("%s:%.0f%%", label, pct)
				if reset != "" {
					frame += " 重置 " + reset
				}
				if len(frames) < 8 {
					frames = append(frames, cleanTitle(frame))
				}
			}
		}
	}
	if len(frames) == 0 {
		if pct, ok := doc["remainingPct"].(float64); ok {
			frames = append(frames, fmt.Sprintf("%.0f%%", pct))
		}
	}
	if intentField(os.Getenv("AIH_RUNTIME_USAGE"), "identity") == "1" {
		if account, ok := doc["account"].(map[string]any); ok {
			email, _ := account["email"].(string)
			plan, _ := account["planType"].(string)
			if text := cleanTitle(email + " " + plan); text != "" {
				frames = append(frames, text)
			}
		}
	}
	return frames, nil
}
