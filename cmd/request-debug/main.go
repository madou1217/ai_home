package main

import (
	"fmt"
	"os"

	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

// main 仅用于本地真实请求合同诊断，不输出请求正文。
func main() {
	body, err := os.ReadFile("/tmp/aih-cross-provider-request.json")
	if err != nil {
		panic(err)
	}
	_, err = openairesponses.NewRequestDecoder().Decode(body)
	fmt.Printf("%v\n", err)
}
