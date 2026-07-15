import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../utils/logger';

export function useAudioPlayback(entryId: string) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  const dispose = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  useEffect(() => dispose, [dispose]);

  const load = useCallback(async (): Promise<HTMLAudioElement | null> => {
    if (audioRef.current) return audioRef.current;
    setIsLoading(true);
    try {
      const result = await window.electronAPI.audio.get(entryId);
      if (!result.success || !result.data) throw new Error(result.error || 'Audio not found');
      const bytes = new Uint8Array(result.data);
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const audio = new Audio(objectUrl);
      audio.preload = 'auto';
      audio.ontimeupdate = () => {
        setProgress(audio.duration > 0 ? Math.min(audio.currentTime / audio.duration, 1) : 0);
      };
      audio.onended = () => {
        setIsPlaying(false);
        setProgress(0);
        audio.currentTime = 0;
      };
      audio.onerror = () => {
        setIsPlaying(false);
        logger.warn(`Could not play audio for memo ${entryId}`);
      };
      objectUrlRef.current = objectUrl;
      audioRef.current = audio;
      return audio;
    } catch (error) {
      logger.error(`Failed to load audio for memo ${entryId}:`, error);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [entryId]);

  const toggle = useCallback(async () => {
    const audio = await load();
    if (!audio) return;
    if (audio.paused) {
      await audio.play();
      setIsPlaying(true);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  }, [load]);

  return { isPlaying, isLoading, progress, toggle };
}
