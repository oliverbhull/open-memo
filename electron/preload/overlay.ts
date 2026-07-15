import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('memoOverlay', {
  onAudioLevels(callback: (levels: number[]) => void): void {
    ipcRenderer.on('memo:audioLevels', (_event, levels: number[]) => callback(levels));
  },
  onStatus(callback: (status: { isRecording: boolean; primaryColor?: string }) => void): void {
    ipcRenderer.on('memo:status', (_event, status) => callback(status));
  },
  onCommandToast(callback: (data: { label: string; primaryColor?: string }) => void): void {
    ipcRenderer.on('memo:commandToast', (_event, data) => callback(data));
  },
});
