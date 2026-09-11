'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const limits = require('../../contracts/chat-attachments.json');
const { resolveProviderAttachmentRootDir } = require('./chat-attachments');
const { ensureDirSync } = require('./fs-compat');
const {
  attachmentMimeTypeFromPath,
  ATTACHMENT_KINDS,
  normalizeChatUpload
} = require('./chat-attachment-validation');
const {
  VIDEO_FRAME_DIR_SUFFIX,
  atomicWriteFileSync,
  cleanupPersistedAttachments,
  removePathBestEffort
} = require('./chat-attachment-filesystem');

// Videos are pre-processed at upload time: ffprobe metadata + a bounded set of
// scaled key frames. Frames ride the existing image channel at turn time, so
// every harness/provider that can see images can analyze video content without
// native video-input support. The original file path is always included in the
// prompt so tool-capable (work) sessions can dig deeper themselves.
const MAX_VIDEO_FRAMES = 8;
const FRAME_EDGE_LIMIT = 768;
const VIDEO_TOOL_TIMEOUT_MS = 30000;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_chat_video', statusCode: 400 });
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function guessVideoMimeType(filePath) {
  const mimeType = attachmentMimeTypeFromPath(filePath);
  return mimeType.startsWith('video/') ? mimeType : '';
}

function normalizeVideoMimeType(mimeType, name) {
  const mime = normalizeString(mimeType).toLowerCase();
  if (limits.videoTypes.includes(mime)) return mime;
  return guessVideoMimeType(name);
}

function isVideoUpload(mimeType, name) {
  return Boolean(normalizeVideoMimeType(mimeType, name));
}

// Legacy chat lane carries every upload as a bare base64 dataUrl without a file
// name; split videos out of that lane by their declared MIME type.
function videoUploadFromDataUrl(dataUrl, index = 0) {
  const match = normalizeString(dataUrl).match(/^data:([^;,]+);base64,/);
  const mimeType = match ? match[1].toLowerCase() : '';
  if (!limits.videoTypes.includes(mimeType)) return null;
  const extension = Object.keys(limits.videoExtensionTypes)
    .find((key) => limits.videoExtensionTypes[key] === mimeType) || 'mp4';
  return { name: `video-${index + 1}.${extension}`, mimeType, dataUrl: normalizeString(dataUrl) };
}

function parseDataUrlVideo(upload) {
  try {
    const normalized = normalizeChatUpload(upload);
    if (normalized.kind !== ATTACHMENT_KINDS.VIDEO) throw new Error('视频附件类型无效');
    return { mimeType: normalized.mimeType, buffer: normalized.buffer };
  } catch (error) {
    throw invalid(error.message);
  }
}

function persistChatVideos(videos, options) {
  const list = Array.isArray(videos) ? videos : [];
  if (!list.length) return [];
  // Validate every upload (encoding, size, non-empty) before touching the disk.
  const parsedList = list.map((upload) => {
    const name = normalizeString(upload && upload.name) || 'video.mp4';
    return { name, parsed: parseDataUrlVideo({ ...upload, name }) };
  });
  const root = resolveProviderAttachmentRootDir(options.fs, options);
  ensureDirSync(options.fs, root);
  const filePaths = [];
  try {
    parsedList.forEach(({ name, parsed }) => {
      // Preserve readable names without letting uploaded paths escape the attachment root.
      let safeName = name.replace(/[/\\\x00-\x1f]/g, '_').slice(-160) || 'video.mp4';
      if (!guessVideoMimeType(safeName)) safeName += '.mp4';
      const filePath = path.join(root, `${crypto.randomUUID()}-${safeName}`);
      atomicWriteFileSync(options.fs, filePath, parsed.buffer, { mode: 0o600 });
      filePaths.push(filePath);
    });
    return filePaths;
  } catch (error) {
    cleanupPersistedAttachments(options.fs, filePaths);
    throw error;
  }
}

function videoFramesDir(filePath) {
  return `${filePath}${VIDEO_FRAME_DIR_SUFFIX}`;
}

function resolveToolBinary(binaryName, envValue, fsImpl) {
  const explicit = normalizeString(envValue);
  if (explicit && fsImpl.existsSync(explicit)) return explicit;
  // Absolute candidates first: the server may run under launchd/systemd where
  // PATH does not include the user's package-manager bin directory.
  for (const candidate of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const candidatePath = path.join(candidate, binaryName);
    if (fsImpl.existsSync(candidatePath)) return candidatePath;
  }
  return binaryName;
}

async function runTool(deps, binary, args) {
  const execFileAsync = deps.execFileAsync || defaultExecFileAsync;
  return execFileAsync(binary, args, { timeout: VIDEO_TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
}

function defaultExecFileAsync(binary, args, options) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function probeVideoMetadata(filePath, deps) {
  const ffprobe = resolveToolBinary('ffprobe', deps.ffprobePath || process.env.AIH_FFPROBE, deps.fs);
  const { stdout } = await runTool(deps, ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath
  ]);
  const parsed = JSON.parse(String(stdout || '{}'));
  const videoStream = (Array.isArray(parsed.streams) ? parsed.streams : [])
    .find((stream) => stream && stream.codec_type === 'video');
  const durationSeconds = Number(parsed.format && parsed.format.duration);
  return {
    ...(Number.isFinite(durationSeconds) && durationSeconds > 0
      ? { durationSeconds: Math.round(durationSeconds * 10) / 10 } : {}),
    ...(videoStream && Number(videoStream.width) > 0 ? { width: Number(videoStream.width) } : {}),
    ...(videoStream && Number(videoStream.height) > 0 ? { height: Number(videoStream.height) } : {})
  };
}

async function extractVideoFrames(filePath, metadata, deps, framesDir) {
  const ffmpeg = resolveToolBinary('ffmpeg', deps.ffmpegPath || process.env.AIH_FFMPEG, deps.fs);
  deps.fs.mkdirSync(framesDir, { recursive: true, mode: 0o700 });
  const duration = Number(metadata && metadata.durationSeconds) || 0;
  const filters = [`scale='min(${FRAME_EDGE_LIMIT},iw)':-2`];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath];
  if (duration > 0) {
    // Evenly spaced frames, at most one per second and MAX_VIDEO_FRAMES overall.
    const interval = Math.max(1, duration / MAX_VIDEO_FRAMES);
    args.push('-vf', `fps=1/${interval.toFixed(3)},${filters.join(',')}`, '-frames:v', String(MAX_VIDEO_FRAMES));
  } else {
    args.push('-vf', filters.join(','), '-frames:v', '1');
  }
  args.push(path.join(framesDir, 'frame-%02d.jpg'));
  await runTool(deps, ffmpeg, args);
  return listVideoFrames(framesDir, deps.fs);
}

function listVideoFrames(framesDir, fsImpl) {
  try {
    return fsImpl.readdirSync(framesDir)
      .filter((entry) => /^frame-\d+\.jpg$/.test(entry))
      .sort()
      .map((entry) => path.join(framesDir, entry));
  } catch (_error) {
    return [];
  }
}

async function prepareChatVideo(filePath, options = {}) {
  const deps = { ...options, fs: options.fs || require('node:fs') };
  const finalFramesDir = videoFramesDir(filePath);
  const stagingFramesDir = `${finalFramesDir}.${crypto.randomUUID()}.tmp`;
  let metadata = {};
  let frames = [];
  let framesReady = false;
  try {
    metadata = await probeVideoMetadata(filePath, deps);
    const stagedFrames = await extractVideoFrames(filePath, metadata, deps, stagingFramesDir);
    framesReady = stagedFrames.length > 0;
    const record = {
      ...metadata,
      frames: stagedFrames.map((frame) => path.basename(frame)),
      ready: framesReady
    };
    atomicWriteFileSync(
      deps.fs,
      path.join(stagingFramesDir, 'metadata.json'),
      JSON.stringify(record),
      { mode: 0o600 }
    );
    removePathBestEffort(deps.fs, finalFramesDir, true);
    deps.fs.renameSync(stagingFramesDir, finalFramesDir);
    frames = listVideoFrames(finalFramesDir, deps.fs);
    framesReady = frames.length > 0;
  } catch (_error) {
    // Extraction is best-effort. Never expose a partial frame set as a valid
    // history artifact; the original video path remains available in Work.
    removePathBestEffort(deps.fs, stagingFramesDir, true);
    removePathBestEffort(deps.fs, finalFramesDir, true);
    frames = [];
    framesReady = false;
  }
  return { filePath, frames, metadata, framesReady };
}

function readVideoFrameArtifacts(filePath, fsImpl) {
  const fs = fsImpl || require('node:fs');
  const framesDir = videoFramesDir(filePath);
  let metadata = {};
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(framesDir, 'metadata.json'), 'utf8'));
  } catch (_error) { /* sidecar optional */ }
  if (metadata.ready !== true || !Array.isArray(metadata.frames)) {
    return { frames: [], metadata, framesReady: false };
  }
  const available = new Set(listVideoFrames(framesDir, fs).map((frame) => path.basename(frame)));
  const frames = metadata.frames
    .filter((entry) => typeof entry === 'string' && /^frame-\d+\.jpg$/.test(entry) && available.has(entry))
    .map((entry) => path.join(framesDir, entry));
  return { frames, metadata, framesReady: frames.length > 0 };
}

function formatVideoMetadata(metadata) {
  const parts = [];
  if (Number(metadata && metadata.durationSeconds) > 0) parts.push(`${metadata.durationSeconds}s`);
  if (Number(metadata && metadata.width) > 0 && Number(metadata && metadata.height) > 0) {
    parts.push(`${metadata.width}x${metadata.height}`);
  }
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function appendVideoContextToPrompt(prompt, videos, options = {}) {
  const list = (Array.isArray(videos) ? videos : []).filter((video) => video && video.path);
  if (!list.length) return prompt;
  const toolsAvailable = options.toolsAvailable !== false;
  const lines = ['Attached video files:'];
  for (const video of list) {
    lines.push(`- ${video.path}${formatVideoMetadata(video.metadata)}`);
  }
  if (list.every((video) => video.framesReady)) {
    lines.push(`Key frames extracted from each video are attached as images; analyze the video content from these frames.${
      toolsAvailable
        ? ' If you need more detail, extract additional frames or audio from the video file directly (for example with ffmpeg).'
        : ''}`);
  } else {
    lines.push(toolsAvailable
      ? 'No key frames were pre-extracted for some videos; read or extract frames from the video file directly (for example with ffmpeg) before analyzing.'
      : 'No key frames could be pre-extracted for some videos, so their content may not be visible in this session.');
  }
  return [String(prompt || '').trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

module.exports = {
  MAX_VIDEO_FRAMES,
  appendVideoContextToPrompt,
  guessVideoMimeType,
  isVideoUpload,
  normalizeVideoMimeType,
  persistChatVideos,
  prepareChatVideo,
  readVideoFrameArtifacts,
  videoFramesDir,
  videoUploadFromDataUrl
};
