package clilogin

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

const fakeAgyToken = `{"auth_method":"consumer","id_token_email":"agy.test@example.com","token":{"access_token":"ya29.access-token-value","refresh_token":"1//refresh-token-value","token_type":"Bearer","expiry":"2099-01-02T03:04:05.000Z","expires_at_ms":4070903045000}}`

// fakeAgyScript 是假 CLI：打印登录菜单并写出 agy 凭据文件。
const fakeAgyScript = `#!/bin/sh
printf 'Select login method
1. Google OAuth
2. Google Cloud project
'
mkdir -p "$HOME/.gemini/antigravity-cli"
printf '%s' '@TOKEN@' > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
printf 'agy.test@example.com' > "$HOME/.gemini/antigravity-cli/email.cache"
`

func writeFakeCLI(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agy")
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("写入假 CLI 失败: %v", err)
	}
	return path
}

func newTestCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("构建 Provider 合同失败: %v", err)
	}
	return catalog
}

func TestRunRegistersAgyAccount(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 CLI 用 sh 脚本")
	}
	aiHomeDir := t.TempDir()
	hostHomeDir := t.TempDir()
	script := writeFakeCLI(t, strings.ReplaceAll(fakeAgyScript, "@TOKEN@", fakeAgyToken))
	t.Setenv("AIH_AGY_BINARY", script)
	var output strings.Builder
	account, err := Run(context.Background(), Options{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		ProviderID:  "agy",
		Stdin:       strings.NewReader(""),
		Stdout:      &output,
		Stderr:      &output,
	})
	if err != nil {
		t.Fatalf("Run 失败: %v\n%s", err, output.String())
	}
	if account.ProviderID() != "agy" {
		t.Fatalf("ProviderID = %q，想要 agy", account.ProviderID())
	}
	if account.Ref().String() == "" || account.CLIAccountID().Int64() <= 0 {
		t.Fatalf("账号身份缺失: ref=%q cli=%d", account.Ref(), account.CLIAccountID().Int64())
	}
	if !strings.Contains(output.String(), "登录成功") {
		t.Fatalf("缺少成功提示: %s", output.String())
	}
	// 登录进程必须用自己的 HOME：宿主 HOME 不能留下凭据。
	hostToken := filepath.Join(hostHomeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token")
	if _, statErr := os.Stat(hostToken); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("宿主 HOME 被写入凭据: %v", statErr)
	}
	// 运行目录保留在 run/login 下（与 Node 同布局），凭据可回看。
	matches, globErr := filepath.Glob(filepath.Join(aiHomeDir, "run", "login", "agy", "auth-*"))
	if globErr != nil || len(matches) != 1 {
		t.Fatalf("运行目录数量 = %d, err=%v", len(matches), globErr)
	}
	// BROWSER 落到「只回显 URL」的捕获脚本，不能真的拉起宿主浏览器。
	captureInfo, statErr := os.Stat(filepath.Join(matches[0], browserCaptureUnix))
	if statErr != nil || captureInfo.Mode()&0o111 == 0 {
		t.Fatalf("浏览器捕获脚本缺失或不可执行: %v", statErr)
	}
}

func TestRunReportsMissingCredential(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 CLI 用 sh 脚本")
	}
	script := writeFakeCLI(t, "#!/bin/sh\nprintf 'no login here\n'\n")
	t.Setenv("AIH_AGY_BINARY", script)
	var output strings.Builder
	_, err := Run(context.Background(), Options{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ProviderID:  "agy",
		Stdin:       strings.NewReader(""),
		Stdout:      &output,
		Stderr:      &output,
	})
	if !errors.Is(err, ErrCredentialMissing) {
		t.Fatalf("err = %v，想要 ErrCredentialMissing", err)
	}
}

func TestRunRejectsUnsupportedProvider(t *testing.T) {
	_, err := Run(context.Background(), Options{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ProviderID:  "kiro",
		Stdin:       strings.NewReader(""),
		Stdout:      &strings.Builder{},
		Stderr:      &strings.Builder{},
	})
	if !errors.Is(err, ErrUnsupportedProvider) {
		t.Fatalf("err = %v，想要 ErrUnsupportedProvider", err)
	}
}

func TestAgyLayoutPointsHomeAtRuntimeDir(t *testing.T) {
	catalog := newTestCatalog(t)
	runtimeDir := filepath.Join(t.TempDir(), "run")
	configDir, env, err := agyLayout(catalog, "/host/home", runtimeDir)
	if err != nil {
		t.Fatalf("agyLayout: %v", err)
	}
	if configDir != filepath.Join(runtimeDir, ".gemini", "antigravity-cli") {
		t.Fatalf("configDir = %q", configDir)
	}
	if env["HOME"] != runtimeDir || env["USERPROFILE"] != runtimeDir {
		t.Fatalf("HOME = %q USERPROFILE = %q", env["HOME"], env["USERPROFILE"])
	}
	// Keychain 绕过变量必须成套出现，否则 agy 会去读宿主钥匙串。
	for _, key := range []string{"SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "container", "WSL_DISTRO_NAME"} {
		if strings.TrimSpace(env[key]) == "" {
			t.Fatalf("%s 未设置", key)
		}
	}
	if got := env["XDG_CONFIG_HOME"]; !strings.HasPrefix(got, "/host/home/.gemini/antigravity-cli/") {
		t.Fatalf("XDG_CONFIG_HOME = %q", got)
	}
}

func TestBaseEnvironmentStripsAccountKeys(t *testing.T) {
	t.Setenv("AGY_ACCESS_TOKEN", "host-token")
	t.Setenv("CODEBUDDY_API_KEY", "host-key")
	env := baseEnvironment("/host/home")
	for _, key := range []string{"AGY_ACCESS_TOKEN", "CODEBUDDY_API_KEY"} {
		if _, found := env[key]; found {
			t.Fatalf("%s 未从宿主环境剥离", key)
		}
	}
}
