import { useState, useEffect, useRef, useCallback } from 'react';
import { logger } from '../utils/logger';

interface UseAudioPlaybackReturn {
  isPlaying: boolean;
  progress: number;
  duration: number | null;
  isLoading: boolean;
  error: string | null;
  hasAudio: boolean;
  play: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  toggle: () => Promise<void>;
}

export function useAudioPlayback(entryId: string): UseAudioPlaybackReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAudio, setHasAudio] = useState(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedTimeRef = useRef<number>(0);
  const progressIntervalRef = useRef<number | null>(null);

  // Check if audio exists
  useEffect(() => {
    if (!window.electronAPI?.audio?.hasAudio) {
      setHasAudio(false);
      return;
    }

    window.electronAPI.audio.hasAudio(entryId)
      .then(setHasAudio)
      .catch(() => setHasAudio(false));
  }, [entryId]);

  const stopRef = useRef<() => void>(() => {});
  
  const updateProgress = useCallback(() => {
    if (!audioBufferRef.current || !audioContextRef.current) return;

    const currentTime = audioContextRef.current.currentTime;
    const elapsed = currentTime - startTimeRef.current + pausedTimeRef.current;
    const newProgress = Math.min(elapsed / audioBufferRef.current.duration, 1);
    setProgress(newProgress);

    if (newProgress >= 1) {
      stopRef.current();
    }
  }, []);

  const stop = useCallback(() => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
      } catch (e) {
        // Ignore errors if already stopped
      }
      sourceNodeRef.current = null;
    }

    setIsPlaying(false);
    setProgress(0);
    pausedTimeRef.current = 0;
    startTimeRef.current = 0;

    if (progressIntervalRef.current !== null) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  }, []);

  // Update stop ref
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, [stop]);

  const loadAudio = useCallback(async (): Promise<AudioBuffer | null> => {
    if (audioBufferRef.current) {
      return audioBufferRef.current;
    }

    if (!window.electronAPI?.audio?.get) {
      throw new Error('Audio API not available');
    }

    setIsLoading(true);
    setError(null);

    try {
      // Get raw OPUS audio data from main process
      const result = await window.electronAPI.audio.get(entryId);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to get audio');
      }

      // Create AudioContext if needed
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      }

      // Get decoded WAV audio from main process
      const decodedResult = await window.electronAPI.audio.getDecoded(entryId);
      if (!decodedResult.success || !decodedResult.data) {
        throw new Error(decodedResult.error || 'Failed to get decoded audio');
      }

      // Decode WAV data using Web Audio API (WAV is natively supported)
      const wavData = new Uint8Array(decodedResult.data);
      const audioBuffer = await audioContextRef.current.decodeAudioData(wavData.buffer);
      
      audioBufferRef.current = audioBuffer;
      setDuration(audioBuffer.duration);
      setIsLoading(false);
      return audioBuffer;

      audioBufferRef.current = audioBuffer;
      setDuration(audioBuffer.duration);
      setIsLoading(false);
      return audioBuffer;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load audio';
      setError(errorMessage);
      setIsLoading(false);
      logger.error('Failed to load audio:', err);
      return null;
    }
  }, [entryId]);

  const play = useCallback(async () => {
    if (isPlaying) return;

    const audioBuffer = await loadAudio();
    if (!audioBuffer || !audioContextRef.current) return;

    // Resume context if suspended
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    // Create new source node
    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);

    // Handle playback end
    source.onended = () => {
      stopRef.current();
    };

    // Start playback from paused position
    const offset = pausedTimeRef.current;
    source.start(0, offset);
    sourceNodeRef.current = source;
    startTimeRef.current = audioContextRef.current.currentTime - offset;
    setIsPlaying(true);

    // Update progress periodically
    progressIntervalRef.current = window.setInterval(updateProgress, 100);
  }, [isPlaying, loadAudio, updateProgress]);

  const pause = useCallback(() => {
    if (!isPlaying || !sourceNodeRef.current || !audioContextRef.current) return;

    // Stop the source
    sourceNodeRef.current.stop();
    sourceNodeRef.current = null;

    // Update paused time
    const currentTime = audioContextRef.current.currentTime;
    pausedTimeRef.current += currentTime - startTimeRef.current;

    setIsPlaying(false);
    if (progressIntervalRef.current !== null) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  }, [isPlaying]);

  const toggle = useCallback(async () => {
    if (isPlaying) {
      pause();
    } else {
      await play();
    }
  }, [isPlaying, play, pause]);

  return {
    isPlaying,
    progress,
    duration,
    isLoading,
    error,
    hasAudio,
    play,
    pause,
    stop,
    toggle,
  };
}
