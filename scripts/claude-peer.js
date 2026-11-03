#!/usr/bin/env node
'use strict';

// Claude Code 跨会话消息的最小客户端（协议取证见
// docs/providers/claude-cross-session-protocol.md）。
//
// 实现已经收进 lib/cli/services/peer/adapters/claude-uds.js —— `aih peer` 用它当
// native 通道。这个脚本保留为「不装 aih 也能跑」的单文件入口和协议探针：
//   node scripts/claude-peer.js list
//   node scripts/claude-peer.js send <name|pid|sessionId> "文本" [--mode bypass] [--dry-run]

const adapter = require('../lib/cli/services/peer/adapters/claude-uds');

const { buildFrames, claudeConfigDir, envelope, findByTarget, listPeers, sendToPeer } = adapter;

function formatPeer(peer) {
  return [String(peer.pid).padStart(7), (peer.name || '-').padEnd(20), (peer.status || '-').padEnd(7), peer.socket].join('  ');
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'list') {
    const peers = await listPeers();
    if (!peers.length) {
      console.log('no live claude sessions with a messaging inbox found');
      return 0;
    }
    for (const peer of peers) console.log(formatPeer(peer));
    return 0;
  }
  if (command === 'send') {
    const target = rest.shift();
    const dryRun = rest.includes('--dry-run');
    const modeIndex = rest.indexOf('--mode');
    const mode = modeIndex >= 0 ? rest[modeIndex + 1] : '';
    const fromIndex = rest.indexOf('--from');
    const fromAddress = fromIndex >= 0 ? rest[fromIndex + 1] : '';
    const flagValueIndexes = new Set();
    if (modeIndex >= 0) flagValueIndexes.add(modeIndex + 1);
    if (fromIndex >= 0) flagValueIndexes.add(fromIndex + 1);
    const text = rest
      .filter((item, index) => item !== '--dry-run' && item !== '--mode' && item !== '--from' && !flagValueIndexes.has(index))
      .join(' ');
    if (!target || !text.trim()) {
      console.error('usage: claude-peer.js send <name|pid|sessionId> "text" [--mode bypass] [--from <address>] [--dry-run]');
      return 1;
    }
    const peers = await listPeers();
    const peer = findByTarget(peers, target);
    if (!peer) {
      console.error(`no live peer matched "${target}"`);
      return 1;
    }
    const result = await sendToPeer(peer, text, { mode, fromAddress, dryRun });
    if (result.dryRun) {
      process.stdout.write(result.frames.auth.replace(/[0-9a-f]{32}/, '<peerToken>'));
      process.stdout.write(result.frames.control);
      return 0;
    }
    console.log(`sent ${result.msgId} to ${peer.name || peer.pid}`);
    return 0;
  }
  console.error('usage: claude-peer.js [list | send ...]');
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(String(error && error.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildFrames,
  claudeConfigDir,
  envelope,
  findByTarget,
  listPeers,
  sendToPeer
};
