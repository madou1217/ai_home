package codexexecintent

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/madou1217/ai_home/internal/runtime/codexlaunchrpc"
)

type thread struct {
	ID            string  `json:"id"`
	Name          *string `json:"name"`
	ModelProvider string  `json:"modelProvider"`
	Cwd           string  `json:"cwd"`
	Status        struct {
		Type string `json:"type"`
	} `json:"status"`
}

func readThread(c *codexlaunchrpc.Client, id string) (thread, error) {
	var out struct {
		Thread thread `json:"thread"`
	}
	if err := c.Call("thread/read", map[string]any{"threadId": id, "includeTurns": false}, &out); err != nil {
		return thread{}, err
	}
	if out.Thread.ID != id {
		return thread{}, fmt.Errorf("codex_exec_thread_identity_mismatch")
	}
	return out.Thread, nil
}

func selectThread(c *codexlaunchrpc.Client, v invocation, provider string) (thread, error) {
	if !v.last {
		if id, err := uuid.Parse(v.identity); err == nil {
			return readThread(c, id.String())
		}
	}
	params := map[string]any{"limit": uint32(100), "modelProviders": []string{}, "sourceKinds": []string{"cli", "exec", "vscode", "appServer"}, "sortKey": "updated_at", "sortDirection": "desc", "useStateDbOnly": true}
	if v.last {
		if provider != "" {
			params["modelProviders"] = []string{provider}
		}
		if !v.all {
			params["cwd"] = v.cwd
		}
	}
	if !v.last {
		params["searchTerm"] = v.identity
	}
	seen := map[string]bool{}
	var match *thread
	for page := 0; page < 100; page++ {
		var result struct {
			Data []thread `json:"data"`
			Next *string  `json:"nextCursor"`
		}
		if err := c.Call("thread/list", params, &result); err != nil {
			return thread{}, err
		}
		for _, row := range result.Data {
			if v.last {
				if !v.all && filepath.Clean(row.Cwd) != filepath.Clean(v.cwd) {
					continue
				}
				return readThread(c, row.ID)
			}
			if row.Name != nil && *row.Name == v.identity {
				if match != nil && match.ID != row.ID {
					return thread{}, fmt.Errorf("codex_exec_thread_name_ambiguous")
				}
				copy := row
				match = &copy
			}
		}
		if result.Next == nil || strings.TrimSpace(*result.Next) == "" {
			if match != nil {
				return readThread(c, match.ID)
			}
			return thread{}, fmt.Errorf("codex_exec_thread_not_found")
		}
		if seen[*result.Next] {
			return thread{}, fmt.Errorf("codex_exec_thread_cursor_repeated")
		}
		seen[*result.Next] = true
		params["cursor"] = *result.Next
	}
	return thread{}, fmt.Errorf("codex_exec_thread_lookup_limit")
}

// The fresh app-server's loaded list cannot see another native process. Inspect
// the latest persisted turn as well, failing closed for active/interrupted
// observations instead of letting a second owner rewrite its running settings.
func requireIdleTurn(c *codexlaunchrpc.Client, id string) error {
	var result struct {
		Data []struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := c.Call("thread/turns/list", map[string]any{"threadId": id, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}, &result); err != nil {
		return err
	}
	for _, turn := range result.Data {
		if turn.Status == "inProgress" || turn.Status == "in_progress" || turn.Status == "running" {
			return fmt.Errorf("codex_exec_thread_not_idle")
		}
	}
	return nil
}
