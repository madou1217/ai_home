package appstate

import "context"

// ServerConfigStore 是 aih.db 中 config:server 原文的唯一读写适配器。
//
// 为什么独立成类型：WebUI 的服务器设置、聊天大粘贴阈值与管理密钥轮换都要在同一个
// 键上做「立即事务读改写」。此前三个 transport 包各自复制了一份字段与方法完全相同的
// Source，并发语义（BEGIN IMMEDIATE）因此有三份实现，任何一处改动都要同步三次。
type ServerConfigStore struct {
	databasePath string
}

// OpenServerConfigStore 按 AIH 数据根创建 server 配置存储。
func OpenServerConfigStore(aiHomeDir string) (*ServerConfigStore, error) {
	path, err := DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &ServerConfigStore{databasePath: path}, nil
}

// ReadServerConfig 返回 config:server 的原始 JSON；没有记录时 found=false。
func (store *ServerConfigStore) ReadServerConfig(ctx context.Context) (string, bool, error) {
	if store == nil {
		return "", false, nil
	}
	return ReadKV(ctx, store.databasePath, KeyServerConfig)
}

// UpdateServerConfig 在立即事务里读改写 config:server。
func (store *ServerConfigStore) UpdateServerConfig(
	ctx context.Context,
	mutate func(current string, found bool) (string, error),
) error {
	if store == nil {
		return nil
	}
	return UpdateKV(ctx, store.databasePath, KeyServerConfig, mutate)
}
