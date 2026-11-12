// 账号启动命令：账号页展示/复制的唯一拼法。
//
// 语义：aih <provider> <cli-id> 是「用这个账号启动该 CLI」的稳定命令。CLI ID 来自
// 服务端的 displayId（record.cliAccountId / accountId 的公开映射），不是内部的
// acct_xxx 主键 —— 用户复制到终端里能直接跑。
//
// 单放在纯 TS 文件里便于 node --test 直接覆盖（组件文件含 JSX，Node 类型剥离解析不了）。

export interface AccountCliCommandFields {
  provider?: string;
  displayId?: string;
}

export function buildAccountCliCommand(record: AccountCliCommandFields | null | undefined): string {
  const provider = String(record?.provider || '').trim().toLowerCase();
  const displayId = String(record?.displayId || '').trim();
  if (!provider || !displayId) return '';
  // 内部主键永远不可能是 CLI 参数：防御性拒绝，避免上游映射错误时把 acct_xxx
  // 复制成一条注定失败的命令。
  if (/^acct_/i.test(displayId)) return '';
  // 数字 ID / 非空账号标识都可能出现；带空格时用 JSON 引号包住，复制后可直接执行。
  const token = /\s/.test(displayId) ? JSON.stringify(displayId) : displayId;
  return `aih ${provider} ${token}`;
}
