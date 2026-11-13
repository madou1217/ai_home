package egress

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// 本文件是 Node lib/account/zcode-egress-binding-store.js 的写侧移植：
// readAccountEgressBinding / writeAccountEgressBinding / mirrorPoolAssignment。
//
// 为什么写侧也在 Go：WebUI 的账号出口设置已划给 Go 权威。写入必须和读侧用同一套
// 归一化（mode / pool scope / retired 拒绝），否则 Node 读回时会看到一份自己写不出的
// 记录。分配投影（egress:entity:assignment:<ref>）是可选镜像：失败不影响绑定写入，
// 与 Node 的 best-effort 语义一致。

// assignmentKeyPrefix 对应 Node egress-entity-store 的 ASSIGNMENT_KEY_PREFIX。
const assignmentKeyPrefix = "egress:entity:assignment:"

// ErrInvalidWriteBinding 等价于 Node writeAccountEgressBinding 抛出的
// invalid_account_egress_binding：调用方只把它当作 egress_binding_write_failed。
var ErrInvalidWriteBinding = errors.New("invalid_account_egress_binding")

// Store 读写账号级出口绑定。
//
// 无缓存：每次调用都现读/现写 app-state，与 Node 的 store 一致（出口变更不重启也生效）。
type Store struct {
	aiHomeDir string
	now       func() time.Time
}

// NewStore 创建绑定存储；aiHomeDir 为空时读写一律返回 ErrInvalidRoot。
func NewStore(aiHomeDir string) *Store {
	return &Store{aiHomeDir: strings.TrimSpace(aiHomeDir), now: time.Now}
}

// WithClock 覆盖时间源（测试用）。
func (store *Store) WithClock(now func() time.Time) *Store {
	if now != nil {
		store.now = now
	}
	return store
}

// Read 返回规范化后的绑定；found=false 表示没有绑定。
//
// 损坏记录返回 errInvalidBindingRecord（调用方归一化成 egress_binding_read_failed），
// 绝不静默当成未绑定。
func (store *Store) Read(ctx context.Context, accountRef string) (Binding, bool, error) {
	databasePath, err := appstate.DatabasePath(store.aiHomeDir)
	if err != nil {
		return Binding{}, false, err
	}
	key := bindingKey(accountRef)
	if key == "" {
		return Binding{}, false, nil
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, key)
	if err != nil {
		return Binding{}, false, err
	}
	if !found || strings.TrimSpace(raw) == "" {
		return Binding{}, false, nil
	}
	binding, err := parseBinding(raw)
	if err != nil {
		return Binding{}, false, err
	}
	return binding, true, nil
}

// Replace 写入一条绑定并同步分配投影。
//
// mode 必须是已知模式（调用方已在 HTTP 边界校验）；proxyUrl 只在 url 模式参与归一化，
// pool 模式改由 scope/strategy 决定。返回落盘后的规范记录，供调用方直接回给 WebUI。
func (store *Store) Replace(
	ctx context.Context,
	accountRef string,
	mode string,
	proxyURL string,
	scope any,
	strategy string,
) (Binding, error) {
	normalizedMode := strings.ToLower(strings.TrimSpace(mode))
	if _, known := knownBindingModes[normalizedMode]; !known {
		return Binding{}, ErrInvalidWriteBinding
	}
	candidate := map[string]any{
		"mode":     normalizedMode,
		"proxyUrl": strings.TrimSpace(proxyURL),
	}
	if normalizedMode == ModePool {
		if scope != nil {
			candidate["scope"] = scope
		}
		if text := strings.TrimSpace(strategy); text != "" {
			candidate["strategy"] = text
		}
	}
	binding, err := parseBindingObject(candidate)
	if err != nil || binding.Retired {
		return Binding{}, ErrInvalidWriteBinding
	}
	now := store.now().UnixMilli()
	databasePath, err := appstate.DatabasePath(store.aiHomeDir)
	if err != nil {
		return Binding{}, err
	}
	encoded, err := encodeBinding(binding, now)
	if err != nil {
		return Binding{}, err
	}
	if err := appstate.WriteKV(ctx, databasePath, bindingKey(accountRef), string(encoded), now); err != nil {
		return Binding{}, err
	}
	// 镜像失败不能把已成功的绑定写入变成错误（Node 同样吞掉）。
	store.mirrorAssignment(ctx, databasePath, accountRef, &binding, now)
	binding.UpdatedAtMS = now
	return binding, nil
}

// Clear 删除绑定（等价于解绑）并清掉分配投影。
func (store *Store) Clear(ctx context.Context, accountRef string) error {
	databasePath, err := appstate.DatabasePath(store.aiHomeDir)
	if err != nil {
		return err
	}
	key := bindingKey(accountRef)
	if key == "" {
		return nil
	}
	if err := appstate.DeleteKV(ctx, databasePath, key); err != nil {
		return err
	}
	store.mirrorAssignment(ctx, databasePath, accountRef, nil, 0)
	return nil
}

// mirrorAssignment 复刻 Node mirrorPoolAssignment：只有 pool 绑定写投影，其余删除。
func (store *Store) mirrorAssignment(ctx context.Context, databasePath string, accountRef string, binding *Binding, now int64) {
	key := assignmentKeyPrefix + strings.TrimSpace(accountRef)
	if key == assignmentKeyPrefix {
		return
	}
	if binding == nil || binding.Mode != ModePool || binding.Retired {
		_ = appstate.DeleteKV(ctx, databasePath, key)
		return
	}
	scope := map[string]any{"kind": "all", "groups": []string{}, "nodes": []string{}}
	if binding.PoolScope != nil {
		scope = map[string]any{
			"kind":   binding.PoolScope.Kind,
			"groups": nonNilStrings(binding.PoolScope.Groups),
			"nodes":  nonNilStrings(binding.PoolScope.Nodes),
		}
	}
	record := map[string]any{
		"accountRef":     strings.TrimSpace(accountRef),
		"poolGroupId":    "",
		"poolId":         "",
		"selectionMode":  "auto",
		"strategy":       binding.PoolStrategy,
		"scope":          scope,
		"fallbackPolicy": "none",
		"updatedAt":      now,
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return
	}
	_ = appstate.WriteKV(ctx, databasePath, key, string(encoded), now)
}

// encodeBinding 产出 Node normalizeEgressBinding 的落盘形状：
// 普通模式 {mode, proxyUrl, updatedAt}；pool 模式把 proxyUrl 归一化为空并带 scope/strategy。
func encodeBinding(binding Binding, now int64) ([]byte, error) {
	document := map[string]any{
		"mode":      binding.Mode,
		"proxyUrl":  binding.ProxyURL,
		"updatedAt": now,
	}
	if binding.Mode == ModePool {
		scope := PoolScope{Kind: "all", Groups: []string{}, Nodes: []string{}}
		if binding.PoolScope != nil {
			scope = *binding.PoolScope
		}
		scope.Groups = nonNilStrings(scope.Groups)
		scope.Nodes = nonNilStrings(scope.Nodes)
		document["scope"] = scope
		document["strategy"] = binding.PoolStrategy
	}
	return json.Marshal(document)
}

// View 返回与 Node readAccountEgressBinding 一致的 WebUI 形状。
func (binding Binding) View() map[string]any {
	view := map[string]any{
		"mode":      binding.Mode,
		"proxyUrl":  binding.ProxyURL,
		"updatedAt": binding.UpdatedAtMS,
	}
	if binding.Retired {
		// Node 的形状固定带 nodeId / groupId（缺省为空串），前端按「有没有值」提示改绑。
		view["retired"] = true
		view["nodeId"] = binding.NodeID
		view["groupId"] = binding.GroupID
		return view
	}
	if binding.Mode == ModePool {
		scope := PoolScope{Kind: "all", Groups: []string{}, Nodes: []string{}}
		if binding.PoolScope != nil {
			scope = *binding.PoolScope
		}
		view["scope"] = PoolScope{
			Kind:   scope.Kind,
			Groups: nonNilStrings(scope.Groups),
			Nodes:  nonNilStrings(scope.Nodes),
		}
		view["strategy"] = binding.PoolStrategy
	}
	return view
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
