import {
  parseManagementKeyQrPayload,
  type ServerCredentialsQr
} from '../../../lib/protocol/server-credentials-qr';

export type { ServerCredentialsQr };

/** Local decoder also works on Safari and HTTP pages without BarcodeDetector. */
export async function readManagementKeyQr(image: ImageData): Promise<ServerCredentialsQr | null> {
  const { default: decode } = await import('jsqr');
  const result = decode(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  return result ? parseManagementKeyQrPayload(result.data) : null;
}

export function captureQrImage(source: CanvasImageSource, width: number, height: number): ImageData {
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器无法读取图像，请更换浏览器后重试。');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export async function readManagementKeyQrFile(file: File): Promise<ServerCredentialsQr> {
  if (file.size > 20 * 1024 * 1024) throw new Error('请选择小于 20 MB 的二维码图片。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => { throw new Error('无法读取这张图片，请拍照或选择 PNG / JPEG 图片。'); });
    const credentials = await readManagementKeyQr(captureQrImage(image, image.naturalWidth, image.naturalHeight));
    if (!credentials) throw new Error('图片中没有识别到二维码，请使用清晰完整的二维码图片。');
    return credentials;
  } finally {
    URL.revokeObjectURL(url);
  }
}
