import {
  createChatExportArchive,
  openChatExportArchive,
  type ExportBuildInput,
  type ExportBuildProgress,
  type ExportBuildResult,
  type OpenedArchiveData,
} from '@cloak/archive';

type WorkerRequest =
  | { id: string; action: 'export'; input: ExportBuildInput }
  | { id: string; action: 'open'; archiveBytes: Uint8Array; password: string };

type WorkerResponse =
  | { id: string; kind: 'progress'; progress: ExportBuildProgress }
  | { id: string; kind: 'export_done'; result: ExportBuildResult }
  | { id: string; kind: 'open_done'; result: OpenedArchiveData }
  | { id: string; kind: 'error'; code: string; message: string };

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.action === 'export') {
      const result = await createChatExportArchive({
        ...req.input,
        onProgress: (progress) => {
          const msg: WorkerResponse = { id: req.id, kind: 'progress', progress };
          self.postMessage(msg);
        },
      });
      const resp: WorkerResponse = { id: req.id, kind: 'export_done', result };
      self.postMessage(resp);
    } else if (req.action === 'open') {
      const result = await openChatExportArchive({
        archiveBytes: req.archiveBytes,
        password: req.password,
      });
      const resp: WorkerResponse = { id: req.id, kind: 'open_done', result };
      self.postMessage(resp);
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    const resp: WorkerResponse = { id: req.id, kind: 'error', code, message };
    self.postMessage(resp);
  }
});

