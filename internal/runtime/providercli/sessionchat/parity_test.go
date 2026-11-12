package sessionchat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/madou1217/ai_home/application/providerruntime"
)

// parityFixture 是对拍快照：同一批输入由 Node 现有实现生成，Go 侧逐字段复算。
type parityFixture struct {
	Version     int                    `json:"version"`
	Generated   string                 `json:"generatedBy"`
	Platform    string                 `json:"platform"`
	NowMs       int64                  `json:"nowMs"`
	Start       []parityStartCase      `json:"start"`
	Resume      []parityResumeCase     `json:"resume"`
	Shell       parityShell            `json:"shell"`
	StreamJSON  []parityStreamJSONCase `json:"streamJson"`
	MediaType   []parityValueCase      `json:"mediaType"`
	Misc        parityMisc             `json:"misc"`
	Transport   parityTransportSection `json:"transport"`
	Failure     []parityFailureCase    `json:"failure"`
	Blocker     []parityBlockerCase    `json:"blocker"`
	Environment parityEnvironment      `json:"environment"`
}

type parityStartCase struct {
	Name     string              `json:"name"`
	Provider string              `json:"provider"`
	Env      map[string]string   `json:"env"`
	Options  parityStartOptions  `json:"options"`
	Result   *parityCommand      `json:"result"`
	Error    *parityErrorLiteral `json:"error"`
}

type parityStartOptions struct {
	Prompt         string   `json:"prompt"`
	SessionID      string   `json:"sessionId"`
	Model          string   `json:"model"`
	ImagePaths     []string `json:"imagePaths"`
	InteractiveCLI bool     `json:"interactiveCli"`
	ProjectPath    string   `json:"projectPath"`
	CLIPath        string   `json:"cliPath"`
}

type parityResumeCase struct {
	Name     string              `json:"name"`
	Provider string              `json:"provider"`
	Env      map[string]string   `json:"env"`
	Options  parityResumeOptions `json:"options"`
	Result   *parityCommand      `json:"result"`
	Error    *parityErrorLiteral `json:"error"`
}

type parityResumeOptions struct {
	Prompt         string   `json:"prompt"`
	SessionID      string   `json:"sessionId"`
	Model          string   `json:"model"`
	ImagePaths     []string `json:"imagePaths"`
	InteractiveCLI bool     `json:"interactiveCli"`
	ProjectDirName string   `json:"projectDirName"`
	SessionPath    string   `json:"sessionPath"`
	SessionFile    string   `json:"sessionFile"`
	CLIPath        string   `json:"cliPath"`
}

type parityCommand struct {
	CommandName string   `json:"commandName"`
	Args        []string `json:"args"`
}

type parityErrorLiteral struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type parityShell struct {
	Quote       []parityValueCase       `json:"quote"`
	Socket      []parityValueCase       `json:"socket"`
	Inner       []parityInnerCase       `json:"inner"`
	RunShell    []parityRunShellCase    `json:"runShell"`
	ClaudeShell []parityClaudeShellCase `json:"claudeShell"`
}

type parityValueCase struct {
	Value  string `json:"value"`
	Expect string `json:"expect"`
}

type parityInnerCase struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Expect  string   `json:"expect"`
}

type parityRunShellCase struct {
	Inner   string `json:"inner"`
	LogPath string `json:"logPath"`
	Expect  string `json:"expect"`
}

type parityClaudeShellCase struct {
	MessageFile string   `json:"messageFile"`
	Command     string   `json:"command"`
	Args        []string `json:"args"`
	Expect      string   `json:"expect"`
}

type parityStreamJSONCase struct {
	Name   string                  `json:"name"`
	Prompt string                  `json:"prompt"`
	Images []parityImageAttachment `json:"images"`
	Expect string                  `json:"expect"`
}

type parityImageAttachment struct {
	MediaType string `json:"mediaType"`
	Data      string `json:"data"`
}

type parityMisc struct {
	ConfigDirArgs  []parityConfigDirCase   `json:"configDirArgs"`
	RunsHome       []parityRunsHomeCase    `json:"runsHome"`
	Multiplexer    []parityMultiplexerCase `json:"multiplexer"`
	OpenCodeLayout []parityLayoutCase      `json:"openCodeLayout"`
}

type parityConfigDirCase struct {
	Name       string   `json:"name"`
	Provider   string   `json:"provider"`
	Args       []string `json:"args"`
	RuntimeDir string   `json:"runtimeDir"`
	Expect     []string `json:"expect"`
}

type parityRunsHomeCase struct {
	Name     string            `json:"name"`
	Injected string            `json:"injected"`
	Env      map[string]string `json:"env"`
	HomeDir  string            `json:"homeDir"`
	Expect   string            `json:"expect"`
}

type parityMultiplexerCase struct {
	Name           string `json:"name"`
	Provider       string `json:"provider"`
	InteractiveCLI bool   `json:"interactiveCli"`
	Platform       string `json:"platform"`
	MultiplexerEnv string `json:"multiplexerEnv"`
	Available      bool   `json:"available"`
	Expect         bool   `json:"expect"`
}

type parityLayoutCase struct {
	Env    string       `json:"env"`
	Expect parityLayout `json:"expect"`
}

type parityLayout struct {
	ID             string `json:"id"`
	DirectoryFlag  string `json:"directoryFlag"`
	StandaloneFlag string `json:"standaloneFlag"`
	PWDDirectory   bool   `json:"pwdDirectory"`
}

type parityTransportSection struct {
	Cases            []parityTransportCase `json:"cases"`
	TmuxRunProviders []string              `json:"tmuxRunProviders"`
	CLIGenerated     []parityBoolCase      `json:"cliGenerated"`
}

type parityBoolCase struct {
	Provider string `json:"provider"`
	Expect   bool   `json:"expect"`
}

type parityTransportCase struct {
	Provider string          `json:"provider"`
	IsResume bool            `json:"isResume"`
	Expect   parityTransport `json:"expect"`
}

type parityTransport struct {
	Mode           string `json:"mode"`
	PromptDelivery string `json:"promptDelivery"`
	StreamUsage    bool   `json:"streamUsage"`
}

type parityFailureCase struct {
	Name      string            `json:"name"`
	Provider  string            `json:"provider"`
	ErrorLike parityErrorInput  `json:"errorLike"`
	Options   parityFailureOpts `json:"options"`
	Expect    parityFailure     `json:"expect"`
}

type parityErrorInput struct {
	Code    string                `json:"code"`
	Message string                `json:"message"`
	Detail  string                `json:"detail"`
	Details *parityFailureDetails `json:"details"`
}

type parityFailureDetails struct {
	Detail  string `json:"detail"`
	Message string `json:"message"`
}

type parityFailureOpts struct {
	ExitCode *float64 `json:"exitCode"`
}

type parityFailure struct {
	Code                string `json:"code"`
	Message             string `json:"message"`
	RetryAnotherAccount bool   `json:"retryAnotherAccount"`
}

type parityBlockerCase struct {
	Provider string          `json:"provider"`
	Output   string          `json:"output"`
	Expect   json.RawMessage `json:"expect"`
}

type parityEnvironment struct {
	Strips     []parityStripCase      `json:"strips"`
	Scoped     []parityScopedCase     `json:"scoped"`
	Projection []parityProjectionCase `json:"projection"`
	Scopes     []parityScopeCase      `json:"scopes"`
	Gemini     []parityGeminiCase     `json:"gemini"`
	Extra      []parityExtraCase      `json:"extra"`
	HostHome   []parityHostHomeCase   `json:"hostHome"`
	AuthModes  []parityAuthModeCase   `json:"authModes"`
}

type parityStripCase struct {
	Name   string            `json:"name"`
	Base   map[string]string `json:"base"`
	Expect map[string]string `json:"expect"`
}

type parityScopedCase struct {
	Name    string            `json:"name"`
	Base    map[string]string `json:"base"`
	Account map[string]string `json:"account"`
	Expect  map[string]string `json:"expect"`
}

type parityFlagSet struct {
	IsLogin                  bool `json:"isLogin"`
	Gateway                  bool `json:"gateway"`
	AuthRelayed              bool `json:"authRelayed"`
	RelayKeepsAccountSandbox bool `json:"relayKeepsAccountSandbox"`
}

type parityProjectionCase struct {
	Provider   string            `json:"provider"`
	Variant    string            `json:"variant"`
	AccountEnv map[string]string `json:"accountEnv"`
	Flags      parityFlagSet     `json:"flags"`
	Expect     bool              `json:"expect"`
}

type parityScopeCase struct {
	Provider      string            `json:"provider"`
	ProjectionDir string            `json:"projectionDir"`
	AccountEnv    map[string]string `json:"accountEnv"`
	Flags         parityFlagSet     `json:"flags"`
	Expect        parityScope       `json:"expect"`
}

type parityScope struct {
	HostHomeDir        string `json:"hostHomeDir"`
	ProjectionRequired bool   `json:"projectionRequired"`
	RuntimeDir         string `json:"runtimeDir"`
}

type parityGeminiCase struct {
	AccountEnv map[string]string `json:"accountEnv"`
	Expect     map[string]string `json:"expect"`
}

type parityExtraCase struct {
	Provider   string            `json:"provider"`
	AccountEnv map[string]string `json:"accountEnv"`
	Expect     map[string]string `json:"expect"`
}

type parityHostHomeCase struct {
	Injected string            `json:"injected"`
	Env      map[string]string `json:"env"`
	Platform string            `json:"platform"`
	Expect   string            `json:"expect"`
}

type parityAuthModeCase struct {
	Value  string          `json:"value"`
	Expect json.RawMessage `json:"expect"`
}

// loadParityFixture 读取与包同目录的 testdata 快照。
func loadParityFixture(t *testing.T) parityFixture {
	t.Helper()
	path := filepath.Join("testdata", "parity-cases.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取对拍快照失败: %v", err)
	}
	var fixture parityFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("解析对拍快照失败: %v", err)
	}
	return fixture
}

// equalStringSlices 把 nil 与空切片视为相等（Node 侧 [] 与 Go 侧 nil 同义）。
func equalStringSlices(left []string, right []string) bool {
	if len(left) == 0 && len(right) == 0 {
		return true
	}
	return reflect.DeepEqual(left, right)
}

// compareCommand 逐字段比较一条命令产物。
func compareCommand(t *testing.T, name string, got Command, gotErr error, want *parityCommand, wantErr *parityErrorLiteral) {
	t.Helper()
	if wantErr != nil {
		if gotErr == nil {
			t.Fatalf("%s: 期望错误 %s，实际命令 %#v", name, wantErr.Code, got)
		}
		if code := ErrorCode(gotErr); code != wantErr.Code {
			t.Fatalf("%s: 错误码 = %q，期望 %q", name, code, wantErr.Code)
		}
		if message := gotErr.Error(); message != wantErr.Message {
			t.Fatalf("%s: 错误消息 = %q，期望 %q", name, message, wantErr.Message)
		}
		return
	}
	if gotErr != nil {
		t.Fatalf("%s: 不应报错: %v", name, gotErr)
	}
	if want == nil {
		t.Fatalf("%s: 快照缺少 result", name)
	}
	if got.CommandName != want.CommandName {
		t.Fatalf("%s: commandName = %q，期望 %q", name, got.CommandName, want.CommandName)
	}
	if !equalStringSlices(got.Args, want.Args) {
		t.Fatalf("%s: args = %#v，期望 %#v", name, got.Args, want.Args)
	}
}

// toGeneric 把值转成 JSON 通用形态，用于跨语言逐字段比较（数字统一成 float64）。
func toGeneric(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var generic any
	if err := json.Unmarshal(data, &generic); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	return generic
}

func TestStartCommandParity(t *testing.T) {
	fixture := loadParityFixture(t)
	if len(fixture.Start) == 0 {
		t.Fatal("快照没有 start 用例")
	}
	for _, testCase := range fixture.Start {
		testCase := testCase
		t.Run(testCase.Name, func(t *testing.T) {
			got, err := BuildStartCommand(testCase.Provider, StartOptions{
				Prompt:         testCase.Options.Prompt,
				SessionID:      testCase.Options.SessionID,
				Model:          testCase.Options.Model,
				ImagePaths:     testCase.Options.ImagePaths,
				InteractiveCLI: testCase.Options.InteractiveCLI,
				ProjectPath:    testCase.Options.ProjectPath,
				Layout:         ResolveOpenCodeLayout(testCase.Env["AIH_OPENCODE_GATEWAY"]),
				Platform:       fixture.Platform,
			})
			compareCommand(t, testCase.Name, got, err, testCase.Result, testCase.Error)
		})
	}
}

func TestResumeCommandParity(t *testing.T) {
	fixture := loadParityFixture(t)
	if len(fixture.Resume) == 0 {
		t.Fatal("快照没有 resume 用例")
	}
	for _, testCase := range fixture.Resume {
		testCase := testCase
		t.Run(testCase.Name, func(t *testing.T) {
			got, err := BuildResumeCommand(testCase.Provider, ResumeOptions{
				Prompt:         testCase.Options.Prompt,
				SessionID:      testCase.Options.SessionID,
				Model:          testCase.Options.Model,
				ImagePaths:     testCase.Options.ImagePaths,
				InteractiveCLI: testCase.Options.InteractiveCLI,
				ProjectDirName: testCase.Options.ProjectDirName,
				SessionPath:    testCase.Options.SessionPath,
				Layout:         ResolveOpenCodeLayout(testCase.Env["AIH_OPENCODE_GATEWAY"]),
				Platform:       fixture.Platform,
			})
			compareCommand(t, testCase.Name, got, err, testCase.Result, testCase.Error)
		})
	}
}

// TestGeminiResumeSessionFile 覆盖 Node 侧需要读盘解析的 gemini 会话文件注入点。
func TestGeminiResumeSessionFile(t *testing.T) {
	got, err := BuildResumeCommand("gemini", ResumeOptions{
		Prompt:            "next",
		SessionID:         "sid-1",
		GeminiSessionFile: "/sessions/gemini-1.json",
	})
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	want := []string{"--session-file", "/sessions/gemini-1.json", "--prompt-interactive", "next"}
	if !equalStringSlices(got.Args, want) {
		t.Fatalf("args = %#v，期望 %#v", got.Args, want)
	}
	fallback, err := BuildResumeCommand("gemini", ResumeOptions{Prompt: "next", SessionID: "sid-1"})
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if !equalStringSlices(fallback.Args, []string{"--resume", "sid-1", "--prompt-interactive", "next"}) {
		t.Fatalf("回退 args = %#v", fallback.Args)
	}
}

// TestClaudeStreamJSONInputWindowsFallback 覆盖 Node 只能在 Windows 上验证的分支：
// Go 调用方可能直接传 runtime.GOOS（windows），必须与 Node 的 win32 同义。
func TestClaudeStreamJSONInputWindowsFallback(t *testing.T) {
	if ClaudeUsesStreamJSONInput("claude", false, "windows") {
		t.Fatal("windows 不应启用 stream-json 输入")
	}
	if !ClaudeUsesStreamJSONInput("claude", false, "darwin") {
		t.Fatal("darwin 应启用 stream-json 输入")
	}
	if ClaudeUsesStreamJSONInput("claude", true, "darwin") {
		t.Fatal("交互式不应启用 stream-json 输入")
	}
	command, err := BuildStartCommand("claude", StartOptions{
		Prompt: "hi", SessionID: "sid-1", Platform: "windows",
	})
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	want := []string{"--print", "--verbose", "--output-format", "stream-json", "--session-id", "sid-1", "hi"}
	if !equalStringSlices(command.Args, want) {
		t.Fatalf("args = %#v，期望 %#v", command.Args, want)
	}
}

func TestShellConstructionParity(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.Shell.Quote {
		if got := ShellSingleQuote(testCase.Value); got != testCase.Expect {
			t.Fatalf("ShellSingleQuote(%q) = %q，期望 %q", testCase.Value, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Shell.Socket {
		if got := SocketForRun(testCase.Value); got != testCase.Expect {
			t.Fatalf("SocketForRun(%q) = %q，期望 %q", testCase.Value, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Shell.Inner {
		if got := BuildInnerCommandFromArgv(testCase.Command, testCase.Args); got != testCase.Expect {
			t.Fatalf("BuildInnerCommandFromArgv = %q，期望 %q", got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Shell.RunShell {
		if got := BuildRunShellCommand(testCase.Inner, testCase.LogPath); got != testCase.Expect {
			t.Fatalf("BuildRunShellCommand = %q，期望 %q", got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Shell.ClaudeShell {
		if got := BuildClaudeStreamJSONShellCommand(testCase.MessageFile, testCase.Command, testCase.Args); got != testCase.Expect {
			t.Fatalf("BuildClaudeStreamJSONShellCommand = %q，期望 %q", got, testCase.Expect)
		}
	}
}

func TestClaudeStreamJSONMessageParity(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.StreamJSON {
		images := make([]ImageAttachment, 0, len(testCase.Images))
		for _, image := range testCase.Images {
			images = append(images, ImageAttachment{MediaType: image.MediaType, Base64: image.Data})
		}
		if got := BuildClaudeStreamJSONUserMessage(testCase.Prompt, images); got != testCase.Expect {
			t.Fatalf("%s: 消息 = %q，期望 %q", testCase.Name, got, testCase.Expect)
		}
	}
}

func TestImageMediaTypeParity(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.MediaType {
		if got := DetectImageMediaType(testCase.Value); got != testCase.Expect {
			t.Fatalf("DetectImageMediaType(%q) = %q，期望 %q", testCase.Value, got, testCase.Expect)
		}
	}
}

func TestMiscConstructionParity(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.Misc.ConfigDirArgs {
		got := ApplyProviderConfigDirArgs(testCase.Provider, testCase.Args, testCase.RuntimeDir)
		if !equalStringSlices(got, testCase.Expect) {
			t.Fatalf("%s: args = %#v，期望 %#v", testCase.Name, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Misc.RunsHome {
		if got := ResolveRunsAIHomeDir(testCase.Injected, testCase.Env, testCase.HomeDir); got != testCase.Expect {
			t.Fatalf("%s: runs home = %q，期望 %q", testCase.Name, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Misc.Multiplexer {
		got := ShouldUseTmuxNativeRun(testCase.Provider, MultiplexerOptions{
			MultiplexerEnv: testCase.MultiplexerEnv,
			InteractiveCLI: testCase.InteractiveCLI,
			Platform:       testCase.Platform,
			Available:      testCase.Available,
		})
		if got != testCase.Expect {
			t.Fatalf("%s: tmux = %v，期望 %v", testCase.Name, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Misc.OpenCodeLayout {
		got := ResolveOpenCodeLayout(testCase.Env)
		if got.ID != testCase.Expect.ID ||
			got.DirectoryFlag != testCase.Expect.DirectoryFlag ||
			got.StandaloneFlag != testCase.Expect.StandaloneFlag ||
			got.PWDDirectory != testCase.Expect.PWDDirectory {
			t.Fatalf("布局 %q = %#v，期望 %#v", testCase.Env, got, testCase.Expect)
		}
	}
}

func TestTransportParity(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.Transport.Cases {
		got := ResolveNativeChatTransport(testCase.Provider, testCase.IsResume)
		want := Transport{
			Mode:           testCase.Expect.Mode,
			PromptDelivery: testCase.Expect.PromptDelivery,
			StreamUsage:    testCase.Expect.StreamUsage,
		}
		if got != want {
			t.Fatalf("%s resume=%v: transport = %#v，期望 %#v", testCase.Provider, testCase.IsResume, got, want)
		}
	}
	if got := TmuxRunProviders(); !reflect.DeepEqual(got, fixture.Transport.TmuxRunProviders) {
		t.Fatalf("TmuxRunProviders() = %#v，期望 %#v", got, fixture.Transport.TmuxRunProviders)
	}
	for _, testCase := range fixture.Transport.CLIGenerated {
		if got := InfersCLIGeneratedSessionIDOnExit(testCase.Provider); got != testCase.Expect {
			t.Fatalf("%s: 回认会话 id = %v，期望 %v", testCase.Provider, got, testCase.Expect)
		}
	}
}

func TestFailureClassificationParity(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.Failure {
		input := &FailureError{
			Code:    testCase.ErrorLike.Code,
			Message: testCase.ErrorLike.Message,
			Detail:  testCase.ErrorLike.Detail,
		}
		if testCase.ErrorLike.Details != nil {
			input.Details = &FailureDetails{
				Detail:  testCase.ErrorLike.Details.Detail,
				Message: testCase.ErrorLike.Details.Message,
			}
		}
		got := ClassifyNativeSessionFailure(testCase.Provider, input, FailureOptions{ExitCode: testCase.Options.ExitCode})
		want := FailureClassification{
			Code:                testCase.Expect.Code,
			Message:             testCase.Expect.Message,
			RetryAnotherAccount: testCase.Expect.RetryAnotherAccount,
		}
		if got != want {
			t.Fatalf("%s: 分类 = %#v，期望 %#v", testCase.Name, got, want)
		}
	}
}

func TestAccountRuntimeBlockerParity(t *testing.T) {
	fixture := loadParityFixture(t)
	for index, testCase := range fixture.Blocker {
		provider := testCase.Provider
		if provider == "" {
			provider = "claude"
		}
		got := ClassifyNativeAccountRuntimeBlocker(provider, testCase.Output, fixture.NowMs)
		if !reflect.DeepEqual(toGeneric(t, got), toGeneric(t, testCase.Expect)) {
			gotJSON, _ := json.Marshal(got)
			t.Fatalf("blocker[%d] provider=%s: 得到 %s，期望 %s", index, provider, gotJSON, string(testCase.Expect))
		}
	}
}

func TestEnvironmentProjectionParity(t *testing.T) {
	fixture := loadParityFixture(t)
	for _, testCase := range fixture.Environment.Strips {
		if got := providerruntime.StripAccountScopedEnv(testCase.Base); !reflect.DeepEqual(got, testCase.Expect) {
			t.Fatalf("%s: strip = %#v，期望 %#v", testCase.Name, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Environment.Scoped {
		if got := providerruntime.BuildAccountScopedEnv(testCase.Base, testCase.Account); !reflect.DeepEqual(got, testCase.Expect) {
			t.Fatalf("%s: scoped = %#v，期望 %#v", testCase.Name, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Environment.Projection {
		got := providerruntime.RequiresProviderAuthProjection(testCase.Provider, testCase.AccountEnv, providerruntime.AuthProjectionOptions{
			IsLogin:     testCase.Flags.IsLogin,
			Gateway:     testCase.Flags.Gateway,
			AuthRelayed: testCase.Flags.AuthRelayed,
		})
		if got != testCase.Expect {
			t.Fatalf("%s/%s: projection = %v，期望 %v", testCase.Provider, testCase.Variant, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Environment.Scopes {
		got := providerruntime.ResolveProviderRuntimeScope(testCase.Provider, testCase.ProjectionDir, map[string]string{
			"HOME": "/host/home",
		}, providerruntime.RuntimeScopeOptions{
			AuthProjectionOptions: providerruntime.AuthProjectionOptions{
				Gateway:     testCase.Flags.Gateway,
				AuthRelayed: testCase.Flags.AuthRelayed,
			},
			AccountEnv:               testCase.AccountEnv,
			HostHomeDir:              "/host/home",
			Platform:                 "darwin",
			RelayKeepsAccountSandbox: testCase.Flags.RelayKeepsAccountSandbox,
		})
		if got.HostHomeDir != testCase.Expect.HostHomeDir ||
			got.ProjectionRequired != testCase.Expect.ProjectionRequired ||
			got.RuntimeDir != testCase.Expect.RuntimeDir {
			t.Fatalf("%s %q: scope = %#v，期望 %#v", testCase.Provider, testCase.ProjectionDir, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Environment.Gemini {
		if got := providerruntime.GeminiCliEndpointEnv(testCase.AccountEnv); !reflect.DeepEqual(got, testCase.Expect) {
			t.Fatalf("gemini 接入点 = %#v，期望 %#v", got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Environment.Extra {
		if got := providerruntime.BuildProviderEnvExtra(testCase.Provider, testCase.AccountEnv); !reflect.DeepEqual(got, testCase.Expect) {
			t.Fatalf("%s: extra = %#v，期望 %#v", testCase.Provider, got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Environment.HostHome {
		if got := providerruntime.ResolveHostHomeDir(testCase.Injected, testCase.Env, testCase.Platform); got != testCase.Expect {
			t.Fatalf("host home = %q，期望 %q", got, testCase.Expect)
		}
	}
	for _, testCase := range fixture.Environment.AuthModes {
		if !reflect.DeepEqual(toGeneric(t, BuildNativeAccountRuntimeBaseState(testCase.Value)), toGeneric(t, testCase.Expect)) {
			t.Fatalf("auth mode %q 不匹配", testCase.Value)
		}
	}
}

// TestBuildHostScopedBaseEnv 覆盖 Node 未导出的私有投影步骤。
func TestBuildHostScopedBaseEnv(t *testing.T) {
	base := map[string]string{
		"HOME":                 "/host/home",
		"USERPROFILE":          "/host/home",
		"CLAUDE_CONFIG_DIR":    "/host/.claude",
		"CODEX_HOME":           "/host/.codex",
		"CODEBUDDY_CONFIG_DIR": "/host/.codebuddy",
		"CLINE_DIR":            "/host/.cline",
		"KEEP_ME":              "yes",
	}
	got := providerruntime.BuildHostScopedBaseEnv(base, "/new/home")
	want := map[string]string{
		"HOME":        "/new/home",
		"USERPROFILE": "/new/home",
		"KEEP_ME":     "yes",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("host scoped = %#v，期望 %#v", got, want)
	}
}

// TestBuildProjectedEnvironment 覆盖环境投影的组合顺序与账号引用写入。
func TestBuildProjectedEnvironment(t *testing.T) {
	env := providerruntime.BuildProjectedEnvironment(providerruntime.EnvironmentInput{
		Provider: "gemini",
		BaseEnv: map[string]string{
			"HOME":              "/host/home",
			"GEMINI_API_KEY":    "host-key",
			"CLAUDE_CONFIG_DIR": "/host/.claude",
			"GEMINI_BASE_URL":   "/host/base",
		},
		AccountEnv: map[string]string{
			"GEMINI_BASE_URL":      "http://gw",
			"VERTEX_AI_PROJECT_ID": "p",
		},
		HostHomeDir: "/host/home",
		ExtraEnv:    map[string]string{"GEMINI_CLI_TRUST_WORKSPACE": "true"},
		AccountRef:  "acct_0123456789abcdef0123",
	})
	want := map[string]string{
		"HOME":                       "/host/home",
		"USERPROFILE":                "/host/home",
		"GEMINI_BASE_URL":            "http://gw",
		"VERTEX_AI_PROJECT_ID":       "p",
		"GOOGLE_GENAI_USE_VERTEXAI":  "true",
		"GOOGLE_VERTEX_BASE_URL":     "http://gw",
		"GOOGLE_CLOUD_PROJECT":       "p",
		"GEMINI_CLI_TRUST_WORKSPACE": "true",
		"AIH_PROVIDER_ACCOUNT_REF":   "acct_0123456789abcdef0123",
	}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("projected = %#v，期望 %#v", env, want)
	}
	// 非法账号引用必须清掉继承来的变量。
	cleared := providerruntime.BuildProjectedEnvironment(providerruntime.EnvironmentInput{
		BaseEnv:    map[string]string{"AIH_PROVIDER_ACCOUNT_REF": "acct_ffffffffffffffffffff"},
		AccountRef: "not-an-account",
	})
	if _, found := cleared["AIH_PROVIDER_ACCOUNT_REF"]; found {
		t.Fatal("非法账号引用未被清除")
	}
}

func TestNormalizeProviderAccountRef(t *testing.T) {
	cases := []struct {
		value string
		want  string
	}{
		{"acct_0123456789abcdef0123", "acct_0123456789abcdef0123"},
		{" acct_0123456789abcdef0123 ", "acct_0123456789abcdef0123"},
		{"acct_0123456789ABCDEF0123", ""},
		{"acct_short", ""},
		{"", ""},
	}
	for _, testCase := range cases {
		if got := providerruntime.NormalizeProviderAccountRef(testCase.value); got != testCase.want {
			t.Fatalf("NormalizeProviderAccountRef(%q) = %q，期望 %q", testCase.value, got, testCase.want)
		}
	}
}

func TestShouldScanNativeRuntimeBlockerOutput(t *testing.T) {
	zero := 0.0
	one := 1.0
	cases := []struct {
		name        string
		interactive bool
		explicit    bool
		exitCode    *float64
		want        bool
	}{
		{"interactive", true, false, nil, true},
		{"explicit error", false, true, nil, true},
		{"non-zero exit", false, false, &one, true},
		{"zero exit", false, false, &zero, false},
		{"no exit", false, false, nil, false},
	}
	for _, testCase := range cases {
		if got := ShouldScanNativeRuntimeBlockerOutput(testCase.interactive, testCase.explicit, testCase.exitCode); got != testCase.want {
			t.Fatalf("%s: got %v，期望 %v", testCase.name, got, testCase.want)
		}
	}
}
