package webuigitapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type stubAuthorizer bool

func (authorizer stubAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

// fakeGit 用固定应答替换真实子进程，按第一个参数（子命令）分派。
type fakeGit struct {
	respond func(root string, args []string, allowFailure bool) (gitResult, error)
}

func (fake fakeGit) run(_ context.Context, root string, args []string, allowFailure bool) (gitResult, error) {
	return fake.respond(root, args, allowFailure)
}

// newFakeGit 把应答函数包装成 Handler 需要的执行端口。
func newFakeGit(respond func(root string, args []string, allowFailure bool) (gitResult, error)) gitRunner {
	return fakeGit{respond: respond}.run
}

type testEnvironment struct {
	handler    *Handler
	home       string
	repository string
}

func newTestEnvironment(t *testing.T, allowed bool) testEnvironment {
	t.Helper()
	home := t.TempDir()
	repository := filepath.Join(home, "workspace", "demo")
	if err := os.MkdirAll(repository, 0o755); err != nil {
		t.Fatalf("创建测试仓库目录失败: %v", err)
	}
	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer(allowed), HostHomeDir: home})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return testEnvironment{handler: handler, home: home, repository: repository}
}

// defaultFakeGit 返回一份含未跟踪、已改、已暂存与重命名四种记录的工作区状态。
func defaultFakeGit() gitRunner {
	return newFakeGit(func(root string, args []string, allowFailure bool) (gitResult, error) {
		switch args[0] {
		case "status":
			return gitResult{stdout: "?? 新增.md\x00 M 已改.go\x00M  已暂存.go\x00R  新名.go\x00旧名.go\x00"}, nil
		case "branch":
			return gitResult{stdout: "main\n"}, nil
		case "rev-parse":
			return gitResult{stdout: "origin/main\n"}, nil
		case "rev-list":
			return gitResult{stdout: "2\t1\n"}, nil
		case "diff":
			return gitResult{stdout: "diff --git a/x b/x\n"}, nil
		}
		return gitResult{}, &gitFailure{code: codeGitFailed, message: "未预期的 git 调用: " + strings.Join(args, " ")}
	})
}

func target(suffix string, values url.Values) string {
	if len(values) == 0 {
		return Path + suffix
	}
	return Path + suffix + "?" + values.Encode()
}

func doRequest(handler *Handler, method, requestTarget string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, requestTarget, nil))
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) any {
	t.Helper()
	var body any
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (%s)", err, recorder.Body.String())
	}
	return body
}

func mustJSON(t *testing.T, literal string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(literal), &value); err != nil {
		t.Fatalf("期望值不是合法 JSON: %v (%s)", err, literal)
	}
	return value
}

// assertErrorBody 校验 Node 形状的错误响应 {ok:false, error, message}。
func assertErrorBody(t *testing.T, recorder *httptest.ResponseRecorder, code, message string) {
	t.Helper()
	body := decodeBody(t, recorder)
	want := mustJSON(t, `{"ok":false,"error":`+quote(t, code)+`,"message":`+quote(t, message)+`}`)
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("错误响应不符\n got = %#v\nwant = %#v", body, want)
	}
}

func quote(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("无法编码期望值: %v", err)
	}
	return string(encoded)
}

func TestNewHandlerRequiresDependencies(t *testing.T) {
	cases := []struct {
		name         string
		dependencies Dependencies
	}{
		{name: "缺少鉴权", dependencies: Dependencies{HostHomeDir: "/tmp"}},
		{name: "缺少宿主目录", dependencies: Dependencies{Authorizer: stubAuthorizer(true)}},
		{name: "宿主目录只有空白", dependencies: Dependencies{Authorizer: stubAuthorizer(true), HostHomeDir: "   "}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := NewHandler(testCase.dependencies); !errors.Is(err, ErrInvalidDependencies) {
				t.Fatalf("NewHandler() error = %v, want ErrInvalidDependencies", err)
			}
		})
	}
}

func TestServeHTTPRejectsUnauthorized(t *testing.T) {
	environment := newTestEnvironment(t, false)
	for _, suffix := range []string{SummarySuffix, DiffSuffix} {
		t.Run(suffix, func(t *testing.T) {
			recorder := doRequest(environment.handler, http.MethodGet, target(suffix, url.Values{"projectPath": {environment.repository}}))
			if recorder.Code != http.StatusUnauthorized {
				t.Fatalf("状态码 = %d, want 401", recorder.Code)
			}
			if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
				t.Fatalf("WWW-Authenticate = %q, want Bearer", got)
			}
			assertErrorBody(t, recorder, codeUnauthorized, "需要管理密钥")
		})
	}
}

func TestServeHTTPRejectsNonGet(t *testing.T) {
	environment := newTestEnvironment(t, true)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			recorder := doRequest(environment.handler, method, target(SummarySuffix, url.Values{"projectPath": {environment.repository}}))
			if recorder.Code != http.StatusMethodNotAllowed {
				t.Fatalf("状态码 = %d, want 405", recorder.Code)
			}
			if got := recorder.Header().Get("Allow"); got != http.MethodGet {
				t.Fatalf("Allow = %q, want GET", got)
			}
			assertErrorBody(t, recorder, codeMethodNotAllowed, "仅支持 GET")
		})
	}
}

func TestServeHTTPUnknownSuffix(t *testing.T) {
	environment := newTestEnvironment(t, true)
	recorder := doRequest(environment.handler, http.MethodGet, Path+"/log")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d, want 404", recorder.Code)
	}
	assertErrorBody(t, recorder, codeNotFound, "未知的 Git 只读接口")
}

func TestResolveProjectRootRejectsEscapes(t *testing.T) {
	environment := newTestEnvironment(t, true)
	outside := t.TempDir()
	link := filepath.Join(environment.home, "外部链接")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("创建符号链接失败: %v", err)
	}
	// 越界路径绝不允许落到子进程：一旦执行 git 就说明包含校验失效。
	environment.handler.runner = newFakeGit(func(root string, args []string, allowFailure bool) (gitResult, error) {
		t.Errorf("越界路径不应执行 git: %s %v", root, args)
		return gitResult{}, nil
	})

	cases := []struct {
		name        string
		projectPath string
	}{
		{name: "空值", projectPath: ""},
		{name: "相对路径", projectPath: "workspace/demo"},
		{name: "父目录逃逸", projectPath: filepath.Join(environment.repository, "..", "..", "..")},
		{name: "绝对路径越界", projectPath: outside},
		{name: "符号链接越界", projectPath: link},
		{name: "路径不存在", projectPath: filepath.Join(environment.home, "missing")},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := doRequest(environment.handler, http.MethodGet, target(SummarySuffix, url.Values{"projectPath": {testCase.projectPath}}))
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("状态码 = %d, want 403 (%s)", recorder.Code, recorder.Body.String())
			}
			assertErrorBody(t, recorder, codeUnknownProjectRoot, "只允许查看已登记项目的 Git 变更")
		})
	}
}

func TestSummaryResponseShape(t *testing.T) {
	environment := newTestEnvironment(t, true)
	environment.handler.runner = defaultFakeGit()

	recorder := doRequest(environment.handler, http.MethodGet, target(SummarySuffix, url.Values{"projectPath": {environment.repository}}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200 (%s)", recorder.Code, recorder.Body.String())
	}
	got := decodeBody(t, recorder)
	want := mustJSON(t, `{
		"ok": true,
		"branch": "main",
		"upstream": "origin/main",
		"ahead": 2,
		"behind": 1,
		"files": [
			{"path": "新增.md", "staged": false, "unstaged": true, "untracked": true, "status": "??"},
			{"path": "已改.go", "staged": false, "unstaged": true, "untracked": false, "status": " M"},
			{"path": "已暂存.go", "staged": true, "unstaged": false, "untracked": false, "status": "M "},
			{"path": "新名.go", "oldPath": "旧名.go", "staged": true, "unstaged": false, "untracked": false, "status": "R "}
		]
	}`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("summary 形状不符\n got = %#v\nwant = %#v", got, want)
	}
}

func TestSummaryDefaultsWithoutUpstream(t *testing.T) {
	environment := newTestEnvironment(t, true)
	environment.handler.runner = newFakeGit(func(root string, args []string, allowFailure bool) (gitResult, error) {
		switch args[0] {
		case "status":
			return gitResult{stdout: ""}, nil
		case "branch":
			return gitResult{stdout: "\n"}, nil
		case "rev-parse":
			// 没有 upstream 时 git 非零退出，Node 用 allowFailure 吞掉。
			return gitResult{stderr: "fatal: no upstream configured\n", exitCode: 128}, nil
		case "rev-list":
			t.Errorf("没有 upstream 时不应查询 rev-list")
			return gitResult{}, nil
		}
		return gitResult{}, &gitFailure{code: codeGitFailed, message: "未预期的 git 调用"}
	})

	recorder := doRequest(environment.handler, http.MethodGet, target(SummarySuffix, url.Values{"projectPath": {environment.repository}}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200 (%s)", recorder.Code, recorder.Body.String())
	}
	got := decodeBody(t, recorder)
	want := mustJSON(t, `{"ok":true,"branch":"HEAD","upstream":"","ahead":0,"behind":0,"files":[]}`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("缺省值不符\n got = %#v\nwant = %#v", got, want)
	}
}

func TestSummaryFailures(t *testing.T) {
	cases := []struct {
		name        string
		status      gitResult
		statusError error
		wantCode    string
		wantMessage string
	}{
		{
			name:        "git 非零退出",
			statusError: &gitFailure{code: codeGitFailed, message: "fatal: not a git repository"},
			wantCode:    codeGitFailed,
			wantMessage: "fatal: not a git repository",
		},
		{
			name:        "git 超时",
			statusError: &gitFailure{code: codeGitTimeout, message: "git 命令超时"},
			wantCode:    codeGitTimeout,
			wantMessage: "git 命令超时",
		},
		{
			name:        "状态输出超限",
			status:      gitResult{truncated: true},
			wantCode:    codeGitOutputTooLarge,
			wantMessage: "Git 工作区状态超过 2MB，无法给出完整变更清单",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			environment := newTestEnvironment(t, true)
			environment.handler.runner = newFakeGit(func(root string, args []string, allowFailure bool) (gitResult, error) {
				switch args[0] {
				case "status":
					return testCase.status, testCase.statusError
				case "branch":
					return gitResult{stdout: "main\n"}, nil
				case "rev-parse":
					return gitResult{stdout: "origin/main\n"}, nil
				}
				return gitResult{}, nil
			})
			recorder := doRequest(environment.handler, http.MethodGet, target(SummarySuffix, url.Values{"projectPath": {environment.repository}}))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("状态码 = %d, want 400 (%s)", recorder.Code, recorder.Body.String())
			}
			assertErrorBody(t, recorder, testCase.wantCode, testCase.wantMessage)
		})
	}
}

func TestDiffResponseShape(t *testing.T) {
	environment := newTestEnvironment(t, true)
	environment.handler.runner = newFakeGit(func(root string, args []string, allowFailure bool) (gitResult, error) {
		want := []string{"diff", "--no-ext-diff", "--no-color", "--unified=3", "--cached", "--", "src/组件.go"}
		if !reflect.DeepEqual(args, want) {
			t.Errorf("git 参数 = %v, want %v", args, want)
		}
		wantRoot, err := filepath.EvalSymlinks(environment.repository)
		if err != nil {
			t.Fatalf("解析仓库真实路径失败: %v", err)
		}
		if root != wantRoot {
			t.Errorf("git -C 根 = %q, want %q", root, wantRoot)
		}
		return gitResult{stdout: "@@ -1 +1 @@\n-旧\n+新\n", truncated: true}, nil
	})

	recorder := doRequest(environment.handler, http.MethodGet, target(DiffSuffix, url.Values{
		"projectPath": {environment.repository},
		"path":        {"src/./组件.go"},
		"staged":      {"1"},
	}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200 (%s)", recorder.Code, recorder.Body.String())
	}
	got := decodeBody(t, recorder)
	want := mustJSON(t, `{"ok":true,"path":"src/组件.go","content":"@@ -1 +1 @@\n-旧\n+新\n","truncated":true}`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("diff 形状不符\n got = %#v\nwant = %#v", got, want)
	}
}

func TestDiffRejectsInvalidPaths(t *testing.T) {
	environment := newTestEnvironment(t, true)
	environment.handler.runner = newFakeGit(func(root string, args []string, allowFailure bool) (gitResult, error) {
		t.Errorf("非法路径不应执行 git: %v", args)
		return gitResult{}, nil
	})

	cases := []struct {
		name string
		path string
	}{
		{name: "空值", path: ""},
		{name: "只有空白", path: "   "},
		{name: "绝对路径", path: "/etc/passwd"},
		{name: "父目录逃逸", path: "../etc/passwd"},
		{name: "折叠后逃逸", path: "src/../../etc/passwd"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := doRequest(environment.handler, http.MethodGet, target(DiffSuffix, url.Values{
				"projectPath": {environment.repository},
				"path":        {testCase.path},
			}))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("状态码 = %d, want 400 (%s)", recorder.Code, recorder.Body.String())
			}
			assertErrorBody(t, recorder, codeInvalidFilePath, "必须提供项目内的相对文件路径")
		})
	}
}

func TestDiffFailure(t *testing.T) {
	environment := newTestEnvironment(t, true)
	environment.handler.runner = newFakeGit(func(root string, args []string, allowFailure bool) (gitResult, error) {
		return gitResult{stderr: "fatal: bad revision\n", exitCode: 128}, &gitFailure{code: codeGitFailed, message: "fatal: bad revision"}
	})
	recorder := doRequest(environment.handler, http.MethodGet, target(DiffSuffix, url.Values{
		"projectPath": {environment.repository},
		"path":        {"a.txt"},
	}))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("状态码 = %d, want 400 (%s)", recorder.Code, recorder.Body.String())
	}
	assertErrorBody(t, recorder, codeGitFailed, "fatal: bad revision")
}

// TestAgainstRealRepository 用真实 git 验证 summary / diff 的端到端行为，
// 包括真实子进程、porcelain 解析、--cached 与 2MB 截断。
func TestAgainstRealRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("本机没有 git")
	}
	environment := newTestEnvironment(t, true)
	runGitCommand := func(arguments ...string) {
		t.Helper()
		command := exec.Command("git", append([]string{"-C", environment.repository}, arguments...)...)
		command.Env = append(os.Environ(),
			"GIT_CONFIG_GLOBAL="+os.DevNull,
			"GIT_CONFIG_SYSTEM="+os.DevNull,
			"GIT_AUTHOR_NAME=测试",
			"GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=测试",
			"GIT_COMMITTER_EMAIL=test@example.com",
		)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v 失败: %v (%s)", arguments, err, output)
		}
	}
	writeFile := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(environment.repository, name), []byte(content), 0o644); err != nil {
			t.Fatalf("写入 %s 失败: %v", name, err)
		}
	}
	summary := func() map[string]any {
		t.Helper()
		recorder := doRequest(environment.handler, http.MethodGet, target(SummarySuffix, url.Values{"projectPath": {environment.repository}}))
		if recorder.Code != http.StatusOK {
			t.Fatalf("summary 状态码 = %d, want 200 (%s)", recorder.Code, recorder.Body.String())
		}
		body := decodeBody(t, recorder)
		decoded, ok := body.(map[string]any)
		if !ok {
			t.Fatalf("summary 响应不是对象: %#v", body)
		}
		return decoded
	}
	diff := func(values url.Values) map[string]any {
		t.Helper()
		values.Set("projectPath", environment.repository)
		recorder := doRequest(environment.handler, http.MethodGet, target(DiffSuffix, values))
		if recorder.Code != http.StatusOK {
			t.Fatalf("diff 状态码 = %d, want 200 (%s)", recorder.Code, recorder.Body.String())
		}
		body := decodeBody(t, recorder)
		decoded, ok := body.(map[string]any)
		if !ok {
			t.Fatalf("diff 响应不是对象: %#v", body)
		}
		return decoded
	}

	runGitCommand("init")
	writeFile("a.txt", "第一行\n")
	runGitCommand("add", "a.txt")
	runGitCommand("commit", "-m", "初始提交")

	initial := summary()
	if branch, _ := initial["branch"].(string); branch == "" || branch == "HEAD" {
		t.Fatalf("branch = %v, want 一个真实分支名", initial["branch"])
	}
	if files, _ := initial["files"].([]any); len(files) != 0 {
		t.Fatalf("干净工作区 files = %v, want 空数组", files)
	}

	writeFile("a.txt", "第一行\n第二行\n")
	modified := summary()
	files, _ := modified["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("files = %v, want 一条记录", files)
	}
	entry, _ := files[0].(map[string]any)
	wantEntry := map[string]any{"path": "a.txt", "staged": false, "unstaged": true, "untracked": false, "status": " M"}
	if !reflect.DeepEqual(entry, wantEntry) {
		t.Fatalf("files[0] = %#v, want %#v", entry, wantEntry)
	}

	unstagedDiff := diff(url.Values{"path": {"a.txt"}})
	if content, _ := unstagedDiff["content"].(string); !strings.Contains(content, "+第二行") {
		t.Fatalf("未暂存 diff 缺少新增行: %v", unstagedDiff["content"])
	}
	if truncated, _ := unstagedDiff["truncated"].(bool); truncated {
		t.Fatalf("小文件 diff 不应被截断")
	}

	runGitCommand("add", "a.txt")
	stagedDiff := diff(url.Values{"path": {"a.txt"}, "staged": {"1"}})
	if content, _ := stagedDiff["content"].(string); !strings.Contains(content, "+第二行") {
		t.Fatalf("已暂存 diff 缺少新增行: %v", stagedDiff["content"])
	}

	writeFile("未跟踪.txt", "新文件\n")
	untracked := summary()
	untrackedFiles, _ := untracked["files"].([]any)
	found := false
	for _, item := range untrackedFiles {
		record, _ := item.(map[string]any)
		if record["path"] == "未跟踪.txt" {
			found = true
			if record["untracked"] != true {
				t.Fatalf("未跟踪记录 = %#v, want untracked=true", record)
			}
		}
	}
	if !found {
		t.Fatalf("files 里没有未跟踪文件: %v", untrackedFiles)
	}

	// 超过 2MB 的 diff 必须显式标注 truncated，而不是悄悄给半截内容。
	writeFile("a.txt", strings.Repeat("0123456789abcdef\n", 200000))
	truncatedDiff := diff(url.Values{"path": {"a.txt"}})
	if truncated, _ := truncatedDiff["truncated"].(bool); !truncated {
		t.Fatalf("超大 diff 未被标注截断")
	}
	content, _ := truncatedDiff["content"].(string)
	if content == "" {
		t.Fatalf("超大 diff 截断后仍应保留前 2MB 内容")
	}
	if len(content) > maxGitOutputBytes {
		t.Fatalf("截断后内容长度 = %d, want <= %d", len(content), maxGitOutputBytes)
	}
}
