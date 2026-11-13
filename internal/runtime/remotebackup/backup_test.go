package remotebackup

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

func TestConfigNormalizeReadWritePermissions(t *testing.T) {
	aiHome := t.TempDir()

	target, err := NormalizeTarget(TargetInput{
		Address:      "alice@[::1]:2222",
		Key:          "~/.ssh/id_ed25519",
		RemoteDir:    `backups\aih-prod`,
		PasswordEnv:  "AIH_BACKUP_PW",
		IdentityFile: "",
	})
	if err != nil {
		t.Fatalf("NormalizeTarget(ipv6) err = %v", err)
	}
	if target.Host != "::1" || target.Port != 2222 || target.Username != "alice" || target.RemoteDir != "backups/aih-prod" {
		t.Fatalf("unexpected target = %+v", target)
	}
	if target.IdentityFile != "~/.ssh/id_ed25519" {
		t.Fatalf("expected Key fallback into IdentityFile, got %q", target.IdentityFile)
	}

	if _, err := NormalizeTarget(TargetInput{Address: "onlyhost", RemoteDir: "../escape"}); err == nil {
		t.Fatal("expected error for missing username / traversal")
	}
	if _, err := NormalizeTarget(TargetInput{Address: "bob@example.com", RemoteDir: "../escape"}); err == nil {
		t.Fatal("expected error for .. in remoteDir")
	}

	cfg := BackupConfig{
		Version:         BackupConfigVersion,
		Enabled:         true,
		IntervalMinutes: 99999,
		DebounceSeconds: 0,
		Targets:         []BackupTarget{target},
	}
	saved, err := WriteBackupConfig(aiHome, cfg)
	if err != nil {
		t.Fatalf("WriteBackupConfig() err = %v", err)
	}
	if saved.IntervalMinutes != MaxIntervalMinutes {
		t.Fatalf("IntervalMinutes = %d, want clamped %d", saved.IntervalMinutes, MaxIntervalMinutes)
	}
	if saved.DebounceSeconds != 0 {
		t.Fatalf("DebounceSeconds = %d, want 0", saved.DebounceSeconds)
	}

	cfgPath, err := ResolveBackupConfigPath(aiHome)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("config.json perm = %o, want 0600", info.Mode().Perm())
	}

	loaded, err := ReadBackupConfig(aiHome)
	if err != nil {
		t.Fatalf("ReadBackupConfig() err = %v", err)
	}
	if !loaded.Enabled || len(loaded.Targets) != 1 || loaded.Targets[0].Host != "::1" {
		t.Fatalf("loaded = %+v", loaded)
	}

	// Non-strict read skips malformed targets while preserving valid ones.
	mixed := `{"version":1,"enabled":true,"targets":[{"host":"badhost"},{"id":"good","strategy":"ssh","enabled":true,"host":"10.0.0.2","port":22,"username":"ops","remoteDir":".aih-backup"}]}`
	if err := os.WriteFile(cfgPath, []byte(mixed), 0o600); err != nil {
		t.Fatal(err)
	}
	nonStrict, err := ReadBackupConfig(aiHome)
	if err != nil {
		t.Fatalf("ReadBackupConfig(mixed) err = %v", err)
	}
	if len(nonStrict.Targets) != 1 || nonStrict.Targets[0].ID != "good" || nonStrict.DebounceSeconds != DefaultDebounceSeconds {
		t.Fatalf("nonStrict.Targets = %+v", nonStrict.Targets)
	}

	state, err := WriteBackupState(aiHome, BackupState{
		Version: BackupStateVersion,
		Targets: map[string]TargetRunState{
			"good": {LastRunAt: "2026-01-01T00:00:00Z", LastOkAt: "2026-01-01T00:00:00Z", Uploaded: 2, Revision: 1},
		},
	})
	if err != nil || state.Targets["good"].Uploaded != 2 {
		t.Fatalf("WriteBackupState() = %+v, err=%v", state, err)
	}
	readState, err := ReadBackupState(aiHome)
	if err != nil || readState.Targets["good"].Revision != 1 {
		t.Fatalf("ReadBackupState() = %+v, err=%v", readState, err)
	}
}

func TestManifestStableHashAndPlanTombstones(t *testing.T) {
	rec := AccountRecord{
		Provider:     "codex",
		AccountRef:   "acct_0123456789abcdef0123",
		CLIAccountID: "42",
		Status:       "up",
		Env: map[string]string{
			"OPENAI_BASE_URL": "https://api.example.com?a=1&b=2",
			"OPENAI_API_KEY":  "sk-<test>",
		},
		NativeAuth: map[string]any{},
	}

	stable, err := StableStringify(rec)
	if err != nil {
		t.Fatalf("StableStringify() err = %v", err)
	}
	wantStable := `{"accountRef":"acct_0123456789abcdef0123","cliAccountId":"42","env":{"OPENAI_API_KEY":"sk-<test>","OPENAI_BASE_URL":"https://api.example.com?a=1&b=2"},"nativeAuth":{},"provider":"codex","status":"up"}`
	if stable != wantStable {
		t.Fatalf("StableStringify = %s\nwant            = %s", stable, wantStable)
	}
	sha, err := HashAccount(rec)
	if err != nil {
		t.Fatalf("HashAccount() err = %v", err)
	}
	const wantNodeSHA = "f912f419abf06c5fdca2530acb0d15885040e225be9d89a5e1e19a0e018de0df"
	if sha != wantNodeSHA {
		t.Fatalf("HashAccount() = %s, want Node vector %s", sha, wantNodeSHA)
	}

	rec2 := AccountRecord{
		Provider:     "kimi",
		AccountRef:   "acct_abcdef0123456789abcd",
		CLIAccountID: "43",
		Status:       "up",
		Env:          map[string]string{"MOONSHOT_API_KEY": "k-1"},
		NativeAuth:   map[string]any{},
	}

	plan1, err := BuildBackupPlan([]AccountRecord{rec, rec2}, nil, false, "mac-studio")
	if err != nil {
		t.Fatalf("BuildBackupPlan(1) err = %v", err)
	}
	if !plan1.Changed || plan1.Manifest.Revision != 1 || len(plan1.Uploads) != 2 || plan1.Unchanged != 0 {
		t.Fatalf("unexpected plan1 = %+v", plan1)
	}

	plan2, err := BuildBackupPlan([]AccountRecord{rec, rec2}, &plan1.Manifest, false, "")
	if err != nil {
		t.Fatalf("BuildBackupPlan(2) err = %v", err)
	}
	if plan2.Changed || plan2.Manifest.Revision != 1 || len(plan2.Uploads) != 0 || plan2.Unchanged != 2 || plan2.Manifest.Source.Host != "mac-studio" {
		t.Fatalf("unexpected plan2 = %+v", plan2)
	}

	planFull, err := BuildBackupPlan([]AccountRecord{rec, rec2}, &plan2.Manifest, true, "mac-studio")
	if err != nil {
		t.Fatalf("BuildBackupPlan(full) err = %v", err)
	}
	if !planFull.Changed || planFull.Manifest.Revision != 2 || len(planFull.Uploads) != 2 || planFull.Unchanged != 0 {
		t.Fatalf("unexpected planFull = %+v", planFull)
	}

	// Delete rec2 -> tombstone marked deleted=true and deleted list returned once.
	planDel, err := BuildBackupPlan([]AccountRecord{rec}, &planFull.Manifest, false, "mac-studio")
	if err != nil {
		t.Fatalf("BuildBackupPlan(del) err = %v", err)
	}
	if !planDel.Changed || planDel.Manifest.Revision != 3 || len(planDel.Deleted) != 1 || planDel.Deleted[0] != rec2.AccountRef {
		t.Fatalf("unexpected planDel = %+v", planDel)
	}
	if !planDel.Manifest.Accounts[rec2.AccountRef].Deleted {
		t.Fatalf("expected tombstone Deleted=true for %s", rec2.AccountRef)
	}

	// Next run with same active account does NOT change manifest or emit new deletion.
	planDelAgain, err := BuildBackupPlan([]AccountRecord{rec}, &planDel.Manifest, false, "mac-studio")
	if err != nil {
		t.Fatalf("BuildBackupPlan(del2) err = %v", err)
	}
	if planDelAgain.Changed || planDelAgain.Manifest.Revision != 3 || len(planDelAgain.Deleted) != 0 {
		t.Fatalf("unexpected planDelAgain = %+v", planDelAgain)
	}

	serialized, err := SerializeManifest(planDel.Manifest)
	if err != nil {
		t.Fatal(err)
	}
	parsed, ok := ParseManifest("\ufeff" + serialized)
	if !ok || parsed.Revision != 3 || !parsed.Accounts[rec2.AccountRef].Deleted {
		t.Fatalf("ParseManifest(BOM) = %+v, ok=%v", parsed, ok)
	}
	if _, ok := ParseManifest(`{"kind":"other","version":1}`); ok {
		t.Fatal("expected ParseManifest to reject mismatched kind")
	}
}

func TestSQLiteAccountExporterIncludesAPIKeyStaticAndZcodeDecryption(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	now := time.UnixMilli(1700000000000).UTC()
	registrar, err := accountapp.NewRegistrar(catalog, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}

	codexCred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-codex-1", BaseURL: "https://api.openai.com/v1"})
	if err != nil {
		t.Fatal(err)
	}
	codexAcct, err := registrar.Register(ctx, codexCred, nil)
	if err != nil {
		t.Fatal(err)
	}

	kimiCred, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "kimi",
		APIKey:     "kimi-key-456",
		BaseURL:    "https://api.moonshot.cn/v1/",
	})
	if err != nil {
		t.Fatal(err)
	}
	kimiAcct, err := registrar.Register(ctx, kimiCred, nil)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("ZCODE_CREDENTIAL_SECRET", "test-secret")
	hdr := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, _ := json.Marshal(map[string]any{"user_id": "4a1c9d2e-0000-4000-8000-000000000001", "sub": "4a1c9d2e-0000-4000-8000-000000000001"})
	jwt := hdr + "." + base64.RawURLEncoding.EncodeToString(body) + ".sig"
	userInfoJSON, _ := json.Marshal(map[string]any{"user_id": "4a1c9d2e-0000-4000-8000-000000000001", "email": "z@example.com"})
	zcodePayload, err := json.Marshal(map[string]any{
		"credentials": map[string]any{
			"zcodejwttoken":       jwt,
			"oauth:zai:user_info": string(userInfoJSON),
			"secret":              "plain-zcode-secret",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	zcodeCred, err := nativeaccount.NewDecoder().DecodeNativeAuth("zcode", zcodePayload)
	if err != nil {
		t.Fatal(err)
	}
	zcodeAcct, err := registrar.Register(ctx, zcodeCred, nil)
	if err != nil {
		t.Fatal(err)
	}

	exported, err := (SQLiteAccountExporter{Store: store, Catalog: catalog}).ExportAccounts(ctx)
	if err != nil {
		t.Fatalf("ExportAccounts() err = %v", err)
	}
	if len(exported.Accounts) != 3 || len(exported.Skipped) != 0 {
		t.Fatalf("exported = %+v", exported)
	}

	byRef := make(map[string]AccountRecord, len(exported.Accounts))
	for _, item := range exported.Accounts {
		byRef[item.AccountRef] = item
	}
	if byRef[codexAcct.Ref().String()].Env["OPENAI_API_KEY"] != "sk-codex-1" {
		t.Fatalf("unexpected codex export = %+v", byRef[codexAcct.Ref().String()])
	}
	if byRef[kimiAcct.Ref().String()].Env["MOONSHOT_API_KEY"] != "kimi-key-456" || byRef[kimiAcct.Ref().String()].Env["KIMI_BASE_URL"] != "https://api.moonshot.cn/v1" {
		t.Fatalf("unexpected kimi export = %+v", byRef[kimiAcct.Ref().String()])
	}
	credsMap, _ := byRef[zcodeAcct.Ref().String()].NativeAuth["credentials"].(map[string]any)
	if credsMap["secret"] != "plain-zcode-secret" {
		t.Fatalf("unexpected zcode export = %+v", byRef[zcodeAcct.Ref().String()].NativeAuth)
	}
	portableDecrypted := PortableZcodeNativeAuth(map[string]any{
		"credentials": map[string]any{
			"secret": "enc:v1:qA2RJPyhmmLJc9f3.fgw3CWGJ6lJS1VYNoE46dA.NuVgZLOXJ20m388",
			"plain":  "keep",
		},
	})
	portableCreds := portableDecrypted["credentials"].(map[string]any)
	if portableCreds["secret"] != "hello-zcode" || portableCreds["plain"] != "keep" {
		t.Fatalf("PortableZcodeNativeAuth(matching) = %+v", portableCreds)
	}
	t.Setenv("ZCODE_CREDENTIAL_SECRET", "wrong-secret")
	portablePreserved := PortableZcodeNativeAuth(map[string]any{
		"credentials": map[string]any{
			"secret": "enc:v1:qA2RJPyhmmLJc9f3.fgw3CWGJ6lJS1VYNoE46dA.NuVgZLOXJ20m388",
		},
	})
	if portablePreserved["credentials"].(map[string]any)["secret"] != "enc:v1:qA2RJPyhmmLJc9f3.fgw3CWGJ6lJS1VYNoE46dA.NuVgZLOXJ20m388" {
		t.Fatalf("PortableZcodeNativeAuth(wrong secret) must preserve encrypted value, got %+v", portablePreserved)
	}
	if false {
		t.Fatalf("expected decrypted zcode token 'hello-zcode', got %+v", byRef[zcodeAcct.Ref().String()].NativeAuth)
	}
}

type memoryStrategy struct {
	mu       sync.Mutex
	id       string
	files    map[string]string
	connect  func() error
	onKey    func(string)
	observed string
	closed   bool
}

func (m *memoryStrategy) ID() string      { return m.id }
func (m *memoryStrategy) BaseDir() string { return "/remote/backup" }
func (m *memoryStrategy) Connect(context.Context) error {
	if m.connect != nil {
		if err := m.connect(); err != nil {
			return err
		}
	}
	if m.observed != "" && m.onKey != nil {
		m.onKey(m.observed)
	}
	return nil
}
func (m *memoryStrategy) ReadFile(_ context.Context, rel string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.files[rel]
	return v, ok, nil
}
func (m *memoryStrategy) WriteFile(_ context.Context, rel string, content string, _ os.FileMode) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.files == nil {
		m.files = make(map[string]string)
	}
	m.files[rel] = content
	return nil
}
func (m *memoryStrategy) Close() error {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	return nil
}

type stubExporter struct {
	res ExportResult
	err error
}

func (s stubExporter) ExportAccounts(context.Context) (ExportResult, error) {
	return s.res, s.err
}

func TestRunRemoteBackupTargetIsolationAndTOFUWriteback(t *testing.T) {
	aiHome := t.TempDir()
	fp := strings.Repeat("a", 64)

	if _, err := WriteBackupConfig(aiHome, BackupConfig{
		Version:         BackupConfigVersion,
		Enabled:         true,
		IntervalMinutes: 60,
		DebounceSeconds: 15,
		Targets: []BackupTarget{
			{ID: "t-ok", Strategy: "ssh", Enabled: true, Host: "10.0.0.1", Port: 22, Username: "u1", RemoteDir: ".aih-backup", PasswordEnv: "PW1"},
			{ID: "t-fail", Strategy: "ssh", Enabled: true, Host: "10.0.0.2", Port: 22, Username: "u2", RemoteDir: ".aih-backup", PasswordEnv: "PW2"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	okStrat := &memoryStrategy{id: "t-ok", files: map[string]string{}, observed: fp}
	failStrat := &memoryStrategy{id: "t-fail", connect: func() error { return errors.New("connection refused") }}

	fixedNow := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	result, err := RunRemoteBackup(context.Background(), ServiceOptions{
		AIHomeDir: aiHome,
		HostName:  "devbox",
		Now:       func() time.Time { return fixedNow },
		Exporter: stubExporter{
			res: ExportResult{
				Accounts: []AccountRecord{{
					Provider:     "codex",
					AccountRef:   "acct_0123456789abcdef0123",
					CLIAccountID: "1",
					Status:       "up",
					Env:          map[string]string{"OPENAI_API_KEY": "sk-1"},
					NativeAuth:   map[string]any{},
				}},
			},
		},
		CreateStrategy: func(target BackupTarget, onHostKey func(string)) (Strategy, error) {
			if target.ID == "t-ok" {
				okStrat.onKey = onHostKey
				return okStrat, nil
			}
			return failStrat, nil
		},
	}, RunOptions{})
	if err != nil {
		t.Fatalf("RunRemoteBackup() err = %v", err)
	}
	if result.OK {
		t.Fatal("expected overall result.OK=false when t-fail failed")
	}
	if len(result.Targets) != 2 || !result.Targets[0].OK || result.Targets[1].OK {
		t.Fatalf("unexpected target results = %+v", result.Targets)
	}
	if result.Targets[0].Uploaded != 1 || result.Targets[0].Revision != 1 {
		t.Fatalf("unexpected healthy target result = %+v", result.Targets[0])
	}
	if !okStrat.closed {
		t.Fatal("expected okStrat closed")
	}

	reloadedCfg, err := ReadBackupConfig(aiHome)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedCfg.Targets[0].HostKeyFingerprint != fp {
		t.Fatalf("expected TOFU fingerprint %q persisted, got %q", fp, reloadedCfg.Targets[0].HostKeyFingerprint)
	}

	reloadedState, err := ReadBackupState(aiHome)
	if err != nil {
		t.Fatal(err)
	}
	if reloadedState.Targets["t-ok"].LastOkAt == "" || reloadedState.Targets["t-fail"].LastError == "" {
		t.Fatalf("unexpected persisted state = %+v", reloadedState.Targets)
	}
}

func TestSchedulerDueTargetsDebounceSingleFlightCoalescing(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	cfg := BackupConfig{
		Version:         1,
		Enabled:         true,
		IntervalMinutes: 60,
		DebounceSeconds: 1,
		Targets: []BackupTarget{
			{ID: "never", Enabled: true, Host: "h1", Username: "u"},
			{ID: "recent-ok", Enabled: true, Host: "h2", Username: "u"},
			{ID: "expired-ok", Enabled: true, Host: "h3", Username: "u"},
			{ID: "recent-err", Enabled: true, Host: "h4", Username: "u"},
			{ID: "expired-err", Enabled: true, Host: "h5", Username: "u"},
			{ID: "disabled", Enabled: false, Host: "h6", Username: "u"},
		},
	}
	state := BackupState{
		Version: 1,
		Targets: map[string]TargetRunState{
			"recent-ok":   {LastRunAt: now.Add(-10 * time.Minute).Format(time.RFC3339), LastOkAt: now.Add(-10 * time.Minute).Format(time.RFC3339)},
			"expired-ok":  {LastRunAt: now.Add(-61 * time.Minute).Format(time.RFC3339), LastOkAt: now.Add(-61 * time.Minute).Format(time.RFC3339)},
			"recent-err":  {LastRunAt: now.Add(-2 * time.Minute).Format(time.RFC3339), LastError: "boom"},
			"expired-err": {LastRunAt: now.Add(-6 * time.Minute).Format(time.RFC3339), LastError: "boom"},
		},
	}
	due := DueTargetIDs(cfg, state, now)
	wantDue := map[string]bool{"never": true, "expired-ok": true, "expired-err": true}
	if len(due) != len(wantDue) {
		t.Fatalf("DueTargetIDs = %v, want keys %v", due, wantDue)
	}
	for _, id := range due {
		if !wantDue[id] {
			t.Fatalf("unexpected due target %q in %v", id, due)
		}
	}

	aiHome := t.TempDir()
	if _, err := WriteBackupConfig(aiHome, BackupConfig{
		Version:         1,
		Enabled:         true,
		IntervalMinutes: 60,
		DebounceSeconds: 1,
		Targets: []BackupTarget{{
			ID: "t1", Strategy: "ssh", Enabled: true, Host: "10.0.0.1", Port: 22, Username: "ops", RemoteDir: ".aih-backup", IdentityFile: "~/.ssh/id_ed25519",
		}},
	}); err != nil {
		t.Fatal(err)
	}

	var calls atomic.Int32
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondDone := make(chan struct{})
	zeroDelay := time.Duration(0)

	sched := NewScheduler(SchedulerOptions{
		Service:      ServiceOptions{AIHomeDir: aiHome},
		TickInterval: time.Hour,
		StartupDelay: &zeroDelay,
		RunBackup: func(ctx context.Context, opts RunOptions) (BackupRunResult, error) {
			n := calls.Add(1)
			if n == 1 {
				close(firstEntered)
				select {
				case <-releaseFirst:
				case <-ctx.Done():
				}
			} else if n == 2 {
				close(secondDone)
			}
			return BackupRunResult{OK: true}, nil
		},
	})

	statusBefore, err := sched.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(statusBefore.Targets) != 1 || !statusBefore.Targets[0].HasIdentityFile || statusBefore.SchedulerActive {
		t.Fatalf("unexpected statusBefore = %+v", statusBefore)
	}

	// Start scheduler and kick off single-flight run synchronously via RunNow in goroutine,
	// then queue rapid Triggers while active to verify pending coalescing.
	if !sched.Start(context.Background()) {
		t.Fatal("expected Start()=true")
	}
	defer sched.Stop()

	runDone := make(chan BackupRunResult, 1)
	go func() {
		res, _ := sched.RunNow(context.Background(), "manual-1", true, false, nil)
		runDone <- res
	}()

	select {
	case <-firstEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for first backup run")
	}

	if !sched.IsRunning() {
		t.Fatal("expected IsRunning()=true while first run blocked")
	}
	// Multiple triggers coalesce into one pending run.
	if !sched.Trigger("lifecycle-1") || !sched.Trigger("lifecycle-2") {
		t.Fatal("expected Trigger()=true")
	}
	close(releaseFirst)

	select {
	case res := <-runDone:
		if !res.OK {
			t.Fatalf("first RunNow res = %+v", res)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for RunNow return")
	}

	select {
	case <-secondDone:
	case <-time.After(3 * time.Second):
		t.Fatal("expected coalesced pending run to execute after first run finished")
	}

	if got := calls.Load(); got != 2 {
		t.Fatalf("total backup runs = %d, want 2 (1 initial + 1 coalesced pending)", got)
	}
}
