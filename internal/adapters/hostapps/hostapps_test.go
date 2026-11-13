package hostapps

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func fakeRunner(outputs map[string]string) CommandRunner {
	return func(_ context.Context, name string, args ...string) ([]byte, error) {
		key := name + " " + strings.Join(args, " ")
		for prefix, output := range outputs {
			if strings.HasPrefix(key, prefix) {
				return []byte(output), nil
			}
		}
		return nil, nil
	}
}

func TestApplicationNameMatchesNodeDerivation(t *testing.T) {
	ref := "acct_0123456789abcdef0123"
	sum := sha256.Sum256([]byte(ref))
	want := "ZCode-" + hex.EncodeToString(sum[:])[:8]
	if got := ApplicationName("zcode", ref); got != want {
		t.Fatalf("zcode application name = %q, want %q", got, want)
	}
	if got := ApplicationName("kiro", ref); got != "aih-kiro_cli_desktop-"+ref {
		t.Fatalf("kiro application name = %q", got)
	}
	if got := ApplicationName("codex", ref); got != "" {
		t.Fatalf("codex application name = %q, want empty", got)
	}
	if got := ApplicationName("zcode", "not-a-ref"); got != "" {
		t.Fatalf("invalid ref application name = %q, want empty", got)
	}
}

func TestListDesktopInstancesRecognizesIdentity(t *testing.T) {
	ref := "acct_0123456789abcdef0123"
	userDataDir := "/Users/model/.ai_home/run/auth-projections/codex/" + ref + "/electron-user-data"
	zcodeName := ApplicationName("zcode", ref)
	processes := strings.Join([]string{
		"101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --user-data-dir=" + userDataDir,
		"102 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --type=renderer --user-data-dir=" + userDataDir,
		"103 " + zcodeName,
		"104 /usr/bin/something --user-data-dir=/tmp/other",
	}, "\n")
	scanner := &Scanner{
		Platform: PlatformMacOS,
		Run:      fakeRunner(map[string]string{"ps -ax -o pid=,command=": processes}),
	}
	instances, err := scanner.ListDesktopInstances(context.Background())
	if err != nil {
		t.Fatalf("ListDesktopInstances: %v", err)
	}
	if len(instances) != 3 {
		t.Fatalf("instances = %+v, want 3", instances)
	}
	if instances[0].UserDataDir != userDataDir {
		t.Fatalf("first user data dir = %q", instances[0].UserDataDir)
	}
	if instances[1].ApplicationName != zcodeName {
		t.Fatalf("zcode application name = %q, want %q", instances[1].ApplicationName, zcodeName)
	}
	if instances[2].UserDataDir != "/tmp/other" {
		t.Fatalf("third user data dir = %q", instances[2].UserDataDir)
	}
}

func TestListCLIInstancesFollowsMarkersAndDescendants(t *testing.T) {
	ref := "acct_0123456789abcdef0123"
	output := strings.Join([]string{
		"200 1 aih codex 12 AIH_ACCOUNT_APP=1 AIH_PROVIDER_ACCOUNT_REF=" + ref,
		"201 200 codex --model gpt-5",
		"300 1 node /opt/ai-home/bin/ai-home.js claude 7 AIH_ACCOUNT_APP=1",
	}, "\n")
	scanner := &Scanner{
		Platform: PlatformMacOS,
		Run:      fakeRunner(map[string]string{"ps -ax -o pid=,ppid=,command=": output}),
	}
	instances, err := scanner.ListCLIInstances(context.Background())
	if err != nil {
		t.Fatalf("ListCLIInstances: %v", err)
	}
	if len(instances) != 3 {
		t.Fatalf("instances = %+v, want 3", instances)
	}
	if instances[0].Provider != "codex" || instances[0].CLIAccountID != "12" || instances[0].AccountRef != ref {
		t.Fatalf("root instance = %+v", instances[0])
	}
	if instances[1].RootPID != 200 || instances[1].AccountRef != ref {
		t.Fatalf("child instance = %+v", instances[1])
	}
	if instances[2].Provider != "claude" || instances[2].CLIAccountID != "7" {
		t.Fatalf("second tree instance = %+v", instances[2])
	}
}

func TestRunningMatchesDesktopAndCLIAccounts(t *testing.T) {
	ref := "acct_0123456789abcdef0123"
	other := "acct_ffffffffffffffffffff"
	aiHomeDir := "/aih"
	userDataDir := UserDataDir(aiHomeDir, "codex", ref)
	zcodeName := ApplicationName("zcode", ref)
	scanner := &Scanner{
		Platform: PlatformMacOS,
		Run: fakeRunner(map[string]string{
			"ps -ax -o pid=,command=": strings.Join([]string{
				"101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --user-data-dir=" + userDataDir,
				"102 " + zcodeName,
			}, "\n"),
			"ps -ax -o pid=,ppid=,command=": strings.Join([]string{
				"200 1 aih claude 12 AIH_ACCOUNT_APP=1 AIH_PROVIDER_ACCOUNT_REF=" + ref,
			}, "\n"),
		}),
	}
	running := scanner.Running(
		context.Background(),
		[]Account{
			{Provider: "codex", AccountRef: ref, Desktop: true},
			{Provider: "zcode", AccountRef: ref, Desktop: true},
			{Provider: "claude", AccountRef: ref},
			{Provider: "codex", AccountRef: other, Desktop: true},
		},
		aiHomeDir,
		nil,
	)
	if got := running.DesktopPIDs[ref]; len(got) != 2 {
		t.Fatalf("desktop pids = %v, want two identities", got)
	}
	if got := running.DesktopPIDs[other]; len(got) != 0 {
		t.Fatalf("unrelated account desktop pids = %v", got)
	}
	if got := running.CLIPIDs[ref]; len(got) != 1 || got[0] != 200 {
		t.Fatalf("cli pids = %v", got)
	}
	if len(running.DesktopAccounts) != 1 || running.DesktopAccounts[0] != ref {
		t.Fatalf("desktop accounts = %v", running.DesktopAccounts)
	}
	if len(running.CLIAccounts) != 1 || running.CLIAccounts[0] != ref {
		t.Fatalf("cli accounts = %v", running.CLIAccounts)
	}
}

func TestRunningFallsBackToCLIAliasSlot(t *testing.T) {
	ref := "acct_0123456789abcdef0123"
	scanner := &Scanner{
		Platform: PlatformMacOS,
		Run: fakeRunner(map[string]string{
			"ps -ax -o pid=,command=":       "",
			"ps -ax -o pid=,ppid=,command=": "200 1 aih codex 12 AIH_ACCOUNT_APP=1",
		}),
	}
	running := scanner.Running(
		context.Background(),
		nil,
		"/aih",
		map[string]string{"codex\x0012": ref},
	)
	if got := running.CLIPIDs[ref]; len(got) != 1 || got[0] != 200 {
		t.Fatalf("cli pids = %v", got)
	}
}

func TestMacUserDataEnvFallback(t *testing.T) {
	ref := "acct_0123456789abcdef0123"
	userDataDir := UserDataDir("/aih", "codex", ref)
	scanner := &Scanner{
		Platform: PlatformMacOS,
		EnvRules: []EnvRule{{
			EnvKey:       "CODEX_ELECTRON_USER_DATA_PATH",
			PathIncludes: []string{"/ChatGPT.app/Contents/MacOS/"},
		}},
		Run: fakeRunner(map[string]string{
			"ps -ax -o pid=,command=": "101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
			"ps eww":                  "101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT CODEX_ELECTRON_USER_DATA_PATH=" + userDataDir + " HOME=/Users/model",
		}),
	}
	instances, err := scanner.ListDesktopInstances(context.Background())
	if err != nil {
		t.Fatalf("ListDesktopInstances: %v", err)
	}
	if len(instances) != 1 || instances[0].UserDataDir != userDataDir {
		t.Fatalf("instances = %+v", instances)
	}
}
