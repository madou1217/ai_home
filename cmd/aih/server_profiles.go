package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
)

func runServerProfiles(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) < 2 || arguments[0] != "server" {
		return false, nil
	}
	action := strings.ToLower(strings.TrimSpace(arguments[1]))
	switch action {
	case "add", "ls", "list", "use", "remove", "rm":
	default:
		return false, nil
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return true, err
	}
	switch action {
	case "add":
		return true, addServerProfile(ctx, home, arguments[2:], runtime)
	case "ls", "list":
		return true, listServerProfiles(ctx, home, arguments[2:], runtime)
	case "use":
		return true, useServerProfile(ctx, home, arguments[2:], runtime)
	case "remove", "rm":
		return true, removeServerProfile(ctx, home, arguments[2:], runtime)
	}
	return true, nil
}

func addServerProfile(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	name, endpoint, managementKey := "", "", ""
	jsonOutput := false
	for index := 0; index < len(args); index++ {
		token := args[index]
		switch {
		case token == "--json":
			jsonOutput = true
		case token == "--url" || token == "--endpoint":
			value, consumed, err := profileFlagValue(args, index, token)
			if err != nil {
				return err
			}
			endpoint = value
			index += consumed - 1
		case strings.HasPrefix(token, "--url="):
			endpoint = strings.TrimPrefix(token, "--url=")
		case strings.HasPrefix(token, "--endpoint="):
			endpoint = strings.TrimPrefix(token, "--endpoint=")
		case token == "--management-key":
			value, consumed, err := profileFlagValue(args, index, token)
			if err != nil {
				return err
			}
			managementKey = value
			index += consumed - 1
		case strings.HasPrefix(token, "--management-key="):
			managementKey = strings.TrimPrefix(token, "--management-key=")
		case strings.HasPrefix(token, "-"):
			return fmt.Errorf("unknown option: %s", token)
		default:
			if name != "" {
				return errors.New("server add accepts one optional name")
			}
			name = strings.TrimSpace(token)
		}
	}
	endpoint = strings.TrimSuffix(endpoint, "/ui")
	endpoint = webuicontrolplaneapi.NormalizeEndpoint(endpoint)
	if endpoint == "" {
		return errors.New("server URL must be a valid http(s) URL")
	}
	managementKey = strings.TrimSpace(managementKey)
	if managementKey == "" {
		return errors.New("--management-key is required")
	}
	if name == "" {
		name = endpoint
	}
	if len(name) > 120 {
		name = name[:120]
	}
	saved, store, err := webuicontrolplaneapi.SaveProfile(ctx, home, map[string]any{
		"name": name, "endpoint": endpoint, "managementKey": managementKey,
		"state": "ready", "lastError": "",
	}, map[string]any{"active": true})
	if err != nil {
		return err
	}
	view := sanitizeServerProfile(saved, textValueFromMap(store, "activeProfileId"))
	return writeProfileResult(runtime, "add", view, jsonOutput)
}

func listServerProfiles(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	jsonOutput := false
	for _, token := range args {
		if token == "--json" {
			jsonOutput = true
			continue
		}
		if strings.HasPrefix(token, "-") {
			return fmt.Errorf("unknown option: %s", token)
		}
		return errors.New("server ls does not accept a target")
	}
	store, err := webuicontrolplaneapi.ListProfiles(ctx, home)
	if err != nil {
		return err
	}
	active := textValueFromMap(store, "activeProfileId")
	profiles := profileList(store)
	if jsonOutput {
		views := make([]map[string]any, 0, len(profiles))
		for _, profile := range profiles {
			views = append(views, sanitizeServerProfile(profile, active))
		}
		return writeProfileJSON(runtime, map[string]any{"ok": true, "activeProfileId": active, "profiles": views})
	}
	if len(profiles) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] no saved servers")
		return nil
	}
	for _, profile := range profiles {
		view := sanitizeServerProfile(profile, active)
		marker := " "
		if view["active"] == true {
			marker = "*"
		}
		key := "missing"
		if view["managementKeyConfigured"] == true {
			key = "configured"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%s %s  %s  %s  key=%s\n",
			marker, view["name"], view["endpoint"], view["state"], key)
	}
	return nil
}

func useServerProfile(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	target, jsonOutput, err := parseProfileTarget(args, "use")
	if err != nil {
		return err
	}
	store, err := webuicontrolplaneapi.ListProfiles(ctx, home)
	if err != nil {
		return err
	}
	profile := findServerProfile(store, target)
	if profile == nil {
		return fmt.Errorf("server not found: %s", target)
	}
	next, err := webuicontrolplaneapi.SetActiveProfile(ctx, home, textValueFromMap(profile, "id"))
	if err != nil {
		return err
	}
	view := sanitizeServerProfile(profile, textValueFromMap(next, "activeProfileId"))
	return writeProfileResult(runtime, "use", view, jsonOutput)
}

func removeServerProfile(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	target, jsonOutput, err := parseProfileTarget(args, "remove")
	if err != nil {
		return err
	}
	store, err := webuicontrolplaneapi.ListProfiles(ctx, home)
	if err != nil {
		return err
	}
	profile := findServerProfile(store, target)
	if profile == nil {
		return fmt.Errorf("server not found: %s", target)
	}
	next, err := webuicontrolplaneapi.RemoveProfile(ctx, home, textValueFromMap(profile, "id"))
	if err != nil {
		return err
	}
	view := sanitizeServerProfile(profile, textValueFromMap(next, "activeProfileId"))
	return writeProfileResult(runtime, "remove", view, jsonOutput)
}

func parseProfileTarget(args []string, action string) (string, bool, error) {
	target := ""
	jsonOutput := false
	for _, token := range args {
		if token == "--json" {
			jsonOutput = true
			continue
		}
		if strings.HasPrefix(token, "-") {
			return "", false, fmt.Errorf("unknown option: %s", token)
		}
		if target != "" {
			return "", false, fmt.Errorf("server %s accepts one target", action)
		}
		target = strings.TrimSpace(token)
	}
	if target == "" {
		return "", false, fmt.Errorf("server %s requires an id, name, or URL", action)
	}
	return target, jsonOutput, nil
}

func profileFlagValue(args []string, index int, flag string) (string, int, error) {
	if index+1 >= len(args) || strings.HasPrefix(args[index+1], "-") {
		return "", 0, fmt.Errorf("%s requires a value", flag)
	}
	return strings.TrimSpace(args[index+1]), 2, nil
}

func findServerProfile(store map[string]any, target string) map[string]any {
	normalized := strings.TrimRight(strings.TrimSpace(target), "/")
	for _, profile := range profileList(store) {
		id := textValueFromMap(profile, "id")
		name := textValueFromMap(profile, "name")
		endpoint := strings.TrimRight(textValueFromMap(profile, "endpoint"), "/")
		if id == normalized || name == normalized || endpoint == normalized {
			return profile
		}
	}
	return nil
}

func profileList(store map[string]any) []map[string]any {
	switch raw := store["profiles"].(type) {
	case []map[string]any:
		return raw
	case []any:
		profiles := make([]map[string]any, 0, len(raw))
		for _, item := range raw {
			if profile, ok := item.(map[string]any); ok {
				profiles = append(profiles, profile)
			}
		}
		return profiles
	default:
		return nil
	}
}

func sanitizeServerProfile(profile map[string]any, activeID string) map[string]any {
	id := textValueFromMap(profile, "id")
	return map[string]any{
		"id": id, "name": textValueFromMap(profile, "name"),
		"endpoint": textValueFromMap(profile, "endpoint"), "state": textValueFromMap(profile, "state"),
		"active":                  id == activeID,
		"managementKeyConfigured": textValueFromMap(profile, "managementKey") != "",
		"lastError":               textValueFromMap(profile, "lastError"),
	}
}

func textValueFromMap(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func writeProfileResult(runtime commandRuntime, action string, profile map[string]any, jsonOutput bool) error {
	if jsonOutput {
		return writeProfileJSON(runtime, map[string]any{"ok": true, "action": action, "profile": profile})
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] server %s: %s (%s)\n", action, profile["name"], profile["endpoint"])
	return nil
}

func writeProfileJSON(runtime commandRuntime, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
	return nil
}
