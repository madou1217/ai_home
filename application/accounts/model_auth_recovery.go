package accounts

import (
	"context"
	"errors"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// ErrModelAuthenticationRejected 表示模型发现的凭据被拒绝，本轮重复探测不能恢复。
// 它不等于管理接口的登录失效，也不把账号永久禁用；新的凭据或外部重扫仍可恢复。
var ErrModelAuthenticationRejected = errors.New("模型目录认证被拒绝，请检查账号凭据或重新授权")

// ModelCredentialRecoverer 在目录明确拒绝凭据后执行至多一次代次安全恢复。
// 可选端口保留只读/无刷新装配；实现必须复用已有凭据刷新协调器，不自行维护令牌。
type ModelCredentialRecoverer interface {
	RecoverModelCredential(context.Context, CredentialSnapshot) (CredentialSnapshot, error)
}

// discoverWithCredentialRecovery 将有界认证恢复与模型目录的编排分开。
// 不递归调用刷新用例：瞬时刷新错误及恢复后的新目录错误以新的分类为准，不能
// 与原认证错误 Join，否则协调器会把可恢复的网络故障误当成认证终态。
func (management *ModelManagement) discoverWithCredentialRecovery(
	ctx context.Context,
	snapshot CredentialSnapshot,
) ([]runtimecore.ModelID, CredentialSnapshot, error) {
	models, err := management.discovery.DiscoverModels(ctx, snapshot.Credential())
	if !errors.Is(err, ErrModelAuthenticationRejected) {
		return models, snapshot, err
	}
	recoverer, ok := management.refresher.(ModelCredentialRecoverer)
	if !ok {
		return nil, snapshot, err
	}
	recovered, recoveryErr := recoverer.RecoverModelCredential(ctx, snapshot)
	if recoveryErr != nil {
		if errors.Is(recoveryErr, ErrModelAuthenticationRejected) {
			// 保留原请求的 status/media_type，不加入任何上游错误正文。
			return nil, snapshot, err
		}
		return nil, snapshot, recoveryErr
	}
	if !recovered.IsValid() || recovered.ProviderID() != snapshot.ProviderID() {
		return nil, snapshot, ErrInvalidCredentialSnapshot
	}
	if recovered.AccountRef() == snapshot.AccountRef() && !recovered.UpdatedAt().After(snapshot.UpdatedAt()) {
		return nil, snapshot, err
	}
	models, err = management.discovery.DiscoverModels(ctx, recovered.Credential())
	return models, recovered, err
}
