import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Command,
  Download,
  FileText,
  FolderOpen,
  Info,
  Layers,
  ListTree,
  Lock,
  Maximize2,
  Minimize2,
  Moon,
  Printer,
  RotateCw,
  Search,
  Sun,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  isNativeDesktopShell,
  p2pApi,
  type P2pPdfDocument,
  type P2pStealthBootstrapState,
  type P2pUnlockOutcome,
  type PdfReaderTheme,
  type UnlockMethod,
} from '../../lib/p2pClient.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type LeftNavTab = 'thumbnails' | 'outline' | 'bookmarks' | 'library';
type ZoomMode = 'custom' | 'fit_width' | 'fit_page' | 'actual_size';

interface OutlineItem {
  title: string;
  pageNumber: number | null;
  items: OutlineItem[];
}

interface SearchHit {
  page: number;
  snippet: string;
}

interface PdfMetadataDisplay {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  producer?: string;
}

interface PdfReaderShellProps {
  bootstrap: P2pStealthBootstrapState;
  onUnlockOutcome: (outcome: P2pUnlockOutcome) => void;
  onReturnToMessenger?: () => void;
  onEmergencyLock?: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function PdfReaderShell({
  bootstrap,
  onUnlockOutcome,
  onReturnToMessenger,
  onEmergencyLock,
}: PdfReaderShellProps) {
  const [theme, setTheme] = useState<PdfReaderTheme>(bootstrap.pdfTheme);
  const [docs, setDocs] = useState<P2pPdfDocument[]>([]);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(bootstrap.defaultPdfId);
  const [leftTab, setLeftTab] = useState<LeftNavTab>(
    bootstrap.activeSurface === 'generic_doc_list' ||
      bootstrap.pdfReturnBehavior === 'document_library'
      ? 'library'
      : 'thumbnails',
  );
  const [leftRailOpen, setLeftRailOpen] = useState(true);

  const [pdfProxy, setPdfProxy] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit_width');
  const [customScale, setCustomScale] = useState(1.1);
  const [renderedScale, setRenderedScale] = useState(1.1);
  const [rotation, setRotation] = useState(0);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [metadata, setMetadata] = useState<PdfMetadataDisplay>({});
  const [docError, setDocError] = useState<string | null>(null);
  const [passwordNeeded, setPasswordNeeded] = useState(false);
  const [pdfPassword, setPdfPassword] = useState('');
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // Ephemeral PDF search bar state (never persisted to recent history / disk!)
  const [searchText, setSearchText] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [activeHitIdx, setActiveHitIdx] = useState(0);

  // Discreet unlock / masked prompt modal state
  const [unlockModalOpen, setUnlockModalOpen] = useState(false);
  const [unlockMethodChoice, setUnlockMethodChoice] = useState<UnlockMethod>('hidden_shortcut_input');
  const [unlockInput, setUnlockInput] = useState('');
  const [additionalSecret, setAdditionalSecret] = useState('');
  const [needsAdditionalFactor, setNeedsAdditionalFactor] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [unlockFeedback, setUnlockFeedback] = useState<string | null>(null);
  const [busyUnlock, setBusyUnlock] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const viewportWrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const thumbCanvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const activeRenderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const hiddenUnlockInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTheme(bootstrap.pdfTheme);
  }, [bootstrap.pdfTheme]);

  const loadLibrary = useCallback(async () => {
    try {
      const list = await p2pApi.listPdfDocuments();
      setDocs(list);
      if (bootstrap.pdfReturnBehavior !== 'neutral_welcome') {
        const preferred =
          (bootstrap.defaultPdfId && list.some((d) => d.id === bootstrap.defaultPdfId)
            ? bootstrap.defaultPdfId
            : null) ??
          list[0]?.id ??
          null;
        setActiveDocId((prev) => {
          if (prev && list.some((d) => d.id === prev)) return prev;
          return preferred;
        });
        if (preferred) {
          setOpenTabIds((tabs) => (tabs.includes(preferred) ? tabs : [...tabs, preferred]));
        }
      }
    } catch {
      // Ignore transient error
    }
  }, [bootstrap.defaultPdfId, bootstrap.pdfReturnBehavior]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const activeDoc = useMemo(
    () => docs.find((d) => d.id === activeDocId) ?? null,
    [docs, activeDocId],
  );
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const loadedDocIdRef = useRef<string | null>(null);

  // Open document into pdf.js with network fetching & JS eval disabled
  const openPdfFromRecord = useCallback(async (doc: P2pPdfDocument, password?: string) => {
    setDocError(null);
    setPasswordNeeded(false);
    try {
      const bytes = await p2pApi.fetchPdfContentBytes(doc.id);
      setPdfBytes(bytes);
      const task = pdfjsLib.getDocument({
        data: bytes.slice(),
        password: password || undefined,
        useWorkerFetch: false,
        disableAutoFetch: true,
        disableStream: true,
      });
      const loaded = await task.promise;
      setPdfProxy((prev) => {
        if (prev && prev !== loaded) {
          void prev.cleanup(false);
        }
        return loaded;
      });
      setPageCount(loaded.numPages);
      const clampedPage = Math.min(Math.max(1, doc.lastPage || 1), loaded.numPages);
      setPageNumber(clampedPage);
      setCustomScale(doc.lastZoom || 1.1);
      setRotation(doc.rotation || 0);

      // Extract real outline & metadata
      try {
        const rawOutline = await loaded.getOutline();
        const convertOutline = async (
          items: Awaited<ReturnType<pdfjsLib.PDFDocumentProxy['getOutline']>>,
        ): Promise<OutlineItem[]> => {
          if (!items) return [];
          const mapped: OutlineItem[] = [];
          for (const item of items) {
            let destPage: number | null = null;
            if (Array.isArray(item.dest) && item.dest[0]) {
              try {
                const idx = await loaded.getPageIndex(item.dest[0] as never);
                destPage = idx + 1;
              } catch {
                destPage = null;
              }
            } else if (typeof item.dest === 'string') {
              try {
                const resolved = await loaded.getDestination(item.dest);
                if (Array.isArray(resolved) && resolved[0]) {
                  const idx = await loaded.getPageIndex(resolved[0] as never);
                  destPage = idx + 1;
                }
              } catch {
                destPage = null;
              }
            }
            mapped.push({
              title: item.title || 'Section',
              pageNumber: destPage,
              items: await convertOutline(item.items as never),
            });
          }
          return mapped;
        };
        setOutline(await convertOutline(rawOutline));
      } catch {
        setOutline([]);
      }

      try {
        const meta = await loaded.getMetadata();
        const info = (meta.info ?? {}) as Record<string, unknown>;
        setMetadata({
          title: typeof info.Title === 'string' ? info.Title : doc.title,
          author: typeof info.Author === 'string' ? info.Author : undefined,
          subject: typeof info.Subject === 'string' ? info.Subject : undefined,
          creator: typeof info.Creator === 'string' ? info.Creator : undefined,
          producer: typeof info.Producer === 'string' ? info.Producer : undefined,
        });
      } catch {
        setMetadata({ title: doc.title });
      }

      if (doc.pageCount !== loaded.numPages) {
        const updated = await p2pApi.updatePdfDocumentState(doc.id, {
          pageCount: loaded.numPages,
        });
        setDocs((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      }
    } catch (err) {
      if (err instanceof pdfjsLib.PasswordException) {
        setPasswordNeeded(true);
        setDocError('This PDF is password-protected. Enter the document password to view.');
      } else {
        setPdfProxy(null);
        setDocError(
          err instanceof Error
            ? `Unable to render PDF document: ${err.message}`
            : 'Unable to render PDF document.',
        );
      }
    }
  }, []);

  useEffect(() => {
    if (!activeDocId) {
      loadedDocIdRef.current = null;
      setPdfProxy((prev) => {
        if (prev) void prev.cleanup(false);
        return null;
      });
      setPdfBytes(null);
      setPageCount(0);
      return;
    }
    if (loadedDocIdRef.current === activeDocId) {
      return;
    }
    const target = docsRef.current.find((d) => d.id === activeDocId);
    if (target) {
      loadedDocIdRef.current = activeDocId;
      void openPdfFromRecord(target);
    }
  }, [activeDocId, docs.length, openPdfFromRecord]);

  // Render active page canvas + selectable text layer
  useEffect(() => {
    let cancelled = false;
    const renderPage = async () => {
      if (!pdfProxy || !canvasRef.current || !viewportWrapRef.current) return;
      try {
        if (activeRenderTaskRef.current) {
          activeRenderTaskRef.current.cancel();
        }
        const page = await pdfProxy.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1, rotation });
        const containerW = Math.max(320, viewportWrapRef.current.clientWidth - 48);
        const containerH = Math.max(360, viewportWrapRef.current.clientHeight - 48);

        let scale = customScale;
        if (zoomMode === 'fit_width') {
          scale = Math.max(0.4, Math.min(3.0, containerW / baseViewport.width));
        } else if (zoomMode === 'fit_page') {
          scale = Math.max(
            0.4,
            Math.min(3.0, Math.min(containerW / baseViewport.width, containerH / baseViewport.height)),
          );
        } else if (zoomMode === 'actual_size') {
          scale = 1.0;
        }
        setRenderedScale(scale);

        const viewport = page.getViewport({ scale, rotation });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        activeRenderTaskRef.current = renderTask;
        await renderTask.promise;
        if (cancelled) return;

        // Render genuine selectable text layer
        if (textLayerRef.current) {
          textLayerRef.current.innerHTML = '';
          textLayerRef.current.style.width = `${Math.floor(viewport.width)}px`;
          textLayerRef.current.style.height = `${Math.floor(viewport.height)}px`;
          textLayerRef.current.style.setProperty('--scale-factor', String(scale));
          const textContent = await page.getTextContent();
          if (cancelled || !textLayerRef.current) return;
          const layer = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayerRef.current,
            viewport,
          });
          await layer.render();
        }
      } catch (err) {
        if (err instanceof pdfjsLib.RenderingCancelledException) return;
      }
    };
    void renderPage();
    return () => {
      cancelled = true;
    };
  }, [pdfProxy, pageNumber, zoomMode, customScale, rotation]);

  // Render crisp thumbnails when Thumbnails tab is visible
  useEffect(() => {
    if (!pdfProxy || !leftRailOpen || leftTab !== 'thumbnails') return;
    let cancelled = false;
    const renderThumbs = async () => {
      const limit = Math.min(pdfProxy.numPages, 24);
      for (let p = 1; p <= limit; p += 1) {
        if (cancelled) return;
        const el = thumbCanvasRefs.current[p];
        if (!el) continue;
        try {
          const page = await pdfProxy.getPage(p);
          if (cancelled) return;
          const vp = page.getViewport({ scale: 0.22, rotation });
          const ctx = el.getContext('2d');
          if (!ctx) continue;
          el.width = Math.max(1, Math.floor(vp.width));
          el.height = Math.max(1, Math.floor(vp.height));
          await page.render({ canvas: el, canvasContext: ctx, viewport: vp }).promise;
        } catch {
          // Ignore thumbnail cancel/error
        }
      }
    };
    void renderThumbs();
    return () => {
      cancelled = true;
    };
  }, [pdfProxy, leftRailOpen, leftTab, rotation]);

  const persistReadingState = useCallback(
    (patch: { lastPage?: number; lastZoom?: number; rotation?: number; bookmarks?: number[] }) => {
      if (!activeDoc) return;
      void p2pApi
        .updatePdfDocumentState(activeDoc.id, patch)
        .then((updated) => {
          setDocs((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
        })
        .catch(() => undefined);
    },
    [activeDoc],
  );

  const goToPage = useCallback(
    (next: number) => {
      if (pageCount <= 0) return;
      const clamped = Math.max(1, Math.min(pageCount, next));
      setPageNumber(clamped);
      persistReadingState({ lastPage: clamped });
    },
    [pageCount, persistReadingState],
  );

  // Import helper for both upload & drag-drop
  const handleImportFiles = useCallback(async (files: FileList | File[]) => {
    setDocError(null);
    const list = Array.from(files);
    for (const file of list) {
      try {
        const doc = await p2pApi.uploadPdfDocument(file);
        setDocs((prev) => [doc, ...prev]);
        setOpenTabIds((prev) => (prev.includes(doc.id) ? prev : [...prev, doc.id]));
        setActiveDocId(doc.id);
      } catch (err) {
        setDocError(err instanceof Error ? err.message : 'PDF import rejected');
      }
    }
  }, []);

  const handleOpenPicker = useCallback(async () => {
    if (isNativeDesktopShell()) {
      try {
        const imported = await p2pApi.pickNativePdfDocuments();
        const first = imported[0];
        if (first) {
          setDocs((prev) => [...imported, ...prev]);
          setOpenTabIds((prev) => (prev.includes(first.id) ? prev : [...prev, first.id]));
          setActiveDocId(first.id);
        }
        return;
      } catch {
        // Fallback to standard file input below
      }
    }
    fileInputRef.current?.click();
  }, []);

  const handleOpenSamplePdf = useCallback(async () => {
    setDocError(null);
    try {
      const doc = await p2pApi.createSamplePdfDocument();
      setDocs((prev) => [doc, ...prev]);
      setOpenTabIds((prev) => (prev.includes(doc.id) ? prev : [...prev, doc.id]));
      setActiveDocId(doc.id);
    } catch (err) {
      setDocError(err instanceof Error ? err.message : 'Could not open sample PDF');
    }
  }, []);

  // Real PDF text search across loaded document (never executes if submitted code unlocked!)
  const runDocumentSearch = useCallback(
    async (query: string) => {
      const q = query.trim().toLowerCase();
      if (!q || !pdfProxy) {
        setSearchHits([]);
        setActiveHitIdx(0);
        return;
      }
      const hits: SearchHit[] = [];
      for (let p = 1; p <= pdfProxy.numPages; p += 1) {
        try {
          const page = await pdfProxy.getPage(p);
          const content = await page.getTextContent();
          const joined = content.items
            .map((it) => ('str' in it ? it.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ');
          const idx = joined.toLowerCase().indexOf(q);
          if (idx >= 0) {
            const start = Math.max(0, idx - 24);
            const snippet = joined.slice(start, Math.min(joined.length, idx + q.length + 36));
            hits.push({ page: p, snippet });
          }
        } catch {
          // Ignore page text error
        }
      }
      setSearchHits(hits);
      setActiveHitIdx(0);
      const firstHit = hits[0];
      if (firstHit) {
        goToPage(firstHit.page);
      }
    },
    [pdfProxy, goToPage],
  );

  // PDF search Enter handler: checks secret unlock discreetly when enabled without storing secret query!
  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = searchText;
    if (!raw.trim()) {
      setSearchHits([]);
      return;
    }
    if (bootstrap.enabledUnlockMethods.includes('pdf_search')) {
      try {
        const outcome = await p2pApi.unlockStealth('pdf_search', raw);
        if (outcome.matched) {
          // Immediately clear input so secret code never lingers in DOM or search state!
          setSearchText('');
          setSearchHits([]);
          if (outcome.needsAdditionalFactor) {
            setNeedsAdditionalFactor(true);
            setUnlockMethodChoice('passphrase');
            setUnlockModalOpen(true);
            setUnlockFeedback(outcome.message);
            return;
          }
          onUnlockOutcome(outcome);
          return;
        }
        // If rate-limited without revealing secret state unnecessarily, fall through gracefully to normal search
      } catch {
        // Fall through silently to standard PDF search
      }
    }
    if (searchHits.length > 0 && pdfProxy) {
      const nextIdx = (activeHitIdx + 1) % searchHits.length;
      setActiveHitIdx(nextIdx);
      const targetHit = searchHits[nextIdx];
      if (targetHit) goToPage(targetHit.page);
    } else {
      await runDocumentSearch(raw);
    }
  };

  // Global reader keyboard shortcuts (incl. configured hidden unlock overlay shortcut + panic hotkey)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'U') {
        if (
          bootstrap.enabledUnlockMethods.includes('hidden_shortcut_input') ||
          bootstrap.enabledUnlockMethods.includes('discreet_command')
        ) {
          e.preventDefault();
          setUnlockMethodChoice('hidden_shortcut_input');
          setUnlockFeedback(null);
          setUnlockModalOpen(true);
          setTimeout(() => hiddenUnlockInputRef.current?.focus(), 40);
        }
      } else if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'L') {
        e.preventDefault();
        onEmergencyLock?.();
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (!unlockModalOpen && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          e.preventDefault();
          goToPage(pageNumber + 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault();
          goToPage(pageNumber - 1);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    bootstrap.enabledUnlockMethods,
    goToPage,
    onEmergencyLock,
    pageNumber,
    unlockModalOpen,
  ]);

  const handleSubmitMaskedUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyUnlock(true);
    setUnlockFeedback(null);
    try {
      if (recoveryMode) {
        const out = await p2pApi.recoverStealth(recoveryInput);
        setRecoveryInput('');
        setRecoveryMode(false);
        setUnlockModalOpen(false);
        onUnlockOutcome(out);
        return;
      }

      const method = needsAdditionalFactor
        ? unlockMethodChoice === 'pin'
          ? 'pin'
          : 'passphrase'
        : unlockMethodChoice;
      const secretVal = needsAdditionalFactor ? additionalSecret || unlockInput : unlockInput;
      const out = await p2pApi.unlockStealth(
        method,
        secretVal,
        additionalSecret ? additionalSecret : undefined,
      );
      setUnlockInput('');
      setAdditionalSecret('');
      if (out.unlocked || (out.matched && !out.needsAdditionalFactor)) {
        setNeedsAdditionalFactor(false);
        setUnlockModalOpen(false);
        onUnlockOutcome(out);
      } else if (out.needsAdditionalFactor) {
        setNeedsAdditionalFactor(true);
        setUnlockFeedback(out.message);
      } else {
        setUnlockFeedback(out.message);
      }
    } catch (err) {
      setUnlockFeedback(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setBusyUnlock(false);
    }
  };

  const handleSaveCopy = () => {
    if (!pdfBytes || !activeDoc) return;
    const copy = new Uint8Array(pdfBytes.byteLength);
    copy.set(pdfBytes);
    const blob = new Blob([copy], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeDoc.filename || 'document.pdf';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    if (!pdfBytes) {
      window.print();
      return;
    }
    window.print();
  };

  const toggleBookmark = () => {
    if (!activeDoc || pageNumber <= 0) return;
    const exists = activeDoc.bookmarks.includes(pageNumber);
    const next = exists
      ? activeDoc.bookmarks.filter((b) => b !== pageNumber)
      : [...activeDoc.bookmarks, pageNumber].sort((a, b) => a - b);
    persistReadingState({ bookmarks: next });
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement && rootRef.current?.requestFullscreen) {
        await rootRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
        setIsFullscreen(false);
      } else {
        setIsFullscreen((v) => !v);
      }
    } catch {
      setIsFullscreen((v) => !v);
    }
  };

  const dark = theme === 'dark';
  const surfaceBg = dark ? 'bg-[#12151c] text-[#e5e7eb]' : 'bg-[#f4f5f7] text-[#1f2937]';
  const barBg = dark ? 'bg-[#1a1f29] border-[#2c3444]' : 'bg-white border-[#d1d5db]';
  const panelBg = dark ? 'bg-[#161a23] border-[#2c3444]' : 'bg-[#fafafa] border-[#e5e7eb]';
  const mutedTxt = dark ? 'text-[#9ca3af]' : 'text-[#6b7280]';
  const btnHover = dark ? 'hover:bg-[#283040]' : 'hover:bg-[#e5e7eb]';
  const inputCls = dark
    ? 'bg-[#0f131a] border-[#334155] text-[#f3f4f6]'
    : 'bg-[#f9fafb] border-[#d1d5db] text-[#111827]';

  const isBookmarked = Boolean(activeDoc?.bookmarks.includes(pageNumber));

  return (
    <div
      ref={rootRef}
      data-testid="pdf-reader-shell"
      className={`h-screen w-screen flex flex-col overflow-hidden select-text ${surfaceBg}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        if (e.dataTransfer.files.length > 0) {
          void handleImportFiles(e.dataTransfer.files);
        }
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            void handleImportFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Top Productivity Toolbar */}
      <header
        className={`flex flex-wrap items-center gap-1.5 px-3 py-2 border-b text-xs ${barBg}`}
      >
        <button
          type="button"
          onClick={() => setLeftRailOpen((v) => !v)}
          className={`px-2 py-1.5 rounded flex items-center gap-1 ${btnHover}`}
          title="Toggle Sidebar"
        >
          <Layers className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => void handleOpenPicker()}
          className={`px-2.5 py-1.5 rounded border font-medium flex items-center gap-1.5 ${barBg} ${btnHover}`}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Open
        </button>

        <button
          type="button"
          onClick={handleSaveCopy}
          disabled={!pdfBytes}
          className={`px-2 py-1.5 rounded flex items-center gap-1 disabled:opacity-40 ${btnHover}`}
          title="Save a local copy"
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Save Copy</span>
        </button>

        <button
          type="button"
          onClick={handlePrint}
          disabled={!pdfProxy}
          className={`px-2 py-1.5 rounded flex items-center gap-1 disabled:opacity-40 ${btnHover}`}
          title="Print document"
        >
          <Printer className="w-3.5 h-3.5" />
        </button>

        <div className="h-4 w-px bg-current opacity-20 mx-1" />

        {/* Page Navigation */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => goToPage(pageNumber - 1)}
            disabled={pageNumber <= 1 || !pdfProxy}
            className={`p-1 rounded disabled:opacity-40 ${btnHover}`}
            aria-label="Previous Page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="number"
            min={1}
            max={Math.max(1, pageCount)}
            value={pageCount > 0 ? pageNumber : 0}
            onChange={(e) => {
              const val = Number(e.target.value);
              if (!Number.isNaN(val)) goToPage(val);
            }}
            aria-label="Current Page"
            className={`w-12 text-center rounded border px-1 py-1 text-xs ${inputCls}`}
          />
          <span className={mutedTxt}>/ {pageCount || 0}</span>
          <button
            type="button"
            onClick={() => goToPage(pageNumber + 1)}
            disabled={pageNumber >= pageCount || !pdfProxy}
            className={`p-1 rounded disabled:opacity-40 ${btnHover}`}
            aria-label="Next Page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="h-4 w-px bg-current opacity-20 mx-1" />

        {/* Zoom & Rotate */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setZoomMode('custom');
              const z = Math.max(0.4, +(renderedScale - 0.15).toFixed(2));
              setCustomScale(z);
              persistReadingState({ lastZoom: z });
            }}
            disabled={!pdfProxy}
            className={`p-1 rounded disabled:opacity-40 ${btnHover}`}
            aria-label="Zoom Out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <select
            aria-label="Zoom Mode"
            value={zoomMode === 'custom' ? 'custom' : zoomMode}
            onChange={(e) => {
              const v = e.target.value as ZoomMode | string;
              if (v === 'fit_width' || v === 'fit_page' || v === 'actual_size') {
                setZoomMode(v);
                if (v === 'actual_size') persistReadingState({ lastZoom: 1.0 });
              } else {
                const num = Number(v);
                if (!Number.isNaN(num)) {
                  setZoomMode('custom');
                  setCustomScale(num);
                  persistReadingState({ lastZoom: num });
                }
              }
            }}
            className={`rounded border px-1.5 py-1 text-xs ${inputCls}`}
          >
            <option value="fit_width">Fit Width</option>
            <option value="fit_page">Fit Page</option>
            <option value="actual_size">Actual Size (100%)</option>
            <option value="custom">{Math.round(renderedScale * 100)}%</option>
            <option value="0.75">75%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
          </select>
          <button
            type="button"
            onClick={() => {
              setZoomMode('custom');
              const z = Math.min(3.0, +(renderedScale + 0.15).toFixed(2));
              setCustomScale(z);
              persistReadingState({ lastZoom: z });
            }}
            disabled={!pdfProxy}
            className={`p-1 rounded disabled:opacity-40 ${btnHover}`}
            aria-label="Zoom In"
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => {
              const nextRot = (rotation + 90) % 360;
              setRotation(nextRot);
              persistReadingState({ rotation: nextRot });
            }}
            disabled={!pdfProxy}
            className={`p-1 rounded disabled:opacity-40 ${btnHover}`}
            aria-label="Rotate Page"
            title="Rotate 90°"
          >
            <RotateCw className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={toggleBookmark}
            disabled={!activeDoc}
            className={`p-1 rounded disabled:opacity-40 ${
              isBookmarked ? 'text-amber-500' : ''
            } ${btnHover}`}
            aria-label="Toggle Bookmark"
            title="Bookmark this page"
          >
            <Bookmark className="w-4 h-4" />
          </button>
        </div>

        {/* Search Input (ordinary PDF search + silent optional secret unlock on Enter) */}
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-1 ml-auto">
          <div className="relative flex items-center">
            <Search className={`w-3.5 h-3.5 absolute left-2 pointer-events-none ${mutedTxt}`} />
            <input
              ref={searchInputRef}
              type="text"
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
                if (!e.target.value.trim()) setSearchHits([]);
              }}
              placeholder="Search in document..."
              aria-label="Search in document"
              autoComplete="off"
              className={`pl-7 pr-2 py-1 rounded border w-44 sm:w-56 text-xs ${inputCls}`}
            />
          </div>
          <button type="submit" className="sr-only">
            Search
          </button>
          {searchHits.length > 0 && (
            <>
              <span className={`text-[11px] px-1 ${mutedTxt}`}>
                {activeHitIdx + 1}/{searchHits.length}
              </span>
              <button
                type="button"
                onClick={() => {
                  const prevIdx = (activeHitIdx - 1 + searchHits.length) % searchHits.length;
                  setActiveHitIdx(prevIdx);
                  const targetHit = searchHits[prevIdx];
                  if (targetHit) goToPage(targetHit.page);
                }}
                className={`px-1.5 py-1 rounded ${btnHover}`}
                title="Previous match"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => {
                  const nextIdx = (activeHitIdx + 1) % searchHits.length;
                  setActiveHitIdx(nextIdx);
                  const targetHit = searchHits[nextIdx];
                  if (targetHit) goToPage(targetHit.page);
                }}
                className={`px-1.5 py-1 rounded ${btnHover}`}
                title="Next match"
              >
                Next
              </button>
            </>
          )}
        </form>

        <button
          type="button"
          onClick={() => setMetadataOpen((v) => !v)}
          disabled={!activeDoc}
          className={`p-1.5 rounded disabled:opacity-40 ${btnHover}`}
          aria-label="Document Info"
          title="Document Properties"
        >
          <Info className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          className={`p-1.5 rounded ${btnHover}`}
          aria-label="Toggle Reader Theme"
          title="Light / Dark theme"
        >
          {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          className={`p-1.5 rounded ${btnHover}`}
          aria-label="Toggle Fullscreen"
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>

        {(bootstrap.enabledUnlockMethods.includes('discreet_command') ||
          bootstrap.enabledUnlockMethods.includes('hidden_shortcut_input') ||
          bootstrap.enabledUnlockMethods.includes('passphrase') ||
          bootstrap.enabledUnlockMethods.includes('pin') ||
          bootstrap.enabledUnlockMethods.includes('windows_hello')) && (
          <button
            type="button"
            onClick={() => {
              setUnlockFeedback(null);
              setUnlockMethodChoice(
                bootstrap.enabledUnlockMethods.includes('passphrase') &&
                  bootstrap.hasPassphraseConfigured
                  ? 'passphrase'
                  : 'hidden_shortcut_input',
              );
              setUnlockModalOpen(true);
              setTimeout(() => hiddenUnlockInputRef.current?.focus(), 40);
            }}
            className={`p-1.5 rounded ${btnHover}`}
            aria-label="Reader Command"
            title={`Command Prompt (${bootstrap.hiddenShortcut})`}
          >
            <Command className="w-4 h-4" />
          </button>
        )}

        {!bootstrap.locked && onReturnToMessenger && (
          <button
            type="button"
            onClick={onReturnToMessenger}
            className="px-2.5 py-1 rounded bg-[#2563eb] text-white font-medium hover:bg-[#1d4ed8]"
          >
            Workspace
          </button>
        )}
      </header>

      {/* Multi-Document Tabs */}
      {openTabIds.length > 0 && (
        <div className={`flex items-center gap-1 px-2 pt-1.5 border-b overflow-x-auto text-xs ${barBg}`}>
          {openTabIds.map((id) => {
            const doc = docs.find((d) => d.id === id);
            if (!doc) return null;
            const active = id === activeDocId;
            return (
              <div
                key={id}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-t border border-b-0 cursor-pointer shrink-0 ${
                  active
                    ? dark
                      ? 'bg-[#12151c] border-[#2c3444] font-semibold'
                      : 'bg-[#f4f5f7] border-[#d1d5db] font-semibold'
                    : `${mutedTxt} border-transparent ${btnHover}`
                }`}
                onClick={() => setActiveDocId(id)}
              >
                <FileText className="w-3.5 h-3.5 shrink-0" />
                <span className="max-w-44 truncate">{doc.title}</span>
                <button
                  type="button"
                  aria-label={`Close ${doc.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const remaining = openTabIds.filter((t) => t !== id);
                    setOpenTabIds(remaining);
                    if (activeDocId === id) {
                      setActiveDocId(remaining[0] ?? null);
                    }
                  }}
                  className="opacity-70 hover:opacity-100"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Main Reader Split Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        {leftRailOpen && (
          <aside className={`w-64 shrink-0 border-r flex flex-col min-h-0 ${panelBg}`}>
            <div className="grid grid-cols-4 border-b text-[11px]">
              {(
                [
                  ['thumbnails', 'Pages', Layers],
                  ['outline', 'Outline', ListTree],
                  ['bookmarks', 'Saved', Bookmark],
                  ['library', 'Library', FileText],
                ] as const
              ).map(([tab, label, Icon]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setLeftTab(tab)}
                  className={`py-2 flex flex-col items-center gap-0.5 border-b-2 ${
                    leftTab === tab
                      ? 'border-blue-600 font-semibold text-blue-600'
                      : `border-transparent ${mutedTxt}`
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-2.5 space-y-2 text-xs">
              {leftTab === 'thumbnails' && (
                <>
                  {!pdfProxy && (
                    <p className={`text-center py-8 ${mutedTxt}`}>No PDF loaded.</p>
                  )}
                  {pdfProxy &&
                    Array.from({ length: Math.min(pageCount, 24) }, (_, idx) => idx + 1).map(
                      (p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => goToPage(p)}
                          className={`w-full p-2 rounded border flex flex-col items-center gap-1 ${
                            pageNumber === p
                              ? 'border-blue-600 ring-1 ring-blue-500'
                              : dark
                                ? 'border-[#2c3444]'
                                : 'border-[#e5e7eb]'
                          }`}
                        >
                          <canvas
                            ref={(el) => {
                              thumbCanvasRefs.current[p] = el;
                            }}
                            className="bg-white shadow-sm max-w-full"
                          />
                          <span className={mutedTxt}>Page {p}</span>
                        </button>
                      ),
                    )}
                </>
              )}

              {leftTab === 'outline' && (
                <div>
                  {outline.length === 0 ? (
                    <p className={`py-6 text-center ${mutedTxt}`}>
                      Document contains no outline entries.
                    </p>
                  ) : (
                    outline.map((item, idx) => (
                      <button
                        key={`${item.title}-${idx}`}
                        type="button"
                        onClick={() => item.pageNumber && goToPage(item.pageNumber)}
                        className={`w-full text-left px-2 py-1.5 rounded ${btnHover}`}
                      >
                        <div className="truncate font-medium">{item.title}</div>
                        {item.pageNumber && (
                          <div className={`text-[11px] ${mutedTxt}`}>Page {item.pageNumber}</div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}

              {leftTab === 'bookmarks' && (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={toggleBookmark}
                    disabled={!activeDoc}
                    className="w-full py-1.5 px-2 rounded border border-dashed text-center font-medium disabled:opacity-40"
                  >
                    {isBookmarked ? `Remove Page ${pageNumber}` : `+ Bookmark Page ${pageNumber}`}
                  </button>
                  {(!activeDoc || activeDoc.bookmarks.length === 0) && (
                    <p className={`text-center py-4 ${mutedTxt}`}>No bookmarked pages yet.</p>
                  )}
                  {activeDoc?.bookmarks.map((bm) => (
                    <button
                      key={bm}
                      type="button"
                      onClick={() => goToPage(bm)}
                      className={`w-full text-left px-2 py-1.5 rounded flex items-center justify-between ${btnHover}`}
                    >
                      <span>Page {bm}</span>
                      <Bookmark className="w-3 h-3 text-amber-500" />
                    </button>
                  ))}
                </div>
              )}

              {leftTab === 'library' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">Local Documents ({docs.length})</span>
                    <button
                      type="button"
                      onClick={() => void handleOpenPicker()}
                      className="text-blue-600 hover:underline font-medium"
                    >
                      + Import
                    </button>
                  </div>
                  {docs.length === 0 && (
                    <p className={`py-4 ${mutedTxt}`}>
                      Import a local PDF file or open the sample document.
                    </p>
                  )}
                  {docs.map((d) => (
                    <div
                      key={d.id}
                      className={`p-2 rounded border space-y-1 ${
                        d.id === activeDocId
                          ? 'border-blue-600'
                          : dark
                            ? 'border-[#2c3444]'
                            : 'border-[#e5e7eb]'
                      }`}
                    >
                      <button
                        type="button"
                        className="w-full text-left font-medium truncate hover:underline"
                        onClick={() => {
                          setOpenTabIds((prev) => (prev.includes(d.id) ? prev : [...prev, d.id]));
                          setActiveDocId(d.id);
                        }}
                      >
                        {d.title}
                      </button>
                      <div className={`text-[11px] flex justify-between ${mutedTxt}`}>
                        <span>
                          {d.pageCount}p · {formatBytes(d.fileSizeBytes)}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void p2pApi.deletePdfDocument(d.id).then(() => {
                              setDocs((prev) => prev.filter((x) => x.id !== d.id));
                              setOpenTabIds((prev) => prev.filter((x) => x !== d.id));
                              if (activeDocId === d.id) setActiveDocId(null);
                            });
                          }}
                          className="text-red-500 hover:text-red-400"
                          title="Remove from local library"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Main PDF Viewport */}
        <main
          ref={viewportWrapRef}
          className="flex-1 overflow-auto flex flex-col items-center justify-start p-6 relative"
        >
          {dragActive && (
            <div className="absolute inset-4 z-30 border-2 border-dashed border-blue-500 bg-blue-500/10 rounded-xl flex flex-col items-center justify-center pointer-events-none">
              <Upload className="w-10 h-10 text-blue-500 mb-2" />
              <p className="text-sm font-semibold">Drop local PDF file to open offline</p>
            </div>
          )}

          {docError && (
            <div className="mb-4 max-w-xl w-full rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-500">
              {docError}
            </div>
          )}

          {passwordNeeded && activeDoc && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void openPdfFromRecord(activeDoc, pdfPassword);
              }}
              className={`max-w-sm w-full rounded-xl border p-5 space-y-3 shadow-lg ${barBg}`}
            >
              <div className="flex items-center gap-2 font-semibold text-sm">
                <Lock className="w-4 h-4 text-amber-500" />
                Password-Protected PDF
              </div>
              <p className={`text-xs ${mutedTxt}`}>
                Enter the password embedded in “{activeDoc.filename}” to view its contents.
              </p>
              <input
                type="password"
                value={pdfPassword}
                onChange={(e) => setPdfPassword(e.target.value)}
                placeholder="Document password"
                className={`w-full rounded border px-3 py-2 text-xs ${inputCls}`}
              />
              <button
                type="submit"
                className="w-full py-2 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
              >
                Open Document
              </button>
            </form>
          )}

          {!activeDoc && !passwordNeeded && (
            <div
              data-testid="pdf-welcome-screen"
              className={`my-auto max-w-md w-full rounded-xl border p-8 text-center space-y-4 shadow-sm ${barBg}`}
            >
              <div className="mx-auto w-12 h-12 rounded-full bg-blue-500/10 text-blue-600 flex items-center justify-center">
                <FileText className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h1 className="text-lg font-semibold">Document Reader</h1>
                <p className={`text-xs leading-relaxed ${mutedTxt}`}>
                  Open or drag and drop any local PDF document. All files stay on this computer and
                  render completely offline.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void handleOpenPicker()}
                  className="w-full sm:w-auto px-4 py-2 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                >
                  Import Local PDF
                </button>
                <button
                  type="button"
                  onClick={() => void handleOpenSamplePdf()}
                  className={`w-full sm:w-auto px-4 py-2 rounded border text-xs font-medium ${barBg} ${btnHover}`}
                >
                  Open Sample Reference PDF
                </button>
              </div>
            </div>
          )}

          {pdfProxy && !passwordNeeded && (
            <div className="relative shadow-xl bg-white rounded-sm">
              <canvas ref={canvasRef} className="block" />
              <div ref={textLayerRef} className="textLayer" />
            </div>
          )}

          {metadataOpen && activeDoc && (
            <div
              className={`fixed top-14 right-4 z-40 w-80 rounded-xl border p-4 shadow-2xl text-xs space-y-2 ${barBg}`}
            >
              <div className="flex items-center justify-between font-semibold">
                <span>Document Properties</span>
                <button type="button" onClick={() => setMetadataOpen(false)}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-1">
                <div>
                  <span className={mutedTxt}>Title: </span>
                  {metadata.title || activeDoc.title}
                </div>
                <div>
                  <span className={mutedTxt}>File: </span>
                  {activeDoc.filename}
                </div>
                <div>
                  <span className={mutedTxt}>Pages: </span>
                  {pageCount}
                </div>
                <div>
                  <span className={mutedTxt}>Size: </span>
                  {formatBytes(activeDoc.fileSizeBytes)}
                </div>
                <div>
                  <span className={mutedTxt}>SHA-256: </span>
                  <span className="font-mono">{activeDoc.sha256Hex.slice(0, 16)}...</span>
                </div>
                {metadata.author && (
                  <div>
                    <span className={mutedTxt}>Author: </span>
                    {metadata.author}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Bottom Status Bar (+ strictly redacted active media status when user configured call continuity) */}
      <footer
        className={`flex items-center justify-between px-3 py-1.5 border-t text-[11px] ${barBg} ${mutedTxt}`}
      >
        <div className="flex items-center gap-3 truncate">
          <span className="truncate">{activeDoc ? activeDoc.filename : 'Ready'}</span>
          {pdfProxy && (
            <span>
              Page {pageNumber} of {pageCount}
            </span>
          )}
          <span>{Math.round(renderedScale * 100)}%</span>
          {rotation > 0 && <span>{rotation}°</span>}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {bootstrap.callSummary.inCall && (
            <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-600 font-medium">
              Audio Session Active
              {bootstrap.callSummary.micMuted ? ' · Mic Muted' : ''}
              {bootstrap.callSummary.screenSharingActive ? ' · Sharing Screen' : ''}
            </span>
          )}
          <span>Offline Local Mode</span>
        </div>
      </footer>

      {/* Discreet Command / Hidden Shortcut Unlock Overlay (never shows plaintext secrets) */}
      {unlockModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Reader Access Prompt"
        >
          <form
            onSubmit={handleSubmitMaskedUnlock}
            className={`max-w-md w-full rounded-xl border p-5 shadow-2xl space-y-4 ${barBg}`}
          >
            <div className="flex items-center justify-between">
              <div className="font-semibold text-sm flex items-center gap-2">
                <Lock className="w-4 h-4 text-blue-600" />
                {recoveryMode
                  ? 'Recovery Key Verification'
                  : needsAdditionalFactor
                    ? 'Secondary Factor Required'
                    : 'Enter Command / Access Code'}
              </div>
              <button
                type="button"
                onClick={() => {
                  setUnlockModalOpen(false);
                  setUnlockInput('');
                  setAdditionalSecret('');
                  setNeedsAdditionalFactor(false);
                  setRecoveryMode(false);
                }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {!recoveryMode && !needsAdditionalFactor && (
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {(
                  [
                    ['hidden_shortcut_input', 'Secret Code'],
                    ['discreet_command', 'Command'],
                    ['passphrase', 'Passphrase'],
                    ['pin', 'PIN'],
                    ['windows_hello', 'Windows Hello'],
                  ] as const
                )
                  .filter(([m]) => bootstrap.enabledUnlockMethods.includes(m))
                  .map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setUnlockMethodChoice(m)}
                      className={`px-2 py-1 rounded border ${
                        unlockMethodChoice === m
                          ? 'bg-blue-600 text-white border-blue-600'
                          : barBg
                      }`}
                    >
                      {label}
                    </button>
                  ))}
              </div>
            )}

            {recoveryMode ? (
              <input
                type="password"
                value={recoveryInput}
                onChange={(e) => setRecoveryInput(e.target.value)}
                placeholder="CLK-..."
                autoFocus
                className={`w-full rounded border px-3 py-2 text-xs ${inputCls}`}
              />
            ) : unlockMethodChoice === 'windows_hello' && !needsAdditionalFactor ? (
              <div className={`text-xs ${mutedTxt}`}>
                Windows Hello status: {bootstrap.windowsHelloStatus}
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  ref={hiddenUnlockInputRef}
                  type="password"
                  value={needsAdditionalFactor ? additionalSecret : unlockInput}
                  onChange={(e) =>
                    needsAdditionalFactor
                      ? setAdditionalSecret(e.target.value)
                      : setUnlockInput(e.target.value)
                  }
                  placeholder={
                    needsAdditionalFactor
                      ? 'Enter additional passphrase or PIN'
                      : 'Enter secret code, passphrase, or PIN'
                  }
                  autoComplete="off"
                  className={`w-full rounded border px-3 py-2 text-xs ${inputCls}`}
                />
                {!needsAdditionalFactor && bootstrap.requireAdditionalAuth && (
                  <input
                    type="password"
                    value={additionalSecret}
                    onChange={(e) => setAdditionalSecret(e.target.value)}
                    placeholder="Additional passphrase / PIN (if required)"
                    autoComplete="off"
                    className={`w-full rounded border px-3 py-2 text-xs ${inputCls}`}
                  />
                )}
              </div>
            )}

            {unlockFeedback && (
              <div className="text-xs text-amber-500" role="alert">
                {unlockFeedback}
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => {
                  setRecoveryMode((v) => !v);
                  setUnlockFeedback(null);
                }}
                className={`text-[11px] hover:underline ${mutedTxt}`}
              >
                {recoveryMode ? 'Back to standard unlock' : 'Use recovery key'}
              </button>
              <button
                type="submit"
                disabled={busyUnlock}
                className="px-4 py-1.5 rounded bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {busyUnlock ? 'Verifying...' : 'Submit'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
