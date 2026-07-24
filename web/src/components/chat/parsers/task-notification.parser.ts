import type { BlockParser } from './types';
import { parseTaskNotification } from '../task-notification';
import { buildTagBlock, parseXmlBlock } from './xml-block';

export const taskNotificationParser: BlockParser = {
  name: 'claude.task-notification',
  parse: (ctx) => {
    const parsed = parseXmlBlock({ ...ctx, tagName: 'task-notification' });
    if (!parsed) return null;
    const compactValue = JSON.stringify(parseTaskNotification(parsed.value));

    return {
      consumed: parsed.consumed,
      block: buildTagBlock('task-notification', compactValue)
    };
  }
};

export const taskNotificationParsers = [taskNotificationParser];
