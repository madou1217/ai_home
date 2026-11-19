package images

// SupportsCodexOAuthImagePlan 不从套餐名称推断专用图片接口的授权。
// 单个 Free 账号的 403 不能证明整个套餐不支持；真实权限由上游响应裁定。
func SupportsCodexOAuthImagePlan(_ string) bool {
	return true
}
