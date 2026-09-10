import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComposerProps } from './Composer';
import { useComposerController } from './use-composer-controller';

const catalog = { models: [{ id: 'k3', label: 'K3', supportedEfforts: ['low', 'high', 'max'],
  defaultEffort: 'low' }], defaultModel: 'k3' };

function Probe(props: ComposerProps) {
  const composer = useComposerController(props);
  return <output>{composer.model}:{composer.reasoningEffort}</output>;
}

function render(effort: string, models = catalog, sessionId = 'kimi-session') {
  const projection = { sessionId, state: 'idle', policy: { reasoningEffort: effort } };
  const props = {
    catalog: models, selectedModel: 'k3', onModelChange() {},
    store: { getSnapshot: () => projection, subscribe: () => () => {} },
  } as unknown as ComposerProps;
  return renderToStaticMarkup(<Probe {...props} />);
}

test('composer remount restores saved Max instead of the K3 Low default', () => {
  assert.equal(render('max'), '<output>k3:max</output>');
  assert.equal(render('max'), '<output>k3:max</output>');
  assert.equal(render('low', catalog, 'other-session'), '<output>k3:low</output>');
});

test('empty catalog during reload cannot erase the stored effort', () => {
  assert.equal(render('max', { models: [], defaultModel: '' }), '<output>:</output>');
  assert.equal(render('max'), '<output>k3:max</output>');
  assert.equal(render('unsupported'), '<output>k3:low</output>');
});
