import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const VISUAL_QA_STEALTH_DIR = path.resolve(process.cwd(), 'docs/visual-qa/stealth-mode');

async function waitForBootstrap(baseUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/p2p/v1/stealth/bootstrap`, {
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

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, `Horizontal overflow at ${label}`).toBeLessThanOrEqual(
    overflow.clientWidth + 2,
  );
}

async function stopProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode === null) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3500);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      proc.kill('SIGKILL');
    });
  }
}

async function stopAndClean(proc: ChildProcess, dir: string): Promise<void> {
  await stopProc(proc);
  await fs
    .rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 })
    .catch(() => undefined);
}

function minimalSecondPdfBuffer(): Buffer {
  const txt =
    '%PDF-1.4\n' +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n' +
    '4 0 obj << /Length 74 >> stream\nBT /F1 14 Tf 72 720 Td (Engineering Memo: Offline Storage Audit) Tj ET\nendstream\nendobj\n' +
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n' +
    'xref\n0 6\n0000000000 65535 f \ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n';
  return Buffer.from(txt, 'utf8');
}

test.describe('Cloak Phase 10 Stealth Mode + Offline PDF Decoy + Secret Unlock + Timers E2E', () => {
  test('Full Stealth lifecycle: 6-tab config, real PDF.js decoy, secret unlock, route isolation, restart persistence & visual QA', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    await fs.mkdir(VISUAL_QA_STEALTH_DIR, { recursive: true });

    const desktopExe = path.resolve(process.cwd(), 'target/release/cloak-desktop.exe');
    await fs.access(desktopExe);

    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-e2e-s10-a-'));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'cloak-e2e-s10-b-'));
    const tokA = 'e2e-tok-s10-alice-12345';
    const tokB = 'e2e-tok-s10-bob-67890';
    const urlA = 'http://127.0.0.1:14541';
    const urlB = 'http://127.0.0.1:14542';

    const spawnA = () =>
      spawn(desktopExe, [
        '--headless',
        '--data-dir',
        dirA,
        '--p2p-bind',
        '127.0.0.1:14551',
        '--http-port',
        '14541',
        '--api-token',
        tokA,
        '--name',
        'StealthAlice',
      ]);

    let procA = spawnA();
    const procB = spawn(desktopExe, [
      '--headless',
      '--data-dir',
      dirB,
      '--p2p-bind',
      '127.0.0.1:0',
      '--http-port',
      '14542',
      '--api-token',
      tokB,
      '--name',
      'StealthBob',
    ]);

    try {
      await Promise.all([waitForBootstrap(urlA, tokA), waitForBootstrap(urlB, tokB)]);

      const ctxA = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        permissions: ['microphone', 'camera'],
      });
      const ctxB = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        permissions: ['microphone', 'camera'],
      });
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      // Track zero unexpected network failures to external hosts
      const externalRequests: string[] = [];
      pageA.on('request', (req) => {
        const u = req.url();
        if (u.startsWith('http://') || u.startsWith('https://')) {
          if (!u.startsWith(urlA)) externalRequests.push(u);
        }
      });

      await pageA.goto(`${urlA}/p2p#cloakToken=${tokA}`);
      await pageB.goto(`${urlB}/p2p#cloakToken=${tokB}`);
      await expect(pageA.getByText('StealthAlice')).toBeVisible({ timeout: 15_000 });
      await expect(pageB.getByText('StealthBob')).toBeVisible({ timeout: 15_000 });

      // Create private room and pair Bob so we test real cross-peer privacy preservation
      await pageA.getByPlaceholder('New private room...').fill('Hidden Ops Vault');
      await pageA.getByRole('button', { name: 'Create P2P Room' }).click();
      await expect(pageA.getByRole('heading', { name: 'Hidden Ops Vault' })).toBeVisible();

      await pageA.getByRole('button', { name: 'Generate Ticket' }).click();
      const ticketUri = await pageA.getByLabel('Shareable pairing ticket').inputValue();
      await pageB.getByPlaceholder('Paste peer cloakp2p://... ticket').fill(ticketUri);
      await pageB.getByRole('button', { name: 'Pair & Connect Directly' }).click();
      await expect(pageB.getByRole('heading', { name: 'Hidden Ops Vault' })).toBeVisible();

      // Send two messages: one viewed by Alice, one kept unread later
      const msgBoxA = pageA.getByPlaceholder(/Direct encrypted message/i);
      await msgBoxA.fill('Alpha classified note (viewed)');
      await pageA.getByRole('button', { name: 'Send' }).click();
      await expect(pageA.getByText('Alpha classified note (viewed)')).toBeVisible();
      await expect(pageB.getByText('Alpha classified note (viewed)')).toBeVisible();

      // Dwell so Alpha becomes Viewed locally
      await expect(pageA.locator('[title="Viewed in local viewport"]').first()).toBeVisible({
        timeout: 6000,
      });

      // Open Stealth & PDF Settings Modal and inspect all 6 tabs visually!
      await pageA.getByTestId('stealth-settings-btn').click();
      await expect(
        pageA.getByRole('heading', { name: /Privacy, Stealth Mode & Ghost Automation/i }),
      ).toBeVisible();

      // Tab 1: Appearance -> enable Stealth + Launch into PDF Reader
      await pageA.getByLabel(/Enable Stealth & Cover System/i).check();
      await pageA.getByLabel('Default Launch Interface').selectOption('pdf_reader');
      await pageA.getByLabel('PDF Reader Theme').selectOption('light');
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '07-stealth-settings-appearance.png') });

      // Tab 2: Unlock & Secret Codes -> configure user-defined hashtag & settings codes
      await pageA.getByRole('button', { name: /Unlock & Codes/i }).click();
      await pageA.getByPlaceholder('Label (e.g. Primary Access)').fill('Phoenix Gate');
      await pageA
        .getByPlaceholder('Secret code or phrase (hashed with Argon2id)')
        .fill('#project_phoenix 2026');
      await pageA.getByRole('button', { name: /Add Secret Code/i }).click();
      await expect(pageA.getByText('Phoenix Gate', { exact: true })).toBeVisible();

      await pageA.getByPlaceholder('Label (e.g. Primary Access)').fill('Vault Config');
      await pageA
        .getByPlaceholder('Secret code or phrase (hashed with Argon2id)')
        .fill('#open-cfg');
      await pageA.getByLabel('Secret Code Action').selectOption('open_privacy_settings');
      await pageA.getByRole('button', { name: /Add Secret Code/i }).click();
      await expect(pageA.getByText('Vault Config', { exact: true })).toBeVisible();

      await pageA.getByPlaceholder('Label (e.g. Primary Access)').fill('Temp Key');
      await pageA
        .getByPlaceholder('Secret code or phrase (hashed with Argon2id)')
        .fill('temp-removable-key');
      await pageA.getByLabel('Secret Code Action').selectOption('open_messenger');
      await pageA.getByRole('button', { name: /Add Secret Code/i }).click();
      await expect(pageA.getByText('Temp Key', { exact: true })).toBeVisible();

      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '08-stealth-settings-unlock-codes.png') });

      // Tab 3: Triggers & Timers -> enable Background Away (60s)
      await pageA.getByRole('button', { name: /Triggers & Timers/i }).click();
      await pageA.getByLabel(/Background-Away Timer/i).check();
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '09-stealth-settings-triggers-timers.png') });

      // Tab 4: Actions, Calls & Notices -> configure visual action & voice call continuity
      await pageA.getByRole('button', { name: /Actions, Calls/i }).click();
      await pageA.getByLabel('Visual Stealth Action').selectOption('switch_to_pdf');
      await pageA.getByLabel(/Voice Call/i).selectOption('continue');
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '10-stealth-settings-calls-notifications.png') });

      // Tab 5: Ghost Mode
      await pageA.getByRole('button', { name: /Ghost Mode/i }).click();
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '11-stealth-settings-ghost-mode.png') });

      // Tab 6: Rules & Test Mode -> run non-destructive preview!
      await pageA.getByRole('button', { name: /Rules & Test Mode/i }).click();
      await pageA.getByRole('button', { name: 'Run Safe Test Preview' }).click();
      await expect(pageA.getByTestId('stealth-test-preview-result')).toBeVisible();
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '12-stealth-settings-rules-testmode.png') });

      // Save Stealth configuration
      await pageA.getByRole('button', { name: 'Save Privacy & Stealth Settings' }).click();
      await expect(pageA.getByTestId('stealth-settings-btn')).toContainText('Stealth: PDF Armed');

      // Stage an unsent draft message to verify composer draft clears when Stealth locks!
      await msgBoxA.fill('unsaved secret draft');

      // Switch to PDF Reader / Lock -> verify composer cleared, messenger DOM unmounted, welcome PDF screen shown
      await pageA.getByTestId('stealth-lock-btn').click();
      await expect(pageA.getByTestId('pdf-welcome-screen')).toBeVisible({ timeout: 8000 });
      expect(await pageA.title()).toBe('Document Reader');
      expect(await pageA.content()).not.toContain('Hidden Ops Vault');
      expect(await pageA.content()).not.toContain('Alpha classified note');
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '01-pdf-welcome-empty.png') });

      // While locked: private routes strictly return 403 STEALTH_LOCKED!
      const lockedRooms = await fetch(`${urlA}/p2p/v1/rooms`, {
        headers: { Authorization: `Bearer ${tokA}` },
      });
      expect(lockedRooms.status).toBe(403);
      const lockedBody = await lockedRooms.text();
      expect(lockedBody).toContain('STEALTH_LOCKED');

      // Open bundled offline 3-page Sample Reference PDF in PDF.js reader
      await pageA.getByRole('button', { name: 'Open Sample Reference PDF' }).click();
      const canvas = pageA.locator('[data-testid="pdf-reader-shell"] main canvas').first();
      await expect(canvas).toBeVisible({ timeout: 10_000 });
      await expect(pageA.getByText(/Page 1 of 3/i)).toBeVisible();
      // Confirm PDF canvas actually rendered pixels and TextLayer contains real selectable text!
      const canvasSize = await canvas.evaluate((el) => ({
        w: (el as HTMLCanvasElement).width,
        h: (el as HTMLCanvasElement).height,
      }));
      expect(canvasSize.w).toBeGreaterThan(200);
      expect(canvasSize.h).toBeGreaterThan(200);
      await expect(pageA.locator('.textLayer')).toContainText(/Quarterly|Operations/i);
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '02-pdf-document-open-light.png') });

      // Navigate pages, toggle Dark Theme, Rotate 90°, Bookmark page 2
      await pageA.getByLabel('Next Page').click();
      await expect(pageA.getByText(/Page 2 of 3/i)).toBeVisible();
      await pageA.getByLabel('Toggle Reader Theme').click();
      await pageA.getByLabel('Rotate Page').click();
      await pageA.getByLabel('Toggle Bookmark').click();
      await pageA.getByRole('button', { name: 'Saved', exact: true }).click();
      await expect(pageA.getByRole('button', { name: /^Page 2$/i })).toBeVisible();
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '03-pdf-document-dark-bookmarks.png') });

      // Reset rotation + switch back to light mode, test Document Properties & Real PDF Search
      await pageA.getByLabel('Rotate Page').click();
      await pageA.getByLabel('Rotate Page').click();
      await pageA.getByLabel('Rotate Page').click();
      await pageA.getByLabel('Toggle Reader Theme').click();
      await pageA.getByLabel('Document Info').click();
      await pageA.getByRole('button', { name: 'Outline', exact: true }).click();
      const pdfSearch = pageA.getByLabel('Search in document');
      await pdfSearch.fill('thermal monitoring');
      await pdfSearch.press('Enter');
      await expect(pageA.getByText(/Page 3 of 3/i)).toBeVisible({ timeout: 6000 });
      await expect(pageA.getByText('1/1')).toBeVisible();
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '04-pdf-outline-and-properties.png') });
      await pageA.getByLabel('Document Info').click();

      // Test corrupt file rejection AND second real PDF import + multi-tab Library view
      const corruptInput = pageA.locator('[data-testid="pdf-reader-shell"] input[type="file"]');
      await corruptInput.setInputFiles({
        name: 'broken.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('NOT A REAL PDF FILE', 'utf8'),
      });
      await expect(pageA.getByText(/valid %PDF- document header/i)).toBeVisible({ timeout: 5000 });

      await corruptInput.setInputFiles({
        name: 'audit-memo.pdf',
        mimeType: 'application/pdf',
        buffer: minimalSecondPdfBuffer(),
      });
      await expect(pageA.locator('.textLayer')).toContainText(/Offline Storage Audit/i, { timeout: 8000 });
      await pageA.getByRole('button', { name: 'Library', exact: true }).click();
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '05-pdf-multi-tab-library.png') });

      // Test restart persistence: kill & restart Cloak Desktop -> MUST boot locked directly into PDF decoy!
      await stopProc(procA);
      procA = spawnA();
      await waitForBootstrap(urlA, tokA);
      await pageA.goto('about:blank');
      await pageA.goto(`${urlA}/p2p#cloakToken=${tokA}`);
      await expect(pageA.getByTestId('pdf-reader-shell')).toBeVisible({ timeout: 12_000 });
      expect(await pageA.content()).not.toContain('Hidden Ops Vault');

      // Test rate limiting via hidden Ctrl+Shift+U unlock overlay -> wrong codes throttle without leaking
      await pageA.keyboard.press('Control+Shift+U');
      const unlockDialog = pageA.getByRole('dialog', { name: 'Reader Access Prompt' });
      await expect(unlockDialog).toBeVisible();
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '06-pdf-hidden-unlock-overlay.png') });

      const modalInput = unlockDialog.getByPlaceholder('Enter secret code, passphrase, or PIN');
      for (const bad of ['wrong1', 'wrong2', 'wrong3']) {
        await modalInput.fill(bad);
        await unlockDialog.getByRole('button', { name: 'Submit', exact: true }).click();
      }
      await expect(unlockDialog.getByText(/Too many|cooldown|try again|throttle/i)).toBeVisible({ timeout: 5000 });

      // Advance deterministic server test clock past cooldown
      await fetch(`${urlA}/p2p/v1/stealth/test-clock-advance`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deltaMs: 20_000 }),
      });

      // Test hidden command unlock opening privacy settings directly (#open-cfg), then close
      await modalInput.fill('#open-cfg');
      await unlockDialog.getByRole('button', { name: 'Submit', exact: true }).click();
      await expect(
        pageA.getByRole('heading', { name: /Privacy, Stealth Mode & Ghost Automation/i }),
      ).toBeVisible({
        timeout: 8000,
      });

      // Remove Temp Key and verify removed secret code no longer works
      await pageA.getByRole('button', { name: /Unlock & Codes/i }).click();
      await pageA.getByLabel('Remove Temp Key').click();
      await pageA.getByRole('button', { name: 'Cancel' }).click();

      // Switch to PDF via Panic/Lock, confirm composer draft was empty, test removed key fails, then unlock via PDF search!
      await expect(pageA.getByPlaceholder(/Direct encrypted message/i)).toHaveValue('');
      await pageA.getByTestId('stealth-lock-btn').click();
      await expect(pageA.getByTestId('pdf-reader-shell')).toBeVisible();

      const pdfSearch2 = pageA.getByLabel('Search in document');
      await pdfSearch2.fill('temp-removable-key');
      await pdfSearch2.press('Enter');
      await expect(pageA.getByTestId('pdf-reader-shell')).toBeVisible(); // stays in PDF mode

      // Unlock via user secret hashtag code in PDF search bar -> opens Messenger immediately!
      await pdfSearch2.fill('#project_phoenix 2026');
      await pdfSearch2.press('Enter');
      await expect(pageA.getByRole('heading', { name: 'Hidden Ops Vault' })).toBeVisible({
        timeout: 8000,
      });

      // Capture 1920x1080 unlocked messenger visual QA + overflow check
      await pageA.setViewportSize({ width: 1920, height: 1080 });
      await assertNoHorizontalOverflow(pageA, 'unlocked messenger 1920x1080');
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '14-unlocked-messenger-1920x1080.png') });

      // Start WebRTC voice call while unlocked, then switch to PDF decoy -> non-leaky generic call pill appears!
      await pageA.setViewportSize({ width: 1280, height: 720 });
      await pageA.getByRole('button', { name: 'Voice' }).click();
      await expect(pageA.getByText(/Direct WebRTC · Voice/i)).toBeVisible({ timeout: 8000 });
      await pageA.getByTestId('switch-pdf-btn').click();
      await expect(pageA.getByTestId('pdf-reader-shell')).toBeVisible();
      await expect(pageA.locator('[data-testid="pdf-reader-shell"] main canvas').first()).toBeVisible({ timeout: 5000 });
      await expect(pageA.getByText(/Audio Session Active/i)).toBeVisible({ timeout: 5000 });
      expect(await pageA.content()).not.toContain('StealthBob');
      expect(await pageA.content()).not.toContain('Hidden Ops Vault');
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '13-pdf-call-indicator-concealed.png') });

      // Responsive layout & visual QA of PDF Decoy at 1366x768 and narrow 720x640
      await pageA.setViewportSize({ width: 1366, height: 768 });
      await assertNoHorizontalOverflow(pageA, 'pdf decoy 1366x768');
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '15-pdf-decoy-1366x768.png') });

      await pageA.setViewportSize({ width: 720, height: 640 });
      await assertNoHorizontalOverflow(pageA, 'pdf decoy 720x640');
      await pageA.screenshot({ path: path.join(VISUAL_QA_STEALTH_DIR, '16-pdf-decoy-narrow-window.png') });

      // Return to messenger (still unlocked because PDF Cover switched surface without locking, or unlock if locked)
      await pageA.setViewportSize({ width: 1280, height: 720 });
      await pageA.getByLabel('Search in document').fill('#project_phoenix 2026');
      await pageA.getByLabel('Search in document').press('Enter');
      await expect(pageA.getByRole('heading', { name: 'Hidden Ops Vault' })).toBeVisible({
        timeout: 8000,
      });

      // Deterministic 60s Background-Away + ClearViewed test with unread preservation & non-resurrection!
      const curCfgResp = await fetch(`${urlA}/p2p/v1/stealth/settings`, {
        headers: { Authorization: `Bearer ${tokA}` },
      });
      expect(curCfgResp.ok).toBeTruthy();
      const curCfg = (await curCfgResp.json()) as Record<string, unknown>;
      const putCfgResp = await fetch(`${urlA}/p2p/v1/stealth/settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...curCfg,
          timers: {
            backgroundAwayEnabled: true,
            backgroundAwaySeconds: 60,
            backgroundAwayCancelOnReturn: true,
            backgroundAwayPreserveDeadline: false,
            backgroundAwayDeletion: 'delete_viewed_local',
            foregroundIdleEnabled: false,
            foregroundIdleSeconds: 120,
            systemIdleEnabled: false,
            systemIdleSeconds: 300,
          },
        }),
      });
      expect(putCfgResp.ok).toBeTruthy();

      // Ensure Bob <-> Alice P2P session is reconnected after Alice's restart before blurring
      const retryBtnB = pageB.getByRole('button', { name: 'Retry' });
      if (await retryBtnB.isVisible().catch(() => false)) {
        await retryBtnB.click();
      }
      await expect
        .poll(
          async () => {
            const r = await fetch(`${urlA}/p2p/v1/status`, {
              headers: { Authorization: `Bearer ${tokA}` },
            });
            const j = (await r.json()) as { activePeerIds?: string[] };
            return j.activePeerIds?.length ?? 0;
          },
          { timeout: 10_000 },
        )
        .toBe(1);

      // Bob sends Beta while Alice is blurred so Beta stays unread on Alice!
      const trigResp = await fetch(`${urlA}/p2p/v1/stealth/trigger`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ trigger: 'alt_tab' }),
      });
      expect(trigResp.ok).toBeTruthy();
      const trigBoot = (await trigResp.json()) as {
        activeSurface?: string;
        locked?: boolean;
        lifecycleState?: string;
      };
      expect(trigBoot.activeSurface).toBe('pdf_reader');
      await expect(pageA.getByTestId('pdf-reader-shell')).toBeVisible();

      await pageB.getByPlaceholder(/Direct encrypted message/i).fill('Beta unread message');
      await pageB.getByRole('button', { name: 'Send' }).click();
      await expect(pageB.getByText('Beta unread message')).toBeVisible();

      // Advance deterministic server clock by 65s -> BackgroundAwayTimeout wipes Alpha (viewed), preserves Beta (unread)!
      const advResp = await fetch(`${urlA}/p2p/v1/stealth/test-clock-advance`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deltaMs: 65_000 }),
      });
      expect(advResp.ok).toBeTruthy();
      const advBoot = (await advResp.json()) as { activeSurface?: string; locked?: boolean };
      expect(advBoot.activeSurface).toBe('pdf_reader');
      await expect(pageA.getByTestId('pdf-reader-shell')).toBeVisible();

      // Unlock Alice -> Alpha is erased locally, Beta is intact, and Bob STILL keeps Alpha!
      await pageA.getByLabel('Search in document').fill('#project_phoenix 2026', { timeout: 5000 });
      await pageA.getByLabel('Search in document').press('Enter');
      await expect(pageA.getByRole('heading', { name: 'Hidden Ops Vault' })).toBeVisible({
        timeout: 8000,
      });
      await expect(pageA.getByText('Alpha classified note (viewed)')).toHaveCount(0);
      await expect(pageA.getByText('Beta unread message')).toBeVisible({ timeout: 6000 });
      await expect(pageB.getByText('Alpha classified note (viewed)')).toBeVisible();

      // Zero external network fetches were made during PDF rendering or Stealth operation!
      expect(externalRequests).toEqual([]);

      await ctxA.close();
      await ctxB.close();
    } finally {
      await stopAndClean(procA, dirA);
      await stopAndClean(procB, dirB);
    }
  });
});

