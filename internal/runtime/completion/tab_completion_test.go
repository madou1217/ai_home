package completion

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// resolverForTest 构造不依赖真实 HOME 的候选上下文。
func resolverForTest() *resolverContext {
	return &resolverContext{
		now: time.Unix(1_700_000_000, 0),
		accountLister: func(provider string) []accountRow {
			if provider != "codex" {
				return nil
			}
			return []accountRow{{Provider: "codex", CLIAccountID: "41", AccountRef: "acct_c016fd7eee0f64163068"}}
		},
		modelLister: func(request modelRequest) []modelChoice {
			if request.Mode != "model" {
				return nil
			}
			return []modelChoice{
				{Value: "gpt-6.2-sol", Description: "主模型"},
				{Value: "gpt-6.2-astra", Description: "备用模型"},
			}
		},
		sessionLister: func(provider, accountRef, current string) []sessionChoice {
			if provider != "codex" {
				return nil
			}
			return []sessionChoice{{ID: "01a1f21b-8aab-7e13-b2fb-8255a465c8be", Title: "卡住的线程", UpdatedAt: "1795596528812"}}
		},
	}
}

func candidateValues(candidates []Candidate) []string {
	values := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		values = append(values, candidate.Value)
	}
	return values
}

func assertCandidate(t *testing.T, candidates []Candidate, wanted string) {
	t.Helper()
	for _, candidate := range candidates {
		if candidate.Value == wanted {
			return
		}
	}
	t.Fatalf("缺少候选 %q，实际为 %v", wanted, candidateValues(candidates))
}

func assertNoCandidate(t *testing.T, candidates []Candidate, unwanted string) {
	t.Helper()
	for _, candidate := range candidates {
		if candidate.Value == unwanted {
			t.Fatalf("不应出现候选 %q：%v", unwanted, candidateValues(candidates))
		}
	}
}

// `-m` 是 Codex 原生模型旗标；TAB 必须和 --model 一样给出模型目录。
func TestProviderLaunchShortModelFlagCompletesModels(t *testing.T) {
	context := resolverForTest()
	for _, words := range [][]string{
		{"codex", "relay", "41", "-m", ""},
		{"codex", "relay", "41", "-m", "gpt-6"},
	} {
		candidates := resolveCompletion(words, context)
		assertCandidate(t, candidates, "gpt-6.2-sol")
	}
	// 已敲完整模型名后不应继续把模型当候选（下一位置是旗标）。
	candidates := resolveCompletion([]string{"codex", "relay", "41", "-m", "gpt-6.2-sol", ""}, context)
	assertNoCandidate(t, candidates, "gpt-6.2-sol")
	assertCandidate(t, candidates, "--model-alias")
}

// 空的 -m / --model 位置不能只给旗标，必须列模型。
func TestProviderLaunchModelFlagListedAndValuesPresent(t *testing.T) {
	context := resolverForTest()
	flags := resolveCompletion([]string{"codex", "relay", "41", ""}, context)
	assertCandidate(t, flags, "-m")
	assertCandidate(t, flags, "--model")

	models := resolveCompletion([]string{"codex", "relay", "41", "-m", ""}, context)
	assertCandidate(t, models, "gpt-6.2-sol")
}

func TestCodexTakeoverActionAndThreadCandidates(t *testing.T) {
	context := resolverForTest()
	actions := resolveCompletion([]string{"codex", "take"}, context)
	assertCandidate(t, actions, "takeover")

	args := resolveCompletion([]string{"codex", "takeover", ""}, context)
	assertCandidate(t, args, "--force")
	assertCandidate(t, args, "01a1f21b-8aab-7e13-b2fb-8255a465c8be")
}

func TestAgySessionVerbs(t *testing.T) {
	context := resolverForTest()
	candidates := resolveCompletion([]string{"agy", "session", ""}, context)
	for _, verb := range []string{"open", "ls", "show", "say", "tail", "resume", "close"} {
		assertCandidate(t, candidates, verb)
	}

	acp := resolveCompletion([]string{"agy", "acp", ""}, context)
	assertCandidate(t, acp, "--auto-approve")
}

func TestSummaryAndProxyCommandsExist(t *testing.T) {
	context := resolverForTest()
	top := resolveCompletion([]string{""}, context)
	assertCandidate(t, top, "summary")
	assertCandidate(t, top, "proxy")

	summary := resolveCompletion([]string{"summary", ""}, context)
	assertCandidate(t, summary, "--from")

	proxy := resolveCompletion([]string{"proxy", ""}, context)
	assertCandidate(t, proxy, "serve")
	assertCandidate(t, proxy, "service")
	assertCandidate(t, resolveCompletion([]string{"proxy", "serve", ""}, context), "--no-socks")
}

func TestClientKeyCandidatesSkipRevoked(t *testing.T) {
	home := t.TempDir()
	database, err := sql.Open("sqlite", filepath.Join(home, "aih.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if _, err := database.Exec(`CREATE TABLE client_api_keys (
		key_id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, revoked_at_ms INTEGER, created_at_ms INTEGER)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO client_api_keys (key_id, name, enabled, revoked_at_ms, created_at_ms)
		VALUES ("ck_active", "生产 key", 1, 0, 2), ("ck_off", "停用 key", 0, 0, 1), ("ck_dead", "已撤销", 1, 99, 0)`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	choices := listClientKeys(home)
	values := make([]string, 0, len(choices))
	for _, choice := range choices {
		values = append(values, choice.Value)
	}
	joined := strings.Join(values, ",")
	if !strings.Contains(joined, "ck_active") || !strings.Contains(joined, "ck_off") {
		t.Fatalf("应包含未撤销的 key，实际 %s", joined)
	}
	if strings.Contains(joined, "ck_dead") {
		t.Fatalf("已撤销的 key 不应出现：%s", joined)
	}
}

func TestBackupTargetCandidates(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "backup")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := `{"version":1,"enabled":true,"targets":[{"id":"jp","strategy":"ssh","enabled":true,"host":"example.com","username":"me","remoteDir":"/backup"}]}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(content), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	choices := listBackupTargets(home)
	if len(choices) != 1 || choices[0].Value != "jp" {
		t.Fatalf("备份目标候选不正确：%+v", choices)
	}
}

// Codex 专属动作的取值面：默认模型、推理强度、沙箱策略。
func TestCodexActionValueCandidates(t *testing.T) {
	context := resolverForTest()
	modelValues := resolveCompletion([]string{"codex", "model", ""}, context)
	assertCandidate(t, modelValues, "show")
	assertCandidate(t, modelValues, "gpt-6.2-sol")

	effort := resolveCompletion([]string{"codex", "effort", ""}, context)
	assertCandidate(t, effort, "xhigh")
	assertCandidate(t, effort, "fast")
	fast := resolveCompletion([]string{"codex", "effort", "fast", ""}, context)
	assertCandidate(t, fast, "on")
	assertCandidate(t, fast, "off")

	policy := resolveCompletion([]string{"codex", "policy", ""}, context)
	assertCandidate(t, policy, "show")
	assertCandidate(t, policy, "set")
	sandbox := resolveCompletion([]string{"codex", "policy", "set", ""}, context)
	assertCandidate(t, sandbox, "danger-full-access")

	gatewayAuth := resolveCompletion([]string{"codex", "gateway-auth", ""}, context)
	assertCandidate(t, gatewayAuth, "--ai-home")
}

func TestLsProviderCompletesAccounts(t *testing.T) {
	context := resolverForTest()
	candidates := resolveCompletion([]string{"ls", "codex", ""}, context)
	assertCandidate(t, candidates, "41")
}

func TestAccountTreeHasNoGhostTransfer(t *testing.T) {
	context := resolverForTest()
	for _, candidate := range resolveCompletion([]string{"account", ""}, context) {
		if candidate.Value == "transfer" {
			t.Fatal("account transfer 未实现，不应出现在补全树里")
		}
	}
}
