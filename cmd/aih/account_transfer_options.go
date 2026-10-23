package main

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// accountTransferFormat 是当前明确支持的外部账号合同。
//
// sub2api 已于 2026-10-23 移除（账号迁移改走原生静态凭据路径）；
// 这里保留枚举而不是退回裸字符串，是因为「格式」天然会继续增加。
type accountTransferFormat string

const (
	transferFormatCLIProxyAPI accountTransferFormat = "cliproxyapi"
)

// transferExportOptions 是单账号导出解析后的完整命令。
type transferExportOptions struct {
	target     aihaccount.AccountTarget
	format     accountTransferFormat
	outputPath string
}

// transferImportOptions 是单账号导入解析后的完整命令。
type transferImportOptions struct {
	inputPath string
}

// parseTransferExportOptions 接受一个目标及互不重复的 format/output 选项。
func parseTransferExportOptions(arguments []string) (transferExportOptions, error) {
	positionals, options, err := parseTransferArguments(
		arguments,
		map[string]struct{}{"--format": {}, "--output": {}},
	)
	if err != nil || len(positionals) != 1 {
		return transferExportOptions{}, invalidTransferCommand(
			"export 需要一个账号目标、--format 和 --output",
		)
	}
	target, err := aihaccount.ParseAccountTarget(positionals[0])
	if err != nil {
		return transferExportOptions{}, invalidTransferCommand(
			"账号目标必须是 account_ref 或 provider:id",
		)
	}
	format := accountTransferFormat(options["--format"])
	if format != transferFormatCLIProxyAPI {
		return transferExportOptions{}, invalidTransferCommand(
			"export format 必须是 cliproxyapi",
		)
	}
	outputPath := options["--output"]
	if !validTransferPath(outputPath) {
		return transferExportOptions{}, invalidTransferCommand(
			"--output 必须是显式文件路径，不能是 stdout",
		)
	}
	return transferExportOptions{target: target, format: format, outputPath: outputPath}, nil
}

// parseTransferArguments 解析少量 name-value 选项并拒绝重复、缺值和未知项。
func parseTransferArguments(
	arguments []string,
	allowed map[string]struct{},
) ([]string, map[string]string, error) {
	positionals := make([]string, 0, 1)
	options := make(map[string]string, len(allowed))
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if !strings.HasPrefix(argument, "--") {
			positionals = append(positionals, argument)
			continue
		}
		if _, found := allowed[argument]; !found || index+1 >= len(arguments) {
			return nil, nil, errInvalidCommand
		}
		if _, duplicate := options[argument]; duplicate {
			return nil, nil, errInvalidCommand
		}
		index++
		value := arguments[index]
		if value == "" || strings.HasPrefix(value, "--") {
			return nil, nil, errInvalidCommand
		}
		options[argument] = value
	}
	if len(options) != len(allowed) {
		return nil, nil, errInvalidCommand
	}
	return positionals, options, nil
}

// validTransferPath 拒绝空路径、控制字符以及 stdin/stdout 约定值。
func validTransferPath(path string) bool {
	if path == "" || path == "-" {
		return false
	}
	for _, character := range path {
		if character == 0 || character == '\n' || character == '\r' {
			return false
		}
	}
	return true
}

// invalidTransferCommand 创建不包含路径或文档正文的稳定命令错误。
func invalidTransferCommand(message string) error {
	return fmt.Errorf("%w: %s", errInvalidCommand, message)
}
