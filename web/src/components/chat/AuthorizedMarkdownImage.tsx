import { memo, type ImgHTMLAttributes } from 'react';
import { useAuthorizedMediaUrl } from '@/hooks/useAuthorizedMediaUrl';

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  source: string;
}

function AuthorizedMarkdownImage({ source, alt, ...props }: Props) {
  const media = useAuthorizedMediaUrl(source);
  if (!media.url) return null;

  return <img {...props} src={media.url} alt={alt || ''} />;
}

export default memo(AuthorizedMarkdownImage);
