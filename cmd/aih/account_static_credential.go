package main

import (
	"fmt"
	"io"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// staticCredentialFromEnvironment 为账号新增和轮换统一解析官方静态凭据变量。
//
// 环境变量名来自 Provider 合同（CredentialFacts），可接受的凭据类型来自账号
// HTTP 契约，本函数不再按 Provider 名写分支：新增 Provider 只需改合同与契约，
// 命令侧无需同步维护第二份名单。
func staticCredentialFromEnvironment(
	providerID string,
	lookupEnv func(string) (string, bool),
) (managementapi.StaticCredentialInput, error) {
	definition, found := providerDefinition(providerID)
	if !found {
		return managementapi.StaticCredentialInput{}, unsupportedStaticCredentialError(providerID)
	}
	facts := definition.CredentialFacts()
	supportsAPIKey := len(facts.APIKeyEnv) > 0 &&
		accountcontract.SupportsStaticCredential(definition.ID, accountcontract.StaticCredentialAPIKey)
	supportsAuthToken := len(facts.AuthTokenEnv) > 0 &&
		accountcontract.SupportsStaticCredential(definition.ID, accountcontract.StaticCredentialAuthToken)

	var apiKey string
	var hasAPIKey bool
	if supportsAPIKey {
		apiKey, hasAPIKey = firstNonEmptyEnvironment(lookupEnv, facts.APIKeyEnv)
	}
	var authToken string
	var hasAuthToken bool
	if supportsAuthToken {
		authToken, hasAuthToken = firstNonEmptyEnvironment(lookupEnv, facts.AuthTokenEnv)
	}
	baseURL, _ := firstNonEmptyEnvironment(lookupEnv, facts.BaseURLEnv)

	switch {
	case supportsAPIKey && supportsAuthToken:
		if hasAPIKey && hasAuthToken {
			return managementapi.StaticCredentialInput{}, fmt.Errorf(
				"%w: %s 与 %s 不能同时提供",
				errInvalidCommand,
				facts.APIKeyEnv[0],
				facts.AuthTokenEnv[0],
			)
		}
		if !hasAPIKey && !hasAuthToken {
			return managementapi.StaticCredentialInput{}, fmt.Errorf(
				"%w: 静态凭据需要 %s 或 %s",
				errInvalidCommand,
				facts.APIKeyEnv[0],
				facts.AuthTokenEnv[0],
			)
		}
	case supportsAPIKey:
		if !hasAPIKey {
			return managementapi.StaticCredentialInput{}, fmt.Errorf(
				"%w: 静态凭据需要 %s",
				errInvalidCommand,
				facts.APIKeyEnv[0],
			)
		}
	case supportsAuthToken:
		if !hasAuthToken {
			return managementapi.StaticCredentialInput{}, fmt.Errorf(
				"%w: 静态凭据需要 %s",
				errInvalidCommand,
				facts.AuthTokenEnv[0],
			)
		}
	default:
		return managementapi.StaticCredentialInput{}, unsupportedStaticCredentialError(providerID)
	}

	if hasAPIKey {
		return managementapi.StaticCredentialInput{
			Kind:    string(accountcontract.StaticCredentialAPIKey),
			APIKey:  apiKey,
			BaseURL: baseURL,
		}, nil
	}
	return managementapi.StaticCredentialInput{
		Kind:      string(accountcontract.StaticCredentialAuthToken),
		AuthToken: authToken,
		BaseURL:   baseURL,
	}, nil
}

// unsupportedStaticCredentialError 报告该 Provider 没有静态凭据更新面。
func unsupportedStaticCredentialError(providerID string) error {
	return fmt.Errorf(
		"%w: Provider %s 不支持静态凭据更新",
		errInvalidCommand,
		providerID,
	)
}

// firstNonEmptyEnvironment 按合同声明的优先级返回第一个有效非空变量。
func firstNonEmptyEnvironment(
	lookupEnv func(string) (string, bool),
	names []string,
) (string, bool) {
	for _, name := range names {
		if value, found := nonEmptyEnvironment(lookupEnv, name); found {
			return value, true
		}
	}
	return "", false
}

// nonEmptyEnvironment 区分未提供与有效非空环境变量，不修改敏感原值。
func nonEmptyEnvironment(
	lookupEnv func(string) (string, bool),
	name string,
) (string, bool) {
	value, found := lookupEnv(name)
	return value, found && strings.TrimSpace(value) != ""
}

// writeStaticCredentialEnvironmentHelp 按账号 HTTP 契约输出支持的 Provider 与官方变量。
//
// 帮助文本与解析逻辑读同一份事实，避免出现「帮助里写了某变量、实际却读另一个」。
func writeStaticCredentialEnvironmentHelp(output io.Writer) {
	_, _ = fmt.Fprintln(output, "Provider 官方环境变量:")
	for _, providerID := range accountcontract.StaticCredentialProviders() {
		definition, found := providerDefinition(providerID)
		if !found {
			continue
		}
		line := staticCredentialEnvironmentLine(definition)
		if line == "" {
			continue
		}
		_, _ = fmt.Fprintf(output, "  %-7s %s\n", providerID+":", line)
	}
}

// staticCredentialEnvironmentLine 描述一个 Provider 的官方凭据变量与可选基地址。
func staticCredentialEnvironmentLine(definition providers.Definition) string {
	facts := definition.CredentialFacts()
	var apiKey string
	if len(facts.APIKeyEnv) > 0 &&
		accountcontract.SupportsStaticCredential(definition.ID, accountcontract.StaticCredentialAPIKey) {
		apiKey = facts.APIKeyEnv[0]
	}
	var authToken string
	if len(facts.AuthTokenEnv) > 0 &&
		accountcontract.SupportsStaticCredential(definition.ID, accountcontract.StaticCredentialAuthToken) {
		authToken = facts.AuthTokenEnv[0]
	}
	var line string
	switch {
	case apiKey != "" && authToken != "":
		line = apiKey + " 或 " + authToken + "（二选一）"
	case apiKey != "":
		line = apiKey
	case authToken != "":
		line = authToken
	default:
		return ""
	}
	if len(facts.BaseURLEnv) > 0 {
		line += "，" + facts.BaseURLEnv[0] + "（可选）"
	}
	return line
}
