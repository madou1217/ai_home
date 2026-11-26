package modelsapi

import "net/http"

// catalogProblem 是与协议无关的错误分类。Handler 只表达“发生了什么”，
// 由各协议的 dialect 决定错误 envelope；这样 OpenAI 与 Anthropic 的
// 错误形状不会散落在路由编排里。
type catalogProblem uint8

const (
	catalogProblemInvalidQuery catalogProblem = iota
	catalogProblemUnauthorized
	catalogProblemForbidden
	catalogProblemMethodNotAllowed
	catalogProblemNotFound
	catalogProblemInternal
)

// catalogQuery 保存解析后的协议专属查询。共享的视图构建阶段只读取
// ViewOptions；具体 dialect 在渲染时断言自己的选项类型。
type catalogQuery interface {
	ViewOptions() catalogViewOptions
}

// catalogViewOptions 是各协议共用的目录构建开关。
type catalogViewOptions struct {
	IncludeModalities bool
	Capability        string
}

// catalogRenderContext 是一次列表渲染所需的全部上下文。
type catalogRenderContext struct {
	handler *Handler
	request *http.Request
	query   catalogQuery
	views   []modelView
}

// catalogDialect 是 /v1/models 的协议策略。ServeHTTP 负责鉴权、目录构建
// 与可见范围；dialect 只负责查询校验、响应形状和协议原生错误。
//
// Matches 按 catalogDialects 的顺序求值：Anthropic 用 anthropic-version
// 头匹配；OpenAI dialect 是兜底，同时继续承接 Codex 的 client_version
// 查询，保持既有合同不变。
type catalogDialect interface {
	Matches(request *http.Request) bool
	ParseQuery(rawQuery string) (catalogQuery, error)
	RenderList(response http.ResponseWriter, context catalogRenderContext)
	RenderModel(response http.ResponseWriter, request *http.Request, modelID string)
	WriteProblem(response http.ResponseWriter, problem catalogProblem, cause error)
}

var catalogDialects = []catalogDialect{
	anthropicCatalogDialect{},
	openAICatalogDialect{},
}

// catalogDialectFor 选择请求所属的协议方言。兜底永远返回 OpenAI，
// 因此新增协议只需要注册一个 Matches 更具体的 dialect。
func catalogDialectFor(request *http.Request) catalogDialect {
	for _, dialect := range catalogDialects {
		if dialect.Matches(request) {
			return dialect
		}
	}
	return openAICatalogDialect{}
}
