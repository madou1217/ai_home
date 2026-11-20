import { useRef, useState } from 'react';
import { Button } from 'antd';
import { DeleteOutlined, EnterOutlined, SendOutlined } from '@ant-design/icons';
import type { SendBrowserCommand } from './browser-view-input';
import styles from './browser-view.module.css';

type Props = { disabled: boolean; send: SendBrowserCommand };
const maxTextBytes = 2048;

export default function BrowserTextComposer({ disabled, send }: Props) {
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState('');
  const composingRef = useRef(false);
  const textBytes = new TextEncoder().encode(text).length;
  const tooLong = textBytes > maxTextBytes;
  const invalid = text.includes('\0');

  const submit = () => {
    if (disabled || composingRef.current || !text || tooLong || invalid) return;
    if (send({ type: 'text', text })) {
      setText('');
      setError('');
    } else setError('文本未发送，请等待新画面或重新连接后手动重试。');
  };

  const sendKey = (key: 'Backspace' | 'Enter') => {
    if (disabled || composingRef.current) return;
    setError(send({ type: 'key', key }) ? '' : '按键未发送，请等待新画面或重新连接后手动重试。');
  };

  return <div className={styles.composer} role="group" aria-label="浏览器文字输入">
    <textarea className={styles.composerInput} aria-label="要发送到浏览器的完成文本" rows={2}
      value={text} disabled={disabled} maxLength={maxTextBytes} autoComplete="off" spellCheck={false}
      placeholder="先在画面中点选网页输入框，再在此输入中文或其他文本"
      onChange={(event) => { setText(event.currentTarget.value); setError(''); }}
      onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
      onCompositionEnd={() => { composingRef.current = false; setComposing(false); }} />
    <div className={styles.composerFooter}>
      <span className={styles.hint}>仅点击发送时提交完成文本；不提供选区替换或输入法透传。{textBytes} / {maxTextBytes} 字节</span>
      <div className={styles.composerActions}>
        <Button icon={<DeleteOutlined />} disabled={disabled || composing} onClick={() => sendKey('Backspace')} aria-label="向浏览器发送退格">退格</Button>
        <Button icon={<EnterOutlined />} disabled={disabled || composing} onClick={() => sendKey('Enter')} aria-label="向浏览器发送回车">回车</Button>
        <Button type="primary" icon={<SendOutlined />} disabled={disabled || composing || !text || tooLong || invalid} onClick={submit}>发送文本</Button>
      </div>
    </div>
    {tooLong || invalid || error ? <span className={styles.inputError} role="status">
      {tooLong ? '文本超过 2048 UTF-8 字节，请分段发送。' : invalid ? '文本不能包含空字符。' : error}
    </span> : null}
  </div>;
}
