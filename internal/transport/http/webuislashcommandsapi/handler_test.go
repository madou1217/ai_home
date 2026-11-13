package webuislashcommandsapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

func newTestHandler(t *testing.T, home string) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer:  fakeAuthorizer{allowed: true},
		HostHomeDir: home,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
}

func doRequest(t *testing.T, handler http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
	return recorder
}

type decodedResponse struct {
	OK               bool      `json:"ok"`
	Provider         string    `json:"provider"`
	Commands         []Command `json:"commands"`
	SlashPassthrough bool      `json:"slashPassthrough"`
	Truncated        bool      `json:"truncated"`
	Error            string    `json:"error"`
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder) decodedResponse {
	t.Helper()
	var body decodedResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (%s)", err, recorder.Body.String())
	}
	return body
}

func findCommand(commands []Command, name string) (Command, bool) {
	for _, command := range commands {
		if command.Command == name {
			return command, true
		}
	}
	return Command{}, false
}

func TestBuiltinCatalogMatchesNodeFingerprint(t *testing.T) {
	// 指纹口径：每条命令按 command\x1fdescription\x1fargumentHint\x1faliases\x1fsource 拼接，
	// 条目间用换行连接，取 sha256。期望值由 Node 侧 native-slash-command-catalog.js 现算，
	// 任何漏条、错字或顺序漂移都会让本用例变红。
	cases := []struct {
		provider string
		count    int
		want     string
	}{
		{providerClaude, 81, "c74d189581638de965be9d8774c256afca3b8634eab9c5b9442da5013c5b7810"},
		{providerCodex, 45, "ed8f05bdd5fe2ec0f0eadc4ab6c2cf6c3ea48b1eef75896d7ea1008a69c5e49a"},
		{providerOpenCode, 20, "3985d3fb108bed7f2a72fb9d97abc31a2e0a99674e9409eb4f428d9b45aacb95"},
		{providerAgy, 30, "ee787fa2390b3926d70bf5cc2f070dcbe4928c45029d83637b655f51bf85a335"},
		{providerGemini, 10, "da82197a2af3aaeaf09fd16a100394f914092f2e125da6ce7d26d90fa5401456"},
	}
	builtin := builtinCommandsByProvider()
	for _, testCase := range cases {
		commands := builtin[testCase.provider]
		if len(commands) != testCase.count {
			t.Fatalf("%s 条目数期望 %d，实际 %d", testCase.provider, testCase.count, len(commands))
		}
		if got := catalogFingerprint(commands); got != testCase.want {
			t.Fatalf("%s 指纹不符：期望 %s，实际 %s", testCase.provider, testCase.want, got)
		}
	}
}

// catalogFingerprint 与 Node 侧的校验口径保持一致。
func catalogFingerprint(commands []Command) string {
	lines := make([]string, 0, len(commands))
	for _, command := range commands {
		lines = append(lines, strings.Join([]string{
			command.Command,
			command.Description,
			command.ArgumentHint,
			strings.Join(command.Aliases, ","),
			command.Source,
		}, "\x1f"))
	}
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:])
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{HostHomeDir: t.TempDir()}); err != ErrInvalidDependencies {
		t.Fatalf("缺少 Authorizer 应失败，实际 %v", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}}); err != ErrInvalidDependencies {
		t.Fatalf("缺少 HostHomeDir 应失败，实际 %v", err)
	}
}

func TestRejectsUnauthorized(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Authorizer:  fakeAuthorizer{allowed: false},
		HostHomeDir: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	recorder := doRequest(t, handler, http.MethodGet, Path+"?provider=claude")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401，实际 %d", recorder.Code)
	}
	if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("期望 WWW-Authenticate=Bearer，实际 %q", got)
	}
}

func TestRejectsNonGet(t *testing.T) {
	handler := newTestHandler(t, t.TempDir())
	for _, method := range []string{http.MethodPost, http.MethodDelete, http.MethodPut} {
		recorder := doRequest(t, handler, method, Path+"?provider=claude")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s 期望 405，实际 %d", method, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != http.MethodGet {
			t.Fatalf("%s 期望 Allow=GET，实际 %q", method, got)
		}
	}
}

func TestRejectsMissingAndUnknownProvider(t *testing.T) {
	home := t.TempDir()
	// 放一个真实命令目录：未知 provider 不该触发扫描，也不该把它的命令带出来。
	writeFile(t, filepath.Join(home, ".claude", "commands", "leak.md"), "---\ndescription: 不该出现\n---\n")
	handler := newTestHandler(t, home)

	missing := doRequest(t, handler, http.MethodGet, Path)
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("缺少 provider 期望 400，实际 %d", missing.Code)
	}
	if body := decode(t, missing); body.OK || body.Error != "missing_provider" {
		t.Fatalf("缺少 provider 错误体不符：%+v", body)
	}

	unknown := doRequest(t, handler, http.MethodGet, Path+"?provider=not-a-provider")
	if unknown.Code != http.StatusOK {
		t.Fatalf("未知 provider 期望 200，实际 %d", unknown.Code)
	}
	body := decode(t, unknown)
	if !body.OK || body.Provider != "not-a-provider" || body.SlashPassthrough {
		t.Fatalf("未知 provider 响应体不符：%+v", body)
	}
	if body.Commands == nil || len(body.Commands) != 0 {
		t.Fatalf("未知 provider 应返回非 nil 空数组：%+v", body.Commands)
	}
	if !strings.Contains(unknown.Body.String(), `"commands":[]`) {
		t.Fatalf("未知 provider commands 应序列化为 []：%s", unknown.Body.String())
	}
	if strings.Contains(unknown.Body.String(), "/leak") {
		t.Fatalf("未知 provider 不应扫描命令目录：%s", unknown.Body.String())
	}
}

func TestBuiltinCatalogShape(t *testing.T) {
	handler := newTestHandler(t, t.TempDir())
	recorder := doRequest(t, handler, http.MethodGet, Path+"?provider=claude")
	if recorder.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", recorder.Code)
	}
	body := decode(t, recorder)
	if !body.OK || body.Provider != "claude" {
		t.Fatalf("响应头部不符：%+v", body)
	}
	if !body.SlashPassthrough {
		t.Fatalf("claude 有原生 CLI，slashPassthrough 应为 true")
	}
	if len(body.Commands) < 70 {
		t.Fatalf("claude 内置清单过短：%d", len(body.Commands))
	}
	for index, command := range body.Commands {
		if !strings.HasPrefix(command.Command, "/") {
			t.Fatalf("命令名缺少前缀：%q", command.Command)
		}
		if command.Description == "" {
			t.Fatalf("%s 缺少描述", command.Command)
		}
		if command.Aliases == nil {
			t.Fatalf("%s 的 aliases 应为数组而不是 null", command.Command)
		}
		if index > 0 && body.Commands[index-1].Command > command.Command {
			t.Fatalf("命令未按名称升序：%q 在 %q 之后", command.Command, body.Commands[index-1].Command)
		}
	}
	// 键名与 Node 契约一致，不允许出现多余键（truncated 只在触顶时出现）。
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	for _, key := range []string{"ok", "provider", "commands", "slashPassthrough"} {
		if _, present := raw[key]; !present {
			t.Fatalf("缺少契约键 %q", key)
		}
	}
	if _, present := raw["truncated"]; present {
		t.Fatalf("未触顶时不应出现 truncated")
	}
	desktop, found := findCommand(body.Commands, "/desktop")
	if !found || len(desktop.Aliases) != 1 || desktop.Aliases[0] != "/app" {
		t.Fatalf("/desktop 别名不符：%+v", desktop)
	}
	if desktop.Source != "claude-builtin" {
		t.Fatalf("/desktop source 不符：%q", desktop.Source)
	}
}

func TestParsesUserCommandsWithFrontmatter(t *testing.T) {
	home := t.TempDir()
	commandsDir := filepath.Join(home, ".claude", "commands")
	writeFile(t, filepath.Join(commandsDir, "deploy.md"),
		"---\ndescription: \"发布到预发环境\"\nargument-hint: <env>\n---\n正文\n")
	writeFile(t, filepath.Join(commandsDir, "plain.md"), "没有 frontmatter 的命令\n")
	writeFile(t, filepath.Join(commandsDir, "git", "commit.md"),
		"---\ndescription: 生成提交信息\n---\n")
	// 与内置命令同名：内置条目优先，不产生重复项。
	writeFile(t, filepath.Join(commandsDir, "clear.md"), "---\ndescription: 覆盖内置\n---\n")
	// 非 markdown 文件不进入清单。
	writeFile(t, filepath.Join(commandsDir, "notes.txt"), "忽略")

	handler := newTestHandler(t, home)
	body := decode(t, doRequest(t, handler, http.MethodGet, Path+"?provider=claude"))

	deploy, found := findCommand(body.Commands, "/deploy")
	if !found {
		t.Fatalf("缺少 /deploy：%+v", body.Commands)
	}
	if deploy.Description != "发布到预发环境" || deploy.ArgumentHint != "<env>" {
		t.Fatalf("/deploy 元数据不符：%+v", deploy)
	}
	if deploy.Source != "claude-user" {
		t.Fatalf("/deploy source 不符：%q", deploy.Source)
	}
	plain, found := findCommand(body.Commands, "/plain")
	if !found || plain.Description != defaultUserCommandDescription || plain.ArgumentHint != "" {
		t.Fatalf("/plain 应回落到默认描述：%+v", plain)
	}
	if _, found := findCommand(body.Commands, "/git:commit"); !found {
		t.Fatalf("子目录命令应带目录前缀：%+v", body.Commands)
	}
	cleared, _ := findCommand(body.Commands, "/clear")
	if cleared.Source != "claude-builtin" {
		t.Fatalf("同名用户命令不应覆盖内置条目：%+v", cleared)
	}
	duplicates := 0
	for _, command := range body.Commands {
		if command.Command == "/clear" {
			duplicates++
		}
	}
	if duplicates != 1 {
		t.Fatalf("/clear 出现 %d 次", duplicates)
	}
	if _, found := findCommand(body.Commands, "/notes.txt"); found {
		t.Fatalf("非 markdown 文件不应进入清单")
	}
}

func TestHonorsClaudeConfigDir(t *testing.T) {
	configDir := t.TempDir()
	writeFile(t, filepath.Join(configDir, "commands", "custom.md"), "---\ndescription: 配置根命令\n---\n")
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)

	home := t.TempDir()
	writeFile(t, filepath.Join(home, ".claude", "commands", "home.md"), "---\ndescription: HOME 命令\n---\n")

	body := decode(t, doRequest(t, newTestHandler(t, home), http.MethodGet, Path+"?provider=claude"))
	if _, found := findCommand(body.Commands, "/custom"); !found {
		t.Fatalf("CLAUDE_CONFIG_DIR 下的命令应被收录")
	}
	if _, found := findCommand(body.Commands, "/home"); found {
		t.Fatalf("设置了 CLAUDE_CONFIG_DIR 后不应再扫 HOME")
	}
}

func TestRejectsSymlinkEscape(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret.md"), "---\ndescription: 越界命令\n---\n")
	writeFile(t, filepath.Join(outside, "nested", "deep.md"), "---\ndescription: 越界深层命令\n---\n")

	commandsDir := filepath.Join(home, ".claude", "commands")
	writeFile(t, filepath.Join(commandsDir, "inside.md"), "---\ndescription: 正常命令\n---\n")
	if err := os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(commandsDir, "escape.md")); err != nil {
		t.Fatalf("Symlink: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "nested"), filepath.Join(commandsDir, "escape-dir")); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	body := decode(t, doRequest(t, newTestHandler(t, home), http.MethodGet, Path+"?provider=claude"))
	if _, found := findCommand(body.Commands, "/escape"); found {
		t.Fatalf("符号链接文件不应被收录")
	}
	if _, found := findCommand(body.Commands, "/escape-dir:deep"); found {
		t.Fatalf("符号链接目录不应被遍历")
	}
	for _, command := range body.Commands {
		if strings.Contains(command.Description, "越界") {
			t.Fatalf("不应读到目录外的文件：%+v", command)
		}
	}
	if _, found := findCommand(body.Commands, "/inside"); !found {
		t.Fatalf("目录内的正常命令应被收录")
	}
}

func TestOversizedFileIsListedWithoutMetadata(t *testing.T) {
	home := t.TempDir()
	oversized := "---\ndescription: 超大文件描述\n---\n" + strings.Repeat("x", maxCommandFileBytes+1)
	writeFile(t, filepath.Join(home, ".claude", "commands", "huge.md"), oversized)

	body := decode(t, doRequest(t, newTestHandler(t, home), http.MethodGet, Path+"?provider=claude"))
	huge, found := findCommand(body.Commands, "/huge")
	if !found {
		t.Fatalf("超限文件仍应列出命令名")
	}
	if huge.Description != defaultUserCommandDescription {
		t.Fatalf("超限文件不应读取元数据：%+v", huge)
	}
}

func TestTruncatesAtDepthLimit(t *testing.T) {
	home := t.TempDir()
	deepest := filepath.Join(home, ".claude", "commands")
	for index := 0; index <= maxScanDepth+1; index++ {
		deepest = filepath.Join(deepest, "d")
	}
	writeFile(t, filepath.Join(deepest, "too-deep.md"), "---\ndescription: 超深命令\n---\n")

	recorder := doRequest(t, newTestHandler(t, home), http.MethodGet, Path+"?provider=claude")
	body := decode(t, recorder)
	if !body.Truncated {
		t.Fatalf("超过深度上限应标记 truncated")
	}
	if _, found := findCommand(body.Commands, strings.Repeat("/d:", maxScanDepth+2)+"too-deep"); found {
		t.Fatalf("超深目录不应被遍历")
	}
	if !strings.Contains(recorder.Body.String(), "\"truncated\":true") {
		t.Fatalf("truncated 应为 JSON true：%s", recorder.Body.String())
	}
}

func TestTruncatesAtEntryLimit(t *testing.T) {
	home := t.TempDir()
	commandsDir := filepath.Join(home, ".claude", "commands")
	if err := os.MkdirAll(commandsDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	for index := 0; index <= maxScanEntries; index++ {
		path := filepath.Join(commandsDir, fmt.Sprintf("cmd%05d.md", index))
		if err := os.WriteFile(path, nil, 0o644); err != nil {
			t.Fatalf("WriteFile(%s): %v", path, err)
		}
	}

	body := decode(t, doRequest(t, newTestHandler(t, home), http.MethodGet, Path+"?provider=claude"))
	if !body.Truncated {
		t.Fatalf("超过条目上限应标记 truncated")
	}
	if len(body.Commands) > maxScanEntries {
		t.Fatalf("截断后命令数不应超过上限：%d", len(body.Commands))
	}
}

func TestOtherProvidersUseStaticCatalog(t *testing.T) {
	handler := newTestHandler(t, t.TempDir())

	codex := decode(t, doRequest(t, handler, http.MethodGet, Path+"?provider=codex"))
	if !codex.SlashPassthrough || len(codex.Commands) == 0 {
		t.Fatalf("codex 应返回内置清单且 passthrough：%+v", codex)
	}
	for _, command := range codex.Commands {
		if command.Source != "codex-builtin" {
			t.Fatalf("codex 条目 source 不符：%+v", command)
		}
	}

	// 已注册但没有本地命令清单的 provider：返回空清单，仍按 CLI 能力给 passthrough。
	workbuddyRecorder := doRequest(t, handler, http.MethodGet, Path+"?provider=workbuddy")
	workbuddy := decode(t, workbuddyRecorder)
	if workbuddy.OK != true || len(workbuddy.Commands) != 0 {
		t.Fatalf("workbuddy 应为空清单：%+v", workbuddy)
	}
	if !strings.Contains(workbuddyRecorder.Body.String(), `"commands":[]`) {
		t.Fatalf("空清单应序列化成 [] 而不是 null：%s", workbuddyRecorder.Body.String())
	}
	if workbuddy.SlashPassthrough {
		t.Fatalf("workbuddy 没有 CLI，passthrough 应为 false")
	}

	// provider 大小写与空白不敏感。
	upper := decode(t, doRequest(t, handler, http.MethodGet, Path+"?provider=%20CLAUDE%20"))
	if upper.Provider != "claude" || len(upper.Commands) == 0 {
		t.Fatalf("provider 归一化不符：%+v", upper)
	}
}
