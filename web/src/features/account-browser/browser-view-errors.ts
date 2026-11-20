type ErrorContext = 'capability' | 'runtime';

// Exact codes only: native, transport and JSON errors can contain private host details.
const messages = new Map<string, string>([
  ['browser_host_platform_unavailable', '所选 Server 尚未提供此平台的原生浏览器适配器（Windows / Linux 当前不支持）；不会回退到本机或其他 Server。'],
  ['browser_host_requires_macos14', '执行 Server 的浏览器适配器要求 macOS 14 或以上版本；不会切换到其他 Server。'],
  ['browser_host_os_version_unavailable', '无法确认执行 Server 的系统版本，请检查该 Server 后重新读取能力。'],
  ['browser_native_build_unavailable', '执行 Server 的原生窗口桥无法构建，请检查该 Server 的构建环境。'],
  ['browser_home_requires_absolute_path', '执行 Server 的任务资料目录配置无效，请由管理员检查目录配置。'],
  ['browser_capture_unavailable', '执行 Server 无法获取任务窗口画面，请检查窗口及录屏权限；本功能不会自动申请权限。'],
  ['browser_capture_stopped', '执行 Server 的画面采集已停止，请检查任务窗口后手动重新连接。'],
  ['browser_window_unavailable', '执行 Server 的任务窗口不可用，请检查窗口后手动重新连接。'],
  ['browser_input_permission_or_identity_lost', '执行 Server 的输入权限或任务窗口身份已失效，已停止控制；请检查后手动重新连接。'],
  ['browser_window_resized_reconnect', '执行 Server 的任务窗口尺寸已改变，请手动重新连接后继续操作。'],
  ['browser_identity_unavailable', '无法确认执行 Server 的任务浏览器身份，已停止操作；请检查浏览器后手动重试。'],
  ['browser_native_helper_stopped', '执行 Server 的原生窗口桥已停止，请检查该 Server 后手动重新连接。'],
  ['browser_native_event_invalid', '执行 Server 返回了无效的原生事件，已停止连接；请检查该 Server 版本。'],
  ['browser_native_event_too_large', '执行 Server 的原生事件超过大小限制，已停止连接；请检查该 Server。'],
  ['browser_native_protocol_invalid', '执行 Server 的原生窗口桥协议无效，已停止连接；请检查该 Server 版本。'],
  ['browser_browser_unavailable', '执行 Server 上的目标浏览器不可用，请检查是否已安装受支持的浏览器。'],
  ['browser_storage_unavailable', '执行 Server 无法使用任务资料目录，请由管理员检查目录及访问权限。'],
  ['browser_storage_unsafe', '执行 Server 的任务资料目录未通过安全检查，已拒绝启动；请由管理员检查目录配置。'],
  ['browser_cleanup_required', '执行 Server 的浏览器清理尚未完成，请先检查原生进程；不要重复启动。'],
  ['browser_system_permission_required', '执行 Server 缺少录屏或事件发送权限；本功能不会自动申请或修改系统权限。'],
  ['browser_surface_already_controlled', '已有窗口正在控制这个浏览器，请先关闭原连接。'],
  ['browser_frame_stale', '画面已过期，输入已暂停。'],
  ['browser_multiple_windows_not_supported', '检测到多个任务窗口，目前仅允许一个窗口。'],
  ['browser_control_backpressure', '控制链路繁忙，已安全断开。请手动重新连接；未确认操作不会自动重试。'],
  ['browser_capabilities_http_404', '所选 Server 尚未升级以提供浏览器能力查询，请升级该 Server 后重新读取；不会回退到本机。'],
  ['browser_capabilities_http_501', '所选 Server 尚未升级以提供浏览器能力查询，请升级该 Server 后重新读取；不会回退到本机。'],
  ['browser_capabilities_http_401', '所选 Server 的能力查询未通过身份认证，请检查 Server 凭据后重新读取。'],
  ['browser_capabilities_http_403', '无权读取所选 Server 的浏览器能力，请检查 Server 授权后重新读取。'],
  ['browser_capabilities_invalid', '所选 Server 返回的能力信息无效，请检查 Server 版本后重新读取。'],
  ['browser_connection_failed', '无法连接所选 Server 的任务浏览器，请检查该 Server 后手动重试。'],
  ['browser_stream_timeout', '与执行 Server 的画面连接已超时，请检查网络后手动重新连接。'],
]);

export function browserViewErrorMessage(failure: unknown, context: ErrorContext = 'runtime'): string {
  const code = typeof failure === 'string' ? failure : failure instanceof Error ? failure.message : '';
  return messages.get(code) || (context === 'capability'
    ? '无法读取所选 Server 的浏览器能力，请检查连接后重新读取；不会回退到本机。'
    : '执行 Server 的任务浏览器暂不可用，请检查该 Server 后手动重试。');
}
