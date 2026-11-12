import React, { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { bootVaultOnStartup } from './lib/workspaceClient.js';

const ArchiveViewerPage = React.lazy(() =>
  import('./pages/ArchiveViewerPage.js').then((m) => ({ default: m.ArchiveViewerPage })),
);
const InviteLandingPage = React.lazy(() =>
  import('./pages/InviteLandingPage.js').then((m) => ({ default: m.InviteLandingPage })),
);
const P2pWorkspacePage = React.lazy(() =>
  import('./pages/P2pWorkspacePage.js').then((m) => ({ default: m.P2pWorkspacePage })),
);
const WorkspacePage = React.lazy(() =>
  import('./pages/WorkspacePage.js').then((m) => ({ default: m.WorkspacePage })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function RouteLoadingFallback() {
  return (
    <div className="min-h-screen bg-[var(--cloak-bg-void)] text-[var(--cloak-text-muted)] flex items-center justify-center text-xs">
      Loading Cloak workspace...
    </div>
  );
}

export function App() {
  useEffect(() => {
    void bootVaultOnStartup();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            <Route path="/" element={<WorkspacePage />} />
            <Route path="/invite" element={<InviteLandingPage />} />
            <Route path="/invite/:token" element={<InviteLandingPage />} />
            <Route path="/archive" element={<ArchiveViewerPage />} />
            <Route path="/p2p" element={<P2pWorkspacePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

