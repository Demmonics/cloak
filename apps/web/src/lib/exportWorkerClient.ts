import {
  ArchiveError,
  createChatExportArchive,
  openChatExportArchive,
  type ExportBuildInput,
  type ExportBuildProgress,
  type ExportBuildResult,
  type OpenedArchiveData,
} from '@cloak/archive';

type WorkerMsg =
  | { id: string; kind: 'progress'; progress: ExportBuildProgress }
  | { id: string; kind: 'export_done'; result: ExportBuildResult }
  | { id: string; kind: 'open_done'; result: OpenedArchiveData }
  | { id: string; kind: 'error'; code: string; message: string };

let sharedWorker: Worker | null = null;

function getExportWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL('../workers/exportWorker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return sharedWorker;
}

export async function runExportInWorker(input: ExportBuildInput): Promise<ExportBuildResult> {
  const worker = getExportWorker();
  if (!worker) {
    return createChatExportArchive(input);
  }

  if (input.signal?.aborted) {
    throw new ArchiveError('CANCELLED', 'Export cancelled');
  }

  const { onProgress, signal, ...serializableInput } = input;
  const reqId = crypto.randomUUID();

  return new Promise<ExportBuildResult>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', handleMsg);
      signal?.removeEventListener('abort', handleAbort);
    };

    const handleAbort = () => {
      cleanup();
      // Terminate stuck/aborted worker so Argon2/ZIP stops immediately
      sharedWorker?.terminate();
      sharedWorker = null;
      reject(new ArchiveError('CANCELLED', 'Export cancelled by user'));
    };

    const handleMsg = (event: MessageEvent<WorkerMsg>) => {
      const msg = event.data;
      if (msg.id !== reqId) return;
      if (msg.kind === 'progress') {
        onProgress?.(msg.progress);
      } else if (msg.kind === 'export_done') {
        cleanup();
        resolve(msg.result);
      } else if (msg.kind === 'error') {
        cleanup();
        reject(new ArchiveError(msg.code as ArchiveError['code'], msg.message));
      }
    };

    signal?.addEventListener('abort', handleAbort);
    worker.addEventListener('message', handleMsg);
    worker.postMessage({ id: reqId, action: 'export', input: serializableInput });
  });
}

export async function openArchiveInWorker(
  archiveBytes: Uint8Array,
  password: string,
): Promise<OpenedArchiveData> {
  const worker = getExportWorker();
  if (!worker) {
    return openChatExportArchive({ archiveBytes, password });
  }

  const reqId = crypto.randomUUID();
  return new Promise<OpenedArchiveData>((resolve, reject) => {
    const handleMsg = (event: MessageEvent<WorkerMsg>) => {
      const msg = event.data;
      if (msg.id !== reqId) return;
      if (msg.kind === 'open_done') {
        worker.removeEventListener('message', handleMsg);
        resolve(msg.result);
      } else if (msg.kind === 'error') {
        worker.removeEventListener('message', handleMsg);
        reject(new ArchiveError(msg.code as ArchiveError['code'], msg.message));
      }
    };
    worker.addEventListener('message', handleMsg);
    worker.postMessage({ id: reqId, action: 'open', archiveBytes, password });
  });
}

