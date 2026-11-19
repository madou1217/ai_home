package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

const modelAliasManagementPath = "/v1/management/webui/model-aliases"

// resolveHarnessAliasArgs 在跨 Provider 钉选启动前把 --model 别名解析成真实模型。
//
// 网关对带 x-account-ref 的跨 Provider 请求不做 alias 改写，因此必须在启动器里
// 先把别名落到钉选账号能路由的目标；否则会把别名原样发给上游。
func resolveHarnessAliasArgs(
	ctx context.Context,
	client managementapi.HTTPClient,
	baseURL string,
	managementKey string,
	provider string,
	arguments []string,
) ([]string, error) {
	if client == nil || strings.TrimSpace(managementKey) == "" {
		return arguments, nil
	}
	aliases, err := fetchHarnessAliases(ctx, client, baseURL, managementKey)
	if err != nil {
		return nil, err
	}
	if len(aliases) == 0 {
		return arguments, nil
	}
	return rewriteModelFlagInArgs(arguments, func(value string) (string, error) {
		return resolveHarnessAlias(aliases, value, provider)
	})
}

func fetchHarnessAliases(
	ctx context.Context,
	client managementapi.HTTPClient,
	baseURL string,
	managementKey string,
) ([]modelalias.Record, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if !strings.HasSuffix(endpoint, "/v1") {
		endpoint += "/v1"
	}
	endpoint += "/management/webui/model-aliases"
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("model_alias_endpoint_invalid")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(managementKey))
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("model_alias_lookup_failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("model_alias_lookup_failed: HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return nil, fmt.Errorf("model_alias_lookup_failed: %w", err)
	}
	var payload struct {
		Aliases []modelalias.Record `json:"aliases"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("model_alias_lookup_failed: %w", err)
	}
	return payload.Aliases, nil
}

func resolveHarnessAlias(aliases []modelalias.Record, model, provider string) (string, error) {
	requested := strings.TrimSpace(model)
	scopeProvider := strings.ToLower(strings.TrimSpace(provider))
	if requested == "" || scopeProvider == "" {
		return model, nil
	}
	type match struct {
		target         string
		wildcard       bool
		prefix         int
		priority       int32
		order          int
		targetProvider string
	}
	matches := []match{}
	for index, record := range aliases {
		if !record.IsEnabled() || !record.IsValid() {
			continue
		}
		pattern := strings.TrimSpace(record.Alias)
		wildcard := strings.HasSuffix(pattern, "*")
		prefix := ""
		if wildcard {
			if strings.Count(pattern, "*") != 1 || len(strings.TrimSuffix(pattern, "*")) < 2 {
				continue
			}
			prefix = strings.TrimSuffix(pattern, "*")
			if !strings.HasPrefix(requested, prefix) {
				continue
			}
		} else if pattern != requested {
			continue
		}
		scope := strings.ToLower(strings.TrimSpace(record.ScopeProvider()))
		if scope != modelalias.ScopeAll && scope != scopeProvider {
			continue
		}
		matches = append(matches, match{
			target:         strings.TrimSpace(record.Target),
			wildcard:       wildcard,
			prefix:         len(prefix),
			priority:       record.Priority,
			order:          index,
			targetProvider: strings.ToLower(strings.TrimSpace(record.ResolvedTargetProvider())),
		})
	}
	if len(matches) == 0 {
		return model, nil
	}
	best := matches[0]
	for _, candidate := range matches[1:] {
		if best.wildcard != candidate.wildcard {
			if !candidate.wildcard {
				best = candidate
			}
			continue
		}
		if candidate.prefix != best.prefix {
			if candidate.prefix > best.prefix {
				best = candidate
			}
			continue
		}
		if candidate.priority != best.priority {
			if candidate.priority > best.priority {
				best = candidate
			}
			continue
		}
		if candidate.order < best.order {
			best = candidate
		}
	}
	if best.target == "" {
		return model, nil
	}
	if best.targetProvider != "" && best.targetProvider != modelalias.TargetProviderAuto && best.targetProvider != scopeProvider {
		return "", fmt.Errorf("model_alias_target_provider_mismatch: alias targets %s, pinned provider is %s", best.targetProvider, scopeProvider)
	}
	return best.target, nil
}

func rewriteModelFlagInArgs(args []string, resolve func(string) (string, error)) ([]string, error) {
	next := append([]string(nil), args...)
	for index := 0; index < len(next); index++ {
		token := next[index]
		if token == "--" {
			break
		}
		if token == "--model" {
			if index+1 < len(next) {
				resolved, err := resolve(next[index+1])
				if err != nil {
					return nil, err
				}
				next[index+1] = resolved
			}
			continue
		}
		if strings.HasPrefix(token, "--model=") {
			resolved, err := resolve(strings.TrimPrefix(token, "--model="))
			if err != nil {
				return nil, err
			}
			next[index] = "--model=" + resolved
		}
	}
	return next, nil
}
