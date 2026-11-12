import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArchiveViewerPage } from './pages/ArchiveViewerPage.js';
import { InviteLandingPage } from './pages/InviteLandingPage.js';
import { WorkspacePage } from './pages/WorkspacePage.js';
import { bootVaultOnStartup } from './lib/workspaceClient.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  useEffect(() => {
    void bootVaultOnStartup();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<WorkspacePage />} />
          <Route path="/invite" element={<InviteLandingPage />} />
          <Route path="/invite/:token" element={<InviteLandingPage />} />
          <Route path="/archive" element={<ArchiveViewerPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

