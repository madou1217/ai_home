package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexappconfig"
	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

const codexAppServerStdioCapability = "aih-codex-app-server-stdio-v1"

// runCodexAppServerStdio 是 Node codex-app-server-stdio-proxy 的 Go 入口：
// 先自愈/合并配置，再把 stdin/stdout 的 JSON-RPC 帧经共享 bridge 转发给 codex。
func runCodexAppServerStdio(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := printlnLine(runtime.stdout, codexAppServerStdioCapability)
		return err
	}
	upstream := ""
	stateFile := ""
	separator := -1
	for index := 0; index < len(args); index++ {
		switch {
		case args[index] == "--":
			separator = index
			index = len(args)
		case args[index] == "--upstream":
			if index+1 >= len(args) {
				return errors.New("codex_app_server_arguments_invalid")
			}
			upstream = strings.TrimSpace(args[index+1])
			index++
		case strings.HasPrefix(args[index], "--upstream="):
			upstream = strings.TrimSpace(strings.TrimPrefix(args[index], "--upstream="))
		case args[index] == "--state-file":
			if index+1 >= len(args) {
				return errors.New("codex_app_server_arguments_invalid")
			}
			stateFile = strings.TrimSpace(args[index+1])
			index++
		case strings.HasPrefix(args[index], "--state-file="):
			stateFile = strings.TrimSpace(strings.TrimPrefix(args[index], "--state-file="))
		}
	}
	if separator < 0 || separator+1 >= len(args) {
		return errors.New("codex_app_server_arguments_invalid")
	}
	forwardArgs := append([]string{}, args[separator+1:]...)
	if upstream == "" {
		binary, err := providercli.ResolveBinary("codex", "codex")
		if err != nil {
			return err
		}
		upstream = binary
	}

	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		home := strings.TrimSpace(os.Getenv("HOME"))
		if home == "" {
			home = strings.TrimSpace(os.Getenv("USERPROFILE"))
		}
		codexHome = filepath.Join(home, ".codex")
	}
	configPath := filepath.Join(codexHome, "config.toml")
	envMap := envSliceMap(os.Environ())
	apiKey := strings.TrimSpace(envMap["OPENAI_API_KEY"])
	baseURL := strings.TrimSpace(envMap["OPENAI_BASE_URL"])
	spawnEnv := append([]string{}, os.Environ()...)

	if identity, runtimeHome := resolveDesktopRuntime(stateFile, codexHome, apiKey, baseURL, envMap); identity != nil {
		configPath = filepath.Join(runtimeHome, "config.toml")
		spawnEnv = replaceEnv(spawnEnv, "CODEX_HOME", runtimeHome)
		spawnEnv = replaceEnv(spawnEnv, "CODEX_SQLITE_HOME", codexHome)
	} else {
		syncOptions := codexappconfig.SyncOptions{
			HasIsAPIKeyMode: apiKey != "" || baseURL != "",
			IsAPIKeyMode:    apiKey != "" || baseURL != "",
			OpenAIAPIKey:    apiKey,
			OpenAIBaseURL:   baseURL,
			CodexVersion:    strings.TrimSpace(envMap["AIH_CODEX_VERSION"]),
		}
		if _, err := codexappconfig.PrepareConfigFile(configPath, codexappconfig.AccountOnlyConfig{}, syncOptions, codexappconfig.HealOptions{}); err != nil {
			return err
		}
	}
	if !codexappconfig.HasCodexModelProviderArg(forwardArgs) {
		providerArgs := codexappconfig.BuildProviderArgs(envMap, codexappconfig.ProviderArgsOptions{})
		forwardArgs = codexappconfig.InjectProviderArgs(forwardArgs, providerArgs)
	}

	process, err := codexappserverws.StartAppServerProcess(codexappserverws.StartProcessOptions{
		Command: upstream,
		Args:    forwardArgs,
		Env:     spawnEnv,
	})
	if err != nil {
		return err
	}
	session := &codexappserverws.StdioBridgeSession{
		Stdin:  process.Stdin(),
		Stdout: process.Stdout(),
		Stderr: process.Stderr(),
		Wait: func() error {
			<-process.Done()
			return process.WaitErr()
		},
		Close: func() error {
			process.Close()
			return nil
		},
	}
	frames := &stdioLineTransport{reader: bufio.NewReaderSize(runtime.stdin, 64<<10), writer: runtime.stdout}
	codexappserverws.BridgeStdio(ctx, frames, session, codexappserverws.FrameBridgeOptions{
		MaxFrameBytes:   16 << 20,
		StdioHalfClose:  true,
		StdinEOFTimeout: 15 * time.Second,
	})
	return nil
}

// stdioLineTransport 把 newline-delimited JSON 当作帧；与 WebSocket adapter 共用 bridge。
type stdioLineTransport struct {
	reader *bufio.Reader
	writer io.Writer
}

func (transport *stdioLineTransport) Read(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	line, err := transport.reader.ReadBytes('\n')
	trimmed := strings.TrimSuffix(strings.TrimSuffix(string(line), "\n"), "\r")
	if trimmed == "" && err == nil {
		return []byte(""), nil
	}
	return []byte(trimmed), err
}

func (transport *stdioLineTransport) Write(ctx context.Context, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := transport.writer.Write(payload); err != nil {
		return err
	}
	_, err := transport.writer.Write([]byte{'\n'})
	return err
}

func (transport *stdioLineTransport) Close() error { return nil }

func printlnLine(writer io.Writer, value string) (int, error) {
	return io.WriteString(writer, value+"\n")
}

func resolveDesktopRuntime(stateFile, hostCodexHome, gatewayBaseURL, gatewayAPIKey string, envMap map[string]string) (*codexappconfig.DesktopIdentity, string) {
	aiHome := strings.TrimSpace(envMap["AIH_HOME_DIR"])
	if aiHome == "" {
		if home := strings.TrimSpace(envMap["HOME"]); home != "" {
			aiHome = filepath.Join(home, ".ai_home")
		}
	}
	desktopRef := ""
	if stateFile != "" {
		if raw, err := os.ReadFile(stateFile); err == nil {
			var state map[string]any
			if json.Unmarshal(raw, &state) == nil {
				desktopRef, _ = state["desktopAccountRef"].(string)
			}
		}
	}
	if aiHome == "" {
		return nil, ""
	}
	store, err := codexappconfig.OpenAccountStore(aiHome)
	if err != nil {
		return nil, ""
	}
	identity := codexappconfig.ResolveDesktopIdentity(store.CandidateRefs(context.Background(), desktopRef), func(ref string) (codexappconfig.DesktopArtifacts, bool) {
		artifacts, ok, readErr := store.ReadDesktopArtifacts(context.Background(), ref)
		return artifacts, ok && readErr == nil
	}, codexappconfig.IdentityOptions{})
	if identity == nil {
		return nil, ""
	}
	runtime, err := codexappconfig.PrepareDesktopRuntimeHome(aiHome, hostCodexHome, identity, codexappconfig.RuntimeConfigOptions{
		ExecutionAccountRef: identity.AccountRef,
		GatewayBaseURL:      gatewayBaseURL,
		GatewayAPIKey:       gatewayAPIKey,
		SupportsWebsockets:  gatewayBaseURL != "",
	})
	if err != nil {
		return nil, ""
	}
	return identity, runtime.RuntimeHome
}

func replaceEnv(entries []string, key, value string) []string {
	next := make([]string, 0, len(entries)+1)
	prefix := key + "="
	replaced := false
	for _, entry := range entries {
		if strings.HasPrefix(entry, prefix) {
			if !replaced {
				next = append(next, prefix+value)
				replaced = true
			}
			continue
		}
		next = append(next, entry)
	}
	if !replaced {
		next = append(next, prefix+value)
	}
	return next
}

func envSliceMap(entries []string) map[string]string {
	values := make(map[string]string, len(entries))
	for _, entry := range entries {
		name, value, ok := strings.Cut(entry, "=")
		if ok {
			values[name] = value
		}
	}
	return values
}
