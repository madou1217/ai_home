package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

type serverSyncOptions struct {
	managementURL string
	key           string
	parallel      int
	limit         int
	dryRun        bool
	namePrefix    string
}

type codexCredential struct {
	accountRef string
	auth       map[string]any
}

func runServerSyncCodex(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) < 2 || arguments[0] != "server" || (arguments[1] != "sync-codex" && arguments[1] != "sync_codex") {
		return false, nil
	}
	options, err := parseServerSyncOptions(arguments[2:], runtime)
	if err != nil {
		return true, err
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return true, err
	}
	if options.key == "" {
		if configKey, readErr := readServerConfigForSync(ctx, home); readErr == nil {
			options.key = strings.TrimSpace(configKey)
		}
	}
	if options.key == "" {
		return true, errors.New("Missing management key. Use --key or env AIH_SERVER_MANAGEMENT_KEY.")
	}
	records, err := readCodexCredentials(ctx, home)
	if err != nil {
		return true, err
	}
	if options.limit > 0 && len(records) > options.limit {
		records = records[:options.limit]
	}
	scanned, eligible, uploaded, skippedInvalid, failed := 0, 0, 0, 0, 0
	firstError := ""
	var lock sync.Mutex
	workers := options.parallel
	if workers > len(records) {
		workers = len(records)
	}
	if workers < 1 {
		workers = 1
	}
	jobs := make(chan codexCredential)
	var wait sync.WaitGroup
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for record := range jobs {
				payload, ok := buildCodexUploadPayload(record.auth)
				lock.Lock()
				scanned++
				if !ok {
					skippedInvalid++
					lock.Unlock()
					continue
				}
				eligible++
				lock.Unlock()
				if options.dryRun {
					continue
				}
				if err := uploadCodexPayload(ctx, options, record.accountRef, payload); err != nil {
					lock.Lock()
					failed++
					if firstError == "" {
						firstError = err.Error()
					}
					lock.Unlock()
					continue
				}
				lock.Lock()
				uploaded++
				lock.Unlock()
			}
		}()
	}
	for _, record := range records {
		jobs <- record
	}
	close(jobs)
	wait.Wait()
	mode := "write"
	if options.dryRun {
		mode = "dry-run"
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] server sync-codex done (%s)\n", mode)
	_, _ = fmt.Fprintf(runtime.stdout, "  management: %s\n", options.managementURL)
	_, _ = fmt.Fprintf(runtime.stdout, "  scanned: %d\n", scanned)
	_, _ = fmt.Fprintf(runtime.stdout, "  eligible: %d\n", eligible)
	_, _ = fmt.Fprintf(runtime.stdout, "  uploaded: %d\n", uploaded)
	_, _ = fmt.Fprintf(runtime.stdout, "  invalid: %d\n", skippedInvalid)
	if !options.dryRun {
		_, _ = fmt.Fprintf(runtime.stdout, "  failed: %d\n", failed)
		if firstError != "" {
			_, _ = fmt.Fprintf(runtime.stdout, "  first_error: %s\n", firstError)
		}
	}
	if failed > 0 {
		return true, &cliExitError{code: 1}
	}
	return true, nil
}

func parseServerSyncOptions(args []string, runtime commandRuntime) (serverSyncOptions, error) {
	options := serverSyncOptions{
		managementURL: serverconfig.BaseURL(serverconfig.DefaultHost, serverconfig.DefaultPort, "/v0/management"),
		key:           strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_SERVER_MANAGEMENT_KEY")),
		parallel:      8,
		namePrefix:    "aih-codex-",
	}
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		switch token {
		case "--dry-run":
			options.dryRun = true
		case "--management-url":
			value, consumed, err := syncFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			options.managementURL = strings.TrimRight(value, "/")
			index += consumed - 1
		case "--key", "--management-key":
			value, consumed, err := syncFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			options.key = value
			index += consumed - 1
		case "--parallel", "-p":
			value, consumed, err := syncFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			parsed, parseErr := strconv.Atoi(value)
			if parseErr != nil {
				return options, errors.New("Invalid --parallel value")
			}
			options.parallel = parsed
			if options.parallel < 1 {
				options.parallel = 1
			}
			if options.parallel > 32 {
				options.parallel = 32
			}
			index += consumed - 1
		case "--limit":
			value, consumed, err := syncFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			parsed, parseErr := strconv.Atoi(value)
			if parseErr != nil || parsed < 0 {
				return options, errors.New("Invalid --limit value")
			}
			options.limit = parsed
			index += consumed - 1
		case "--name-prefix":
			value, consumed, err := syncFlagValue(args, index, token)
			if err != nil {
				return options, err
			}
			options.namePrefix = value
			index += consumed - 1
		default:
			return options, fmt.Errorf("Unknown option: %s", token)
		}
	}
	return options, nil
}

func syncFlagValue(args []string, index int, flag string) (string, int, error) {
	if index+1 >= len(args) || strings.TrimSpace(args[index+1]) == "" {
		return "", 0, fmt.Errorf("Invalid %s value", flag)
	}
	return strings.TrimSpace(args[index+1]), 2, nil
}

func readServerConfigForSync(ctx context.Context, home string) (string, error) {
	path, err := appstate.DatabasePath(home)
	if err != nil {
		return "", err
	}
	raw, found, err := appstate.ReadKV(ctx, path, appstate.KeyServerConfig)
	if err != nil || !found {
		return "", err
	}
	var config map[string]any
	if json.Unmarshal([]byte(raw), &config) != nil {
		return "", nil
	}
	value, _ := config["managementKey"].(string)
	return value, nil
}

func readCodexCredentials(ctx context.Context, home string) ([]codexCredential, error) {
	path := filepath.Join(strings.TrimSpace(home), "aih.db")
	db, err := appstate.OpenReadOnly(ctx, path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	query := "SELECT a.account_ref, c.credential_json " +
		"FROM account_credentials c " +
		"INNER JOIN accounts a ON a.account_ref = c.account_ref " +
		"WHERE a.provider_id = 'codex' " +
		"AND c.credential_json <> '{}' " +
		"ORDER BY a.account_ref"
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return nil, nil
		}
		return nil, err
	}
	defer rows.Close()
	records := make([]codexCredential, 0)
	for rows.Next() {
		var accountRef, raw string
		if err := rows.Scan(&accountRef, &raw); err != nil {
			return nil, err
		}
		var document map[string]any
		if json.Unmarshal([]byte(raw), &document) != nil {
			continue
		}
		native := document
		if inner, ok := document["native_auth_json"].(map[string]any); ok {
			native = inner
		} else if innerRaw, ok := document["native_auth_json"].(string); ok {
			var parsed map[string]any
			if json.Unmarshal([]byte(innerRaw), &parsed) == nil && parsed != nil {
				native = parsed
			}
		}
		auth, _ := native["auth"].(map[string]any)
		if auth == nil {
			auth = native
		}
		records = append(records, codexCredential{accountRef: accountRef, auth: auth})
	}
	return records, rows.Err()
}

func buildCodexUploadPayload(auth map[string]any) (map[string]any, bool) {
	tokens, _ := auth["tokens"].(map[string]any)
	if tokens == nil {
		return nil, false
	}
	refreshToken := codexText(tokens["refresh_token"])
	if refreshToken == "" || strings.ContainsAny(refreshToken, "\r\n\x00") {
		return nil, false
	}
	lastRefresh := codexText(auth["last_refresh"])
	if lastRefresh == "" || lastRefresh == "<nil>" {
		lastRefresh = time.Now().UTC().Format(time.RFC3339)
	}
	return map[string]any{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token":      codexText(tokens["id_token"]),
			"access_token":  codexText(tokens["access_token"]),
			"refresh_token": refreshToken,
			"account_id":    codexText(tokens["account_id"]),
		},
		"last_refresh": lastRefresh,
	}, true
}

func codexText(value any) string {
	if value == nil {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return strings.TrimSpace(fmt.Sprint(value))
	}
	return strings.TrimSpace(text)
}

func uploadCodexPayload(ctx context.Context, options serverSyncOptions, accountRef string, payload map[string]any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	name := options.namePrefix + accountRef + ".json"
	endpoint := options.managementURL + "/auth-files?name=" + url.QueryEscape(name)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+options.key)
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 200))
		return fmt.Errorf("HTTP %d %s", response.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

type cliExitError struct{ code int }

func (errorValue *cliExitError) Error() string { return "" }

func (errorValue *cliExitError) ExitCode() int { return errorValue.code }

func (errorValue *cliExitError) SilentExit() {}
