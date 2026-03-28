// Helper to launch the real Electron app for E2E testing
import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';

export async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(__dirname, '../../dist/main/main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
    timeout: 15000,
  });

  const page = await app.firstWindow();
  await page.waitForSelector('.app-layout', { timeout: 10000 });

  return { app, page };
}

export async function closeApp(app: ElectronApplication): Promise<void> {
  if (!app) return;
  try {
    // Force-kill the process to avoid lingering
    const pid = app.process().pid;
    await Promise.race([
      app.close(),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    // If still alive, kill it
    try { process.kill(pid!, 'SIGKILL'); } catch {}
  } catch {
    // Already dead
  }
}
