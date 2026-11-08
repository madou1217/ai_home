package plugincontrol

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
)

func writeDatabase(t *testing.T, directory string, statements ...string) {
	t.Helper()
	path := filepath.Join(directory, AppStateDatabaseFileName)
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("执行测试语句失败: %v (%s)", err, statement)
		}
	}
}

func controlStateJSON() string {
	return `{"schemaVersion":1,"revision":4,"installed":[{"pluginId":"echo","version":"1.0.0","digest":"sha256:abc","installedAt":1,"manifest":{"pluginId":"echo","version":"1.0.0","contributes":[{"id":"echo.reply","capability":"gateway.request","order":0,"failurePolicy":"deny"}]}}],"instances":[{"instanceId":"echo","pluginId":"echo","version":"1.0.0","enabled":true,"configuration":{"token":"secret"},"updatedAt":2}]}`
}

// TestReaderReadControlState 覆盖空目录、正常文档、缺键、缺表与损坏文档。
func TestReaderReadControlState(t *testing.T) {
	tests := []struct {
		name      string
		prepare   func(t *testing.T, directory string)
		wantErr   error
		wantState func(t *testing.T, state pluginruntime.ControlState)
	}{
		{
			name:    "空目录不建库",
			prepare: func(*testing.T, string) {},
			wantState: func(t *testing.T, state pluginruntime.ControlState) {
				t.Helper()
				if state.Revision != 0 || len(state.Installed) != 0 || len(state.Instances) != 0 {
					t.Fatalf("空目录应按空状态处理: %+v", state)
				}
			},
		},
		{
			name: "正常文档",
			prepare: func(t *testing.T, directory string) {
				writeDatabase(t, directory,
					`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
					`INSERT INTO app_kv (key, value, updated_at) VALUES ('plugins.control.v1', '`+controlStateJSON()+`', 1)`,
				)
			},
			wantState: func(t *testing.T, state pluginruntime.ControlState) {
				t.Helper()
				if state.Revision != 4 || len(state.Installed) != 1 || len(state.Instances) != 1 {
					t.Fatalf("控制状态解码不符: %+v", state)
				}
				if state.Instances[0].InstanceID != "echo" || !state.Instances[0].Enabled {
					t.Fatalf("实例字段不符: %+v", state.Instances[0])
				}
				if len(state.Installed[0].Manifest.Contributes) != 1 || state.Installed[0].Manifest.Contributes[0].ID != "echo.reply" {
					t.Fatalf("清单贡献项不符: %+v", state.Installed[0].Manifest)
				}
			},
		},
		{
			name: "缺键",
			prepare: func(t *testing.T, directory string) {
				writeDatabase(t, directory,
					`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
				)
			},
			wantState: func(t *testing.T, state pluginruntime.ControlState) {
				t.Helper()
				if state.Revision != 0 || len(state.Instances) != 0 {
					t.Fatalf("缺键应按空状态处理: %+v", state)
				}
			},
		},
		{
			name: "缺 app_kv 表",
			prepare: func(t *testing.T, directory string) {
				writeDatabase(t, directory, `CREATE TABLE unrelated (id INTEGER PRIMARY KEY)`)
			},
			wantState: func(t *testing.T, state pluginruntime.ControlState) {
				t.Helper()
				if state.Revision != 0 || len(state.Installed) != 0 {
					t.Fatalf("缺表应按空状态处理: %+v", state)
				}
			},
		},
		{
			name: "损坏文档",
			prepare: func(t *testing.T, directory string) {
				writeDatabase(t, directory,
					`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
					`INSERT INTO app_kv (key, value, updated_at) VALUES ('plugins.control.v1', '{broken', 1)`,
				)
			},
			wantErr: pluginruntime.ErrControlStateInvalid,
		},
		{
			name: "未知 schema 版本",
			prepare: func(t *testing.T, directory string) {
				writeDatabase(t, directory,
					`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
					`INSERT INTO app_kv (key, value, updated_at) VALUES ('plugins.control.v1', '{"schemaVersion":9}', 1)`,
				)
			},
			wantErr: pluginruntime.ErrControlStateInvalid,
		},
		{
			name: "超大文档",
			prepare: func(t *testing.T, directory string) {
				oversized := `{"schemaVersion":1,"padding":"` + strings.Repeat("x", pluginruntime.MaxControlStateBytes) + `"}`
				writeDatabase(t, directory,
					`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
					`INSERT INTO app_kv (key, value, updated_at) VALUES ('plugins.control.v1', '`+oversized+`', 1)`,
				)
			},
			wantErr: pluginruntime.ErrControlStateInvalid,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			test.prepare(t, directory)
			reader, err := NewReader(directory)
			if err != nil {
				t.Fatalf("创建读取器失败: %v", err)
			}
			state, err := reader.ReadControlState(context.Background())
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("错误: got %v want %v", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("读取失败: %v", err)
			}
			test.wantState(t, state)
			if test.name == "空目录不建库" {
				if _, statErr := os.Stat(filepath.Join(directory, AppStateDatabaseFileName)); !errors.Is(statErr, os.ErrNotExist) {
					t.Fatalf("只读读取不得创建数据库文件: %v", statErr)
				}
			}
		})
	}
}

// TestNewReaderRejectsEmptyHome 防止在未配置数据根时误读当前工作目录。
func TestNewReaderRejectsEmptyHome(t *testing.T) {
	if _, err := NewReader("   "); !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("空数据根应被拒绝: %v", err)
	}
}
