package pluginruntime

// OutcomeRecorder 是可选的调用结果记录端口。插件宿主实现它以后，
// 数据面会把「插件正常返回但拒绝请求」与 RPC 失败分开计数。
type OutcomeRecorder interface {
	RecordPluginRejection(contributionID, reason string)
}

func recordPluginRejection(invoker Invoker, contributionID, reason string) {
	if invoker == nil || contributionID == "" {
		return
	}
	if recorder, ok := invoker.(OutcomeRecorder); ok {
		recorder.RecordPluginRejection(contributionID, reason)
	}
}
