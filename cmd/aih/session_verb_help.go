package main

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// writeSessionVerbHelp handles the local help surface without account lookup,
// credential refresh or spawning the official CLI. Native -- escapes bypass it.
func writeSessionVerbHelp(providerID string, arguments []string, runtime commandRuntime) bool {
	index := 1
	if len(arguments) > 2 && isNumericAccountToken(arguments[1]) {
		index = 2
	}
	if len(arguments) <= index || !isSessionVerbToken(arguments[index]) {
		return false
	}
	help := false
	for _, argument := range arguments[index+1:] {
		if argument == "--help" || argument == "-h" {
			help = true
		}
	}
	if !help {
		return false
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return false
	}
	definition, found := catalog.Get(providerID)
	if !found {
		return false
	}
	verb := arguments[index]
	fmt.Fprintf(runtime.stdout, "用法: aih %s [账号] %s [会话ID] [原生参数...]\n", providerID, verb)
	var command *providers.NativeSessionCommand
	if definition.NativeBoundary != nil {
		if verb == "resume" {
			command = definition.NativeBoundary.Sessions.Resume
		} else {
			command = definition.NativeBoundary.Sessions.Fork
		}
	}
	if command == nil {
		fmt.Fprintln(runtime.stdout, "该 Provider 未声明此启动命令；请使用其原生界面。")
		return true
	}
	fmt.Fprintf(runtime.stdout, "指定会话: %s\n", strings.Join(command.WithID, " "))
	if len(command.WithoutID) == 0 {
		fmt.Fprintln(runtime.stdout, "必须提供精确会话 ID。")
	} else {
		fmt.Fprintf(runtime.stdout, "省略会话 ID: %s\n", strings.Join(command.WithoutID, " "))
	}
	return true
}
