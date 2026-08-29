import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { PlayCircleFilled, PauseCircleFilled, SoundOutlined } from '@ant-design/icons';
import styles from './chat.module.css';

export interface AudioWaveformPlayerProps {
  src: string;
  title?: string;
  duration?: number;
}

/**
 * HarmonyOS 6 灵动胶囊声学波形播放器
 * 具备声波动态律动、超级曲率圆角与通透亚克力毛玻璃质感
 */
export const AudioWaveformPlayer = memo(function AudioWaveformPlayer({
  src,
  title = '语音消息',
  duration,
}: AudioWaveformPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(duration || 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio(src);
    audioRef.current = audio;

    const handleLoadedMetadata = () => {
      if (audio.duration && !Number.isNaN(audio.duration)) {
        setTotalDuration(Math.round(audio.duration));
      }
    };

    const handleTimeUpdate = () => {
      setCurrentTime(Math.round(audio.currentTime));
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.pause();
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [src]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  }, [isPlaying]);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const progressPercent = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  return (
    <div className={styles.audioPlayerCapsule}>
      <button
        type="button"
        className={styles.audioPlayBtn}
        onClick={togglePlay}
        aria-label={isPlaying ? '暂停播放' : '播放音频'}
      >
        {isPlaying ? <PauseCircleFilled /> : <PlayCircleFilled />}
      </button>

      <div className={styles.audioInfo}>
        <div className={styles.audioHeader}>
          <span className={styles.audioTitle}>
            <SoundOutlined /> {title}
          </span>
          <span className={styles.audioDuration}>
            {formatTime(currentTime)} / {formatTime(totalDuration)}
          </span>
        </div>

        <div className={styles.audioWaveformTrack}>
          <div
            className={styles.audioWaveformProgress}
            style={{ width: `${progressPercent}%` }}
          />
          <div className={styles.audioWaveBars}>
            {[40, 70, 30, 90, 60, 100, 45, 80, 55, 95, 65, 85, 35, 75, 50].map((h, i) => (
              <span
                key={i}
                className={`${styles.audioWaveBar} ${isPlaying ? styles.audioWaveBarAnimated : ''}`}
                style={{
                  height: `${h}%`,
                  animationDelay: `${(i % 5) * 0.12}s`,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

export default AudioWaveformPlayer;
