import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Typography } from 'antd';
import { CameraOutlined, PictureOutlined } from '@ant-design/icons';
import {
  captureQrImage,
  readManagementKeyQr,
  readManagementKeyQrFile,
  type ServerCredentialsQr
} from '@/services/management-key-qr-reader';
import { normalizeEndpoint } from '../../../../lib/protocol/server-credentials-qr';
import styles from './ManagementKeyQrScanner.module.css';

interface Props {
  onClose: () => void;
  onDecoded: (credentials: ServerCredentialsQr) => void;
  expectedEndpoint?: string;
}

export default function ManagementKeyQrScanner(props: Props) {
  const [note, setNote] = useState('正在开启摄像头…');
  const [reading, setReading] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const cameraFile = useRef<HTMLInputElement>(null);
  const galleryFile = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);
  const latest = useRef(props);
  latest.current = props;

  const stop = useCallback(() => {
    generation.current += 1;
    clearTimeout(timer.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  const accept = useCallback((credentials: ServerCredentialsQr) => {
    const expected = latest.current.expectedEndpoint;
    if (expected && normalizeEndpoint(expected) !== credentials.endpoint) {
      throw new Error('二维码的 Server URL 与正在编辑的 Server 不一致。请为该 Server 扫码，或通过“添加 Server”连接另一台。');
    }
    stop();
    latest.current.onDecoded(credentials);
  }, [stop]);

  const startCamera = useCallback(async () => {
    stop();
    const current = generation.current;
    setCameraActive(false);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNote('当前页面无法使用实时摄像头。可点“拍照”或“从相册识别”；HTTPS 页面支持实时扫描。');
      return;
    }
    setNote('将终端上的完整二维码放入取景框。');
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (current !== generation.current) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = acquired;
      const element = video.current;
      if (!element) { stop(); return; }
      element.srcObject = acquired;
      await element.play();
      if (current !== generation.current) return;
      setCameraActive(true);
      const scan = async () => {
        if (current !== generation.current) return;
        try {
          if (element.readyState >= 2 && element.videoWidth) {
            const credentials = await readManagementKeyQr(captureQrImage(element, element.videoWidth, element.videoHeight));
            if (current !== generation.current) return;
            if (credentials) { accept(credentials); return; }
          }
          timer.current = setTimeout(() => void scan(), 250);
        } catch (error) {
          if (current !== generation.current) return;
          stop();
          setCameraActive(false);
          setNote(error instanceof Error ? error.message : '识别失败，请重新扫描。');
        }
      };
      void scan();
    } catch (error) {
      if (current !== generation.current) return;
      stop();
      const name = (error as { name?: string })?.name;
      setNote(name === 'NotAllowedError'
        ? '摄像头权限未开启。请允许访问后重试，也可拍照或从相册识别。'
        : '无法开启摄像头。请检查相机是否被占用，或拍照 / 从相册识别。');
    }
  }, [accept, stop]);

  useEffect(() => {
    void startCamera();
    return stop;
  }, [startCamera, stop]);

  const readFile = async (file?: File) => {
    if (!file) return;
    stop();
    setCameraActive(false);
    setReading(true);
    const current = generation.current;
    try {
      const credentials = await readManagementKeyQrFile(file);
      if (current === generation.current) accept(credentials);
    } catch (error) {
      if (current === generation.current) setNote(error instanceof Error ? error.message : '图片识别失败。');
    } finally {
      if (current === generation.current) setReading(false);
    }
  };

  const close = () => { stop(); latest.current.onClose(); };
  return (
    <Modal open title="扫描 Server 凭据二维码" onCancel={close} footer={null} width={440} destroyOnHidden>
      <video ref={video} className={styles.video} autoPlay playsInline muted aria-label="二维码取景框" />
      <Typography.Text className={styles.note} role="status" aria-live="polite">{note}</Typography.Text>
      <div className={styles.controls}>
        {!cameraActive && <Button disabled={reading} onClick={() => void startCamera()}>开启摄像头</Button>}
        <Button icon={<CameraOutlined />} loading={reading} onClick={() => cameraFile.current?.click()}>拍照</Button>
        <Button icon={<PictureOutlined />} loading={reading} onClick={() => galleryFile.current?.click()}>从相册识别</Button>
        <Button type="text" onClick={close}>关闭并手动输入</Button>
      </div>
      <input ref={cameraFile} type="file" accept="image/*" capture="environment" className={styles.file}
        onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
      <input ref={galleryFile} type="file" accept="image/*" className={styles.file}
        onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
      <Typography.Text type="secondary" className={styles.note}>
        在 Server 终端运行 aih server config show --show-secrets --qr。识别在本机完成，填入地址和 Key 后请确认并提交。
      </Typography.Text>
    </Modal>
  );
}
