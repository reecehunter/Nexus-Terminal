import { isTauri } from '@tauri-apps/api/core';
import type { Backend } from '../backend';
import { createMockBackend } from './mock-backend';
import { createTauriBackend } from './tauri-backend';

/** Select the real desktop adapter only when the UI is hosted by Tauri. */
export function createBackend(): Backend {
  return isTauri() ? createTauriBackend() : createMockBackend();
}
