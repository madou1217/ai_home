package main

import (
	"fmt"
	"path"
	"strconv"
	"strings"
)

type lsArguments struct {
	Help       bool
	Scope      []string
	FilterID   int64
	Positional []string
}

func parseLSArguments(arguments []string) (lsArguments, error) {
	parsed := lsArguments{}
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		if token == "" {
			continue
		}
		if token == "--scope" {
			index++
			for index < len(arguments) {
				next := strings.TrimSpace(arguments[index])
				if next == "" || strings.HasPrefix(next, "-") || isNumericLSToken(next) {
					index--
					break
				}
				for _, piece := range strings.Split(next, ",") {
					if value := strings.TrimSpace(piece); value != "" {
						parsed.Scope = append(parsed.Scope, value)
					}
				}
				index++
			}
			if len(parsed.Scope) == 0 {
				return parsed, fmt.Errorf("%w: --scope 至少需要一个 Provider", errInvalidCommand)
			}
			continue
		}
		if strings.HasPrefix(token, "--scope=") {
			value := strings.TrimSpace(strings.TrimPrefix(token, "--scope="))
			if value == "" {
				return parsed, fmt.Errorf("%w: --scope 至少需要一个 Provider", errInvalidCommand)
			}
			for _, piece := range strings.Split(value, ",") {
				if trimmed := strings.TrimSpace(piece); trimmed != "" {
					parsed.Scope = append(parsed.Scope, trimmed)
				}
			}
			if len(parsed.Scope) == 0 {
				return parsed, fmt.Errorf("%w: --scope 至少需要一个 Provider", errInvalidCommand)
			}
			continue
		}
		parsed.Positional = append(parsed.Positional, token)
	}
	if len(parsed.Positional) > 0 {
		first := strings.TrimSpace(parsed.Positional[0])
		if first == "--help" || first == "-h" || first == "help" {
			parsed.Help = true
			return parsed, nil
		}
		if isNumericLSToken(first) {
			value, err := strconv.ParseInt(first, 10, 64)
			if err != nil || value <= 0 {
				return parsed, fmt.Errorf("%w: 账号 ID 必须是正整数", errInvalidCommand)
			}
			parsed.FilterID = value
			return parsed, nil
		}
	}
	return parsed, nil
}

func isNumericLSToken(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func matchLSProviders(patterns []string, providers []string) ([]string, error) {
	matched := make([]string, 0)
	seen := make(map[string]bool)
	unmatched := make([]string, 0)
	for _, pattern := range patterns {
		hits := matchLSProviderSelector(pattern, providers)
		if len(hits) == 0 {
			unmatched = append(unmatched, pattern)
			continue
		}
		for _, hit := range hits {
			if !seen[hit] {
				seen[hit] = true
				matched = append(matched, hit)
			}
		}
	}
	if len(unmatched) > 0 {
		return nil, fmt.Errorf("%w: %s", errInvalidCommand, describeLSScopeMiss(unmatched, providers))
	}
	return matched, nil
}

func matchLSProviderSelector(pattern string, providers []string) []string {
	token := strings.ToLower(strings.TrimSpace(pattern))
	if token == "" {
		return nil
	}
	if strings.ContainsAny(token, "*?") {
		result := make([]string, 0)
		for _, provider := range providers {
			if ok, _ := path.Match(token, strings.ToLower(provider)); ok {
				result = append(result, provider)
			}
		}
		return result
	}
	for _, provider := range providers {
		if strings.EqualFold(provider, token) {
			return []string{provider}
		}
	}
	if len(token) < 2 {
		return nil
	}
	result := make([]string, 0)
	for _, provider := range providers {
		if strings.Contains(strings.ToLower(provider), token) {
			result = append(result, provider)
		}
	}
	return result
}

func describeLSScopeMiss(unmatched []string, providers []string) string {
	quoted := make([]string, 0, len(unmatched))
	for _, item := range unmatched {
		quoted = append(quoted, fmt.Sprintf("%q", item))
	}
	message := fmt.Sprintf("No provider matches %s. Known providers: %s", strings.Join(quoted, ", "), strings.Join(providers, ", "))
	if len(unmatched) == 1 {
		core := strings.Trim(strings.TrimSpace(unmatched[0]), "*?")
		if len(core) >= 2 {
			if hits := matchLSProviderSelector(core, providers); len(hits) > 0 {
				message += fmt.Sprintf("\n       Did you mean %q (no quotes or wildcards needed)? It matches %s.", core, strings.Join(hits, ", "))
			}
		}
	}
	return message
}

func lsProviderNames() []string {
	return append([]string(nil), lsProviderOrder()...)
}
