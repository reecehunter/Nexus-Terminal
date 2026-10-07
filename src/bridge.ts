import { createBackend } from './platform/create-backend';
import type { Backend } from './backend';

/**
 * Stable frontend boundary. Components import this module, never Tauri APIs.
 * A future local-socket or remote-terminal adapter can replace this factory
 * without changing the React application.
 */
export const bridge: Backend = createBackend();
export const desktopAvailable = () => bridge.available;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
