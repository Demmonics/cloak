import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const VISUAL_QA_DIR = path.resolve(process.cwd(), 'docs/visual-qa');

async function ensureVisualQaDir(): Promise<void> {
  await fs.mkdir(VISUAL_QA_DIR, { recursive: true });
}

async function onboardUser(page: Page, displayName: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cloak Private Workspace' })).toBeVisible();
  await page.getByLabel('Display Nickname (optional)').fill(displayName);
  await page.getByRole('button', { name: 'Generate Identity & Enter Cloak' }).click();
  await expect(page.getByRole('button', { name: 'Create Private Room or DM' })).toBeVisible();
}

test.describe('Cloak End-to-End Privacy, Messaging, Export & Visual QA', () => {
  test('two-browser E2EE flow, attachments, deletion, burn, .cloakexport /archive, and responsive visual QA', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    await ensureVisualQaDir();

    const secretMarker = 'top-secret-zebra-9182';
    const editedMarker = 'edited-cipher-falcon-4421';
    const exportPassword = 'ExportStrongPass!2026';
    const leakedPayloads: string[] = [];

    const aliceCtx = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
    });
    const bobCtx = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      acceptDownloads: true,
    });

    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();

    const pageErrors: string[] = [];
    alicePage.on('pageerror', (err) => pageErrors.push(`Alice pageerror: ${err.message}`));
    bobPage.on('pageerror', (err) => pageErrors.push(`Bob pageerror: ${err.message}`));

    for (const [who, p] of [
      ['Alice', alicePage],
      ['Bob', bobPage],
    ] as const) {
      p.on('request', (req) => {
        if (!req.url().includes('/api/')) return;
        const body = req.postData() ?? '';
        const url = req.url();
        for (const sensitive of [secretMarker, editedMarker, exportPassword, 'Saveable-attachment-payload']) {
          if (body.includes(sensitive) || url.includes(sensitive)) {
            leakedPayloads.push(`${who} leaked "${sensitive}" to ${url}`);
          }
        }
        if (url.includes('/search')) {
          leakedPayloads.push(`${who} sent server search request: ${url}`);
        }
      });
    }

    try {
      // 1. Onboard Alice (1920x1080) & capture onboarding visual QA screenshot
      await alicePage.goto('/');
      await expect(alicePage.getByRole('heading', { name: 'Cloak Private Workspace' })).toBeVisible();
      await alicePage.screenshot({ path: path.join(VISUAL_QA_DIR, '01-onboarding-1920x1080.png'), fullPage: true });
      await onboardUser(alicePage, 'Alice');

      // Onboard Bob (1366x768)
      await onboardUser(bobPage, 'Bob');

      // 2. Alice creates a Private Encrypted Room
      await alicePage.getByRole('button', { name: 'Create Private Room or DM' }).click();
      await alicePage.locator('#create-room-name').fill('Cobalt Syndicate');
      await alicePage.locator('#create-room-desc').fill('Zero-knowledge group sanctuary');
      await alicePage.getByRole('button', { name: 'Create Encrypted Room' }).click();
      await expect(alicePage.getByRole('heading', { name: 'Cobalt Syndicate' })).toBeVisible();

      // Create an extra text & voice channel so multi-channel switching is verified
      await alicePage.getByRole('button', { name: 'Create Channel' }).first().click();
      await alicePage.locator('#ch-type').selectOption('text');
      await alicePage.locator('#ch-name').fill('ops-notes');
      await alicePage.locator('dialog[open]').getByRole('button', { name: 'Create Channel' }).click();
      await expect(alicePage.getByRole('button', { name: 'ops-notes', exact: true })).toBeVisible();

      await alicePage.getByRole('button', { name: 'Create Channel' }).first().click();
      await alicePage.locator('#ch-type').selectOption('voice');
      await alicePage.locator('#ch-name').fill('war-room-voice');
      await alicePage.locator('dialog[open]').getByRole('button', { name: 'Create Channel' }).click();
      await expect(alicePage.getByRole('button', { name: 'war-room-voice', exact: true })).toBeVisible();

      // Ensure we are back on #general
      await alicePage.getByRole('button', { name: 'general', exact: true }).click();

      // 3. Alice generates a revoked invite AND a valid password-protected invite
      await alicePage.getByRole('button', { name: 'Invite' }).click();
      await alicePage.getByRole('button', { name: 'Generate Private Invite Link' }).click();
      const revokedUrl = await alicePage.getByLabel('Generated invite URL').inputValue();
      expect(revokedUrl).toContain('#k=');
      await alicePage.getByRole('button', { name: 'Revoke invitation' }).first().click();

      await alicePage.locator('#inv-pw').fill('InvitePass#42');
      await alicePage.getByRole('button', { name: 'Generate Private Invite Link' }).click();
      await expect(alicePage.getByLabel('Generated invite URL')).toBeVisible();
      const validUrl = await alicePage.getByLabel('Generated invite URL').inputValue();
      expect(validUrl).toContain('#k=');
      expect(validUrl).not.toBe(revokedUrl);
      await alicePage.getByRole('button', { name: 'Close modal' }).click();

      // 4. Bob tries revoked invite -> rejected cleanly
      const revokedPath = new URL(revokedUrl);
      await bobPage.goto(`${revokedPath.pathname}${revokedPath.hash}`);
      await expect(bobPage.getByRole('alert')).toBeVisible();

      // Bob visits valid invite -> wrong password fails -> right password joins!
      const validPath = new URL(validUrl);
      await bobPage.goto(`${validPath.pathname}${validPath.hash}`);
      await expect(bobPage.getByText('Cobalt Syndicate')).toBeVisible();
      await bobPage.locator('#invite-landing-pw').fill('WrongPass!');
      await bobPage.getByRole('button', { name: 'Accept Invite & Enter Room' }).click();
      await expect(bobPage.getByRole('alert')).toBeVisible();

      await bobPage.locator('#invite-landing-pw').fill('InvitePass#42');
      await bobPage.getByRole('button', { name: 'Accept Invite & Enter Room' }).click();
      await expect(bobPage.getByRole('heading', { name: 'Cobalt Syndicate' })).toBeVisible();

      // 5. Alice sends an encrypted text message + XSS probe; Bob receives live
      const aliceInput = alicePage.locator('#composer-textarea');
      await aliceInput.fill(`Hello Bob ${secretMarker}`);
      await aliceInput.press('Enter');
      await expect(alicePage.locator('article').getByText(`Hello Bob ${secretMarker}`)).toBeVisible();
      await expect(bobPage.locator('article').getByText(`Hello Bob ${secretMarker}`)).toBeVisible({ timeout: 20_000 });

      // XSS payload must render harmlessly without script execution
      await aliceInput.fill('<img src=x onerror="window.__xssTriggered=1"> xss-safe-check');
      await aliceInput.press('Enter');
      await expect(bobPage.locator('article').getByText(/xss-safe-check/)).toBeVisible({ timeout: 15_000 });
      expect(await alicePage.evaluate(() => (window as unknown as { __xssTriggered?: number }).__xssTriggered)).toBeUndefined();
      expect(await bobPage.evaluate(() => (window as unknown as { __xssTriggered?: number }).__xssTriggered)).toBeUndefined();

      // 6. Alice uploads an encrypted text file AND an SVG (verifying SVG inline preview blocked)
      const fileChooserPromise = alicePage.waitForEvent('filechooser');
      await alicePage.getByRole('button', { name: 'Attach file' }).click();
      const chooser = await fileChooserPromise;
      await chooser.setFiles([
        {
          name: 'secret-note.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Saveable-attachment-payload-content', 'utf8'),
        },
        {
          name: 'vector-probe.svg',
          mimeType: 'image/svg+xml',
          buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgXss=1</script></svg>', 'utf8'),
        },
      ]);
      await aliceInput.fill('Attached two encrypted files');
      await aliceInput.press('Enter');

      await expect(bobPage.getByText('secret-note.txt')).toBeVisible({ timeout: 20_000 });
      await expect(bobPage.getByText('SVG preview disabled (download only)')).toBeVisible();

      // Bob downloads secret-note.txt cleanly
      const attDownloadPromise = bobPage.waitForEvent('download');
      await bobPage.getByRole('button', { name: 'Save' }).first().click();
      const attDownload = await attDownloadPromise;
      expect(attDownload.suggestedFilename()).toBe('secret-note.txt');

      // 7. Reactions, Edit, Client-Side Local Search, Shared Files drawer + Delete attachment
      const aliceMsgCard = alicePage.locator('article').filter({ hasText: secretMarker }).first();
      await aliceMsgCard.hover();
      await aliceMsgCard.getByRole('button', { name: 'React 👍' }).click();
      await expect(bobPage.locator('article').filter({ hasText: secretMarker }).getByText('👍')).toBeVisible({ timeout: 15_000 });

      await aliceMsgCard.hover();
      await aliceMsgCard.getByRole('button', { name: 'Edit message' }).click();
      await aliceInput.fill(editedMarker);
      await aliceInput.press('Enter');
      await expect(bobPage.locator('article').getByText(editedMarker)).toBeVisible({ timeout: 15_000 });

      // Client-side search
      await alicePage.getByRole('button', { name: 'Local Search' }).click();
      await alicePage.locator('#local-search-input').fill('falcon-4421');
      await expect(alicePage.locator('aside').getByText(editedMarker)).toBeVisible();

      // Visual QA Screenshot: Desktop 1920x1080 workspace with Search Sidebar
      await alicePage.screenshot({ path: path.join(VISUAL_QA_DIR, '02-workspace-1920x1080.png'), fullPage: true });
      // Visual QA Screenshot: Bob Desktop 1366x768 workspace
      await bobPage.screenshot({ path: path.join(VISUAL_QA_DIR, '03-workspace-1366x768.png'), fullPage: true });

      // Voice channel click + VoiceDockBar graceful handling + channel switching without disconnect
      await alicePage.getByRole('button', { name: 'war-room-voice', exact: true }).click();
      await expect(alicePage.getByLabel('Active voice and video call controls')).toBeVisible();
      await alicePage.getByRole('button', { name: 'ops-notes', exact: true }).click();
      await expect(alicePage.getByLabel('Active voice and video call controls')).toBeVisible();
      await alicePage.getByRole('button', { name: 'general', exact: true }).click();
      await alicePage.getByRole('button', { name: 'Disconnect call' }).click();
      await expect(alicePage.getByLabel('Active voice and video call controls')).toBeHidden();

      // Delete attachment from Shared Files drawer
      await alicePage.getByRole('button', { name: 'Shared Files' }).click();
      await alicePage.getByRole('button', { name: 'Delete vector-probe.svg' }).click();
      await expect(alicePage.getByText('Attachment deleted from object store')).toBeVisible();

      // 8. Export Complete Chat Archive (.cloakexport) with mandatory password -> verify binary header & /archive
      await alicePage.getByRole('button', { name: 'Export' }).first().click();
      await alicePage.locator('#exp-pw').fill(exportPassword);
      await alicePage.locator('#exp-pw2').fill(exportPassword);
      await alicePage.screenshot({ path: path.join(VISUAL_QA_DIR, '04-export-modal-1920x1080.png'), fullPage: true });

      const exportDownloadPromise = alicePage.waitForEvent('download');
      await alicePage.getByRole('button', { name: 'Encrypt & Export Archive' }).click();
      const exportDownload = await exportDownloadPromise;
      const exportPath = path.join(VISUAL_QA_DIR, exportDownload.suggestedFilename());
      await exportDownload.saveAs(exportPath);

      const archiveBytes = await fs.readFile(exportPath);
      expect(archiveBytes.subarray(0, 10).equals(Buffer.from('CLOAKEXP\x01\x00', 'latin1'))).toBe(true);
      // Secret room name and message must NEVER appear in plaintext anywhere inside .cloakexport bytes
      expect(archiveBytes.includes(Buffer.from('Cobalt Syndicate', 'utf8'))).toBe(false);
      expect(archiveBytes.includes(Buffer.from(editedMarker, 'utf8'))).toBe(false);

      // 9. Delete for Everyone + reload verification (never resurrects)
      await alicePage.getByRole('button', { name: 'Close panel' }).click();
      const editedCard = alicePage.locator('article').filter({ hasText: editedMarker }).first();
      await editedCard.hover();
      await editedCard.getByRole('button', { name: 'Delete for everyone' }).click();
      await alicePage.locator('dialog[open]').getByRole('button', { name: 'Delete for Everyone', exact: true }).click();
      await expect(alicePage.getByText(editedMarker)).toHaveCount(0);
      await alicePage.reload();
      await expect(alicePage.getByText(editedMarker)).toHaveCount(0);

      // Burn Room History & Rotate Epoch
      await alicePage.getByRole('button', { name: 'Burn' }).click();
      await alicePage.locator('#burn-confirm-input').fill('BURN');
      await alicePage.getByRole('button', { name: 'Burn History & Rotate Epoch' }).click();
      await expect(alicePage.locator('[title="Current E2EE key epoch"]')).toHaveText('E2', { timeout: 15_000 });
      await expect(alicePage.getByText('xss-safe-check')).toHaveCount(0);

      // 10. Mobile / Narrow Viewport (390x844) Visual QA
      await bobPage.setViewportSize({ width: 390, height: 844 });
      await bobPage.screenshot({ path: path.join(VISUAL_QA_DIR, '05-mobile-390x844.png'), fullPage: true });

      // 11. Open Archive Viewer (/archive) offline: test wrong password, tampered archive, valid unlock + Save Offline HTML check
      await alicePage.goto('/archive');
      await alicePage.locator('input[type="file"]').setInputFiles(exportPath);
      await alicePage.locator('#arch-pw').fill('WrongArchivePassword!');
      await alicePage.getByRole('button', { name: 'Unlock Archive' }).click();
      await expect(alicePage.getByRole('alert')).toBeVisible();

      // Tamper final byte -> fails AEAD / integrity cleanly
      const tamperedPath = path.join(VISUAL_QA_DIR, 'tampered-test.cloakexport');
      const tampered = Buffer.from(archiveBytes);
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
      await fs.writeFile(tamperedPath, tampered);
      await alicePage.locator('input[type="file"]').setInputFiles(tamperedPath);
      await alicePage.locator('#arch-pw').fill(exportPassword);
      await alicePage.getByRole('button', { name: 'Unlock Archive' }).click();
      await expect(alicePage.getByRole('alert')).toBeVisible();

      // Valid unlock
      await alicePage.locator('input[type="file"]').setInputFiles(exportPath);
      await alicePage.locator('#arch-pw').fill(exportPassword);
      await alicePage.getByRole('button', { name: 'Unlock Archive' }).click();
      await expect(alicePage.getByText('Integrity SHA-256 Verified')).toBeVisible();
      await expect(alicePage.getByText(editedMarker)).toBeVisible();
      await alicePage.screenshot({ path: path.join(VISUAL_QA_DIR, '06-archive-viewer-unlocked.png'), fullPage: true });

      // Verify offline HTML export has zero <script>, zero onerror=, and zero external http/https URLs
      const htmlDownloadPromise = alicePage.waitForEvent('download');
      await alicePage.getByRole('button', { name: 'Save Offline HTML' }).click();
      const htmlDownload = await htmlDownloadPromise;
      const htmlTmpPath = path.join(VISUAL_QA_DIR, 'tmp-offline-check.html');
      await htmlDownload.saveAs(htmlTmpPath);
      const htmlText = await fs.readFile(htmlTmpPath, 'utf8');
      await fs.rm(htmlTmpPath, { force: true });
      expect(htmlText).not.toMatch(/<script/i);
      expect(htmlText).not.toMatch(/<img\b/i);
      expect(htmlText).toContain('&lt;img src=x onerror=&quot;window.__xssTriggered=1&quot;&gt;');
      expect(htmlText).not.toMatch(/https?:\/\//i);
      expect(htmlText).toContain(editedMarker);

      // Remove temporary exported test binaries from docs/visual-qa so only screenshots remain there
      await fs.rm(exportPath, { force: true });
      await fs.rm(tamperedPath, { force: true });

      expect(leakedPayloads).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });
});
