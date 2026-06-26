import { memo, useMemo } from 'react';
import { Image } from 'antd';
import { splitImageReferenceText, type ImageReferenceSegment, type ImageReferenceSource } from './image-reference-utils';
import MessageMarkdown from './MessageMarkdown';
import { shouldRenderMarkdown } from './markdown-detection';
import styles from './chat.module.css';

interface ImageGalleryProps {
  images: string[];
}

interface ImageReferenceContentProps {
  value: string;
  images: ImageReferenceSource[];
  mobile?: boolean;
  markdown?: boolean;
  markdownComponents?: any;
  presentation?: 'inline' | 'media';
  className?: string;
}

export const ImageGallery = memo(({ images }: ImageGalleryProps) => {
  if (!Array.isArray(images) || images.length === 0) return null;

  return (
    <Image.PreviewGroup items={images}>
      <div className={styles.imageGallery}>
        {images.map((src, index) => (
          <Image
            key={`${src}-${index}`}
            src={src}
            alt={`图片 ${index + 1}`}
            width={112}
            className={styles.imageGalleryImage}
          />
        ))}
      </div>
    </Image.PreviewGroup>
  );
});

ImageGallery.displayName = 'ImageGallery';

const ImageReferenceCard = ({
  segment,
  mobile = false,
  presentation = 'inline'
}: {
  segment: Extract<ImageReferenceSegment, { type: 'image_reference' }>;
  mobile?: boolean;
  presentation?: 'inline' | 'media';
}) => {
  const label = `图片 ${segment.imageNumber}`;
  const mediaMode = presentation === 'media';
  const imageKey = `${segment.src || 'missing'}-${segment.fallbackSrc || 'no-fallback'}`;
  const previewSrc = segment.src || segment.fallbackSrc || undefined;

  if (!segment.src) {
    return (
      <span
        className={[
          styles.imageReferenceMissing,
          mediaMode ? styles.imageReferenceMissingMedia : '',
          mobile ? styles.imageReferenceMissingMobile : ''
        ].filter(Boolean).join(' ')}
        title="图片数据未读取到"
        aria-label={`${label} 未读取到`}
      >
        图片未读取到
      </span>
    );
  }

  return (
    <span
      key={`${imageKey}-${segment.imageNumber}`}
      className={[
        styles.imageReferenceCard,
        mediaMode ? styles.imageReferenceCardMedia : '',
        mobile ? styles.imageReferenceCardMobile : ''
      ].filter(Boolean).join(' ')}
      title=""
      aria-label={label}
    >
      {/* AntD Image 会缓存加载错误状态；按真实图片源重建，并让预览优先使用文件媒体源。 */}
      <Image
        key={imageKey}
        src={segment.src}
        alt=""
        width={mediaMode ? (mobile ? 160 : 220) : (mobile ? 36 : 40)}
        className={[
          styles.imageReferenceThumb,
          mediaMode ? styles.imageReferenceThumbMedia : ''
        ].filter(Boolean).join(' ')}
        fallback={segment.fallbackSrc || undefined}
        preview={{ src: previewSrc, mask: null }}
      />
    </span>
  );
};

const TextSegment = ({
  value,
  markdown = false,
  markdownComponents
}: {
  value: string;
  markdown?: boolean;
  markdownComponents?: any;
}) => {
  if (!value) return null;

  if (markdown || shouldRenderMarkdown(value)) {
    return <MessageMarkdown value={value} components={markdownComponents} inline />;
  }

  return <span className={styles.imageReferencePlainText}>{value}</span>;
};

const ImageReferenceContent = ({
  value,
  images,
  mobile = false,
  markdown = false,
  markdownComponents,
  presentation = 'inline',
  className = ''
}: ImageReferenceContentProps) => {
  const segments = useMemo(() => splitImageReferenceText(value, images), [value, images]);
  const hasImageReferences = segments.some((segment) => segment.type === 'image_reference');
  const renderMarkdown = markdown || shouldRenderMarkdown(value);

  if (!hasImageReferences) {
    return <MessageMarkdown value={value} components={markdownComponents} forceMarkdown={renderMarkdown} />;
  }

  return (
    <span className={[
      styles.imageReferenceFlow,
      presentation === 'media' ? styles.imageReferenceFlowMedia : '',
      className
    ].filter(Boolean).join(' ')}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return (
            <TextSegment
              key={`text-${index}`}
              value={segment.value}
              markdown={renderMarkdown}
              markdownComponents={markdownComponents}
            />
          );
        }

        return (
          <ImageReferenceCard
            key={`image-${segment.imageNumber}-${index}`}
            segment={segment}
            mobile={mobile}
            presentation={presentation}
          />
        );
      })}
    </span>
  );
};

export default memo(ImageReferenceContent);
