package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
)

// ensureConnectionSchema 按实际表/列/索引/触发器能力幂等初始化或增量补齐账号数据库。
//
// 已具备完整能力的 AIH 数据库在只读快路径直接返回，不获取写锁、不重跑汇总回填；
// 非 AIH 数据库（application_id 不匹配，或 application_id=0 但含未知非兼容表）在改动前拒绝。
func ensureConnectionSchema(ctx context.Context, connection *sql.Conn) (resultErr error) {
	applicationID, _, err := inspectDatabaseIdentity(ctx, connection)
	if err != nil {
		return err
	}
	if applicationID != 0 && applicationID != ApplicationID {
		return fmt.Errorf("%w: application_id=%d", ErrIncompatibleDatabase, applicationID)
	}
	if applicationID == ApplicationID {
		if readyErr := ValidateSchemaConn(ctx, connection); readyErr == nil {
			return nil
		}
	}

	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("开始账号数据库结构收敛事务失败: %w", err)
	}
	defer func() {
		if resultErr != nil {
			_, _ = connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		}
	}()

	applicationID, objectCount, err := inspectDatabaseIdentity(ctx, connection)
	if err != nil {
		return err
	}
	if applicationID != 0 && applicationID != ApplicationID {
		return fmt.Errorf("%w: application_id=%d", ErrIncompatibleDatabase, applicationID)
	}
	if applicationID == 0 && objectCount != 0 {
		if err := verifyCompatibilityBootstrapObjects(ctx, connection); err != nil {
			return err
		}
	}
	if applicationID == ApplicationID {
		if readyErr := ValidateSchemaConn(ctx, connection); readyErr == nil {
			return commitSchemaTransaction(ctx, connection)
		}
	}

	if _, err := connection.ExecContext(ctx, SchemaBaselineSQL); err != nil {
		return fmt.Errorf("确保账号数据库核心表失败: %w", err)
	}
	if err := ensureMissingColumns(ctx, connection); err != nil {
		return err
	}
	if _, err := connection.ExecContext(ctx, SchemaIndexesAndTriggersSQL); err != nil {
		return fmt.Errorf("确保账号数据库索引与触发器失败: %w", err)
	}
	if err := ensureUsageLedgerDaily(ctx, connection); err != nil {
		return err
	}
	if applicationID == 0 {
		if _, err := connection.ExecContext(
			ctx,
			fmt.Sprintf("PRAGMA application_id = %d;", ApplicationID),
		); err != nil {
			return fmt.Errorf("写入账号数据库 application_id 失败: %w", err)
		}
	}
	if err := ValidateSchemaConn(ctx, connection); err != nil {
		return err
	}
	return commitSchemaTransaction(ctx, connection)
}

func commitSchemaTransaction(ctx context.Context, connection *sql.Conn) error {
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("提交账号数据库结构收敛事务失败: %w", err)
	}
	return nil
}

// validateConnection 校验运行时连接的外键开关与完整表结构能力。
func validateConnection(ctx context.Context, connection *sql.Conn) error {
	var foreignKeysEnabled int
	if err := connection.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeysEnabled); err != nil {
		return fmt.Errorf("读取账号数据库外键设置失败: %w", err)
	}
	if foreignKeysEnabled != 1 {
		return fmt.Errorf("%w: foreign_keys=off", ErrIncompatibleDatabase)
	}
	return ValidateSchemaConn(ctx, connection)
}

// ValidateSchemaConn 只读校验连接上的 AIH application_id 与全部必需表、列子集、索引及触发器能力。
//
// 不使用结构版本号，且容忍其它模块在同一数据库中新增未知表与列。
func ValidateSchemaConn(ctx context.Context, connection *sql.Conn) error {
	if ctx == nil || connection == nil {
		return ErrInvalidOpenOptions
	}
	var applicationID int
	if err := connection.QueryRowContext(ctx, "PRAGMA application_id").Scan(&applicationID); err != nil {
		return fmt.Errorf("读取账号数据库 application_id 失败: %w", err)
	}
	if applicationID != ApplicationID {
		return fmt.Errorf("%w: application_id=%d", ErrIncompatibleDatabase, applicationID)
	}

	tables, indexes, triggers, err := readSchemaObjectSets(ctx, connection)
	if err != nil {
		return err
	}
	for tableName, requiredColumns := range requiredTableColumns {
		if _, ok := tables[tableName]; !ok {
			return fmt.Errorf("%w: missing table=%s", ErrIncompatibleDatabase, tableName)
		}
		columnSet, err := readTableColumnSet(ctx, connection, tableName)
		if err != nil {
			return err
		}
		for _, column := range requiredColumns {
			if _, ok := columnSet[column]; !ok {
				return fmt.Errorf("%w: missing column=%s.%s", ErrIncompatibleDatabase, tableName, column)
			}
		}
	}
	for _, indexName := range requiredIndexNames {
		if _, ok := indexes[indexName]; !ok {
			return fmt.Errorf("%w: missing index=%s", ErrIncompatibleDatabase, indexName)
		}
	}
	for _, triggerName := range requiredCoreTriggerNames {
		if _, ok := triggers[triggerName]; !ok {
			return fmt.Errorf("%w: missing trigger=%s", ErrIncompatibleDatabase, triggerName)
		}
	}
	ledgerReady, err := hasUsageLedgerDailyCapabilities(ctx, connection)
	if err != nil {
		return err
	}
	if !ledgerReady {
		return fmt.Errorf("%w: usage_ledger_daily capabilities incomplete", ErrIncompatibleDatabase)
	}

	var metaRows int
	if err := connection.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM model_alias_meta WHERE id = 1",
	).Scan(&metaRows); err != nil {
		return fmt.Errorf("检查模型别名元数据行失败: %w", err)
	}
	if metaRows != 1 {
		return fmt.Errorf("%w: missing model_alias_meta row", ErrIncompatibleDatabase)
	}
	return nil
}

func readSchemaObjectSets(
	ctx context.Context,
	connection *sql.Conn,
) (map[string]struct{}, map[string]struct{}, map[string]struct{}, error) {
	rows, err := connection.QueryContext(
		ctx,
		`SELECT type, name
		   FROM sqlite_schema
		  WHERE name NOT LIKE 'sqlite_%'
		    AND type IN ('table', 'index', 'trigger')`,
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("读取账号数据库 schema 对象清单失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	tables := make(map[string]struct{}, len(requiredTableColumns))
	indexes := make(map[string]struct{}, len(requiredIndexNames))
	triggers := make(map[string]struct{}, len(requiredCoreTriggerNames)+3)
	for rows.Next() {
		var kind, name string
		if err := rows.Scan(&kind, &name); err != nil {
			return nil, nil, nil, fmt.Errorf("解析账号数据库 schema 对象失败: %w", err)
		}
		switch kind {
		case "table":
			tables[name] = struct{}{}
		case "index":
			indexes[name] = struct{}{}
		case "trigger":
			triggers[name] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, fmt.Errorf("遍历账号数据库 schema 对象失败: %w", err)
	}
	return tables, indexes, triggers, rows.Close()
}

// readTableColumnSet 通过 PRAGMA table_info 读取表上当前存在的全部列名集合。
func readTableColumnSet(
	ctx context.Context,
	connection *sql.Conn,
	tableName string,
) (map[string]struct{}, error) {
	rows, err := connection.QueryContext(ctx, "PRAGMA table_info("+tableName+")")
	if err != nil {
		return nil, fmt.Errorf("读取账号表 %s 结构失败: %w", tableName, err)
	}
	defer func() {
		_ = rows.Close()
	}()

	columns := make(map[string]struct{}, 16)
	for rows.Next() {
		var columnID int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue sql.NullString
		if err := rows.Scan(
			&columnID,
			&name,
			&columnType,
			&notNull,
			&defaultValue,
			&primaryKey,
		); err != nil {
			return nil, fmt.Errorf("解析账号表 %s 结构失败: %w", tableName, err)
		}
		columns[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号表 %s 结构失败: %w", tableName, err)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("%w: table=%s has no columns", ErrIncompatibleDatabase, tableName)
	}
	return columns, nil
}

func hasRequiredColumnSubset(present map[string]struct{}, required []string) bool {
	for _, column := range required {
		if _, ok := present[column]; !ok {
			return false
		}
	}
	return true
}
