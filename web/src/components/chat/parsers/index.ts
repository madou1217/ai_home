import { commonParsers } from './common.parser';
import { codexParsers } from './codex.parser';
import { claudeParsers } from './claude.parser';
import { oaiMemParsers } from './oai-mem.parser';
import { taskNotificationParsers } from './task-notification.parser';
import type { BlockParser } from './types';

// The order matters: from most specific to generic.
export const registeredParsers: BlockParser[] = [
  ...codexParsers,
  ...claudeParsers,
  ...taskNotificationParsers,
  ...oaiMemParsers,
  ...commonParsers
];

export * from './types';
