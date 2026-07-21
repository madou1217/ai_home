import type { BlockParser } from './types';
import { buildTagBlock, parseXmlBlock } from './xml-block';

function readTagValue(value: string, tagName: string) {
  const match = String(value || '').match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'i'));
  return match?.[1]?.trim() || '';
}

export const taskNotificationParser: BlockParser = {
  name: 'claude.task-notification',
  parse: (ctx) => {
    const parsed = parseXmlBlock({ ...ctx, tagName: 'task-notification' });
    if (!parsed) return null;
    const compactValue = JSON.stringify({
      taskId: readTagValue(parsed.value, 'task-id'),
      toolUseId: readTagValue(parsed.value, 'tool-use-id'),
      outputFile: readTagValue(parsed.value, 'output-file'),
      status: readTagValue(parsed.value, 'status'),
      summary: readTagValue(parsed.value, 'summary')
    });

    return {
      consumed: parsed.consumed,
      block: buildTagBlock('task-notification', compactValue)
    };
  }
};

export const taskNotificationParsers = [taskNotificationParser];
