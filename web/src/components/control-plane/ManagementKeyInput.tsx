import { useState } from 'react';
import { Button, Input, message } from 'antd';
import { ScanOutlined } from '@ant-design/icons';
import ManagementKeyQrScanner from './ManagementKeyQrScanner';
import type { ServerCredentialsQr } from '@/services/management-key-qr-reader';
import styles from './ManagementKeyQrScanner.module.css';

interface Props {
  value?: string;
  onChange?: (value: string) => void;
  onCredentials: (credentials: ServerCredentialsQr) => void;
  expectedEndpoint?: string;
  placeholder?: string;
}

/** Form.Item owns the credential value; the scanner only fills the draft. */
export default function ManagementKeyInput({ value, onChange, onCredentials, expectedEndpoint, placeholder = 'Management Key' }: Props) {
  const [scanning, setScanning] = useState(false);
  return (
    <div>
      <Input.Password value={value} onChange={(event) => onChange?.(event.target.value)}
        autoComplete="new-password" placeholder={placeholder} aria-label="Management Key" />
      <div className={styles.controls}>
        <Button icon={<ScanOutlined />} htmlType="button" onClick={() => setScanning(true)}>扫描二维码</Button>
      </div>
      {scanning && <ManagementKeyQrScanner expectedEndpoint={expectedEndpoint} onClose={() => setScanning(false)}
        onDecoded={(credentials) => {
          onChange?.(credentials.managementKey);
          onCredentials(credentials);
          setScanning(false);
          message.success('Server URL 和 Key 已填入，请确认后提交');
        }} />}
    </div>
  );
}
