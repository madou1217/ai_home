import { memo, useState, useRef, useCallback } from 'react';
import {
  PlayCircleFilled,
  PauseCircleFilled,
  FullscreenOutlined,
  FullscreenExitOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import styles from './message-bubble.module.css';

export interface VideoPlayerCardProps {
  src: string;
  poster?: string;
  title?: string;
  duration?: number;
}

/**
 * HarmonyOS 6 风格多模态视频播放卡片
 * 具备超级曲率圆角、悬浮毛玻璃控制胶囊与画中画全屏交互
 */
export const VideoPlayerCard = memo(function VideoPlayerCard({
  src,
  poster,
  title = '视频内容',
}: VideoPlayerCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  }, [isPlaying]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || Number.isNaN(video.duration)) return;
    setProgress((video.currentTime / video.duration) * 100);
  }, []);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    setProgress(0);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  return (
    <div ref={containerRef} className={styles.videoPlayerCard}>
      <div className={styles.videoHeader}>
        <span className={styles.videoTitle}>
          <VideoCameraOutlined /> {title}
        </span>
      </div>

      <div className={styles.videoCanvasWrap} onClick={togglePlay}>
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          className={styles.videoElement}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
          playsInline
        />
        {!isPlaying ? (
          <div className={styles.videoPlayOverlay}>
            <button type="button" className={styles.videoBigPlayBtn} aria-label="播放视频">
              <PlayCircleFilled />
            </button>
          </div>
        ) : null}
      </div>

      <div className={styles.videoControlBar}>
        <button
          type="button"
          className={styles.videoControlBtn}
          onClick={togglePlay}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <PauseCircleFilled /> : <PlayCircleFilled />}
        </button>

        <div className={styles.videoTrack}>
          <div className={styles.videoTrackFill} style={{ width: `${progress}%` }} />
        </div>

        <button
          type="button"
          className={styles.videoControlBtn}
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? '退出全屏' : '全屏'}
        >
          {isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
        </button>
      </div>
    </div>
  );
});

export default VideoPlayerCard;
