package pluginartifact

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateManifestAcceptsContractExample(t *testing.T) {
	manifest := validTestManifest()
	normalized, err := ValidateManifest(manifest, ManifestOptions{
		HostVersion: "1.0.0",
		NodeVersion: "22.14.0",
		Target:      "darwin-arm64",
	})
	if err != nil {
		t.Fatalf("合法清单被拒绝: %v", err)
	}
	if normalized["pluginId"] != "aih.test.echo" || normalized["version"] != "1.0.0" {
		t.Fatalf("规范化清单字段不符: %+v", normalized)
	}
	if _, present := normalized["permissions"]; present {
		t.Fatalf("无授权清单不应凭空生成 permissions: %+v", normalized)
	}
	if PermissionFingerprint(normalized) != "" {
		t.Fatal("无 permissions 的指纹必须为空")
	}
}

func TestValidateManifestRejectsViolations(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(map[string]any)
		options ManifestOptions
		code    string
	}{
		{
			name: "入口绝对路径",
			mutate: func(manifest map[string]any) {
				manifest["entry"] = "/index.mjs"
			},
			code: codeEntryInvalid,
		},
		{
			name: "版本不是严格 semver",
			mutate: func(manifest map[string]any) {
				manifest["version"] = "1.0"
			},
			code: codeVersionInvalid,
		},
		{
			name: "宿主版本不满足",
			mutate: func(manifest map[string]any) {
				manifest["engines"] = map[string]any{"aih": ">=2.0.0"}
			},
			code: codeHostIncompatible,
		},
		{
			name: "Node 版本不满足",
			mutate: func(manifest map[string]any) {
				manifest["engines"] = map[string]any{"aih": ">=1.0.0", "node": ">=24"}
			},
			options: ManifestOptions{HostVersion: "1.0.0", NodeVersion: "22.14.0", Target: "darwin-arm64"},
			code:    codeNodeIncompatible,
		},
		{
			name: "缺宿主 Node 版本时 fail closed",
			mutate: func(manifest map[string]any) {
				manifest["engines"] = map[string]any{"aih": ">=1.0.0", "node": ">=22"}
			},
			options: ManifestOptions{HostVersion: "1.0.0", Target: "darwin-arm64"},
			code:    codeNodeIncompatible,
		},
		{
			name: "平台不匹配",
			mutate: func(manifest map[string]any) {
				manifest["targets"] = []any{"linux-x64"}
			},
			options: ManifestOptions{HostVersion: "1.0.0", NodeVersion: "22.14.0", Target: "darwin-arm64"},
			code:    codePlatformIncompatible,
		},
		{
			name: "未知能力",
			mutate: func(manifest map[string]any) {
				manifest["contributes"] = []any{
					map[string]any{"id": "aih.test.echo.run", "capability": "no.such", "version": number(1)},
				}
			},
			code: codeCapabilityIncompatible,
		},
		{
			name: "能力版本不匹配",
			mutate: func(manifest map[string]any) {
				manifest["contributes"] = []any{
					map[string]any{"id": "aih.test.echo.run", "capability": "command", "version": number(2)},
				}
			},
			code: codeCapabilityIncompatible,
		},
		{
			name: "贡献项 id 重复",
			mutate: func(manifest map[string]any) {
				manifest["contributes"] = []any{
					map[string]any{"id": "aih.test.echo.run", "capability": "command", "version": number(1)},
					map[string]any{"id": "aih.test.echo.run", "capability": "command", "version": number(1)},
				}
			},
			code: codeContributionDuplicate,
		},
		{
			name: "提供宿主服务名 aih",
			mutate: func(manifest map[string]any) {
				manifest["provides"] = []any{map[string]any{"name": "aih", "version": "1.0.0"}}
			},
			code: codeServiceDuplicate,
		},
		{
			name: "服务版本无效",
			mutate: func(manifest map[string]any) {
				manifest["provides"] = []any{map[string]any{"name": "svc", "version": "1.0"}}
			},
			code: codeServiceVersionInvalid,
		},
		{
			name: "依赖重复",
			mutate: func(manifest map[string]any) {
				manifest["requires"] = []any{
					map[string]any{"name": "svc", "versionRange": "^1.0.0"},
					map[string]any{"name": "svc", "versionRange": "^2.0.0"},
				}
			},
			code: codeRequirementDuplicate,
		},
		{
			name: "依赖区间无效",
			mutate: func(manifest map[string]any) {
				manifest["requires"] = []any{map[string]any{"name": "svc", "versionRange": "not-a-range"}}
			},
			code: codeServiceVersionInvalid,
		},
		{
			name: "配置 schema 使用未实现关键字",
			mutate: func(manifest map[string]any) {
				manifest["configSchema"] = map[string]any{"type": "object", "format": "email"}
			},
			code: codeConfigSchemaInvalid,
		},
		{
			name: "账号能力缺 permissions",
			mutate: func(manifest map[string]any) {
				manifest["contributes"] = []any{
					map[string]any{"id": "aih.test.echo.login", "capability": "account.login", "version": number(1)},
				}
			},
			code: codePermissionsRequired,
		},
		{
			name: "网络权限带查询串",
			mutate: func(manifest map[string]any) {
				manifest["permissions"] = map[string]any{
					"network":    []any{"https://api.example.com?token=1"},
					"filesystem": map[string]any{"read": []any{}, "write": []any{}},
					"secrets":    []any{},
				}
			},
			code: codePermissionNetworkInvalid,
		},
		{
			name: "网络权限带用户信息",
			mutate: func(manifest map[string]any) {
				manifest["permissions"] = map[string]any{
					"network":    []any{"https://user@api.example.com"},
					"filesystem": map[string]any{"read": []any{}, "write": []any{}},
					"secrets":    []any{},
				}
			},
			code: codePermissionNetworkInvalid,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			manifest := cloneJSON(t, validTestManifest())
			testCase.mutate(manifest)
			options := testCase.options
			if options.HostVersion == "" {
				options = ManifestOptions{HostVersion: "1.0.0", NodeVersion: "22.14.0", Target: "darwin-arm64"}
			}
			_, err := ValidateManifest(manifest, options)
			requireErrorCode(t, err, testCase.code)
		})
	}
}

func TestValidateManifestNormalizesPermissions(t *testing.T) {
	manifest := validTestManifest()
	manifest["permissions"] = map[string]any{
		"network":    []any{"https://api.example.com"},
		"filesystem": map[string]any{"read": []any{"state"}, "write": []any{"state"}},
		"secrets":    []any{"api_key"},
	}
	normalized, err := ValidateManifest(manifest, ManifestOptions{
		HostVersion: "1.0.0",
		NodeVersion: "22.14.0",
		Target:      "any",
	})
	if err != nil {
		t.Fatalf("合法权限被拒绝: %v", err)
	}
	permissions := normalized["permissions"].(normalizedPermissions)
	if len(permissions.Environment) != 0 {
		t.Fatalf("environment 应补为空数组: %+v", permissions)
	}
	fingerprint := PermissionFingerprint(normalized)
	if len(fingerprint) != 16 {
		t.Fatalf("指纹长度 = %d, want 16", len(fingerprint))
	}
	// 同一份权限重复计算必须稳定（状态记录会持久化这个值）。
	if again := PermissionFingerprint(normalized); again != fingerprint {
		t.Fatalf("指纹不稳定: %s != %s", fingerprint, again)
	}
}

func TestCompileSchemaSubset(t *testing.T) {
	valid := []string{
		`{"type":"object"}`,
		`{"type":"object","properties":{"token":{"type":"string","minLength":2}},"required":["token"],"additionalProperties":false}`,
		`{"type":"array","items":{"type":"integer"},"uniqueItems":true}`,
		`{"definitions":{"text":{"type":"string"}},"type":"object","properties":{"name":{"$ref":"#/definitions/text"}}}`,
		`{"anyOf":[{"type":"string"},{"type":"number"}]}`,
	}
	for _, document := range valid {
		if _, err := CompileSchema([]byte(document)); err != nil {
			t.Fatalf("合法 schema 被拒绝: %s: %v", document, err)
		}
	}
	invalid := []string{
		`{"type":"object","format":"email"}`,
		`{"type":"object","properties":{"a":{"type":"string"},"b":{"type":"unknown"}}}`,
		`{"type":"array","items":[{"type":"string"}]}`,
		`{"type":"object","properties":{"a":{"$ref":"#/definitions/missing"}}}`,
		`{"type":"object","patternProperties":{"^x":{"type":"string"}}}`,
	}
	for _, document := range invalid {
		if _, err := CompileSchema([]byte(document)); err == nil {
			t.Fatalf("未实现的 schema 没有 fail closed: %s", document)
		}
	}
}

func TestSchemaValidateValues(t *testing.T) {
	schema, err := CompileSchema([]byte(`{"type":"object","properties":{"name":{"type":"string","minLength":2},"count":{"type":"integer","minimum":1}},"required":["name"],"additionalProperties":false}`))
	if err != nil {
		t.Fatalf("编译 schema 失败: %v", err)
	}
	decode := func(text string) any {
		var value any
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			t.Fatalf("解码失败: %v", err)
		}
		return value
	}
	if err := schema.Validate(decode(`{"name":"ok","count":2}`)); err != nil {
		t.Fatalf("合法值被拒绝: %v", err)
	}
	for _, text := range []string{
		`{"count":2}`,
		`{"name":"x"}`,
		`{"name":"ok","count":1.5}`,
		`{"name":"ok","extra":1}`,
	} {
		if err := schema.Validate(decode(text)); err == nil {
			t.Fatalf("非法值被接受: %s", text)
		}
	}
}
