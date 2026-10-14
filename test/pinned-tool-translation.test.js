'use strict';

// 「钉住某个工具」的翻译不变量（跨形态，P2）。
//
// 为什么需要这个文件：上游（CodeBuddy / WorkBuddy 家族）把 `tool_choice` 声明成 **Go string**，
// 客户端按 OpenAI 规范发的 object 直接被 400 拒；而把 object 一律降级成裸 `required` 又会
// 静默丢掉「必须调用 X」的语义 —— 对标实现把这一现象判定为缺陷本身
// （cloudflare/ai#560「a 'model must call this tool' step silently becomes a step the model can
// answer in prose」；raine/claude-code-proxy a638e26「mapped to the generic 'required', which lets
// the model choose any function」）。codebuddy-family-inference 的用例逐条覆盖了各形态；这里守的
// 是**跨形态的不变量**，新增形态时任何一条回归都会失败：
//
//   ① 上游合法性：无论客户端发什么，落到 body 的 `tool_choice` 只可能是上游认的字符串
//      （auto/required/none），且 `stream` 恒为 true —— 这两条是上游会 400 的硬约束；
//   ② 有损必留痕：一旦发生语义降级（`toolChoiceDowngraded`），必须同时给出原因
//      （`toolChoicePinMissing` 或 `toolChoiceUnsupportedForm`），不允许「悄悄变弱」；
//   ③ 钉选不静默丢失：客户端表达了具体函数名时，结局只能是保住（`pinPreserved`）
//      或显式报缺失（`pinMissing`），不存在第三种；
//   ④ 保住的钉选必须严格等价：收窄 tools 到被钉的那一个 + `required`，且不再标记降级；
//   ⑤ 不改写入参：客户端传进来的 tools 数组必须原样可用（调用方还要拿它做日志）；
//   ⑥ 可观测：适配器返回的每个改写结论都必须在唯一调用点被 annotateAttempt 记进注解袋子，
//      否则「有损」在日志里根本看不见（这条是 ②③ 能被事后排查的前提）。
//
// 另一条同源的有损路径（非流式聚合丢工具调用）见文件末尾的流表：客户端拿到
// `finish_reason: 'tool_calls'` 就必须有工具可执行，否则表现为「模型回答为空」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  adaptCodebuddyFamilyChatRequest,
  aggregateCodebuddyFamilySse
} = require('../lib/account/codebuddy-family-inference');

// 上游唯一接受的 tool_choice 取值（2026-10-14 探针矩阵实测：上游声明为 Go string）。
const UPSTREAM_TOOL_CHOICE_STRINGS = ['auto', 'required', 'none'];

const PIN_TOOLS = [
  { type: 'function', function: { name: 'get_weather', description: 'w', parameters: {} } },
  { type: 'function', function: { name: 'read_file', description: 'r', parameters: {} } }
];
const PIN_TOOLS_SNAPSHOT = JSON.stringify(PIN_TOOLS);
const MESSAGES = [{ role: 'system', content: 's' }];

// 与实现无关地读出「客户端想钉住哪个函数」（嵌套 OpenAI 形态与 Responses 扁平形态）。
function pinNameFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (String(value.type || '').trim().toLowerCase() !== 'function') return '';
  const nested = value.function && typeof value.function === 'object' ? value.function.name : '';
  return String(nested || value.name || '').trim();
}

// 一行 = 一种客户端能表达的 tool_choice 形态 + 我们承诺的结局。
// `expect` 里的 `bodyToolChoice: undefined` 表示「该字段必须从 body 里消失」（不是被置 null）。
function pin(name) {
  return { type: 'function', function: { name } };
}

const TOOL_CHOICE_TABLE = [
  // ① 客户端压根没发这个字段：不得凭空造出一个约束。
  {
    name: 'absent',
    input: {},
    expect: { normalized: false, downgraded: false, toolsUntouched: true }
  },
  // ② 上游认的字符串：原样通过（只有大小写/空白才动）。
  {
    name: 'string auto',
    input: { toolChoice: 'auto', tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'auto', normalized: false, downgraded: false, toolsUntouched: true }
  },
  {
    name: 'string none',
    input: { toolChoice: 'none', tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'none', normalized: false, downgraded: false, toolsUntouched: true }
  },
  {
    // 客户端自相矛盾（required 却一个工具都没给）。上游不校验这一条：2026-10-14 实测
    // `tool_choice:'required'` + 无 tools 直接 200（模型照常回答散文），所以原样透传，
    // 既不降级也不标记 —— 不要把「上游会拒」当成事实写进实现（见适配器注释的更正）。
    name: 'string required 无 tools',
    input: { toolChoice: 'required' },
    expect: { bodyToolChoice: 'required', normalized: false, downgraded: false, toolsUntouched: true }
  },
  {
    name: 'string 大小写/空白归一',
    input: { toolChoice: ' REQUIRED ', tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'required', normalized: true, downgraded: false, toolsUntouched: true }
  },
  {
    name: 'alias any',
    input: { toolChoice: 'any', tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'required', normalized: true, downgraded: false, toolsUntouched: true }
  },
  {
    name: 'object {type:auto}',
    input: { toolChoice: { type: 'auto' }, tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'auto', normalized: true, downgraded: false, toolsUntouched: true }
  },
  // ③ 钉选保住：收窄 tools 到被钉的那一个 + required。
  {
    name: 'pin nested',
    input: { toolChoice: pin('read_file'), tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'required', normalized: true, pinPreserved: true, narrowedTools: ['read_file'] }
  },
  {
    name: 'pin flat',
    input: { toolChoice: { type: 'function', name: 'read_file' }, tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'required', normalized: true, pinPreserved: true, narrowedTools: ['read_file'] }
  },
  // ④ 钉选保不住：只能放宽，但必须显式标记「钉的那一个不在了」。
  {
    name: 'pin 不在 tools 里',
    input: { toolChoice: pin('nope_tool'), tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'required', normalized: true, pinMissing: true, downgraded: true, toolsUntouched: true }
  },
  {
    name: 'pin 但没带 tools',
    input: { toolChoice: pin('read_file') },
    expect: { bodyToolChoice: undefined, normalized: true, pinMissing: true, downgraded: true, toolsUntouched: true }
  },
  {
    name: 'pin 但 tools 为空数组',
    input: { toolChoice: pin('read_file'), tools: [] },
    expect: { bodyToolChoice: undefined, normalized: true, pinMissing: true, downgraded: true, toolsUntouched: true }
  },
  // ⑤ 认不出的形态：一律放宽成 auto（有工具时）或干脆不约束，绝不原样发上去换 400。
  {
    name: 'function 无名字(有 tools)',
    input: { toolChoice: { type: 'function' }, tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'required', normalized: true, downgraded: true, unsupportedForm: 'function_without_name', toolsUntouched: true }
  },
  {
    name: 'function 无名字(无 tools)',
    input: { toolChoice: { type: 'function' } },
    expect: { bodyToolChoice: undefined, normalized: true, downgraded: true, unsupportedForm: 'function_without_name', toolsUntouched: true }
  },
  {
    name: '未知字符串',
    input: { toolChoice: 'banana', tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'auto', normalized: true, downgraded: true, unsupportedForm: 'banana', toolsUntouched: true }
  },
  {
    name: '数组',
    input: { toolChoice: ['required'], tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'auto', normalized: true, downgraded: true, unsupportedForm: 'array', toolsUntouched: true }
  },
  {
    name: '数字(无 tools)',
    input: { toolChoice: 3 },
    expect: { bodyToolChoice: undefined, normalized: true, downgraded: true, unsupportedForm: 'number', toolsUntouched: true }
  },
  {
    name: '未知对象 type',
    input: { toolChoice: { type: 'tool' }, tools: PIN_TOOLS },
    expect: { bodyToolChoice: 'auto', normalized: true, downgraded: true, unsupportedForm: 'tool', toolsUntouched: true }
  }
];

test('钉住工具的翻译不变量：任何形态都只发上游认的形态，且不静默丢钉选', () => {
  for (const row of TOOL_CHOICE_TABLE) {
    const label = row.name;
    const input = { messages: MESSAGES.slice() };
    if (Object.hasOwn(row.input, 'toolChoice')) input.tool_choice = row.input.toolChoice;
    if (Object.hasOwn(row.input, 'tools')) input.tools = row.input.tools;

    const adapted = adaptCodebuddyFamilyChatRequest(input);
    const body = adapted.body;
    const expect = row.expect;

    // ① 上游合法性：这两条是上游会 400 的硬约束，任何形态都不例外。
    assert.equal(body.stream, true, `${label}: stream 必须为 true`);
    assert.equal(adapted.streamed, true, `${label}: 已向上游要流`);
    if (Object.hasOwn(body, 'tool_choice')) {
      assert.equal(typeof body.tool_choice, 'string', `${label}: tool_choice 只能是字符串`);
      assert.ok(
        UPSTREAM_TOOL_CHOICE_STRINGS.includes(body.tool_choice),
        `${label}: ${body.tool_choice} 不在上游取值 ${UPSTREAM_TOOL_CHOICE_STRINGS.join('/')} 里`
      );
    }

    // ② 有损必留痕：降级必须说出原因，不允许「悄悄变弱」。
    if (adapted.toolChoiceDowngraded) {
      assert.ok(
        adapted.toolChoicePinMissing || adapted.toolChoiceUnsupportedForm,
        `${label}: 发生了降级却没给出原因`
      );
    }

    // ③ 钉选不静默丢失：客户端钉了谁，要么保住、要么显式报缺失。
    const expressed = pinNameFrom(row.input.toolChoice);
    if (expressed) {
      assert.equal(adapted.toolChoicePin, expressed, `${label}: 必须如实报出被钉的函数名`);
      assert.ok(
        adapted.toolChoicePinPreserved || adapted.toolChoicePinMissing,
        `${label}: 钉选既没保住也没报缺失（静默丢失）`
      );
    } else {
      assert.equal(adapted.toolChoicePin, undefined, `${label}: 没钉选就不该报 pin`);
      assert.equal(adapted.toolChoicePinPreserved, false, `${label}: 没钉选就不该报保住`);
    }

    // ④ 保住的钉选必须严格等价于「必须调用 X」：收窄到那一个 + required，且不再标记降级。
    if (adapted.toolChoicePinPreserved) {
      assert.equal(body.tool_choice, 'required', `${label}: 保住钉选必须配 required`);
      assert.equal(adapted.toolChoiceDowngraded, false, `${label}: 保住了就不是降级`);
      assert.deepEqual(
        body.tools.map((entry) => entry.function.name),
        [adapted.toolChoicePin],
        `${label}: tools 必须收窄到被钉的那一个`
      );
    }

    // ⑤ 不改写入参：调用方还要拿原始 tools / tool_choice 做日志，且 fixtures 必须保持干净。
    if (expect.toolsUntouched) {
      const sent = Object.hasOwn(body, 'tools') ? body.tools : null;
      assert.equal(sent, row.input.tools === undefined ? null : row.input.tools, `${label}: 不该改写客户端工具集`);
    }
    if (row.input.toolChoice && typeof row.input.toolChoice === 'object') {
      assert.equal(input.tool_choice, row.input.toolChoice, `${label}: 不得改写调用方传入的 tool_choice`);
    }
    assert.equal(JSON.stringify(PIN_TOOLS), PIN_TOOLS_SNAPSHOT, `${label}: 不得就地改写共享工具夹具`);

    // 行级期望：表格本身就是契约，逐项比对。
    assert.equal(adapted.toolChoiceNormalized, expect.normalized, `${label}: toolChoiceNormalized`);
    assert.equal(adapted.toolChoiceDowngraded, expect.downgraded === true, `${label}: toolChoiceDowngraded`);
    assert.equal(adapted.toolChoicePinPreserved, expect.pinPreserved === true, `${label}: pinPreserved`);
    assert.equal(adapted.toolChoicePinMissing, expect.pinMissing === true, `${label}: pinMissing`);
    assert.equal(adapted.toolChoiceUnsupportedForm, expect.unsupportedForm, `${label}: unsupportedForm`);
    assert.equal(body.tool_choice, expect.bodyToolChoice, `${label}: body.tool_choice`);
    if (expect.narrowedTools) {
      assert.deepEqual(
        body.tools.map((entry) => entry.function.name),
        expect.narrowedTools,
        `${label}: 收窄后的工具集`
      );
    }
  }
});

// ⑦ 与「钉住工具」同源的另一种有损：非流式客户端拿到 finish_reason='tool_calls' 却没有工具可执行，
// 表现成「模型回答为空」，与「模型真的没说话」无法区分。这条不变量锁住聚合层不许把它丢掉。
test('非流式聚合不变量：声称要调用工具就必须给出可执行的工具调用', () => {
  const cases = [
    {
      name: '标准 delta.tool_calls 分片',
      sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":""}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
        ''
      ].join('\n'),
      expect: { finishReason: 'tool_calls', names: ['get_weather'], arguments: ['{"city":"Paris"}'] }
    },
    {
      name: '并行调用按 index 排序',
      sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"get_time","arguments":"{}"}}]},"finish_reason":""}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
        ''
      ].join('\n'),
      expect: { finishReason: 'tool_calls', names: ['get_weather', 'get_time'], arguments: ['{}', '{}'] }
    },
    {
      name: '历史 function_call 形态',
      sse: [
        'data: {"choices":[{"delta":{"function_call":{"name":"get_weather","arguments":"{}"}},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
        ''
      ].join('\n'),
      expect: { finishReason: 'tool_calls', legacyName: 'get_weather' }
    }
  ];

  for (const item of cases) {
    const choice = aggregateCodebuddyFamilySse(item.sse).payload.choices[0];
    const message = choice.message;
    assert.equal(choice.finish_reason, item.expect.finishReason, `${item.name}: finish_reason`);
    if (item.expect.legacyName) {
      assert.equal(
        message.function_call && message.function_call.name,
        item.expect.legacyName,
        `${item.name}: legacy function_call`
      );
      continue;
    }
    assert.deepEqual(message.tool_calls.map((call) => call.function.name), item.expect.names, `${item.name}: 工具名`);
    assert.deepEqual(message.tool_calls.map((call) => call.function.arguments), item.expect.arguments, `${item.name}: 入参`);
  }

  // 反例守卫：空 tool_calls 不得凭空造出可执行的工具，也不得因此丢掉 finish_reason。
  const empty = aggregateCodebuddyFamilySse(
    'data: {"choices":[{"delta":{"content":"","tool_calls":[]},"finish_reason":"tool_calls"}]}\n'
  ).payload.choices[0];
  assert.equal(empty.finish_reason, 'tool_calls');
  assert.equal(empty.message.tool_calls, undefined);
});

// ⑥ 可观测：适配器的每个改写结论都必须在唯一调用点被 annotateAttempt 记进注解袋子。
// 没有这一条，②③ 只是「代码里知道」——排查时日志里查不到（历史教训：
// codebuddyFamilyInjectedSystemPrompt 曾只写在 attempt 上、从未进过任何日志行）。
test('钉住工具的改写结论必须全部进注解袋子（唯一调用点不漏项）', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'server', 'upstream-endpoints-transport-general.js'),
    'utf8'
  );
  const conclusions = [
    ['codebuddyFamilyInjectedSystemPrompt', 'injectedSystemPrompt'],
    ['codebuddyFamilyToolChoice', 'body.tool_choice'],
    ['codebuddyFamilyToolChoiceNormalized', 'toolChoiceNormalized'],
    ['codebuddyFamilyToolChoiceDowngraded', 'toolChoiceDowngraded'],
    ['codebuddyFamilyToolChoicePin', 'toolChoicePin'],
    ['codebuddyFamilyToolChoicePinPreserved', 'toolChoicePinPreserved'],
    ['codebuddyFamilyToolChoicePinMissing', 'toolChoicePinMissing'],
    ['codebuddyFamilyToolChoiceUnsupportedForm', 'toolChoiceUnsupportedForm']
  ];
  for (const [key, field] of conclusions) {
    assert.ok(
      source.includes(`annotateAttempt(attemptMutable, '${key}', adapted.${field})`),
      `${key} 没有从 adapted.${field} 记进注解袋子`
    );
  }
  // 收窄数量取自 body，且只在真的收窄时上报（保住钉选时 tools 一定存在，否则读 length 会抛）。
  assert.ok(
    source.includes('adapted.toolChoicePinPreserved ? adapted.body.tools.length : undefined'),
    'codebuddyFamilyToolChoiceNarrowedTools 必须由 pinPreserved 守卫'
  );
  // 适配器新增结论却没接线时，下面这条会失败（把「忘了记日志」变成测试失败而不是线上盲区）。
  const adapted = adaptCodebuddyFamilyChatRequest({
    messages: MESSAGES.slice(),
    tool_choice: pin('read_file'),
    tools: PIN_TOOLS
  });
  const returned = Object.keys(adapted).filter((key) => key !== 'body' && key !== 'streamed');
  for (const key of returned) {
    assert.ok(
      conclusions.some(([, field]) => field === key),
      `适配器新增的结论 ${key} 没有对应的注解键`
    );
  }
});

