package nativeresources

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeRunner struct {
	nodeBin string
	calls   int32
	handler func(command string, args []string, cwd string, env map[string]string) CommandExecResult
}

func (f *fakeRunner) Run(_ context.Context, command string, args []string, cwd string, env map[string]string, _ time.Duration) CommandExecResult {
	atomic.AddInt32(&f.calls, 1)
	if f.handler != nil {
		return f.handler(command, args, cwd, env)
	}
	return CommandExecResult{ExitCode: 0, Stdout: "1.0.0\n"}
}

func (f *fakeRunner) FindNode() string {
	return f.nodeBin
}

func setupTestDirs(t *testing.T) (aiHome, hostHome, demoRoot string) {
	t.Helper()
	base := t.TempDir()
	aiHome = filepath.Join(base, "aihome")
	hostHome = filepath.Join(base, "hosthome")
	demoRoot = filepath.Join(base, "repo")
	for _, d := range []string{aiHome, hostHome, demoRoot} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return aiHome, hostHome, demoRoot
}

func TestDoctorCapabilitiesAndSWRCache(t *testing.T) {
	aiHome, hostHome, demoRoot := setupTestDirs(t)
	runner := &fakeRunner{nodeBin: "/usr/local/bin/node"}
	svc, err := NewService(Config{
		AIHomeDir:       aiHome,
		HostHomeDir:     hostHome,
		DemoRoot:        demoRoot,
		Env:             map[string]string{"PATH": ""},
		Runner:          runner,
		SkipDoctorProbe: true,
	})
	if err != nil {
		t.Fatalf("NewService 失败: %v", err)
	}

	ctx := context.Background()
	rep1, err := svc.Report(ctx)
	if err != nil {
		t.Fatalf("首次 Report 失败: %v", err)
	}
	if !rep1.OK || rep1.DemoSources["skill"] != "assets/provider-skills/aih-demo" {
		t.Fatalf("Report 基础字段异常: %+v", rep1)
	}
	if len(rep1.Providers) == 0 || len(rep1.Hosts) < 3 {
		t.Fatalf("providers=%d hosts=%d 数量不符合预期", len(rep1.Providers), len(rep1.Hosts))
	}

	// 验证 Codex / Gemini / DeepSeek 能力边界声明
	var foundCodex, foundAgy bool
	for _, p := range rep1.Providers {
		if p.Provider == "codex" {
			foundCodex = true
			if p.Resources["skill"].State != "supported" || p.Resources["mcp"].State != "projection-only" {
				t.Fatalf("codex 能力声明不匹配: %+v", p.Resources)
			}
		}
		if p.Provider == "agy" {
			foundAgy = true
			if p.Resources["skill"].State != "projection-only" || p.Resources["skill"].Mode != "projection-only" {
				t.Fatalf("antigravity 能力声明不匹配: %+v", p.Resources["skill"])
			}
		}
	}
	if !foundCodex || !foundAgy {
		t.Fatalf("缺少核心 provider: codex=%v agy=%v", foundCodex, foundAgy)
	}

	// 验证 SWR 缓存命中，不会重复刷新
	rep2, err := svc.Report(ctx)
	if err != nil || rep2.Source != rep1.Source {
		t.Fatalf("二次 Report 异常: err=%v source=%q", err, rep2.Source)
	}
}

func TestSkillNativeAndProjectionLifecycle(t *testing.T) {
	aiHome, hostHome, demoRoot := setupTestDirs(t)

	// 创建示例 Skill 包（带 Frontmatter 与多文件）
	skillSrc := filepath.Join(demoRoot, "assets/provider-skills/aih-collab")
	if err := os.MkdirAll(filepath.Join(skillSrc, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	skillMD := "---\nname: aih-collab\ndescription: Cross model collaboration\n---\nAlways use subagents wisely.\n"
	if err := os.WriteFile(filepath.Join(skillSrc, "SKILL.md"), []byte(skillMD), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillSrc, "scripts/helper.sh"), []byte("#!/bin/sh\necho ok\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	svc, err := NewService(Config{
		AIHomeDir:       aiHome,
		HostHomeDir:     hostHome,
		DemoRoot:        demoRoot,
		Env:             map[string]string{"PATH": ""},
		Runner:          &fakeRunner{},
		SkipDoctorProbe: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// 1) Native directory skill (codex)
	opRes, err := svc.Operate(ctx, OperateInput{
		Kind:     "skill",
		Action:   "install",
		Provider: "codex",
		Source:   "assets/provider-skills/aih-collab",
	})
	if err != nil {
		t.Fatalf("codex skill install 失败: %v", err)
	}
	installedSkill := filepath.Join(hostHome, ".codex/skills/aih-collab/SKILL.md")
	if _, err := os.Stat(installedSkill); err != nil {
		t.Fatalf("codex 技能文件未投影到原生目录: %v", err)
	}
	if len(opRes.Report.Managed.Skill) != 1 || opRes.Report.Managed.Skill[0].Target != "aih-collab" {
		t.Fatalf("managed skill 汇总异常: %+v", opRes.Report.Managed.Skill)
	}

	// Disable -> 原生目录被删除，记录保留 disabled
	if _, err := svc.Operate(ctx, OperateInput{Kind: "skill", Action: "disable", Provider: "codex", ID: "aih-collab"}); err != nil {
		t.Fatalf("skill disable 失败: %v", err)
	}
	if _, err := os.Stat(filepath.Join(hostHome, ".codex/skills/aih-collab")); !os.IsNotExist(err) {
		t.Fatalf("disable 后原生目录应被删除")
	}

	// Enable -> 从 snapshot 恢复
	if _, err := svc.Operate(ctx, OperateInput{Kind: "skill", Action: "enable", Provider: "codex", ID: "aih-collab"}); err != nil {
		t.Fatalf("skill enable 失败: %v", err)
	}
	if _, err := os.Stat(installedSkill); err != nil {
		t.Fatalf("enable 后未恢复: %v", err)
	}

	// 篡改目标文件应拒绝 remove
	if err := os.WriteFile(installedSkill, []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Operate(ctx, OperateInput{Kind: "skill", Action: "remove", Provider: "codex", ID: "aih-collab"}); err == nil || err.Error() != "skill_target_modified" {
		t.Fatalf("期望 skill_target_modified，实际: %v", err)
	}

	// 2) Projection-only instruction block (antigravity -> ~/.gemini/GEMINI.md) + legacy adoption
	geminiMD := filepath.Join(hostHome, ".gemini/GEMINI.md")
	if err := os.MkdirAll(filepath.Dir(geminiMD), 0o700); err != nil {
		t.Fatal(err)
	}
	legacyContent := "# User Rules\n<!-- aih-collab:v1:begin -->\nAlways use subagents wisely.\n<!-- aih-collab:end -->\n"
	if err := os.WriteFile(geminiMD, []byte(legacyContent), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.skills.install(ctx, skillSrc, "agy", skillSrc, false); err != nil {
		t.Fatalf("antigravity legacy adopt 失败: %v", err)
	}
	updatedMD, _ := os.ReadFile(geminiMD)
	if !strings.Contains(string(updatedMD), "<!-- aih-skill:aih-collab:begin -->") || !strings.Contains(string(updatedMD), "# User Rules") {
		t.Fatalf("legacy 块迁移异常: %q", string(updatedMD))
	}

	// 越权路径必须被拒绝 (400 native_resource_source_forbidden)
	if _, err := svc.Operate(ctx, OperateInput{
		Kind:     "skill",
		Action:   "install",
		Provider: "codex",
		Source:   "../../etc/passwd",
	}); err == nil || err.Error() != "native_resource_source_forbidden" {
		t.Fatalf("期望 native_resource_source_forbidden，实际: %v", err)
	}
}

func TestPluginAdaptersAndPortableHost(t *testing.T) {
	aiHome, hostHome, demoRoot := setupTestDirs(t)

	// 构建通用插件包（兼容 gemini / opencode / deepseek host）
	pluginSrc := filepath.Join(demoRoot, "examples/native-plugins/aih-demo")
	if err := os.MkdirAll(filepath.Join(pluginSrc, "dist"), 0o700); err != nil {
		t.Fatal(err)
	}
	pkgJSON := map[string]any{
		"name":        "@aih/demo-plugin",
		"version":     "1.2.3",
		"description": "Demo plugin",
		"exports": map[string]any{
			"./deepseek": "./dist/deepseek.js",
		},
		"dsh": map[string]any{
			"bundle": map[string]any{
				"patch": "./patch.yml",
			},
		},
		"agentPlugin": map[string]any{
			"pluginId":        "aih-demo",
			"manifestVersion": 1,
			"engines": map[string]any{
				"deepseek": ">=1.0.0",
			},
		},
	}
	pkgBytes, _ := json.MarshalIndent(pkgJSON, "", "  ")
	_ = os.WriteFile(filepath.Join(pluginSrc, "package.json"), pkgBytes, 0o600)
	_ = os.WriteFile(filepath.Join(pluginSrc, "dist/deepseek.js"), []byte("export default {};\n"), 0o600)
	_ = os.WriteFile(filepath.Join(pluginSrc, "gemini-extension.json"), []byte(`{"name":"aih-demo","version":"1.2.3"}`), 0o600)
	_ = os.WriteFile(filepath.Join(pluginSrc, "patch.yml"), []byte("- insert:\n    - id: aih-demo\n      name: \"@aih/demo-plugin/deepseek\"\n      config:\n        enabled: true\n"), 0o600)

	svc, err := NewService(Config{
		AIHomeDir:       aiHome,
		HostHomeDir:     hostHome,
		DemoRoot:        demoRoot,
		Env:             map[string]string{"PATH": ""},
		Runner:          &fakeRunner{},
		SkipDoctorProbe: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// 1) Gemini extension adapter
	if _, err := svc.Operate(ctx, OperateInput{
		Kind:     "plugin",
		Action:   "install",
		Provider: "gemini",
	}); err != nil {
		t.Fatalf("gemini plugin install 失败: %v", err)
	}
	if _, err := os.Stat(filepath.Join(hostHome, ".gemini/extensions/aih-demo/gemini-extension.json")); err != nil {
		t.Fatalf("gemini 扩展目录缺失: %v", err)
	}

	// 2) OpenCode local JSONC adapter (预先写入带注释的 opencode.jsonc)
	ocDir := filepath.Join(hostHome, ".config/opencode")
	_ = os.MkdirAll(ocDir, 0o700)
	_ = os.WriteFile(filepath.Join(ocDir, "opencode.jsonc"), []byte("{\n  // user config\n  \"theme\": \"dark\",\n}\n"), 0o600)
	if _, err := svc.Operate(ctx, OperateInput{Kind: "plugin", Action: "install", Provider: "opencode"}); err != nil {
		t.Fatalf("opencode plugin install 失败: %v", err)
	}
	ocRaw, _ := os.ReadFile(filepath.Join(ocDir, "opencode.jsonc"))
	if !strings.Contains(string(ocRaw), "plugins/aih-demo") {
		t.Fatalf("opencode.jsonc 未写入 plugin 路径: %s", string(ocRaw))
	}

	// 3) DeepSeek host portable + cordis-patch adapter
	resDS, err := svc.Operate(ctx, OperateInput{Kind: "plugin", Action: "install", Host: "deepseek"})
	if err != nil {
		t.Fatalf("deepseek host plugin install 失败: %v", err)
	}
	patchFile := filepath.Join(aiHome, "managed-resources/native-plugin-patches/deepseek/aih-demo.yml")
	patchRaw, err := os.ReadFile(patchFile)
	if err != nil || !strings.Contains(string(patchRaw), "file://") || !strings.Contains(string(patchRaw), ".dsh/plugins/aih-demo/dist/deepseek.js") {
		t.Fatalf("cordis patch YAML 输出异常: err=%v body=%q", err, string(patchRaw))
	}
	if _, err := svc.Operate(ctx, OperateInput{Kind: "plugin", Action: "remove", Host: "deepseek", ID: "aih-demo"}); err != nil {
		t.Fatalf("deepseek host plugin remove 失败: %v (res=%+v)", err, resDS.Result)
	}
	if _, err := os.Stat(patchFile); !os.IsNotExist(err) {
		t.Fatalf("remove 后 patch 文件应被移除")
	}

	// 4) Codex marketplace adapter (mock CLI)
	codexMock := &fakeRunner{
		handler: func(command string, args []string, _ string, env map[string]string) CommandExecResult {
			cacheTarget := filepath.Join(env["CODEX_HOME"], "plugins/cache/aih-local/aih-demo/1.2.3")
			if len(args) >= 3 && args[0] == "plugin" && args[1] == "marketplace" && args[2] == "list" {
				if _, err := os.Stat(filepath.Join(aiHome, "managed-resources/native-plugin-marketplaces/aih-demo/.agents/plugins/marketplace.json")); err == nil &&
					env["TEST_ADDED"] == "" {
					return CommandExecResult{Stdout: `{"marketplaces":[]}`}
				}
				return CommandExecResult{Stdout: `{"marketplaces":[]}`}
			}
			if len(args) >= 3 && args[0] == "plugin" && args[1] == "list" {
				if _, err := os.Stat(cacheTarget); err == nil {
					return CommandExecResult{Stdout: `{"installed":[{"pluginId":"aih-demo@aih-local"}]}`}
				}
				return CommandExecResult{Stdout: `{"installed":[]}`}
			}
			if len(args) >= 2 && args[0] == "plugin" && args[1] == "add" {
				pkg, _ := readPluginPackage(pluginSrc)
				_ = copyPluginPackage(pkg, cacheTarget)
				out, _ := json.Marshal(map[string]any{"installedPath": cacheTarget})
				return CommandExecResult{Stdout: string(out)}
			}
			return CommandExecResult{Stdout: `{}`}
		},
	}
	svcCodex, err := NewService(Config{
		AIHomeDir:       aiHome,
		HostHomeDir:     hostHome,
		DemoRoot:        demoRoot,
		Env:             map[string]string{"PATH": ""},
		Runner:          codexMock,
		NativeBinaries:  map[string]string{"codex": "/usr/local/bin/codex"},
		SkipDoctorProbe: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svcCodex.Operate(ctx, OperateInput{Kind: "plugin", Action: "install", Provider: "codex"}); err != nil {
		t.Fatalf("codex marketplace install 失败: %v", err)
	}
}

func TestMCPLifecycleAndStdioToolLoop(t *testing.T) {
	aiHome, hostHome, demoRoot := setupTestDirs(t)

	// 使用 node 若可用；否则用 sh+python3（若都可用优先真实 node 验证 demo-like stdio JSON-RPC 服务）
	mcpDir := filepath.Join(demoRoot, "examples/mcp")
	_ = os.MkdirAll(mcpDir, 0o700)
	mcpScript := filepath.Join(mcpDir, "aih-demo-server.js")

	// 编写一个零依赖可运行 MCP stdio JSON-RPC 服务脚本（由真实 node 或 python3 执行）
	nodeScript := `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  let result = {};
  if (msg.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', serverInfo: { name: 'aih-demo', version: '1.0.0' }, capabilities: { tools: {} } };
  } else if (msg.method === 'tools/list') {
    result = { tools: [{ name: 'aih_echo', description: 'echo', inputSchema: { type: 'object' } }] };
  } else if (msg.method === 'tools/call') {
    result = { content: [{ type: 'text', text: msg.params.arguments.text || 'ok' }], isError: false };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});
`
	if err := os.WriteFile(mcpScript, []byte(nodeScript), 0o700); err != nil {
		t.Fatal(err)
	}

	nodeBin := defaultCommandRunner{}.FindNode()
	svc, err := NewService(Config{
		AIHomeDir:       aiHome,
		HostHomeDir:     hostHome,
		DemoRoot:        demoRoot,
		Env:             map[string]string{"PATH": os.Getenv("PATH")},
		Runner:          defaultCommandRunner{},
		SkipDoctorProbe: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// 先测试 TOML (codex) 配置投影（即使没有 node 也完整验证 TOML 写入与删除）
	if _, err := svc.mcps.add(ctx, "aih-demo", MCPServerSpec{
		Command: nodeBinOrFallback(nodeBin),
		Args:    []string{mcpScript},
		Env:     map[string]string{"SECRET_TOKEN": "top-secret"},
	}, "codex"); err != nil {
		t.Fatalf("codex mcp add 失败: %v", err)
	}
	enabledRec, err := svc.mcps.change(ctx, "aih-demo", "codex", "enable")
	if err != nil || !enabledRec.Enabled {
		t.Fatalf("codex mcp enable 失败: rec=%+v err=%v", enabledRec, err)
	}
	tomlData, err := os.ReadFile(filepath.Join(hostHome, ".codex/config.toml"))
	if err != nil || !strings.Contains(string(tomlData), `[mcp_servers."aih-demo"]`) || !strings.Contains(string(tomlData), `SECRET_TOKEN = "top-secret"`) {
		t.Fatalf("codex config.toml 内容异常: err=%v body=%q", err, string(tomlData))
	}
	// 确认 PublicMCPRecord 不泄露敏感 Env 值
	rep, err := svc.Report(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Managed.MCP) != 1 || len(rep.Managed.MCP[0].EnvKeys) != 1 || rep.Managed.MCP[0].EnvKeys[0] != "SECRET_TOKEN" {
		t.Fatalf("PublicMCPRecord 脱敏视图异常: %+v", rep.Managed.MCP)
	}

	// 若本机存在 node，则真实执行 MCP stdio JSON-RPC test / tools / call 闭环！
	if nodeBin != "" {
		testOut, err := svc.Operate(ctx, OperateInput{Kind: "mcp", Action: "test", Provider: "codex", ID: "aih-demo"})
		if err != nil {
			t.Fatalf("MCP test 握手失败: %v", err)
		}
		if resMap, ok := testOut.Result.(map[string]any); !ok || resMap["ok"] != true {
			t.Fatalf("MCP test 返回异常: %+v", testOut.Result)
		}
		toolsOut, err := svc.Operate(ctx, OperateInput{Kind: "mcp", Action: "tools", Provider: "codex", ID: "aih-demo"})
		if err != nil {
			t.Fatalf("MCP tools 列表失败: %v", err)
		}
		toolsSlice, _ := toolsOut.Result.([]map[string]any)
		if len(toolsSlice) != 1 || toolsSlice[0]["name"] != "aih_echo" {
			t.Fatalf("MCP tools 内容异常: %+v", toolsOut.Result)
		}
		callOut, err := svc.Operate(ctx, OperateInput{Kind: "mcp", Action: "call", Provider: "codex", ID: "aih-demo"})
		if err != nil {
			t.Fatalf("MCP call 失败: %v", err)
		}
		callMap, _ := callOut.Result.(map[string]any)
		contentSlice, _ := callMap["content"].([]any)
		firstItem, _ := contentSlice[0].(map[string]any)
		if firstItem["text"] != "AIH_WEBUI_MCP_OK" {
			t.Fatalf("MCP call 回显不匹配: %+v", callOut.Result)
		}
	}

	// Disable 与 Remove 应彻底清理 TOML 配置块
	if _, err := svc.Operate(ctx, OperateInput{Kind: "mcp", Action: "remove", Provider: "codex", ID: "aih-demo"}); err != nil {
		t.Fatalf("MCP remove 失败: %v", err)
	}
	tomlAfter, _ := os.ReadFile(filepath.Join(hostHome, ".codex/config.toml"))
	if strings.Contains(string(tomlAfter), "aih-demo") {
		t.Fatalf("remove 后 config.toml 仍残留 mcp 块: %s", string(tomlAfter))
	}
}

func nodeBinOrFallback(bin string) string {
	if bin != "" {
		return bin
	}
	return "/usr/local/bin/node"
}
