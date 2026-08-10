package main

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// accountTransferFormat 是当前明确支持的两个外部账号合同。
type accountTransferFormat string

const (
	transferFormatSub2API     accountTransferFormat = "sub2api"
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
	if format != transferFormatSub2API && format != transferFormatCLIProxyAPI {
		return transferExportOptions{}, invalidTransferCommand(
			"export format 必须是 sub2api 或 cliproxyapi",
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

// parseTransferImportOptions 只接受 sub2api 和一个显式输入文件。
func parseTransferImportOptions(arguments []string) (transferImportOptions, error) {
	positionals, options, err := parseTransferArguments(
		arguments,
		map[string]struct{}{"--format": {}, "--input": {}},
	)
	if err != nil || len(positionals) != 0 ||
		options["--format"] != string(transferFormatSub2API) {
		return transferImportOptions{}, invalidTransferCommand(
			"import 只接受 --format sub2api 和 --input",
		)
	}
	inputPath := options["--input"]
	if !validTransferPath(inputPath) {
		return transferImportOptions{}, invalidTransferCommand(
			"--input 必须是显式文件路径，不能是 stdin",
		)
	}
	return transferImportOptions{inputPath: inputPath}, nil
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
