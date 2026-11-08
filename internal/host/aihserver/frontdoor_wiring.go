package aihserver

import (
	"net/http"
	"net/url"
	"strings"
)

// newFrontDoorFromOptions 在配置了上游时构造公开端口兜底反代。
//
// 空上游返回 nil：调用方保持「未识别路由 404」的原有语义，不引入隐式依赖。
func newFrontDoorFromOptions(options Options) (http.Handler, error) {
	upstream := strings.TrimSpace(options.FrontDoorUpstream)
	if upstream == "" {
		return nil, nil
	}
	parsed, err := url.Parse(upstream)
	if err != nil {
		return nil, err
	}
	return NewFrontDoor(parsed, strings.TrimSpace(options.FrontDoorToken), options.ErrorLog)
}
