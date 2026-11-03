package aihaccount

import (
	"context"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// ErrInvalidImportRequest 表示导入请求的 Context 或 Provider 无效。
var ErrInvalidImportRequest = errors.New("AIH 账号导入请求无效")

// ImportResult 是一次官方登录态导入的公开结果，绝不包含任何凭据。
type ImportResult struct {
	// ProviderID 是导入账号所属的规范 Provider。
	ProviderID string
	// CLIAccountID 是持久化层原子分配的 Provider 内数字别名。
	CLIAccountID int64
	// AccountRef 是由凭据派生的稳定账号身份。
	AccountRef string
	// Email 是官方公开资料中的登录邮箱，用于确认导入的是哪个登录。
	Email string
	// Models 是响应时已经物化的模型；首次异步刷新尚未完成时可以为空。
	Models []string
	// Sources 是本次读取的官方 artifact 文件路径。
	Sources []string
}

// ImportOfficialLogin 把该 Provider 官方 CLI 当前登录态注册成一个 AIH 账号。
//
// 正式 Server 会在注册事务提交后异步刷新模型；本方法不会以目录请求阻塞导入。
func (app *App) ImportOfficialLogin(
	ctx context.Context,
	providerID string,
) (ImportResult, error) {
	if app == nil || ctx == nil {
		return ImportResult{}, ErrInvalidImportRequest
	}
	if err := ctx.Err(); err != nil {
		return ImportResult{}, err
	}
	if !app.decoder.Supports(providerID) || !app.reader.Supports(providerID) {
		return ImportResult{}, fmt.Errorf(
			"%w: 当前只支持 codex 和 claude",
			ErrInvalidImportRequest,
		)
	}
	artifacts, err := app.reader.Read(providerID)
	if err != nil {
		return ImportResult{}, fmt.Errorf("读取 %s 官方登录态失败: %w", providerID, err)
	}
	defer clear(artifacts.Envelope)

	credential, profile, err := app.decoder.Decode(providerID, artifacts.Envelope)
	if err != nil {
		return ImportResult{}, fmt.Errorf("解码 %s 官方登录态失败: %w", providerID, err)
	}
	account, err := app.registrar.Register(ctx, credential, profile)
	if err != nil {
		return ImportResult{}, fmt.Errorf("注册 %s 账号失败: %w", providerID, err)
	}
	models, err := app.accounts.ListAccountModels(ctx, account.Ref())
	if err != nil {
		return ImportResult{}, fmt.Errorf("读取账号模型目录失败: %w", err)
	}
	return ImportResult{
		ProviderID:   account.ProviderID(),
		CLIAccountID: account.CLIAccountID().Int64(),
		AccountRef:   account.Ref().String(),
		Email:        profileEmail(profile),
		Models:       effectiveModelIDs(models),
		Sources:      artifacts.Sources,
	}, nil
}

// profileEmail 只在存在官方公开资料时回显登录邮箱。
func profileEmail(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	return profile.Email()
}

// effectiveModelIDs 只返回当前真实生效的模型，供调用方选择验收模型。
func effectiveModelIDs(models []accountapp.AccountModel) []string {
	values := make([]string, 0, len(models))
	for _, model := range models {
		if model.Effective() {
			values = append(values, model.ModelID().String())
		}
	}
	return values
}
