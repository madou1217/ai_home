'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadCoordinator() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'session-request-coordinator.js'
  )).href;
  return import(modulePath);
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test('session request key isolates provider, session, project, resource and page', async () => {
  const { buildSessionRequestKey } = await loadCoordinator();
  const base = '/v0/webui/sessions/agy/session-1';

  assert.notEqual(
    buildSessionRequestKey(`${base}/events?cursor=10&projectDirName=project-a`),
    buildSessionRequestKey('/v0/webui/sessions/codex/session-1/events?cursor=10&projectDirName=project-a')
  );
  assert.notEqual(
    buildSessionRequestKey(`${base}/events?cursor=10&projectDirName=project-a`),
    buildSessionRequestKey('/v0/webui/sessions/agy/session-2/events?cursor=10&projectDirName=project-a')
  );
  assert.notEqual(
    buildSessionRequestKey(`${base}/events?cursor=10&projectDirName=project-a`),
    buildSessionRequestKey(`${base}/events?cursor=10&projectDirName=project-b`)
  );
  assert.notEqual(
    buildSessionRequestKey(`${base}/events?cursor=10&projectDirName=project-a`),
    buildSessionRequestKey(`${base}/events?cursor=11&projectDirName=project-a`)
  );
  assert.notEqual(
    buildSessionRequestKey(`${base}/messages?limit=50&projectDirName=project-a`),
    buildSessionRequestKey(`${base}/messages?before=50&limit=20&projectDirName=project-a`)
  );
  assert.notEqual(
    buildSessionRequestKey(`${base}/events?cursor=10&projectDirName=project-a`),
    buildSessionRequestKey(`${base}/messages?limit=50&projectDirName=project-a`)
  );
  assert.equal(
    buildSessionRequestKey(`${base}/events?cursor=10&projectDirName=project-a`),
    buildSessionRequestKey(`${base}/events?projectDirName=project-a&cursor=10`)
  );
  assert.equal(buildSessionRequestKey('/v0/webui/projects'), '');
});

test('single flight shares only an identical session request', async () => {
  const { SessionRequestCoordinator } = await loadCoordinator();
  const coordinator = new SessionRequestCoordinator();
  const gate = deferred();
  let calls = 0;
  const url = '/v0/webui/sessions/agy/session-1/messages?projectDirName=project-a&limit=50';
  const loader = async () => {
    calls += 1;
    await gate.promise;
    return 'history';
  };

  const first = coordinator.run(url, loader);
  const duplicate = coordinator.run(url, loader);

  assert.strictEqual(duplicate, first);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve();
  assert.equal(await first, 'history');
  assert.equal(await duplicate, 'history');
});

test('different event cursors and message pages complete without cancelling each other', async () => {
  const { SessionRequestCoordinator } = await loadCoordinator();
  const coordinator = new SessionRequestCoordinator();
  const olderEvent = deferred();
  const newerEvent = deferred();
  const messagePage = deferred();
  const base = '/v0/webui/sessions/agy/session-1';

  const older = coordinator.run(
    `${base}/events?cursor=22971&projectDirName=project-a`,
    () => olderEvent.promise
  );
  const newer = coordinator.run(
    `${base}/events?cursor=22972&projectDirName=project-a`,
    () => newerEvent.promise
  );
  const messages = coordinator.run(
    `${base}/messages?before=50&limit=20&projectDirName=project-a`,
    () => messagePage.promise
  );

  newerEvent.resolve('newer');
  messagePage.resolve('messages');
  olderEvent.resolve('older');

  assert.deepEqual(await Promise.all([older, newer, messages]), [
    'older',
    'newer',
    'messages',
  ]);
});
