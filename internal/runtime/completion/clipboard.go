package completion

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/clipboard"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/clipboardstore"
)

const (
	clipboardCandidateLimit       = 20
	clipboardDescriptionMaxRunes  = 60
	clipboardCompletionTimeout    = 500 * time.Millisecond
)

// listClipboardCandidates reads the most recent 20 non-deleted clipboard items from aih.db.
// Value is the 8-char ID prefix (no '#' prefix); Description is "#N preview" truncated to 60 runes.
func listClipboardCandidates(aiHome, hostAIHome string) []clipboardChoice {
	home := resolveClipboardDBHome(aiHome, hostAIHome)
	if home == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), clipboardCompletionTimeout)
	defer cancel()

	store, err := clipboardstore.Open(ctx, home)
	if err != nil {
		return nil
	}
	defer func() { _ = store.Close() }()

	items, err := store.ListItems(ctx, clipboard.ListFilter{Limit: clipboardCandidateLimit})
	if err != nil || len(items) == 0 {
		return nil
	}
	choices := make([]clipboardChoice, 0, len(items))
	for index, item := range items {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if len(id) > 8 {
			id = id[:8]
		}
		preview := collapseWhitespace(item.Preview)
		if preview == "" {
			preview = string(item.Kind)
		}
		desc := clipText(fmt.Sprintf("#%d %s", index+1, preview), clipboardDescriptionMaxRunes)
		choices = append(choices, clipboardChoice{
			Value:       id,
			Description: desc,
		})
	}
	return choices
}

func resolveClipboardDBHome(aiHome, hostAIHome string) string {
	for _, candidate := range []string{strings.TrimSpace(aiHome), strings.TrimSpace(hostAIHome)} {
		if candidate == "" {
			continue
		}
		if info, err := os.Stat(businessdb.Path(candidate)); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}
