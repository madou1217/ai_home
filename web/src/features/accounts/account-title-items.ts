// 账号标题「多身份轮播」的纯展示规则。
//
// 单独放在 .ts 里（不放进 .tsx）是为了能被 node --test 直接导入：组件文件含 JSX，
// Node 的类型剥离解析不了。规则本身与 React 无关，测试只需要这几个字段。

export interface AccountTitleDisplayName {
  type: string;
  value: string;
}

export interface AccountTitleFields {
  displayId?: string;
  displayName?: string;
  email?: string;
  displayNames?: AccountTitleDisplayName[];
}

// 为什么要轮播：一个账号可能同时有昵称、手机号、邮箱、CLI ID，单行放不下，
// 而用户在不同场景需要不同身份（对照 CLI 用 ID、确认账号用手机号/邮箱）。
//
// 顺序：#CLI ID → 服务端下发的 displayNames（数组顺序即轮播顺序）。
// displayNames 是**唯一**的身份列表：新增身份类型（uin、员工号…）不需要改这里。
// 旧服务端没有该字段时，回退到 displayName / email 的旧口径。
export function buildAccountTitleItems(record: AccountTitleFields): string[] {
  const items: string[] = [];
  const push = (value: string) => {
    const text = String(value || '').trim();
    if (text && !items.includes(text)) items.push(text);
  };
  push(record.displayId ? `#${record.displayId}` : '');

  if (Array.isArray(record.displayNames)) {
    for (const entry of record.displayNames) {
      if (!entry || typeof entry !== 'object') continue;
      push(String(entry.value || ''));
    }
    return items;
  }

  // —— 旧服务端兼容：没有 displayNames 时按原字段拼 ——
  const name = String(record.displayName || '').trim();
  push(name);
  const email = String(record.email || '').trim();
  const syntheticPhone = /^(\d{6,})@phone\.local$/i.exec(email);
  if (syntheticPhone) push(syntheticPhone[1]);
  if (email && !syntheticPhone && email !== name) push(email);
  return items;
}
