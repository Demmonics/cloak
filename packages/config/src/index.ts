export interface ScreenSharePreset {
  id: '720p30' | '1080p30' | '1080p60';
  label: string;
  width: number;
  height: number;
  frameRate: number;
  maxBitrateBps: number;
}

export const SCREEN_SHARE_PRESETS: readonly ScreenSharePreset[] = [
  {
    id: '720p30',
    label: '720p @ 30 FPS (Balanced)',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrateBps: 1_500_000,
  },
  {
    id: '1080p30',
    label: '1080p @ 30 FPS (Sharp Text)',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrateBps: 3_000_000,
  },
  {
    id: '1080p60',
    label: '1080p @ 60 FPS (Smooth Motion)',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrateBps: 5_000_000,
  },
] as const;

export const CLIENT_LIMITS = {
  maxAttachmentBytes: 25 * 1024 * 1024, // 25 MiB default server quota limit
  attachmentChunkBytes: 1024 * 1024, // 1 MiB chunks
  maxParallelUploads: 3,
  maxParallelExportDownloads: 4,
  exportStreamChunkBytes: 64 * 1024,
  maxUnpackArchiveBytes: 1024 * 1024 * 1024, // 1 GiB decompression bomb limit
  maxUnpackEntryBytes: 256 * 1024 * 1024,
  maxUnpackEntryCount: 50_000,
  maxCompressionRatio: 200,
  wsHeartbeatIntervalMs: 20_000,
  wsMaxReconnectDelayMs: 15_000,
  messagePageSize: 50,
} as const;

export const DISAPPEARING_MESSAGE_OPTIONS = [
  { label: 'Off (Keep until deleted)', seconds: null },
  { label: '30 seconds', seconds: 30 },
  { label: '5 minutes', seconds: 300 },
  { label: '1 hour', seconds: 3600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
] as const;

export const ARGON2_DEFAULT_BROWSER_PARAMS = {
  // Interactive-to-moderate browser-safe defaults (~16 MiB, opslimit=3)
  // Benchmarkable in browser via benchmarkArgon2Params(); recorded verbatim in .cloakexport header
  opslimit: 3,
  memlimitBytes: 16 * 1024 * 1024,
  minOpslimit: 2,
  maxOpslimit: 16,
  minMemlimitBytes: 8 * 1024 * 1024,
  maxMemlimitBytes: 256 * 1024 * 1024,
} as const;

export function getApiBaseUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return metaEnv?.VITE_API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8080');
}

export function getWsBaseUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (metaEnv?.VITE_WS_BASE_URL) return metaEnv.VITE_WS_BASE_URL;
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}`;
  }
  return 'ws://127.0.0.1:8080';
}

export function getLiveKitUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return metaEnv?.VITE_LIVEKIT_URL || 'ws://127.0.0.1:7880';
}

