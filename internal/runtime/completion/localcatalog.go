package completion

// 本文件补齐「命令树里有位置、但取值来自本机状态」的候选来源：
// client-keys、backup 目标、failure-policy 规则。全部只读本机文件/DB，
// 不发网络请求，TAB 失败时按空列表退化。

import (
	"context"
	"database/sql"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
	"github.com/madou1217/ai_home/internal/runtime/shellsetup"
	"github.com/madou1217/ai_home/internal/runtime/upstreamfailurepolicy"
)

// listClientKeys 读取本地 client_api_keys（aih client-keys 的离线存储）。
func listClientKeys(aiHome string) []namedChoice {
	choices := make([]namedChoice, 0, 8)
	withReadDB(aiHome, func(database *sql.DB) {
		rows, err := database.Query(
			"SELECT key_id, name, enabled, revoked_at_ms FROM client_api_keys ORDER BY created_at_ms DESC")
		if err != nil {
			return
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var keyID, name string
			var enabled bool
			var revokedAt int64
			if scanErr := rows.Scan(&keyID, &name, &enabled, &revokedAt); scanErr != nil {
				continue
			}
			keyID = strings.TrimSpace(keyID)
			if keyID == "" || revokedAt != 0 {
				continue
			}
			description := strings.TrimSpace(name)
			if !enabled {
				description = strings.TrimSpace(description + " · 已停用")
			}
			if description == "" {
				description = "client key"
			}
			choices = append(choices, namedChoice{Value: keyID, Description: description})
		}
	})
	return choices
}

// listBackupTargets 读取 <aiHome>/backup/config.json 的目标 ID。
func listBackupTargets(aiHome string) []namedChoice {
	config, err := remotebackup.ReadBackupConfig(aiHome)
	if err != nil {
		return nil
	}
	choices := make([]namedChoice, 0, len(config.Targets))
	for _, target := range config.Targets {
		id := strings.TrimSpace(target.ID)
		if id == "" {
			continue
		}
		description := ""
		if target.Host != "" {
			description = target.Username + "@" + target.Host
			if target.RemoteDir != "" {
				description += ":" + target.RemoteDir
			}
		}
		if !target.Enabled {
			description = strings.TrimSpace(description + " · 已暂停")
		}
		choices = append(choices, namedChoice{Value: id, Description: description})
	}
	return choices
}

// listFailureSignals 读取合并全局覆盖后的失败语义规则 ID。
func listFailureSignals(aiHome string) []namedChoice {
	// Load 只读 config:server；缺失/非法时 Effective 仍返回内置契约。
	_ = upstreamfailurepolicy.Load(context.Background(), aiHome)
	document := upstreamfailurepolicy.Effective()
	if document == nil {
		return nil
	}
	choices := make([]namedChoice, 0, len(document.Signals))
	for _, signal := range document.Signals {
		id := strings.TrimSpace(signal.ID)
		if id == "" {
			continue
		}
		parts := make([]string, 0, 3)
		if signal.Provider != "" {
			parts = append(parts, signal.Provider)
		}
		if len(signal.Statuses) > 0 {
			parts = append(parts, "HTTP "+strconv.Itoa(signal.Statuses[0]))
		}
		if signal.ErrorType != "" {
			parts = append(parts, signal.ErrorType)
		}
		if signal.Semantic != "" {
			parts = append(parts, signal.Semantic)
		}
		description := strings.Join(parts, " · ")
		if signal.Shadowed {
			description = strings.TrimSpace(description + " · 已被覆盖")
		}
		choices = append(choices, namedChoice{Value: id, Description: description})
	}
	return choices
}

// listFailurePolicyKinds 返回可覆盖的失败分类（契约策略表的 kind）。
func listFailurePolicyKinds(aiHome string) []string {
	_ = upstreamfailurepolicy.Load(context.Background(), aiHome)
	document := upstreamfailurepolicy.Effective()
	if document == nil {
		return nil
	}
	kinds := make([]string, 0, len(document.Policies))
	seen := make(map[string]bool, len(document.Policies))
	for _, policy := range document.Policies {
		kind := strings.TrimSpace(policy.Kind)
		if kind == "" || seen[kind] {
			continue
		}
		seen[kind] = true
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	return kinds
}

// listLearnedCorrections 返回已学习的拼写纠正（aih shell typo forget 的取值）。
func listLearnedCorrections(aiHome string) []namedChoice {
	corrections := shellsetup.NewCorrectionsStore(aiHome).List()
	choices := make([]namedChoice, 0, len(corrections))
	for _, correction := range corrections {
		typo := strings.TrimSpace(correction.Typo)
		if typo == "" {
			continue
		}
		choices = append(choices, namedChoice{
			Value:       typo,
			Description: strings.Join(correction.Argv, " "),
		})
	}
	return choices
}
