export interface TaskStackEntry {
  extensionId: string;
  canvasState: unknown;
  reason: string;
  pausedAt: string; // ISO timestamp
}
