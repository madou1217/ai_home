package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

func runServerEnv(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) < 2 || arguments[0] != "server" || arguments[1] != "env" {
		return false, nil
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return true, err
	}
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, home)
	if err != nil {
		return true, err
	}
	host := strings.TrimSpace(config.Host)
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	baseURL := fmt.Sprintf("http://%s:%d/v1", host, config.Port)
	apiKey := strings.TrimSpace(config.APIKey)
	if apiKey == "" {
		apiKey, err = generateAPIKey()
		if err != nil {
			return true, err
		}
		if _, err := webuiserverconfigapi.ApplyConfigPatch(ctx, home, map[string]any{"apiKey": apiKey}); err != nil {
			return true, err
		}
	}
	rest := arguments[2:]
	for index := 0; index < len(rest); index++ {
		token := strings.TrimSpace(rest[index])
		switch token {
		case "--base-url":
			if index+1 >= len(rest) || strings.TrimSpace(rest[index+1]) == "" {
				return true, fmt.Errorf("Invalid --base-url value")
			}
			index++
			baseURL = strings.TrimSpace(rest[index])
		case "--api-key":
			if index+1 >= len(rest) || strings.TrimSpace(rest[index+1]) == "" {
				return true, fmt.Errorf("Invalid --api-key value")
			}
			index++
			apiKey = strings.TrimSpace(rest[index])
		default:
			return true, fmt.Errorf("Unknown option: %s", token)
		}
	}
	_, _ = fmt.Fprintf(runtime.stdout, "export OPENAI_BASE_URL=\"%s\"\n", baseURL)
	_, _ = fmt.Fprintf(runtime.stdout, "export OPENAI_API_KEY=\"%s\"\n", apiKey)
	return true, nil
}

func generateAPIKey() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "sk-" + hex.EncodeToString(raw), nil
}
