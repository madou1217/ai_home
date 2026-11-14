// Package codexmodelcatalog reads the installed official CLI's embedded model metadata.
// It never uses account credentials or modifies the user's Codex home.
package codexmodelcatalog

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

// Reader caches an exact-match catalog; unknown models never inherit another model's tiers.
type Reader struct {
	mu         sync.Mutex
	expires    time.Time
	models     map[string][]modelmetadata.ServiceTier
	refreshing chan struct{}
}

func NewReader() *Reader { return &Reader{} }

func (reader *Reader) LookupServiceTiers(ctx context.Context, provider, model string) []modelmetadata.ServiceTier {
	if provider != "codex" || ctx == nil {
		return nil
	}
	for {
		if ctx.Err() != nil {
			return nil
		}
		reader.mu.Lock()
		if time.Now().Before(reader.expires) {
			tiers := append([]modelmetadata.ServiceTier(nil), reader.models[model]...)
			reader.mu.Unlock()
			return tiers
		}
		if pending := reader.refreshing; pending != nil {
			reader.mu.Unlock()
			select {
			case <-ctx.Done():
				return nil
			case <-pending:
				continue
			}
		}
		pending := make(chan struct{})
		reader.refreshing = pending
		reader.mu.Unlock()
		// Never hold the cache mutex across process I/O. Waiters retain their own deadlines.
		models, err := reader.load(ctx)
		reader.mu.Lock()
		if err == nil {
			reader.models = models
			reader.expires = time.Now().Add(time.Hour)
		} else if ctx.Err() == nil {
			// Preserve the last observed snapshot on transient failure. Caller cancellation
			// must neither clear it nor create a negative cache for unrelated requests.
			reader.expires = time.Now().Add(time.Minute)
		}
		reader.refreshing = nil
		close(pending)
		tiers := append([]modelmetadata.ServiceTier(nil), reader.models[model]...)
		reader.mu.Unlock()
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			log.Printf("[aih] Codex native service-tier catalog refresh unavailable (%v); retaining only previously observed metadata", err)
		}
		return tiers
	}
}

func (reader *Reader) binary() (string, error) {
	return providercli.ResolveBinary("codex", "codex")
}

func (reader *Reader) load(parent context.Context) (map[string][]modelmetadata.ServiceTier, error) {
	binary, err := reader.binary()
	if err != nil {
		return nil, err
	}
	home, err := os.MkdirTemp("", "aih-codex-catalog-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(home)
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "app-server", "--listen", "stdio://")
	cmd.Dir = home
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_AUTH_JSON":
			continue
		}
		// 宿主进程带着 AIH_* 会话/网关变量；子进程只应作为普通 Codex app-server 运行，
		// 否则会进入托管会话并立即关闭 stdio（表现为 model/list EOF）。
		if strings.HasPrefix(strings.ToUpper(key), "AIH_") {
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	cmd.Env = append(cmd.Env, "CODEX_HOME="+home)
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	defer func() {
		input.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()
	// No thread is started: model/list returns the binary's local fallback catalog without authentication.
	for _, msg := range []any{
		map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]string{"name": "aih-model-catalog", "version": "1"}}},
		map[string]any{"method": "initialized"},
		map[string]any{"id": 2, "method": "model/list", "params": map[string]bool{"includeHidden": true}},
	} {
		if err := json.NewEncoder(input).Encode(msg); err != nil {
			return nil, err
		}
	}
	decoder := json.NewDecoder(io.LimitReader(output, 2<<20))
	for {
		var msg struct {
			ID     int             `json:"id"`
			Error  json.RawMessage `json:"error"`
			Result struct {
				Data []struct {
					Model string                      `json:"model"`
					Tiers []modelmetadata.ServiceTier `json:"serviceTiers"`
				} `json:"data"`
			} `json:"result"`
		}
		if err := decoder.Decode(&msg); err != nil {
			return nil, err
		}
		if msg.ID != 2 {
			continue
		}
		if len(msg.Error) != 0 && string(msg.Error) != "null" {
			return nil, fmt.Errorf("model/list rejected")
		}
		models := make(map[string][]modelmetadata.ServiceTier)
		for _, model := range msg.Result.Data {
			seen := make(map[string]bool)
			for _, tier := range model.Tiers {
				if tier.ID == "" || strings.TrimSpace(tier.ID) != tier.ID || seen[tier.ID] {
					continue
				}
				seen[tier.ID] = true
				models[model.Model] = append(models[model.Model], tier)
			}
		}
		return models, nil
	}
}
