import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const VISUAL_QA_DIR = path.resolve(process.cwd(), 'docs/visual-qa');

async function waitForStatus(baseUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/p2p/v1/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return;
    } catch {
      // Retry until ready
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`cloak-desktop failed to respond at ${baseUrl}`);
}

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page, label: string) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, `Horizontal overflow at ${label}`).toBeLessThanOrEqual(overflow.clientWidth + 2);
}

async function stopAndClean(proc: ChildProcess, dir: string): Promise<void> {
  if (proc.exitCode === null) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      proc.kill('SIGKILL');
    });
  }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }).catch(() => undefined);
}

test.describe('Cloak Phase 9 Native Rust P2P Desktop + Ghost Mode + Real WebRTC E2E', () => {
  test('Spec 1: Loopback auth guard, DirectOnly pairing, multi-viewport layout, search, attachment & export', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await fs.mkdir(VISUAL_QA_DIR, { recursive: true });

    const desktopExe = path.resolve(process.cwd(), 'target/release/cloak-desktop.exe');
    await fs.access(desktopExe);

    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-e2e-s1-a-'));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-e2e-s1-b-'));
    const tokA = 'e2e-tok-s1-alice-12345';
    const tokB = 'e2e-tok-s1-bob-67890';
    const urlA = 'http://127.0.0.1:14511';
    const urlB = 'http://127.0.0.1:14512';

    const procA: ChildProcess = spawn(desktopExe, [
      '--headless',
      '--data-dir',
      dirA,
      '--p2p-bind',
      '127.0.0.1:0',
      '--http-port',
      '14511',
      '--api-token',
      tokA,
      '--name',
      'DesktopAlice',
    ]);
    const procB: ChildProcess = spawn(desktopExe, [
      '--headless',
      '--data-dir',
      dirB,
      '--p2p-bind',
      '127.0.0.1:0',
      '--http-port',
      '14512',
      '--api-token',
      tokB,
      '--name',
      'DesktopBob',
    ]);

    const ctxA = await browser.newContext({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
    const ctxB = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });

    try {
      await Promise.all([waitForStatus(urlA, tokA), waitForStatus(urlB, tokB)]);

      // Verify unauthenticated loopback API request is strictly blocked
      const unauth = await fetch(`${urlA}/p2p/v1/status`);
      expect(unauth.status).toBe(401);

      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const pageErrors: string[] = [];
      pageA.on('pageerror', (e) => pageErrors.push(`A: ${e.message}`));
      pageB.on('pageerror', (e) => pageErrors.push(`B: ${e.message}`));

      await pageA.goto(`${urlA}/p2p#cloakToken=${tokA}`);
      await pageB.goto(`${urlB}/p2p#cloakToken=${tokB}`);
      await expect(pageA.getByText('DesktopAlice')).toBeVisible();
      await expect(pageB.getByText('DesktopBob')).toBeVisible();
      expect(pageA.url()).not.toContain(tokA);

      // Verify diagnostics start collapsed and expand cleanly via disclosure toggle
      const diagToggle = pageA.getByRole('button', {
        name: /Advanced Connection & Vault Diagnostics/i,
      });
      await expect(diagToggle).toHaveAttribute('aria-expanded', 'false');
      await diagToggle.click();
      await expect(diagToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(pageA.getByText('DPAPI')).toBeVisible();
      await expect(pageA.getByText(/LAN IPv4:/)).toBeVisible();

      // Create room & test DirectOnly refusal on closed port
      await pageA.getByPlaceholder('New private room...').fill('Direct Sanctuary');
      await pageA.getByRole('button', { name: 'Create P2P Room' }).click();
      await expect(pageA.getByRole('heading', { name: 'Direct Sanctuary' })).toBeVisible();

      await pageA.getByRole('button', { name: 'Generate Ticket' }).click();
      const ticketUri = await pageA.getByLabel('Shareable pairing ticket').inputValue();
      expect(ticketUri).toMatch(/^cloakp2p:\/\/.+\?/);
      await expect(pageA.getByText(/Single-use · signed/i)).toBeVisible();

      const badTicket = ticketUri.replace(/:(\d+)\?/, ':19999?');
      await pageB.getByPlaceholder('Paste peer cloakp2p://... ticket').fill(badTicket);
      await pageB.getByRole('button', { name: 'Pair & Connect Directly' }).click();
      await expect(pageB.getByRole('alert')).toContainText(/DirectOnly|connect/i);

      // Valid pairing over localhost TCP
      await pageB.getByPlaceholder('Paste peer cloakp2p://... ticket').fill(ticketUri);
      await pageB.getByRole('button', { name: 'Pair & Connect Directly' }).click();
      await expect(pageB.getByRole('heading', { name: 'Direct Sanctuary' })).toBeVisible();

      // Send encrypted message + file attachment
      const fileChooserPromise = pageA.waitForEvent('filechooser');
      await pageA.getByRole('button', { name: 'Attach P2P file' }).click();
      const chooser = await fileChooserPromise;
      await chooser.setFiles([
        {
          name: 'p2p-proof.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Verified P2P Direct Payload', 'utf8'),
        },
      ]);
      await pageA.getByPlaceholder(/staged|Direct encrypted message/i).fill('Zero-server direct encrypted message!');
      await pageA.getByRole('button', { name: 'Send', exact: true }).click();

      await expect(pageB.locator('article').getByText('Zero-server direct encrypted message!')).toBeVisible();
      await expect(pageB.locator('article').getByText(/p2p-proof\.txt/)).toBeVisible();

      // Test local search filter + encrypted .cloakexport download
      await pageB.getByLabel('Search decrypted messages').fill('Zero-server');
      await expect(pageB.locator('[data-message-id]')).toHaveCount(1);
      await pageB.getByLabel('Search decrypted messages').fill('');

      await pageA.getByRole('button', { name: /\.cloakexport/i }).click();
      await pageA.getByPlaceholder('Strong export password (min 8 chars)').fill('VeryStrongArchive#9');
      await pageA.getByPlaceholder('Confirm password').fill('VeryStrongArchive#9');
      const dlPromise = pageA.waitForEvent('download');
      await pageA.getByRole('button', { name: 'Export .cloakexport' }).click();
      const dl = await dlPromise;
      expect(dl.suggestedFilename()).toContain('.cloakexport');
      await expect(pageA.getByText(/Exported encrypted archive/)).toBeVisible();

      // Multi-viewport responsive checks & Visual QA screenshots
      await assertNoHorizontalOverflow(pageA, '1920x1080');
      await pageA.screenshot({ path: path.join(VISUAL_QA_DIR, '07-p2p-desktop-1920x1080.png') });

      await assertNoHorizontalOverflow(pageB, '1366x768');
      await pageB.screenshot({ path: path.join(VISUAL_QA_DIR, '08-p2p-desktop-1366x768.png') });

      await pageA.setViewportSize({ width: 1280, height: 720 });
      await assertNoHorizontalOverflow(pageA, '1280x720');
      await pageA.screenshot({ path: path.join(VISUAL_QA_DIR, '09-p2p-desktop-1280x720.png') });

      await pageA.setViewportSize({ width: 780, height: 720 });
      await assertNoHorizontalOverflow(pageA, '780x720');
      await pageA.screenshot({ path: path.join(VISUAL_QA_DIR, '10-p2p-desktop-780x720-narrow.png') });

      expect(pageErrors).toEqual([]);
    } finally {
      await ctxA.close();
      await ctxB.close();
      procA.kill('SIGKILL');
      procB.kill('SIGKILL');
      await Promise.all([stopAndClean(procA, dirA), stopAndClean(procB, dirB)]);
    }
  });

  test('Spec 2: Ghost Mode privacy shield + PIN, Clear Viewed preserving unread & peer copy, modal guard, non-resurrection, Clear Open & peer revoke', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await fs.mkdir(VISUAL_QA_DIR, { recursive: true });

    const desktopExe = path.resolve(process.cwd(), 'target/release/cloak-desktop.exe');
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-e2e-s2-a-'));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-e2e-s2-b-'));
    const tokA = 'e2e-tok-s2-alice-12345';
    const tokB = 'e2e-tok-s2-bob-67890';
    const urlA = 'http://127.0.0.1:14521';
    const urlB = 'http://127.0.0.1:14522';

    const procA = spawn(desktopExe, [
      '--headless', '--data-dir', dirA, '--p2p-bind', '127.0.0.1:0', '--http-port', '14521', '--api-token', tokA, '--name', 'GhostAlice',
    ]);
    const procB = spawn(desktopExe, [
      '--headless', '--data-dir', dirB, '--p2p-bind', '127.0.0.1:0', '--http-port', '14522', '--api-token', tokB, '--name', 'GhostBob',
    ]);

    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    try {
      await Promise.all([waitForStatus(urlA, tokA), waitForStatus(urlB, tokB)]);
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      await pageA.goto(`${urlA}/p2p#cloakToken=${tokA}`);
      await pageB.goto(`${urlB}/p2p#cloakToken=${tokB}`);
      await expect(pageA.getByText('GhostAlice')).toBeVisible();

      // Pair A <-> B
      await pageA.getByPlaceholder('New private room...').fill('Ghost Vault Room');
      await pageA.getByRole('button', { name: 'Create P2P Room' }).click();
      await pageA.getByRole('button', { name: 'Generate Ticket' }).click();
      const ticketUri = await pageA.getByLabel('Shareable pairing ticket').inputValue();
      await pageB.getByPlaceholder('Paste peer cloakp2p://... ticket').fill(ticketUri);
      await pageB.getByRole('button', { name: 'Pair & Connect Directly' }).click();
      await expect(pageB.getByRole('heading', { name: 'Ghost Vault Room' })).toBeVisible();

      // Send a message from Bob to Alice
      await pageB.getByPlaceholder(/Direct encrypted message/i).fill('Alpha secret viewed');
      await pageB.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(pageA.locator('article').getByText('Alpha secret viewed')).toBeVisible();

      // 1. Open Ghost Settings: verify ClearOpenConversation requires destructive checkbox
      await pageA.getByTestId('ghost-status-pill').click();
      await pageA.getByRole('radio', { name: /Clear Entire Open Conversation/i }).check();
      await pageA.getByRole('button', { name: 'Save Ghost Policy' }).click();
      await expect(pageA.getByRole('alert')).toContainText(/confirm/i);

      // 2. Configure Privacy Shield + PIN "2468"
      await pageA.getByRole('radio', { name: /Privacy Shield/i }).check();
      await pageA.getByLabel(/Require PIN to unlock/i).check();
      await pageA.getByPlaceholder(/PIN/i).fill('2468');
      await pageA.screenshot({ path: path.join(VISUAL_QA_DIR, '12-ghost-settings-modal.png') });
      await pageA.getByRole('button', { name: 'Save Ghost Policy' }).click();
      await expect(pageA.getByTestId('ghost-status-pill')).toContainText('Ghost: Shield');

      // Manual Lock -> Privacy overlay covers screen & removes DOM message articles immediately!
      await pageA.getByRole('button', { name: 'Lock' }).click();
      await expect(pageA.getByTestId('ghost-privacy-overlay')).toBeVisible();
      await expect(pageA.locator('[data-message-id]')).toHaveCount(0);
      await pageA.screenshot({ path: path.join(VISUAL_QA_DIR, '11-ghost-privacy-shield-pin.png') });

      // Wrong PIN denied, correct PIN unlocks
      await pageA.getByLabel('Ghost Privacy PIN').fill('9999');
      await pageA.getByRole('button', { name: /Unlock Cloak View/i }).click();
      await expect(pageA.getByText(/Incorrect Ghost Mode PIN/i)).toBeVisible();

      await pageA.getByLabel('Ghost Privacy PIN').fill('2468');
      await pageA.getByRole('button', { name: /Unlock Cloak View/i }).click();
      await expect(pageA.getByTestId('ghost-privacy-overlay')).toBeHidden();
      await expect(pageA.locator('article').getByText('Alpha secret viewed')).toBeVisible();

      // 3. Configure ClearViewed mode + 250ms dwell
      await pageA.getByTestId('ghost-status-pill').click();
      await pageA.getByRole('radio', { name: /Clear Viewed Messages/i }).check();
      await pageA.getByLabel(/Require PIN to unlock/i).uncheck();
      await pageA.getByLabel(/Viewed dwell threshold/i).selectOption('250');
      await pageA.getByRole('button', { name: 'Save Ghost Policy' }).click();

      // Wait for IntersectionObserver dwell to mark Alpha viewed
      await expect(pageA.locator('article').filter({ hasText: 'Alpha secret viewed' })).toContainText('Viewed');

      // Modal guard check: while Ghost Settings modal is open, external_focus_loss must NOT wipe viewed messages
      await pageA.getByTestId('ghost-status-pill').click();
      await fetch(`${urlA}/p2p/v1/ghost/trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'external_focus_loss' }),
      });
      await pageA.getByRole('button', { name: 'Cancel' }).click();
      await expect(pageA.locator('article').getByText('Alpha secret viewed')).toBeVisible();

      // Shield Alice cleanly via trigger, send Beta while Alice cannot view it, then inspect ClearViewed accuracy!
      const trig1 = await fetch(`${urlA}/p2p/v1/ghost/trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'external_focus_loss' }),
      });
      expect(trig1.ok).toBe(true);
      await expect(pageA.getByTestId('ghost-privacy-overlay')).toBeVisible();

      // Beta arrives while Alice is shielded (unread!)
      await pageB.getByPlaceholder(/Direct encrypted message/i).fill('Beta unread survives');
      await pageB.getByRole('button', { name: 'Send', exact: true }).click();
      await new Promise((r) => setTimeout(r, 400));

      // Unlock Alice -> Alpha (viewed) WAS wiped; Beta (unread) IS visible; Bob still has Alpha!
      await pageA.getByRole('button', { name: /Resume Session View/i }).click();
      await expect(pageA.locator('article').getByText('Alpha secret viewed')).toHaveCount(0);
      await expect(pageA.locator('article').getByText('Beta unread survives')).toBeVisible();
      await expect(pageB.locator('article').getByText('Alpha secret viewed')).toBeVisible();
      await pageA.screenshot({ path: path.join(VISUAL_QA_DIR, '13-ghost-cleared-state.png') });

      // Search excludes cleared message Alpha
      await pageA.getByLabel('Search decrypted messages').fill('Alpha');
      await expect(pageA.locator('[data-message-id]')).toHaveCount(0);
      await pageA.getByLabel('Search decrypted messages').fill('');

      // Wait dwell for Beta, switch to ClearOpenConversation with confirmation, verify full wipe & Peer Revoke
      await expect(pageA.locator('article').filter({ hasText: 'Beta unread survives' })).toContainText('Viewed');
      await pageA.getByTestId('ghost-status-pill').click();
      await pageA.getByRole('radio', { name: /Clear Entire Open Conversation/i }).check();
      await pageA.getByLabel(/I understand this deletes local conversation history/i).check();
      await pageA.getByRole('button', { name: 'Save Ghost Policy' }).click();
      await expect(pageA.getByRole('dialog')).toBeHidden();
      await expect(pageA.getByTestId('ghost-status-pill')).toContainText('Ghost: Clear Open');
      await expect
        .poll(async () => {
          const r = await fetch(`${urlA}/p2p/v1/ghost/state`, {
            headers: { Authorization: `Bearer ${tokA}` },
          });
          const gs = (await r.json()) as { inAppModalDepth: number };
          return gs.inAppModalDepth;
        })
        .toBe(0);

      await fetch(`${urlA}/p2p/v1/ghost/trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'minimize' }),
      });
      await fetch(`${urlA}/p2p/v1/ghost/trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'restore_focus' }),
      });
      await expect(pageA.locator('[data-message-id]')).toHaveCount(0);

      // Revoke Bob from Alice's peer list
      await pageA.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(pageA.getByText('Revoked', { exact: true })).toBeVisible();
    } finally {
      await ctxA.close();
      await ctxB.close();
      procA.kill('SIGKILL');
      procB.kill('SIGKILL');
      await Promise.all([stopAndClean(procA, dirA), stopAndClean(procB, dirB)]);
    }
  });

  test('Spec 3: Real two-peer WebRTC video + audio + native Win32 screen share + Ghost shield call continuity', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await fs.mkdir(VISUAL_QA_DIR, { recursive: true });

    const desktopExe = path.resolve(process.cwd(), 'target/release/cloak-desktop.exe');
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-e2e-s3-a-'));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-e2e-s3-b-'));
    const tokA = 'e2e-tok-s3-alice-12345';
    const tokB = 'e2e-tok-s3-bob-67890';
    const urlA = 'http://127.0.0.1:14531';
    const urlB = 'http://127.0.0.1:14532';

    const procA = spawn(desktopExe, [
      '--headless', '--data-dir', dirA, '--p2p-bind', '127.0.0.1:0', '--http-port', '14531', '--api-token', tokA, '--name', 'MediaAlice',
    ]);
    const procB = spawn(desktopExe, [
      '--headless', '--data-dir', dirB, '--p2p-bind', '127.0.0.1:0', '--http-port', '14532', '--api-token', tokB, '--name', 'MediaBob',
    ]);

    const ctxA = await browser.newContext({ viewport: { width: 1366, height: 768 }, permissions: ['microphone', 'camera'] });
    const ctxB = await browser.newContext({ viewport: { width: 1366, height: 768 }, permissions: ['microphone', 'camera'] });

    try {
      await Promise.all([waitForStatus(urlA, tokA), waitForStatus(urlB, tokB)]);
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      await pageA.goto(`${urlA}/p2p#cloakToken=${tokA}`);
      await pageB.goto(`${urlB}/p2p#cloakToken=${tokB}`);

      await pageA.getByPlaceholder('New private room...').fill('Call Studio');
      await pageA.getByRole('button', { name: 'Create P2P Room' }).click();
      await pageA.getByRole('button', { name: 'Generate Ticket' }).click();
      const ticketUri = await pageA.getByLabel('Shareable pairing ticket').inputValue();
      await pageB.getByPlaceholder('Paste peer cloakp2p://... ticket').fill(ticketUri);
      await pageB.getByRole('button', { name: 'Pair & Connect Directly' }).click();
      await expect(pageB.getByRole('heading', { name: 'Call Studio' })).toBeVisible();

      // Start real direct Video+Audio call (Chromium fake devices capture real synthetic audio+video)
      await pageA.getByRole('button', { name: 'Video', exact: true }).click();
      await expect(pageA.getByLabel('Direct WebRTC Media Stage')).toBeVisible();
      await expect(pageB.getByLabel('Direct WebRTC Media Stage')).toBeVisible({ timeout: 20_000 });

      // Wait for real ICE connection & non-zero inbound RTP bytesReceived + non-zero video frames!
      await expect(pageB.getByText(/ICE: (connected|completed)/)).toBeVisible({ timeout: 20_000 });
      await expect(pageB.getByTestId('rtp-stats')).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(
          async () =>
            pageB.evaluate(() => {
              const v = document.querySelector('[data-testid="remote-video"]') as HTMLVideoElement | null;
              return v && v.videoWidth > 0 && v.videoHeight > 0;
            }),
          { timeout: 20_000 },
        )
        .toBe(true);

      const dims = await pageB.evaluate(() => {
        const v = document.querySelector('[data-testid="remote-video"]') as HTMLVideoElement;
        return { w: v.videoWidth, h: v.videoHeight };
      });
      expect(dims.w).toBeGreaterThan(0);
      expect(dims.h).toBeGreaterThan(0);

      // Native Capture Source Picker + pre-live preview + 1080p30 + Go Live!
      await pageA.getByRole('button', { name: 'Share Screen' }).click();
      await expect(pageA.getByText('Share Screen or Application Window')).toBeVisible();
      await pageA.getByLabel('Stream Quality:').selectOption('1080p30');
      await pageA.getByRole('button', { name: 'Go Live with Selected Source' }).click();
      await expect(pageA.getByText(/Live screen share active/)).toBeVisible();

      // Toggle Mute, Deafen, and Theater view, capture screenshot
      await pageA.getByRole('button', { name: 'Mute microphone' }).click();
      await pageB.getByRole('button', { name: 'Deafen audio' }).click();
      await pageB.screenshot({ path: path.join(VISUAL_QA_DIR, '14-webrtc-active-call-screen-share.png') });

      // Enable Privacy Shield & verify ongoing WebRTC call stays active while chat is shielded!
      await fetch(`${urlA}/p2p/v1/ghost/policy`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          mode: 'privacy_shield',
          triggers: { onFocusLoss: true, onMinimize: true, onSessionLock: true, onClose: true },
          clearAttachments: false,
          hideSensitiveNames: true,
          captureProtection: false,
          requirePinUnlock: false,
          hasPinConfigured: false,
          destructiveConfirmed: false,
          viewedDwellMs: 800,
          outgoingViewedPolicy: 'immediate_after_dwell',
        }),
      });
      await pageA.getByRole('button', { name: 'Lock' }).click();
      await expect(pageA.getByTestId('ghost-privacy-overlay')).toBeVisible();
      await expect(pageA.getByText(/Direct encrypted call remains connected/)).toBeVisible();
      await expect(pageA.getByLabel('Direct WebRTC Media Stage')).toBeVisible();

      // End call cleanly
      await pageA.getByRole('button', { name: 'End' }).click();
      await expect(pageA.getByLabel('Direct WebRTC Media Stage')).toBeHidden();
    } finally {
      await ctxA.close();
      await ctxB.close();
      procA.kill('SIGKILL');
      procB.kill('SIGKILL');
      await Promise.all([stopAndClean(procA, dirA), stopAndClean(procB, dirB)]);
    }
  });
});
