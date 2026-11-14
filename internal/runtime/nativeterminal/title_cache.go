package nativeterminal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

const titleReadLimit = 2 << 20

type cachedTitleFile struct {
	path, signature string
	data            []byte
}

func fileSignature(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return "missing"
	}
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}
func (file *cachedTitleFile) read(path string) []byte {
	signature := fileSignature(path)
	if path == file.path && signature == file.signature {
		return file.data
	}
	file.path, file.signature, file.data = path, signature, nil
	handle, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer handle.Close()
	if info, err := handle.Stat(); err != nil || !info.Mode().IsRegular() || info.Size() > titleReadLimit {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(handle, titleReadLimit+1))
	if err == nil && len(data) <= titleReadLimit {
		file.data = data
	}
	return file.data
}

type titleCache struct {
	labels, correlation, state, route cachedTitleFile
	labelSignature, labelValue        string
	labelAt                           int64
	usageSignature                    string
	usageAt                           time.Time
	usage                             []string
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func (cache *titleCache) frames(ctx context.Context, home string, entry Entry) []string {
	// Read the shared title cache, not provider session directories or all accounts.
	label := entry.Label
	rawLabels := cache.labels.read(persistent.SessionCachePath(home))
	if cache.labels.signature != cache.labelSignature {
		cache.labelSignature = cache.labels.signature
		cache.labelValue, cache.labelAt = "", 0
		var labels struct {
			At   int64                          `json:"at"`
			Rows []persistent.SessionCacheEntry `json:"rows"`
		}
		if json.Unmarshal(rawLabels, &labels) == nil {
			cache.labelAt = labels.At
			for _, row := range labels.Rows {
				if row.Name == entry.Session && row.Provider == entry.Provider && row.Title != "" {
					cache.labelValue = row.Title
					break
				}
			}
		}
	}
	if cache.labelValue != "" && time.Now().UnixMilli()-cache.labelAt <= 30*60*1000 {
		label = cache.labelValue
	}
	if label == "" {
		label = filepath.Base(entry.CWD)
	}
	identity := fmt.Sprintf("%s:%d", entry.Provider, entry.CLIAccountID)
	if entry.Model != "" {
		identity += ":" + entry.Model
	}
	frames := []string{cleanTitle(label), cleanTitle(identity)}
	var correlation struct {
		Version int    `json:"version"`
		Key     string `json:"key"`
	}
	correlationPath := filepath.Join(home, "run", "provider-session-correlations", digest(entry.CorrelationID)+".json")
	if json.Unmarshal(cache.correlation.read(correlationPath), &correlation) == nil && correlation.Key != "" {
		var state sessionevents.SessionState
		if json.Unmarshal(cache.state.read(filepath.Join(home, "run", "provider-session-state", digest(correlation.Key)+".json")), &state) == nil {
			if state.Question != nil && state.Question.Question != "" {
				return []string{"? " + cleanTitle(state.Question.Question)}
			}
			if state.TurnState == "failed" {
				return []string{"! " + cleanTitle(identity)}
			}
			if state.TurnState == "interrupted" {
				frames = append(frames, "interrupted")
			}
			if state.Retry != nil {
				if attempt, ok := state.Retry["attempt"].(float64); ok {
					frames = append(frames, fmt.Sprintf("retry %.0f", attempt))
				}
			}
			if state.Statusline != nil {
				if pct, ok := state.Statusline["contextPct"].(float64); ok {
					frames = append(frames, fmt.Sprintf("context %.0f%%", pct))
				}
			}
		}
	}
	if entry.Provider != entry.IdentityProvider {
		var route struct {
			AccountID string `json:"accountId"`
			Model     string `json:"model"`
			At        int64  `json:"at"`
		}
		if json.Unmarshal(cache.route.read(filepath.Join(home, "run", "route-observation", entry.CorrelationID+".json")), &route) == nil && route.At > 0 && time.Now().UnixMilli()-route.At < 30*60*1000 {
			frames = append(frames, cleanTitle("→"+route.AccountID+":"+route.Model))
		}
	}
	// At most one account-scoped SELECT per 30s, only after DB/WAL signatures change.
	// An idle title rotation does not open SQLite or rescan native sessions.
	database := filepath.Join(home, "aih.db")
	signature := fileSignature(database) + "/" + fileSignature(database+"-wal")
	if cache.usageAt.IsZero() || time.Since(cache.usageAt) >= 30*time.Second {
		cache.usageAt = time.Now()
		if signature != cache.usageSignature {
			frames, readErr := usageTitleFrames(ctx, home, entry.AccountRef)
			if readErr == nil {
				cache.usage = frames
				cache.usageSignature = signature
			} else {
				// Stable diagnostic only; do not include SQL/provider payload or credentials.
				_, _ = fmt.Fprintln(os.Stderr, "aih native terminal: usage title unavailable")
			}
		}
	}
	return append(frames, cache.usage...)
}
