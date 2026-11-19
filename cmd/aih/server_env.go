package main

import (
	"context"
	"fmt"
	"strings"
)

func runServerEnv(_ context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) < 2 || arguments[0] != "server" || arguments[1] != "env" {
		return false, nil
	}
	baseURL := "http://127.0.0.1:9527/v1"
	apiKey := "dummy"
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
