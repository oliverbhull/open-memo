/**
 * Device ID service - generates and persists a unique device identifier
 * Used for sync conflict resolution
 */

const DEVICE_ID_KEY = 'memo-device-id';

/**
 * Get or create a device ID for this device
 * Format: platform-hostname-random
 */
export async function getDeviceId(): Promise<string> {
  // Check localStorage first
  const stored = localStorage.getItem(DEVICE_ID_KEY);
  if (stored) {
    return stored;
  }

  // Generate new device ID
  const platform = navigator.platform || 'unknown';
  const hostname = window.location.hostname || 'unknown';
  const random = Math.random().toString(36).substring(2, 10);
  const deviceId = `desktop-${platform}-${hostname}-${random}`;

  // Store it
  localStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

