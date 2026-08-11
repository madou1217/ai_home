package main

import (
	"context"
	"fmt"
	"io"
	"text/tabwriter"

	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// runAccountModels 解析账号模型的只读列表与显式刷新子命令。
func runAccountModels(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) == 0 || isRootHelp(arguments[0]) || arguments[0] == "help" {
		writeAccountModelsUsage(runtime.stdout)
		return nil
	}
	command := arguments[0]
	if command != "list" && command != "refresh" && command != "set-policy" {
		return fmt.Errorf("%w: 未知账号模型子命令 %s", errInvalidCommand, arguments[0])
	}
	if len(arguments) == 2 && isRootHelp(arguments[1]) {
		writeAccountModelsUsage(runtime.stdout)
		return nil
	}
	if command == "set-policy" {
		if len(arguments) != 4 {
			writeAccountModelsUsage(runtime.stderr)
			return fmt.Errorf(
				"%w: models set-policy 需要账号、模型和策略",
				errInvalidCommand,
			)
		}
		policyCommand, err := aihaccount.ParseAccountModelPolicyCommand(
			arguments[1],
			arguments[2],
			arguments[3],
		)
		if err != nil {
			writeAccountModelsUsage(runtime.stderr)
			return fmt.Errorf("%w: 账号目标、模型或策略无效", errInvalidCommand)
		}
		return runAccountModelsCommand(
			ctx,
			accountModelsInvocation{
				name:          command,
				policyCommand: policyCommand,
			},
			runtime,
		)
	}
	if len(arguments) != 2 {
		writeAccountModelsUsage(runtime.stderr)
		return fmt.Errorf("%w: models %s 需要一个账号目标", errInvalidCommand, command)
	}
	target, err := aihaccount.ParseAccountTarget(arguments[1])
	if err != nil {
		writeAccountModelsUsage(runtime.stderr)
		return fmt.Errorf("%w: 账号目标必须是 account_ref 或 provider:id", errInvalidCommand)
	}
	return runAccountModelsCommand(
		ctx,
		accountModelsInvocation{name: command, target: target},
		runtime,
	)
}

// accountModelsInvocation 是 CLI 校验后的账号模型命令值。
type accountModelsInvocation struct {
	name          string
	target        aihaccount.AccountTarget
	policyCommand aihaccount.AccountModelPolicyCommand
}

// runAccountModelsCommand 统一账号模型命令的 Server 解析、HTTP 操作和结果输出。
func runAccountModelsCommand(
	ctx context.Context,
	invocation accountModelsInvocation,
	runtime commandRuntime,
) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	var (
		result       managementapi.AccountModelsResult
		operationErr error
	)
	target := invocation.target
	if invocation.name == "set-policy" {
		target = invocation.policyCommand.Target
	}
	accountRef, err := resolveManagementAccountRef(ctx, client, target)
	if err != nil {
		return fmt.Errorf("解析 Server 账号模型目标失败: %w", err)
	}
	switch invocation.name {
	case "list":
		result, operationErr = client.ListAccountModels(ctx, accountRef)
	case "refresh":
		result, operationErr = client.RefreshAccountModels(ctx, accountRef)
	case "set-policy":
		result, operationErr = client.SetAccountModelPolicy(
			ctx,
			accountRef,
			invocation.policyCommand.ModelID,
			invocation.policyCommand.ManualPolicy,
		)
	default:
		operationErr = fmt.Errorf(
			"%w: 未知账号模型操作 %s",
			errInvalidCommand,
			invocation.name,
		)
	}
	if operationErr != nil {
		return fmt.Errorf("执行 Server 账号模型操作失败: %w", operationErr)
	}
	if invocation.name == "refresh" {
		_, _ = fmt.Fprintln(runtime.stdout, "模型刷新完成。")
	} else if invocation.name == "set-policy" {
		_, _ = fmt.Fprintln(runtime.stdout, "模型策略已更新。")
	}
	writeAccountModelsResult(runtime.stdout, newHostAccountModelsResult(result))
	return nil
}

// writeAccountModelsResult 输出模型来源、人工策略和最终路由有效性。
func writeAccountModelsResult(
	output io.Writer,
	result aihaccount.AccountModelsResult,
) {
	if len(result.Models) == 0 {
		_, _ = fmt.Fprintf(
			output,
			"账号 %s 当前没有已物化模型。\n",
			result.AccountRef,
		)
		return
	}
	_, _ = fmt.Fprintf(
		output,
		"账号模型（%s，共 %d 个）:\n",
		result.AccountRef,
		len(result.Models),
	)
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(writer, "MODEL\tUPSTREAM\tPOLICY\tEFFECTIVE\tUPDATED_AT")
	for _, model := range result.Models {
		_, _ = fmt.Fprintf(
			writer,
			"%s\t%s\t%s\t%s\t%s\n",
			model.ModelID,
			accountModelUpstreamLabel(model.UpstreamAvailable),
			model.ManualPolicy,
			accountModelEffectiveLabel(model.Effective),
			accountTimeLabel(model.UpdatedAt),
		)
	}
	_ = writer.Flush()
}

// accountModelUpstreamLabel 区分最近目录是否仍包含该模型。
func accountModelUpstreamLabel(available bool) string {
	if available {
		return "available"
	}
	return "missing"
}

// accountModelEffectiveLabel 表示人工策略合并后是否进入账号路由正排。
func accountModelEffectiveLabel(effective bool) string {
	if effective {
		return "enabled"
	}
	return "disabled"
}

// writeAccountModelsUsage 说明模型列表与刷新各自的数据和网络边界。
func writeAccountModelsUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih account models list <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output, "  aih account models refresh <account_ref|provider:id>")
	_, _ = fmt.Fprintln(output, "  aih account models set-policy <account_ref|provider:id> <model_id> <policy>")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "目标:")
	_, _ = fmt.Fprintln(output, "  acct_...   全链路稳定 AccountRef")
	_, _ = fmt.Fprintln(output, "  provider:id Provider 内数字别名，例如 claude:1 或 codex:2")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "字段:")
	_, _ = fmt.Fprintln(output, "  UPSTREAM  最近一次完整目录是否包含模型")
	_, _ = fmt.Fprintln(output, "  POLICY    inherit、force_enable 或 force_disable")
	_, _ = fmt.Fprintln(output, "  EFFECTIVE 合并上游目录和人工策略后的最终路由状态")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "行为:")
	_, _ = fmt.Fprintln(output, "  list 只读取目标 Server 中已物化的账号模型快照，不实时请求 Provider。")
	_, _ = fmt.Fprintln(output, "  refresh 由目标 Server 使用规范凭据读取完整 Provider 目录，成功后原子替换上游发现部分。")
	_, _ = fmt.Fprintln(output, "  refresh 失败时保留旧快照；人工 force_enable/force_disable 策略不被覆盖。")
	_, _ = fmt.Fprintln(output, "  set-policy 只修改一个精确模型，不访问 Provider；inherit 恢复跟随上游目录。")
	_, _ = fmt.Fprintln(output, "  两个命令都不输出凭据正文、usage 或运行态。")
	_, _ = fmt.Fprintln(output, "  AIH_HOME 不参与这些查询；账号事实以 AIH_SERVER_BASE_URL 为准。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih account models list claude:1")
	_, _ = fmt.Fprintln(output, "  aih account models list acct_0123456789abcdef0123")
	_, _ = fmt.Fprintln(output, "  aih account models refresh claude:1")
	_, _ = fmt.Fprintln(output, "  aih account models set-policy claude:1 claude-opus-5 force_disable")
}
