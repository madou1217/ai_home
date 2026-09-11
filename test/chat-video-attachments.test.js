'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const limits = require('../contracts/chat-attachments.json');
const {
  appendVideoContextToPrompt,
  guessVideoMimeType,
  isVideoUpload,
  persistChatVideos,
  prepareChatVideo,
  readVideoFrameArtifacts,
  videoFramesDir,
  videoUploadFromDataUrl
} = require('../lib/server/chat-video-attachments');
const { sessionAttachmentTurnInput } = require('../lib/server/chat-runtime/chat-harness-policy');
const { resolveProviderAttachmentRoot } = require('../lib/runtime/provider-storage-policy');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-video-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('video mime guessing covers contract extensions and rejects others', () => {
  assert.equal(guessVideoMimeType('a/b.mp4'), 'video/mp4');
  assert.equal(guessVideoMimeType('a/b.MOV'), 'video/quicktime');
  assert.equal(guessVideoMimeType('a/b.webm'), 'video/webm');
  assert.equal(guessVideoMimeType('a/b.png'), '');
  assert.equal(isVideoUpload('video/mp4', 'anything.bin'), true);
  assert.equal(isVideoUpload('', 'clip.m4v'), true);
  assert.equal(isVideoUpload('application/zip', 'x.zip'), false);
});

test('videoUploadFromDataUrl splits videos out of the legacy base64 lane', () => {
  const upload = videoUploadFromDataUrl('data:video/quicktime;base64,YQ==', 2);
  assert.deepEqual(upload, {
    name: 'video-3.mov', mimeType: 'video/quicktime', dataUrl: 'data:video/quicktime;base64,YQ=='
  });
  assert.equal(videoUploadFromDataUrl('data:image/png;base64,YQ==', 0), null);
  assert.equal(videoUploadFromDataUrl('not-a-data-url', 0), null);
});

test('persistChatVideos writes binary payloads with safe names under the provider root', (t) => {
  const hostHomeDir = tempHome(t);
  const buffer = Buffer.from('mp4-binary-\u0001-content');
  const dataUrl = `data:video/mp4;base64,${buffer.toString('base64')}`;
  const [file] = persistChatVideos([{ name: '../../片段.mp4', mimeType: 'video/mp4', dataUrl }], {
    fs, provider: 'codex', hostHomeDir
  });
  assert.ok(path.basename(file).endsWith('片段.mp4'));
  assert.equal(path.dirname(file), resolveProviderAttachmentRoot(hostHomeDir, 'codex', path));
  assert.deepEqual(fs.readFileSync(file), buffer);
  assert.throws(() => persistChatVideos([{ name: 'x.mp4', mimeType: 'video/mp4', dataUrl: 'data:video/mp4;base64,' }]),
    /视频为空/);
});

test('prepareChatVideo probes metadata and extracts bounded key frames', async (t) => {
  const hostHomeDir = tempHome(t);
  const videoPath = path.join(hostHomeDir, 'clip.mp4');
  fs.writeFileSync(videoPath, Buffer.from('fake'));
  const calls = [];
  const execFileAsync = async (binary, args) => {
    calls.push({ binary, args });
    if (binary.endsWith('ffprobe')) {
      return { stdout: JSON.stringify({
        format: { duration: '24.04' },
        streams: [{ codec_type: 'video', width: 1280, height: 720 }]
      }) };
    }
    // Emulate ffmpeg materializing the requested frame pattern.
    const output = args[args.length - 1];
    for (const index of [1, 2, 3]) {
      fs.writeFileSync(output.replace('%02d', `0${index}`), `frame-${index}`);
    }
    return { stdout: '' };
  };
  const prepared = await prepareChatVideo(videoPath, {
    fs, ffmpegPath: '/tools/ffmpeg', ffprobePath: '/tools/ffprobe', execFileAsync
  });
  assert.equal(prepared.framesReady, true);
  assert.equal(prepared.frames.length, 3);
  assert.deepEqual(prepared.metadata, { durationSeconds: 24, width: 1280, height: 720 });
  const ffmpegArgs = calls.find((call) => call.binary.endsWith('ffmpeg')).args;
  assert.match(ffmpegArgs.join(' '), /fps=1\/3\.000/);
  assert.match(ffmpegArgs.join(' '), /frames:v 8/);
  const artifacts = readVideoFrameArtifacts(videoPath, fs);
  assert.equal(artifacts.frames.length, 3);
  assert.equal(artifacts.metadata.ready, true);
  assert.equal(artifacts.metadata.durationSeconds, 24);
});

test('prepareChatVideo degrades gracefully when ffmpeg is unavailable', async (t) => {
  const hostHomeDir = tempHome(t);
  const videoPath = path.join(hostHomeDir, 'clip.webm');
  fs.writeFileSync(videoPath, Buffer.from('fake'));
  const prepared = await prepareChatVideo(videoPath, {
    fs,
    ffmpegPath: path.join(hostHomeDir, 'no-ffmpeg'),
    ffprobePath: path.join(hostHomeDir, 'no-ffprobe'),
    execFileAsync: async () => { const error = new Error('spawn ENOENT'); error.code = 'ENOENT'; throw error; }
  });
  assert.equal(prepared.framesReady, false);
  assert.deepEqual(prepared.frames, []);
  const artifacts = readVideoFrameArtifacts(videoPath, fs);
  assert.equal(artifacts.framesReady, false);
});

test('failed extraction discards partial frames and history cannot replay them', async (t) => {
  const hostHomeDir = tempHome(t);
  const videoPath = path.join(hostHomeDir, 'clip.mp4');
  fs.writeFileSync(videoPath, Buffer.from('fake'));
  const prepared = await prepareChatVideo(videoPath, {
    fs,
    ffmpegPath: '/tools/ffmpeg',
    ffprobePath: '/tools/ffprobe',
    execFileAsync: async (binary, args) => {
      if (binary.endsWith('ffprobe')) return { stdout: JSON.stringify({ format: { duration: '2' } }) };
      const output = args.at(-1);
      fs.writeFileSync(output.replace('%02d', '01'), 'partial-frame');
      throw new Error('injected_ffmpeg_failure');
    }
  });

  assert.equal(prepared.framesReady, false);
  assert.deepEqual(prepared.frames, []);
  assert.equal(fs.existsSync(videoFramesDir(videoPath)), false);
  assert.deepEqual(readVideoFrameArtifacts(videoPath, fs), {
    frames: [], metadata: {}, framesReady: false
  });
});

test('history frame discovery requires the committed metadata manifest', (t) => {
  const hostHomeDir = tempHome(t);
  const videoPath = path.join(hostHomeDir, 'clip.mp4');
  const framesDir = videoFramesDir(videoPath);
  fs.writeFileSync(videoPath, 'video');
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(path.join(framesDir, 'frame-01.jpg'), 'orphan-frame');
  assert.equal(readVideoFrameArtifacts(videoPath, fs).framesReady, false);

  fs.writeFileSync(path.join(framesDir, 'metadata.json'), JSON.stringify({
    ready: true,
    frames: ['frame-01.jpg', '../escape.jpg', 'frame-02.jpg']
  }));
  const artifacts = readVideoFrameArtifacts(videoPath, fs);
  assert.equal(artifacts.framesReady, true);
  assert.deepEqual(artifacts.frames, [path.join(framesDir, 'frame-01.jpg')]);
});

test('appendVideoContextToPrompt adapts guidance to tool availability', () => {
  const work = appendVideoContextToPrompt('分析问题', [
    { path: '/v/a.mp4', metadata: { durationSeconds: 12.5, width: 1920, height: 1080 }, framesReady: true }
  ], { toolsAvailable: true });
  assert.match(work, /Attached video files:\n- \/v\/a\.mp4 \(12\.5s, 1920x1080\)/);
  assert.match(work, /attached as images/);
  assert.match(work, /ffmpeg/);
  assert.match(work, /^分析问题/);

  const chat = appendVideoContextToPrompt('', [
    { path: '/v/a.mp4', metadata: {}, framesReady: true }
  ], { toolsAvailable: false });
  assert.match(chat, /attached as images/);
  assert.doesNotMatch(chat, /extract additional frames/);

  const missing = appendVideoContextToPrompt('看', [
    { path: '/v/b.mp4', metadata: {}, framesReady: false }
  ], { toolsAvailable: true });
  assert.match(missing, /No key frames were pre-extracted/);
  assert.equal(appendVideoContextToPrompt('纯文本', []), '纯文本');
});

test('sessionAttachmentTurnInput routes images, video frames and documents per workspace mode', (t) => {
  const hostHomeDir = tempHome(t);
  const imagePath = path.join(hostHomeDir, 'shot.png');
  const videoPath = path.join(hostHomeDir, 'clip.mp4');
  const docPath = path.join(hostHomeDir, 'notes.md');
  fs.writeFileSync(imagePath, 'png');
  fs.writeFileSync(videoPath, 'mp4');
  fs.writeFileSync(docPath, '# 文档正文');
  fs.mkdirSync(videoFramesDir(videoPath), { recursive: true });
  fs.writeFileSync(path.join(videoFramesDir(videoPath), 'frame-01.jpg'), 'frame-a');
  fs.writeFileSync(path.join(videoFramesDir(videoPath), 'metadata.json'),
    JSON.stringify({ durationSeconds: 6, ready: true, frames: ['frame-01.jpg'] }));

  const work = sessionAttachmentTurnInput({ policy: {} }, '处理这些附件', [imagePath, videoPath, docPath], fs);
  assert.deepEqual(work.imagePaths, [imagePath, path.join(videoFramesDir(videoPath), 'frame-01.jpg')]);
  assert.match(work.prompt, /Attached document files:\n- /);
  assert.match(work.prompt, /Attached video files:\n- /);
  assert.match(work.prompt, /ffmpeg/);

  const chat = sessionAttachmentTurnInput(
    { policy: { workspaceMode: 'chat' } }, '看看', [videoPath, docPath], fs);
  assert.deepEqual(chat.imagePaths, [path.join(videoFramesDir(videoPath), 'frame-01.jpg')]);
  // chat 模式内联文档全文，绝不截断或丢内容
  assert.match(chat.prompt, /# 文档正文/);
  assert.match(chat.prompt, /附件 "notes.md"/);
  assert.doesNotMatch(chat.prompt, /extract additional frames/);
});

test('contract keeps videos inside the shared per-turn budget', () => {
  assert.ok(limits.maxVideoBytes <= limits.maxTotalBytes);
  assert.ok(limits.maxDocumentBytes > 1048576);
});
