/**
 * HarmonyOS 6 动态壁纸与色彩萃取引擎 (Dynamic Wallpaper & Palette Engine)
 * 支持用户自定义壁纸，并使用 Canvas 算法从图像中动态萃取 HarmonyOS 强调色与亚克力光晕
 */

export interface ExtractedPalette {
  dominantColor: string;
  auraGradient: string;
  glassBg: string;
  accentColor: string;
}

const WALLPAPER_STORAGE_KEY = 'aih_hos6_dynamic_wallpaper';

export class DynamicWallpaperEngine {
  public static getSavedWallpaper(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem(WALLPAPER_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  public static saveWallpaper(dataUrl: string): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(WALLPAPER_STORAGE_KEY, dataUrl);
      this.applyWallpaper(dataUrl);
    } catch (err) {
      console.warn('[WallpaperEngine] Failed to save wallpaper:', err);
    }
  }

  public static clearWallpaper(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(WALLPAPER_STORAGE_KEY);
      const root = document.documentElement;
      root.style.removeProperty('--hos-custom-wallpaper');
      root.style.removeProperty('--hos-custom-aura');
      root.style.removeProperty('--hos-custom-accent');
    } catch {}
  }

  public static applyWallpaper(dataUrl: string): void {
    if (typeof window === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--hos-custom-wallpaper', `url("${dataUrl}")`);
    
    // 异步萃取强调色
    this.extractPalette(dataUrl).then((palette) => {
      if (palette) {
        root.style.setProperty('--hos-custom-aura', palette.auraGradient);
        root.style.setProperty('--hos-custom-accent', palette.accentColor);
      }
    });
  }

  public static async extractPalette(imgSrc: string): Promise<ExtractedPalette | null> {
    if (typeof window === 'undefined') return null;

    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(null);
            return;
          }

          canvas.width = 64;
          canvas.height = 64;
          ctx.drawImage(img, 0, 0, 64, 64);

          const imageData = ctx.getImageData(0, 0, 64, 64);
          const data = imageData.data;

          let r = 0, g = 0, b = 0;
          let count = 0;

          for (let i = 0; i < data.length; i += 16) {
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count += 1;
          }

          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);

          const dominantColor = `rgb(${r}, ${g}, ${b})`;
          const accentColor = `rgb(${Math.min(255, r + 30)}, ${Math.min(255, g + 30)}, ${Math.min(255, b + 40)})`;
          const auraGradient = `radial-gradient(circle at 50% 0%, rgba(${r}, ${g}, ${b}, 0.22) 0%, rgba(${r}, ${g}, ${b}, 0.04) 55%, transparent 100%)`;
          const glassBg = `rgba(${r}, ${g}, ${b}, 0.75)`;

          resolve({
            dominantColor,
            auraGradient,
            glassBg,
            accentColor,
          });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = imgSrc;
    });
  }
}
