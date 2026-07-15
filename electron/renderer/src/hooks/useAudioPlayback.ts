import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../utils/logger';

export function useAudioPlayback(entryId: string) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const dispose = useCallback(() => {
    if (audioRef.current) {
      const audio = audioRef.current;
      audio.onplay = null;
      audio.onpause = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
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
      audio.onplay = () => setIsPlaying(true);
      audio.onpause = () => setIsPlaying(false);
      audio.onended = () => {
        setIsPlaying(false);
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
    try {
      if (audio.paused) {
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (error) {
      setIsPlaying(false);
      logger.error(`Failed to play audio for memo ${entryId}:`, error);
    }
  }, [entryId, load]);

  return { isPlaying, isLoading, toggle };
}
