package accountrefmap

import (
	"context"
	"strings"
)

// Dir 从 AIH 数据根目录读取 Node/Go 账号引用映射表。
type Dir struct {
	AIHomeDir string
}

// LoadTable 读取当前映射表；无记录时返回空映射。
func (dir Dir) LoadTable(ctx context.Context) (Table, error) {
	if strings.TrimSpace(dir.AIHomeDir) == "" {
		return Table{}, nil
	}
	return Load(ctx, dir.AIHomeDir)
}
