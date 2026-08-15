import { Alert, Modal, QRCode, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { ProxyNode } from '@/types';
import { copyText } from './proxy-pool-utils';

const { Text, Title } = Typography;

interface ProxyShareModalProps {
  open: boolean;
  node: ProxyNode | null;
  onClose: () => void;
}

export default function ProxyShareModal({ open, node, onClose }: ProxyShareModalProps) {
  return (
    <Modal title="节点分享二维码" open={open} onCancel={onClose} footer={null}>
      {node?.rawUri ? (
        <div className="proxy-share-content">
          <Title level={4}>{node.countryFlag || '🌐'} {node.name}</Title>
          <QRCode value={node.rawUri} size={220} bordered />
          <Text code copyable={false}>{node.rawUri}</Text>
          <Button
            type="primary"
            icon={<CopyOutlined />}
            onClick={() => void copyText(node.rawUri || '', '分享链接已复制')}
          >
            复制分享链接
          </Button>
        </div>
      ) : (
        <Alert type="warning" showIcon message="该节点没有可逆的原始分享链接，无法生成可信二维码" />
      )}
    </Modal>
  );
}
