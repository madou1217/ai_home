package opencodestorage

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

var (
	// ErrUnsupportedCredential 表示凭据不是 OpenCode 原生 OAuth。
	ErrUnsupportedCredential = errors.New("opencode projection requires native oauth credential")
	// ErrIdentityMismatch 表示投影文件里的账号与当前账号不是同一身份，绝不能回写。
	ErrIdentityMismatch = errors.New("opencode projection identity mismatch")
)

const (
	accountAuthFile = ".local/share/opencode/auth.json"
	bridgeAuthFile  = ".local/share/aih-opencode-runtime/opencode/auth.json"
)

// Materializer 物化 auth.json 并把它桥接进 XDG bridge。
type Materializer struct{}

// ProviderID 返回 OpenCode 规范 Provider ID。
func (Materializer) ProviderID() string { return ProviderID }

// Materialize 写 auth.json（缺失或空时），并把 bridge 里的 auth.json 链接到账号文件。
//
// API Key 账号没有 auth.json，仍然建立符号链接（悬空链接与 Node 行为一致）：
// CLI 的 v1 路径会回退到环境变量，v2 路径走 OPENCODE_API_KEY。
func (Materializer) Materialize(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) ([]accountprojection.ArtifactWrite, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, accountprojection.ErrInvalidProjectionRequest
	}
	writes := make([]accountprojection.ArtifactWrite, 0, 1)
	switch credential := request.Credential.(type) {
	case *accountcore.NativeCredential:
		if credential == nil || credential.ProviderID() != ProviderID {
			return nil, ErrUnsupportedCredential
		}
		auth, err := payloadAuth(credential.Payload())
		if err != nil || len(auth) == 0 {
			return nil, ErrUnsupportedCredential
		}
		path := filepath.Join(root, accountAuthFile)
		if existing, found := readDocument(path); !found || isEmptyObject(existing) {
			writes = append(writes, accountprojection.ArtifactWrite{Path: path, Data: auth, Mode: 0o600})
		}
	case *accountcore.StaticAPIKeyAuth:
		if credential == nil || credential.ProviderID() != ProviderID {
			return nil, ErrUnsupportedCredential
		}
	default:
		return nil, ErrUnsupportedCredential
	}
	// bridge 链接必须指向账号自己的 auth.json；已存在的旧链接/文件先摘掉。
	bridgePath := filepath.Join(root, bridgeAuthFile)
	if err := os.MkdirAll(filepath.Dir(bridgePath), 0o700); err != nil {
		return nil, err
	}
	_ = os.Remove(bridgePath)
	if err := os.Symlink(filepath.Join(root, accountAuthFile), bridgePath); err != nil {
		return nil, err
	}
	return writes, nil
}

// Capture 读取账号 auth.json 并重建凭据；身份不一致时报错。
func (Materializer) Capture(
	_ context.Context,
	request accountprojection.Request,
	_ accountprojection.Policy,
	root string,
) (accountapp.Credential, bool, error) {
	if request.ProviderID != ProviderID || root == "" {
		return nil, false, accountprojection.ErrInvalidProjectionRequest
	}
	auth, found := readDocument(filepath.Join(root, accountAuthFile))
	if !found || isEmptyObject(auth) {
		return nil, false, nil
	}
	payload, err := json.Marshal(map[string]json.RawMessage{"auth": auth})
	if err != nil {
		return nil, false, err
	}
	envelope, err := json.Marshal(map[string]json.RawMessage{"native_auth_json": payload})
	if err != nil {
		return nil, false, err
	}
	next, _, err := nativeaccount.NewDecoder().Decode(ProviderID, envelope)
	if err != nil {
		return nil, false, err
	}
	nextNative, ok := next.(*accountcore.NativeCredential)
	if !ok || nextNative == nil {
		return nil, false, ErrUnsupportedCredential
	}
	if current, ok := request.Credential.(*accountcore.NativeCredential); ok && current != nil {
		if current.IdentitySeed() != nextNative.IdentitySeed() {
			return nil, false, ErrIdentityMismatch
		}
	}
	return nextNative, true, nil
}

// ShouldAdopt 只在代际更新时回写；无法比较时保留账号库。
func (Materializer) ShouldAdopt(current accountapp.Credential, next accountapp.Credential) bool {
	currentNative, currentOK := current.(*accountcore.NativeCredential)
	nextNative, nextOK := next.(*accountcore.NativeCredential)
	if !currentOK || !nextOK || currentNative == nil || nextNative == nil {
		return false
	}
	newer, ordered := nextNative.NewerThan(currentNative)
	return ordered && newer
}

// payloadAuth 从 native_auth_json 里取出 auth.json 文档。
func payloadAuth(payload []byte) (json.RawMessage, error) {
	if len(payload) == 0 {
		return nil, ErrUnsupportedCredential
	}
	var document struct {
		Auth json.RawMessage `json:"auth"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, err
	}
	return document.Auth, nil
}

// readDocument 读取 JSON；缺失或损坏按不存在处理。
func readDocument(path string) (json.RawMessage, bool) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) || err != nil || len(raw) == 0 || len(raw) > 1024*1024 {
		return nil, false
	}
	if !json.Valid(raw) {
		return nil, false
	}
	return json.RawMessage(raw), true
}

func isEmptyObject(document json.RawMessage) bool {
	var object map[string]any
	if err := json.Unmarshal(document, &object); err != nil {
		return true
	}
	return len(object) == 0
}

var _ = strings.TrimSpace
