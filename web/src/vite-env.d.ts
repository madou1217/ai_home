/// <reference types="vite/client" />

declare module '*.svg' {
  const content: string;
  export default content;
}

declare module '*.png' {
  const content: string;
  export default content;
}

declare module '*.jpg' {
  const content: string;
  export default content;
}

declare module '*.jpeg' {
  const content: string;
  export default content;
}

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// react-file-icon 当前 npm 包不随包发布 d.ts，这里只声明 WebUI 实际用到的窄接口。
declare module 'react-file-icon' {
  import type { ComponentType } from 'react';

  export type ReactFileIconType =
    | '3d'
    | 'acrobat'
    | 'android'
    | 'audio'
    | 'binary'
    | 'code'
    | 'code2'
    | 'compressed'
    | 'document'
    | 'drive'
    | 'font'
    | 'image'
    | 'presentation'
    | 'settings'
    | 'spreadsheet'
    | 'vector'
    | 'video';

  export interface ReactFileIconProps {
    color?: string;
    extension?: string;
    fold?: boolean;
    foldColor?: string;
    glyphColor?: string;
    gradientColor?: string;
    gradientOpacity?: number;
    labelColor?: string;
    labelTextColor?: string;
    labelUppercase?: boolean;
    radius?: number;
    type?: ReactFileIconType;
  }

  export const FileIcon: ComponentType<ReactFileIconProps>;
  export const defaultStyles: Record<string, ReactFileIconProps>;
}
