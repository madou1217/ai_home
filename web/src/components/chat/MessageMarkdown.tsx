import { Children, isValidElement, memo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseMarkdownCarouselSlides } from './file-preview-utils';
import { shouldRenderMarkdown } from './markdown-detection';
import styles from './chat.module.css';

// react-markdown 默认只放行 http(s)/mailto 等协议，会把 data: URL 的 src 剥成空，
// 导致图像生成模型(如 gemini-3.1-flash-image)透出的内联 base64 图片渲染成裂图。
// 额外放行 data:image/；file:// 也放行——provider CLI 用 file:///abs/path 引用生成
// 文件，默认清洗把 href/src 剥成空串，上层 a/img 组件（右侧预览、fs/media 重写）就
// 永远收不到原始地址（表现为"点击文件链接开了个空白新窗口"）。其余仍走默认清洗。
function urlTransformAllowInlineImage(url: string, key: string): string {
  if (key === 'src' && /^data:image\//i.test(url)) return url;
  if (/^file:\/\//i.test(url)) return url;
  return defaultUrlTransform(url);
}

interface Props {
  value: string;
  components?: any;
  inline?: boolean;
  className?: string;
  forceMarkdown?: boolean;
}

function resolveCarouselSlides(children: ReactNode) {
  const nodes = Children.toArray(children);
  if (nodes.length !== 1 || !isValidElement(nodes[0])) return [];
  const codeNode = nodes[0] as ReactElement<{
    className?: string;
    children?: ReactNode;
  }>;
  const language = String(codeNode.props.className || '').match(/(?:^|\s)language-([^\s]+)/)?.[1] || '';
  return parseMarkdownCarouselSlides(language, String(codeNode.props.children || ''));
}

function MarkdownCarousel({ slides, components }: { slides: string[]; components?: any }) {
  return (
    <div className={styles.markdownCarousel} role="region" aria-label={`图片轮播，共 ${slides.length} 张`}>
      {slides.map((slide, index) => (
        <div
          key={`${index}-${slide.slice(0, 80)}`}
          className={styles.markdownCarouselSlide}
          role="group"
          aria-label={`第 ${index + 1} 张，共 ${slides.length} 张`}
        >
          <MessageMarkdown value={slide} components={components} forceMarkdown />
        </div>
      ))}
    </div>
  );
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
    : {
        ...components,
        pre({ children, ...props }: any) {
          const slides = resolveCarouselSlides(children);
          if (slides.length > 0) {
            return <MarkdownCarousel slides={slides} components={components} />;
          }
          const ExternalPre = components && components.pre;
          return ExternalPre
            ? <ExternalPre {...props}>{children}</ExternalPre>
            : <pre {...props}>{children}</pre>;
        }
      };

  const MarkdownWrapper = inline ? 'span' : 'div';

  return (
    <MarkdownWrapper className={classNames}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={urlTransformAllowInlineImage}
      >
        {value}
      </ReactMarkdown>
    </MarkdownWrapper>
  );
}

export default memo(MessageMarkdown);
