package webuiusageconfigapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeStore struct {
	raw      string
	found    bool
	err      error
	written  *string
	writeErr error
}

func (fake fakeStore) ReadUsageConfig(context.Context) (string, bool, error) {
	return fake.raw, fake.found, fake.err
}

func (fake fakeStore) WriteUsageConfig(_ context.Context, value string) error {
	if fake.writeErr != nil {
		return fake.writeErr
	}
	if fake.written != nil {
		*fake.written = value
	}
	return nil
}

func newHandler(t *testing.T, store Store) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func decodeConfig(t *testing.T, recorder *httptest.ResponseRecorder) ConfigView {
	t.Helper()
	var payload struct {
		OK     bool       `json:"ok"`
		Config ConfigView `json:"config"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if !payload.OK {
		t.Fatalf("ok = false: %s", recorder.Body.String())
	}
	return payload.Config
}

func TestDefaultsWhenConfigMissing(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	config := decodeConfig(t, recorder)
	if config.ActiveRefreshInterval != "1m" || config.BackgroundRefreshInterval != "1h" || config.ThresholdPct != 95 || config.AutoSwitch || config.AutoSwitchRemainingPct != nil {
		t.Fatalf("config = %#v", config)
	}
}

func TestStoredConfigIsNormalized(t *testing.T) {
	raw := "{\"active_refresh_interval\":\"3m\",\"background_refresh_interval\":\"hourly\",\"threshold_pct\":80,\"auto_switch\":true,\"auto_switch_remaining_pct\":0}"
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: raw, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	config := decodeConfig(t, recorder)
	if config.ActiveRefreshInterval != "3m" || config.BackgroundRefreshInterval != "1h" || config.ThresholdPct != 80 || !config.AutoSwitch {
		t.Fatalf("config = %#v", config)
	}
	if config.AutoSwitchRemainingPct == nil || *config.AutoSwitchRemainingPct != 0 {
		t.Fatalf("remaining = %#v", config.AutoSwitchRemainingPct)
	}
}

func TestNormalizationMatchesNode(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		threshold int
		auto      bool
		remaining *int
	}{
		{name: "camel case", raw: "{\"activeRefreshInterval\":\"3m\",\"thresholdPct\":70,\"autoSwitch\":\"on\",\"autoSwitchRemainingPct\":\"15\"}", threshold: 70, auto: true, remaining: intPtr(15)},
		{name: "threshold below one", raw: "{\"threshold_pct\":0}", threshold: 1},
		{name: "threshold above hundred", raw: "{\"threshold_pct\":120}", threshold: 100},
		{name: "threshold rounds", raw: "{\"threshold_pct\":79.6}", threshold: 80},
		{name: "remaining clamps low", raw: "{\"auto_switch_remaining_pct\":-5}", threshold: 95, remaining: intPtr(0)},
		{name: "remaining clamps high", raw: "{\"auto_switch_remaining_pct\":150}", threshold: 95, remaining: intPtr(100)},
		{name: "remaining empty string", raw: "{\"auto_switch_remaining_pct\":\"  \"}", threshold: 95},
		{name: "remaining invalid", raw: "{\"auto_switch_remaining_pct\":\"abc\"}", threshold: 95},
		{name: "unknown interval falls back", raw: "{\"active_refresh_interval\":\"5m\",\"background_refresh_interval\":\"2h\"}", threshold: 95},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			newHandler(t, fakeStore{raw: testCase.raw, found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
			config := decodeConfig(t, recorder)
			if config.ThresholdPct != testCase.threshold || config.AutoSwitch != testCase.auto {
				t.Fatalf("config = %#v", config)
			}
			if testCase.remaining == nil {
				if config.AutoSwitchRemainingPct != nil {
					t.Fatalf("remaining = %d, want nil", *config.AutoSwitchRemainingPct)
				}
			} else if config.AutoSwitchRemainingPct == nil || *config.AutoSwitchRemainingPct != *testCase.remaining {
				t.Fatalf("remaining = %#v, want %d", config.AutoSwitchRemainingPct, *testCase.remaining)
			}
		})
	}
}

func TestInvalidJSONIsRejected(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{raw: "{", found: true}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}

func TestReadFailureIsRejected(t *testing.T) {
	recorder := httptest.NewRecorder()
	newHandler(t, fakeStore{err: errors.New("boom")}).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}

func TestAuthorizationAndMethod(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, Store: fakeStore{}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	newHandler(t, fakeStore{}).ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT status = %d", recorder.Code)
	}
}

func TestSourceReadsSameKeyAsNode(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		t.Fatalf("create app_kv: %v", err)
	}
	if _, err := db.Exec("INSERT INTO app_kv (key, value, updated_at) VALUES ('config:usage', '{\"threshold_pct\":80}', 1)"); err != nil {
		t.Fatalf("insert: %v", err)
	}
	source, err := OpenSource(directory)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	raw, found, err := source.ReadUsageConfig(context.Background())
	if err != nil || !found {
		t.Fatalf("ReadUsageConfig() found=%v err=%v", found, err)
	}
	config, err := normalizeConfig(raw, found)
	if err != nil || config.ThresholdPct != 80 {
		t.Fatalf("config = %#v err=%v", config, err)
	}
}

func intPtr(value int) *int { return &value }

func postUsageConfig(t *testing.T, handler http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body)))
	return recorder
}

func TestWriteNormalizesAndPersists(t *testing.T) {
	written := ""
	handler := newHandler(t, fakeStore{written: &written})
	recorder := postUsageConfig(t, handler, "{\"config\":{\"active_refresh_interval\":\"3m\",\"background_refresh_interval\":\"hourly\",\"threshold_pct\":120,\"auto_switch\":\"on\",\"auto_switch_remaining_pct\":-1}}")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(written), &stored); err != nil {
		t.Fatalf("written = %q: %v", written, err)
	}
	if stored["active_refresh_interval"] != "3m" || stored["background_refresh_interval"] != "1h" {
		t.Fatalf("intervals = %#v", stored)
	}
	if stored["threshold_pct"] != float64(100) || stored["auto_switch"] != true || stored["auto_switch_remaining_pct"] != float64(0) {
		t.Fatalf("stored = %#v", stored)
	}
}

func TestWriteRejectsMissingConfigAndInvalidJSON(t *testing.T) {
	handler := newHandler(t, fakeStore{})
	for _, body := range []string{"{}", "{\"config\":null}", "{"} {
		recorder := postUsageConfig(t, handler, body)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body %s status = %d", body, recorder.Code)
		}
	}
}

func TestWriteFailure(t *testing.T) {
	handler := newHandler(t, fakeStore{writeErr: errors.New("boom")})
	recorder := postUsageConfig(t, handler, "{\"config\":{}}")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", recorder.Code)
	}
}
