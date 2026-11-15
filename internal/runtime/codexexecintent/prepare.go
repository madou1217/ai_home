// Package codexexecintent applies a caller's current speed intent to the exact
// native exec-resume thread through official app-server methods, not file edits.
package codexexecintent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexlaunchrpc"
	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
)

// Prepare returns pinned native arguments and an OS lease retained until the
// foreground native process exits. Unrelated commands are exact no-ops.
func Prepare(ctx context.Context, provider, command string, args, env []string) ([]string, func(), error) {
	return PrepareWithLauncher(ctx, provider, command, nil, false, args, env)
}

// PrepareWithLauncher preserves native Windows npm shims as command+prefix.
// It never builds a shell command from credentials or untrusted prompt text.
func PrepareWithLauncher(ctx context.Context, provider, command string, prefix []string, verbatim bool, args, env []string) ([]string, func(), error) {
	release := func() {}
	if provider != "codex" {
		return args, release, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, release, err
	}
	call, matched, err := parse(args, cwd)
	if err != nil || !matched {
		return args, release, err
	}
	home, err := codexHome(env)
	if err != nil {
		return nil, release, err
	}
	if err := codexpreferences.CheckHostReady(home); err != nil {
		return nil, release, err
	}
	profile, err := call.profileTier(home)
	if err != nil {
		return nil, release, err
	}
	explicit, err := call.explicitTier()
	if err != nil {
		return nil, release, err
	}
	if call.ignoreConfig && explicit == nil && profile == nil {
		// No desired tier remains after ignoring root config. Preserve the
		// native resume behavior instead of inventing a default override.
		return args, release, nil
	}
	appArgs := call.appArgs
	if profile != nil {
		appArgs = append([]string{appArgs[0], appArgs[1], appArgs[2], "-c", "service_tier=" + quote(*profile)}, appArgs[3:]...)
	}
	work, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	client, err := codexlaunchrpc.Open(work, command, append(append([]string(nil), prefix...), appArgs...), env, call.cwd, verbatim)
	if err != nil {
		return nil, release, err
	}
	defer client.Close()
	var config struct {
		Config map[string]json.RawMessage `json:"config"`
	}
	if err = client.Call("config/read", map[string]any{"cwd": call.cwd, "includeLayers": false}, &config); err != nil {
		return nil, release, err
	}
	raw, known := config.Config["service_tier"]
	if !known || string(raw) == "null" {
		return args, release, nil
	}
	var tier string
	if json.Unmarshal(raw, &tier) != nil || !validTier(tier) {
		return nil, release, fmt.Errorf("codex_exec_tier_invalid")
	}
	var modelProvider string
	if raw := config.Config["model_provider"]; len(raw) > 0 {
		_ = json.Unmarshal(raw, &modelProvider)
	}
	selected, err := selectThread(client, call, modelProvider)
	if err != nil {
		return nil, release, err
	}
	held, err := acquire(home, selected.ID)
	if err != nil {
		return nil, release, err
	}
	succeeded := false
	defer func() {
		if !succeeded {
			// Keep the lease until the failed native control owner has exited.
			// A later launcher must never race its unsubscribe/failed writes.
			_ = client.Close()
			held()
		}
	}()
	// Re-read after acquiring our lease; do not act on the earlier list snapshot.
	selected, err = readThread(client, selected.ID)
	if err != nil {
		return nil, release, err
	}
	if selected.Status.Type != "notLoaded" && selected.Status.Type != "idle" {
		return nil, release, fmt.Errorf("codex_exec_thread_not_idle")
	}
	if err := requireIdleTurn(client, selected.ID); err != nil {
		return nil, release, err
	}
	var resumed struct {
		Thread      thread  `json:"thread"`
		ServiceTier *string `json:"serviceTier"`
	}
	if err = client.Call("thread/resume", map[string]any{"threadId": selected.ID, "serviceTier": tier, "excludeTurns": true}, &resumed); err != nil {
		return nil, release, err
	}
	if resumed.Thread.ID != selected.ID {
		return nil, release, fmt.Errorf("codex_exec_thread_identity_mismatch")
	}
	if err = client.Call("thread/settings/update", map[string]any{"threadId": selected.ID, "serviceTier": tier}, nil); err != nil {
		return nil, release, err
	}
	if err = client.Call("thread/unsubscribe", map[string]any{"threadId": selected.ID}, nil); err != nil {
		return nil, release, fmt.Errorf("codex_exec_thread_release_failed")
	}
	if err = work.Err(); err != nil {
		return nil, release, err
	}
	if err := client.Close(); err != nil {
		return nil, release, err
	}
	// Native ownership has been released before the foreground CLI starts.
	succeeded = true
	return call.pinned(selected.ID), held, nil
}
