import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { shouldRenderMarkdown } from './markdown-detection';
import styles from './chat.module.css';

interface Props {
  value: string;
  components?: any;
  inline?: boolean;
  className?: string;
  forceMarkdown?: boolean;
}

function MessageMarkdown({
  value,
  components,
  inline = false,
  className = '',
  forceMarkdown = false
}: Props) {
  const markdown = forceMarkdown || shouldRenderMarkdown(value);
  const classNames = [
    inline ? styles.messageMarkdownInline : styles.messageMarkdown,
    !markdown ? styles.messageMarkdownPlain : '',
    className
  ].filter(Boolean).join(' ');

  if (!markdown) {
    const Wrapper = inline ? 'span' : 'div';
    return <Wrapper className={classNames}>{value}</Wrapper>;
  }

  const markdownComponents = inline
    ? {
        ...components,
        p({ children, ...props }: any) {
          return <span {...props}>{children}</span>;
        }
      }
    : components;

  const MarkdownWrapper = inline ? 'span' : 'div';

  return (
    <MarkdownWrapper className={classNames}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {value}
      </ReactMarkdown>
    </MarkdownWrapper>
  );
}

export default memo(MessageMarkdown);
