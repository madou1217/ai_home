import { Input, List, Space, Typography, Upload } from 'antd';
import { DeleteOutlined, InboxOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { LOCAL_SOURCE_MAX_BYTES } from './aggregator-presentation';
import SourcePreviewSummary from './SourcePreviewSummary';
import { requestSourcePreview, type SourcePreviewState } from './use-source-preview';

const { Text } = Typography;

export interface ImportFileEntry extends SourcePreviewState {
  uid: string;
  fileName: string;
  /** 保存成本地订阅源时用的名称（默认取文件名） */
  name: string;
  content: string;
}

interface LocalFileImportProps {
  files: ImportFileEntry[];
  onChange: (update: (files: ImportFileEntry[]) => ImportFileEntry[]) => void;
}

const ACCEPT = '.yaml,.yml,.json,.jsonc,.conf,.txt,.list,.ini,.cfg,.sgmodule,.plist';

function sourceName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').trim().slice(0, 64) || fileName.slice(0, 64);
}

/** 只有能导入出节点的文件才会保存。 */
export function importableFiles(files: ImportFileEntry[]) {
  return files.filter((file) => (file.preview?.nodes.length || 0) > 0);
}

/**
 * 导入文件：拖入或选择多个文件，在浏览器里读出文本后逐个做解析预览；每个文件保存成一个本地订阅源。
 * 支持其它客户端导出的 YAML / JSON、WireGuard .conf、Surge / Loon / QX 配置和分享链接列表。
 */
export default function LocalFileImport({ files, onChange }: LocalFileImportProps) {
  const addFile = async (file: File & { uid?: string }) => {
    const uid = file.uid || `${file.name}-${file.size}-${file.lastModified}`;
    const entry: ImportFileEntry = { uid, fileName: file.name, name: sourceName(file.name), content: '', preview: null, loading: true, error: '' };
    onChange((current) => [...current.filter((item) => item.uid !== uid), entry]);
    const update = (patch: Partial<ImportFileEntry>) => onChange((current) => current.map((item) => (item.uid === uid ? { ...item, ...patch } : item)));
    if (file.size > LOCAL_SOURCE_MAX_BYTES) {
      update({ loading: false, error: '文件超过 2 MB' });
      return;
    }
    try {
      const content = await file.text();
      update({ content, ...(await requestSourcePreview(content)) });
    } catch (_readError) {
      update({ loading: false, error: '读取文件失败' });
    }
  };

  return (
    <>
      <Upload.Dragger
        multiple
        accept={ACCEPT}
        showUploadList={false}
        beforeUpload={(file) => {
          void addFile(file);
          return Upload.LIST_IGNORE;
        }}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">拖入文件，或点击选择（可多选）</p>
        <p className="ant-upload-hint">
          Clash / sing-box / v2rayN（Xray）/ Egern 导出的 YAML 或 JSON、WireGuard .conf、Surge / Loon / QX 配置、分享链接列表；每个文件存成一个本地订阅源。
        </p>
      </Upload.Dragger>
      {files.length > 0 && (
        <List
          dataSource={files}
          renderItem={(file) => (
            <List.Item
              actions={[
                <Button
                  key="remove"
                  type="text"
                  icon={<DeleteOutlined />}
                  aria-label={`移除 ${file.fileName}`}
                  disableDebounce
                  onClick={() => onChange((current) => current.filter((item) => item.uid !== file.uid))}
                />
              ]}
            >
              <List.Item.Meta
                title={(
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Text type="secondary" ellipsis>{file.fileName}</Text>
                    <Input
                      value={file.name}
                      maxLength={64}
                      onChange={(event) => onChange((current) => current.map((item) => (item.uid === file.uid ? { ...item, name: event.target.value } : item)))}
                      aria-label={`${file.fileName} 的订阅源名称`}
                      placeholder="订阅源名称"
                    />
                  </Space>
                )}
                description={<SourcePreviewSummary preview={file.preview} loading={file.loading} error={file.error} />}
              />
            </List.Item>
          )}
        />
      )}
    </>
  );
}
