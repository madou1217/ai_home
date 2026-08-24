'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const apiPath = path.join(projectRoot, 'web/src/services/api.ts');
const routesPath = path.join(projectRoot, 'web/config/routes.ts');
const serverRoutePath = path.join(projectRoot, 'lib/server/webui-image-studio-routes.js');
const modelCatalogPath = path.join(projectRoot, 'lib/server/image-studio-model-catalog.js');
const composerPath = path.join(projectRoot, 'web/src/features/image-studio/ImageStudioComposer.tsx');
const workspacePath = path.join(projectRoot, 'web/src/features/image-studio/ImageStudioWorkspace.tsx');
const canvasPath = path.join(projectRoot, 'web/src/features/image-studio/ImageStudioCanvas.tsx');
const typesPath = path.join(projectRoot, 'web/src/types/index.ts');

test('image Studio model route stays aligned across WebUI API, server route and page navigation', () => {
  const apiSource = fs.readFileSync(apiPath, 'utf8');
  const routesSource = fs.readFileSync(routesPath, 'utf8');
  const serverSource = fs.readFileSync(serverRoutePath, 'utf8');
  const modelCatalogSource = fs.readFileSync(modelCatalogPath, 'utf8');

  assert.match(routesSource, /path:\s*["']\/studio\/image["']/);
  assert.match(apiSource, /\/webui\/studio\/image\/models/);
  assert.match(serverSource, /IMAGE_STUDIO_BASE_PATH\}\/models/);
  assert.match(serverSource, /availableAccountCount/);
  assert.match(modelCatalogSource, /unavailableReasons/);
});

test('image Studio exposes account availability and revised prompts without forbidden alert blocks', () => {
  const composerSource = fs.readFileSync(composerPath, 'utf8');
  const canvasSource = fs.readFileSync(canvasPath, 'utf8');
  const typesSource = fs.readFileSync(typesPath, 'utf8');

  assert.match(typesSource, /unavailableReasons\?:\s*Array/);
  assert.match(typesSource, /qualityOptions\?:\s*string\[\]/);
  assert.match(typesSource, /maxInputImages:\s*number/);
  assert.match(typesSource, /sourceAssetIds:\s*string\[\]/);
  assert.match(typesSource, /outputCompression:\s*number\s*\|\s*null/);
  assert.match(typesSource, /revisedPrompt\?:\s*string/);
  assert.match(composerSource, /formatImageStudioModelAvailability/);
  assert.match(composerSource, /availableAccountCount\s*<\s*1/);
  assert.match(composerSource, /accept="image\/png"/);
  assert.match(composerSource, /multiple/);
  assert.match(composerSource, /OUTPUT_COUNT_OPTIONS\s*=\s*Array\.from\(\{\s*length:\s*10\s*\}/);
  assert.match(composerSource, /outputFormat/);
  assert.match(composerSource, /background/);
  assert.match(canvasSource, /selectedAsset\?\.revisedPrompt/);
  assert.match(canvasSource, /onReuseRevision/);
  for (const source of [composerSource, canvasSource]) {
    assert.doesNotMatch(source, /\bAlert\b|borderLeft|border-left/);
  }
});

test('image Studio workspace wires ordered references and output controls without legacy single-image state', () => {
  const workspaceSource = fs.readFileSync(workspacePath, 'utf8');

  assert.match(workspaceSource, /const handleSourceFiles = async \(files: File\[\]\)/);
  assert.match(workspaceSource, /const handleMaskFile = async \(file: File\)/);
  assert.match(workspaceSource, /sources:\s*sourceSelections\.map/);
  assert.match(workspaceSource, /sources=\{sourcePreviews\}/);
  assert.match(workspaceSource, /sourceLimit=\{sourceLimit\}/);
  assert.match(workspaceSource, /background=\{background\}/);
  assert.match(workspaceSource, /outputFormat=\{outputFormat\}/);
  assert.match(workspaceSource, /outputCompression=\{outputCompression\}/);
  assert.match(workspaceSource, /moderation=\{moderation\}/);
  assert.doesNotMatch(workspaceSource, /\bsourceAssetId\b|\bsourceImage\b|setSourceAssetId|setSourceUpload/);
});
