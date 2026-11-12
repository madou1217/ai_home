package webuiprojectsapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Codex 从某个版本开始把会话索引写进 state 库（~/.codex/state_<n>.sqlite 的
// threads 表），rollout 文件只是正文。Node readCodexProjectsFromHost 先读库里
// 的线程行，库里读得到就完全不再扫 rollout 文件；扫文件只服务于没有 state 库的
// 旧版 Codex。
//
// 只扫文件会漏掉两类会话：库里有、rollout 文件已被删的行；以及标题只存在于
// threads.title、rollout 文件头里找不到可用用户消息的行。后者的真实例子：
// 首个用户消息在 3MB 之后，超出文件头预算。
const (
	// codexStateDbTable 是会话索引表；列集合随版本变化，按存在性投影。
	codexStateDbTable = "threads"
	// codexSpawnEdgeTable 记录子代理线程；表缺失时视为没有子线程。
	codexSpawnEdgeTable = "thread_spawn_edges"
	// codexStateDbNestedDir 是新版本把 state 库挪进去的子目录。
	codexStateDbNestedDir = "sqlite"
)

// codexStateDbNamePattern 匹配 state 库文件名；版本号越大越新。
var codexStateDbNamePattern = regexp.MustCompile("(?i)^state_([0-9]+)\\.sqlite$")

// codexThreadRow 是 threads 表一行在列投影后的形态，字段顺序与 Node
// buildCodexThreadsQuery 的 SELECT 一致。
type codexThreadRow struct {
	ID               string
	Cwd              string
	Title            string
	FirstUserMessage string
	RolloutPath      string
	Source           string
	ThreadSource     string
	ParentThreadID   string
	UpdatedAtMS      int64
}

// codexThreadSnapshot 是一次 state 库读取的结果。
//
// Authoritative=true 表示至少有一个库提供了 threads 表：此时与 Node 一致，只认
// 库里的行，不再扫 rollout 文件。库打不开或没有 threads 表时退回文件扫描。
type codexThreadSnapshot struct {
	Rows            []codexThreadRow
	SpawnedChildIDs map[string]bool
	Authoritative   bool
}

// listCodexStateDbPaths 复刻 Node listCodexStateDbPaths 的发现与排序：
// 顶层 state_<n>.sqlite 在前，sqlite/ 子目录在后，同版本按路径排序。
func listCodexStateDbPaths(codexDir string) []string {
	type candidate struct {
		path    string
		version int
		nested  bool
	}
	candidates := make([]candidate, 0, 4)
	seen := make(map[string]bool, 4)
	appendDirectory := func(directory string, nested bool) {
		if directory == "" {
			return
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			return
		}
		for _, entry := range entries {
			// 符号链接一律跳过：它可能指向白名单根之外。
			if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			match := codexStateDbNamePattern.FindStringSubmatch(entry.Name())
			if match == nil {
				continue
			}
			fullPath := filepath.Join(directory, entry.Name())
			if seen[fullPath] {
				continue
			}
			seen[fullPath] = true
			version, _ := strconv.Atoi(match[1])
			candidates = append(candidates, candidate{path: fullPath, version: version, nested: nested})
		}
	}
	appendDirectory(codexDir, false)
	appendDirectory(filepath.Join(codexDir, codexStateDbNestedDir), true)

	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].version != candidates[right].version {
			return candidates[left].version > candidates[right].version
		}
		if candidates[left].nested != candidates[right].nested {
			return !candidates[left].nested
		}
		return candidates[left].path < candidates[right].path
	})
	paths := make([]string, 0, len(candidates))
	for _, item := range candidates {
		paths = append(paths, item.path)
	}
	return paths
}

// readCodexThreadSnapshot 读取全部 state 库并按 id 合并。
//
// 同一 id 在多代库里都有时取 updated_at 更新的副本；并列时取字段更完整的
// 副本（Node shouldReplaceCodexThreadRow 同口径）。第一份遇到的顺序决定输出
// 顺序，与 Node Map 的插入顺序一致。
func (scan *scanner) readCodexThreadSnapshot(codexDir string) codexThreadSnapshot {
	snapshot := codexThreadSnapshot{SpawnedChildIDs: make(map[string]bool, 16)}
	indexByID := make(map[string]int, 128)
	for _, databasePath := range listCodexStateDbPaths(codexDir) {
		if scan.outOfTime() {
			return snapshot
		}
		rows, spawnedChildIDs, ok := scan.readCodexStateDb(databasePath)
		if !ok {
			continue
		}
		snapshot.Authoritative = true
		for id := range spawnedChildIDs {
			snapshot.SpawnedChildIDs[id] = true
		}
		for _, row := range rows {
			if position, exists := indexByID[row.ID]; exists {
				if shouldReplaceCodexThreadRow(snapshot.Rows[position], row) {
					snapshot.Rows[position] = row
				}
				continue
			}
			indexByID[row.ID] = len(snapshot.Rows)
			snapshot.Rows = append(snapshot.Rows, row)
		}
	}
	return snapshot
}

// readCodexStateDb 读一个 state 库的 threads 行与子代理边。
//
// ok=false 表示这个库不可用（打不开、没有 threads 表或查询失败），调用方继续
// 看下一个库；ok=true 只代表这个库读出来了，行是否可见由调用方过滤。
func (scan *scanner) readCodexStateDb(databasePath string) ([]codexThreadRow, map[string]bool, bool) {
	database, ok := openReadOnlySQLite(scan.ctx, databasePath)
	if !ok {
		return nil, nil, false
	}
	defer func() { _ = database.Close() }()

	columns, ok := sqliteTableColumns(scan.ctx, database, codexStateDbTable)
	if !ok {
		return nil, nil, false
	}
	query := buildCodexThreadsQuery(columns)
	if query == "" {
		return nil, nil, false
	}
	// 子代理边要在读 threads 之前取：同一连接上并行开两个查询会互相等锁。
	spawnedChildIDs := readCodexSpawnedChildIDs(scan.ctx, database)
	rows, err := database.QueryContext(scan.ctx, query)
	if err != nil {
		return nil, nil, false
	}
	defer func() { _ = rows.Close() }()

	records := make([]codexThreadRow, 0, 128)
	for rows.Next() {
		if scan.outOfTime() {
			return records, spawnedChildIDs, true
		}
		var (
			rawID               any
			rawCwd              any
			rawTitle            any
			rawUpdatedAt        any
			rawUpdatedAtMS      any
			rawRolloutPath      any
			rawFirstUserMessage any
			rawSource           any
			rawThreadSource     any
			rawParentThreadID   any
		)
		if rows.Scan(
			&rawID, &rawCwd, &rawTitle, &rawUpdatedAt, &rawUpdatedAtMS,
			&rawRolloutPath, &rawFirstUserMessage, &rawSource, &rawThreadSource, &rawParentThreadID,
		) != nil {
			continue
		}
		id := trimSpace(sqliteValueString(rawID))
		if id == "" {
			continue
		}
		updatedAtMS := sqliteValueInt64(rawUpdatedAtMS)
		if updatedAtMS == 0 {
			updatedAtMS = sqliteValueInt64(rawUpdatedAt) * 1000
		}
		records = append(records, codexThreadRow{
			ID:               id,
			Cwd:              trimSpace(sqliteValueString(rawCwd)),
			Title:            trimSpace(sqliteValueString(rawTitle)),
			FirstUserMessage: trimSpace(sqliteValueString(rawFirstUserMessage)),
			RolloutPath:      trimSpace(sqliteValueString(rawRolloutPath)),
			Source:           trimSpace(sqliteValueString(rawSource)),
			ThreadSource:     trimSpace(sqliteValueString(rawThreadSource)),
			ParentThreadID:   trimSpace(sqliteValueString(rawParentThreadID)),
			UpdatedAtMS:      updatedAtMS,
		})
	}
	if rows.Err() != nil {
		// 行没读完就报错：这批数据不完整，交给上层的截断协议处理。
		scan.truncated = true
	}
	return records, spawnedChildIDs, true
}

// buildCodexThreadsQuery 复刻 Node buildCodexThreadsQuery：缺列用 NULL 顶替，
// 有 archived 列时只看未归档行，按最近更新倒序。
func buildCodexThreadsQuery(columns map[string]bool) string {
	if !columns["id"] || !columns["cwd"] || !columns["title"] {
		return ""
	}
	expression := func(column string) string {
		if columns[column] {
			return column
		}
		return "NULL AS " + column
	}
	whereClause := ""
	if columns["archived"] {
		whereClause = "WHERE archived = 0"
	}
	orderExpression := "id"
	switch {
	case columns["updated_at_ms"] && columns["updated_at"]:
		orderExpression = "COALESCE(updated_at_ms, updated_at * 1000)"
	case columns["updated_at_ms"]:
		orderExpression = "updated_at_ms"
	case columns["updated_at"]:
		orderExpression = "updated_at * 1000"
	}
	return fmt.Sprintf(
		"SELECT id, cwd, title, %s, %s, %s, %s, %s, %s, %s FROM %s %s ORDER BY %s DESC, id DESC",
		expression("updated_at"), expression("updated_at_ms"), expression("rollout_path"),
		expression("first_user_message"), expression("source"), expression("thread_source"),
		expression("parent_thread_id"), quoteSQLiteIdentifier(codexStateDbTable),
		whereClause, orderExpression,
	)
}

// readCodexSpawnedChildIDs 返回 thread_spawn_edges 里的子线程 id 集合。
func readCodexSpawnedChildIDs(ctx context.Context, database *sql.DB) map[string]bool {
	columns, ok := sqliteTableColumns(ctx, database, codexSpawnEdgeTable)
	if !ok || !columns["child_thread_id"] {
		return nil
	}
	rows, err := database.QueryContext(
		ctx,
		"SELECT child_thread_id FROM "+quoteSQLiteIdentifier(codexSpawnEdgeTable)+
			" WHERE child_thread_id IS NOT NULL AND child_thread_id <> ''",
	)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	childIDs := make(map[string]bool, 16)
	for rows.Next() {
		var rawChildID any
		if rows.Scan(&rawChildID) != nil {
			continue
		}
		id := trimSpace(sqliteValueString(rawChildID))
		if id != "" {
			childIDs[id] = true
		}
	}
	return childIDs
}

// isCodexVisibleThreadRow 复刻 Node isCodexTopLevelInteractiveThread：子代理、
// worktree 项目与非交互来源（exec 等）都不进项目视图。
func isCodexVisibleThreadRow(row codexThreadRow, spawnedChildIDs map[string]bool) bool {
	if isCodexSubagentThreadRow(row, spawnedChildIDs) {
		return false
	}
	if isCodexWorktreePath(row.Cwd) {
		return false
	}
	return isCodexInteractiveSourceKind(row.Source)
}

// isCodexSubagentThreadRow 复刻 Node isCodexSubagentThread 对 threads 行的判定。
func isCodexSubagentThreadRow(row codexThreadRow, spawnedChildIDs map[string]bool) bool {
	if row.ID != "" && spawnedChildIDs[row.ID] {
		return true
	}
	if strings.EqualFold(row.ThreadSource, "subagent") {
		return true
	}
	if row.ParentThreadID != "" {
		return true
	}
	return isCodexSubagentSource(json.RawMessage(row.Source))
}

// isCodexInteractiveSourceKind 判断 state 库里纯文本 source 列是否为交互来源。
//
// 与 Node 一致：空值（旧记录）保留，只认 cli/vscode。这里不能用
// isCodexInteractiveSource —— 那个函数把 source 当 JSON 字面量解析，纯文本
// "exec" 会解析失败而被误判成交互会话。
func isCodexInteractiveSourceKind(value string) bool {
	switch strings.ToLower(trimSpace(value)) {
	case "", "cli", "vscode":
		return true
	default:
		return false
	}
}

// shouldReplaceCodexThreadRow 在同 id 多副本之间选：时间新的优先，并列时字段
// 更完整的优先（Node shouldReplaceCodexThreadRow 同口径）。
func shouldReplaceCodexThreadRow(current, candidate codexThreadRow) bool {
	if delta := candidate.UpdatedAtMS - current.UpdatedAtMS; delta != 0 {
		return delta > 0
	}
	return codexThreadRowFieldCount(candidate) > codexThreadRowFieldCount(current)
}

func codexThreadRowFieldCount(row codexThreadRow) int {
	count := 0
	for _, value := range []string{
		row.ID, row.Cwd, row.Title, row.FirstUserMessage,
		row.RolloutPath, row.Source, row.ThreadSource, row.ParentThreadID,
	} {
		if value != "" {
			count++
		}
	}
	if row.UpdatedAtMS != 0 {
		count++
	}
	return count
}

// resolveCodexRolloutPath 复刻 Node normalizeCodexSessionFilePath 的可用部分：
// 候选路径必须落成真实 .jsonl 文件且文件名带会话 id，否则返回空。
//
// Node 还会做 Windows 盘符 / WSL 路径变形，本包只处理 POSIX 形态。
func resolveCodexRolloutPath(codexDir, sessionID, rolloutPath string) string {
	id := trimSpace(sessionID)
	raw := trimSpace(rolloutPath)
	if id == "" || raw == "" {
		return ""
	}
	candidates := []string{raw}
	if !filepath.IsAbs(raw) {
		candidates = append(candidates, filepath.Join(codexDir, raw))
	}
	for _, candidate := range candidates {
		if !strings.HasSuffix(candidate, ".jsonl") || !strings.Contains(filepath.Base(candidate), id) {
			continue
		}
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		return candidate
	}
	return ""
}
