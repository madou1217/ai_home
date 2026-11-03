'use strict';

// 回归守卫：重启后把状态文件里的 running=true 归零。
//
// 旧实现只在任务自己结束时清 running；进程在任务中途重启（或上一次 task_timeout
// 后又被杀掉）时，状态文件里会留下 running=true。服务启动不修正它，runNow 会一直
// 返回 task_running —— 界面表现就是「计划任务卡住」，而且点立即执行也没反应。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScheduledTaskService } = require('../lib/server/scheduled-task-service');

test('启动时清理上一次进程留下的 running 残影', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-sched-stale-'));
  const dir = path.join(home, 'run', 'scheduled-tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    tasks: [{
      id: 'stask-stale',
      name: '领臭鸡蛋',
      eventId: 'activity:zcode:trial_plan',
      eventLabel: 'ZCODE · 领臭鸡蛋',
      eventParams: {},
      schedule: { kind: 'daily', at: '20:00' },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      lastRunAt: 0,
      lastStatus: '',
      lastSummary: '',
      running: true,
      nextRunAt: 0
    }],
    records: []
  }), 'utf8');

  const service = createScheduledTaskService({ fs, path, aiHomeDir: home });
  const listed = service.list();
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].running, false, '重启后不应保留 running=true');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(onDisk.tasks[0].running, false, '归零要落盘，而不只是内存视图');
});

