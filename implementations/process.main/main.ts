// @archigraph process.main
// Electron main process entry point for DraftDown

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import * as https from 'https';
import {
  UserPreferences,
  DEFAULT_PREFERENCES,
  MenuAction,
} from '../../src/core/ipc-types';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PREFS_FILE = (): string =>
  path.join(app.getPath('userData'), 'preferences.json');

const AUTOSAVE_DIR = (): string =>
  path.join(app.getPath('userData'), 'autosave');

const MAX_RECENT_FILES = 10;
const SHUTDOWN_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let preferences: UserPreferences = { ...DEFAULT_PREFERENCES };
let autoSaveTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function loadPreferences(): UserPreferences {
  try {
    const raw = fs.readFileSync(PREFS_FILE(), 'utf-8');
    const stored = JSON.parse(raw) as Partial<UserPreferences>;
    return { ...DEFAULT_PREFERENCES, ...stored };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function savePreferences(prefs: UserPreferences): void {
  atomicWriteText(PREFS_FILE(), JSON.stringify(prefs, null, 2));
}

// ---------------------------------------------------------------------------
// Atomic file writes (write to temp then rename)
// ---------------------------------------------------------------------------

function atomicWriteBuffer(filePath: string, data: Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function atomicWriteText(filePath: string, text: string): void {
  atomicWriteBuffer(filePath, Buffer.from(text, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Recent files management
// ---------------------------------------------------------------------------

function addRecentFile(filePath: string): void {
  const absolute = path.resolve(filePath);
  preferences.recentFiles = preferences.recentFiles.filter(
    (f) => f !== absolute,
  );
  preferences.recentFiles.unshift(absolute);
  if (preferences.recentFiles.length > MAX_RECENT_FILES) {
    preferences.recentFiles = preferences.recentFiles.slice(0, MAX_RECENT_FILES);
  }
  savePreferences(preferences);
  rebuildMenu();
}

function pruneRecentFiles(): void {
  const before = preferences.recentFiles.length;
  preferences.recentFiles = preferences.recentFiles.filter((f) => {
    try {
      fs.accessSync(f, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (preferences.recentFiles.length !== before) {
    savePreferences(preferences);
  }
}

function getRecentFiles(): string[] {
  return [...preferences.recentFiles];
}

// ---------------------------------------------------------------------------
// Auto-save
// ---------------------------------------------------------------------------

function startAutoSaveTimer(): void {
  stopAutoSaveTimer();
  const interval = preferences.autoSaveInterval;
  if (interval <= 0) return;
  autoSaveTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file:auto-save-tick', {});
    }
  }, interval);
}

function stopAutoSaveTimer(): void {
  if (autoSaveTimer !== null) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
}

function cleanOldAutosaves(): void {
  const dir = AUTOSAVE_DIR();
  if (!fs.existsSync(dir)) return;
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();
  try {
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch { /* ignore cleanup errors */ }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  // -- File operations ------------------------------------------------------

  // @archigraph calls|process.main|svc.file_system|runtime
  ipcMain.handle('file:open', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: '3D Files', extensions: ['skp', 'obj', 'stl', 'gltf', 'glb', 'fbx', 'dae', 'ply', '3mf', 'skc'] },
        { name: 'SketchUp Files', extensions: ['skp'] },
        { name: 'DraftDown Files', extensions: ['skc'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const data = fs.readFileSync(filePath);
    addRecentFile(filePath);
    return { filePath, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  });

  ipcMain.handle('file:save', async (_event, args: { filePath: string; data: ArrayBuffer }) => {
    try {
      atomicWriteBuffer(args.filePath, Buffer.from(args.data));
      addRecentFile(args.filePath);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('file:save-as', async (_event, args: { data: ArrayBuffer; defaultName: string }) => {
    if (!mainWindow) return null;
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: args.defaultName,
      filters: [
        { name: 'DraftDown Files', extensions: ['skc'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    atomicWriteBuffer(result.filePath, Buffer.from(args.data));
    addRecentFile(result.filePath);
    return { filePath: result.filePath };
  });

  ipcMain.handle('file:export', async (_event, args: { data: ArrayBuffer; format: string; defaultName: string }) => {
    if (!mainWindow) return null;
    const filters: Electron.FileFilter[] = [];
    switch (args.format) {
      case 'obj': filters.push({ name: 'Wavefront OBJ', extensions: ['obj'] }); break;
      case 'stl': filters.push({ name: 'STL', extensions: ['stl'] }); break;
      case 'gltf': filters.push({ name: 'glTF', extensions: ['gltf', 'glb'] }); break;
      case 'dxf': filters.push({ name: 'DXF', extensions: ['dxf'] }); break;
      default: filters.push({ name: args.format.toUpperCase(), extensions: [args.format] }); break;
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: args.defaultName,
      filters,
    });
    if (result.canceled || !result.filePath) return null;
    atomicWriteBuffer(result.filePath, Buffer.from(args.data));
    return { filePath: result.filePath };
  });

  ipcMain.handle('file:import', async (_event, args: { formats: string[] }) => {
    if (!mainWindow) return null;
    const extensions = args.formats.flatMap((f) => {
      switch (f) {
        case 'obj': return ['obj'];
        case 'stl': return ['stl'];
        case 'step': return ['step', 'stp'];
        case 'dxf': return ['dxf'];
        case 'gltf': return ['gltf', 'glb'];
        case 'skp': return ['skp'];
        default: return [f];
      }
    });
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: '3D Files', extensions },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const data = fs.readFileSync(filePath);
    return {
      filePath,
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      format: ext,
    };
  });

  // @archigraph file.skp
  ipcMain.handle('file:convert-skp', async (_event, args: { filePath: string; data?: ArrayBuffer }) => {
    // Convert .skp to .obj using the skp2obj tool (links against SketchUp C SDK)
    const toolPath = path.join(__dirname, '..', 'tools', 'skp2obj');
    const tmpObj = path.join(os.tmpdir(), `skp-${Date.now()}.obj`);

    // If raw data was provided (e.g. fetched from URL), write to temp file first
    let skpPath = args.filePath;
    if (args.data) {
      skpPath = path.join(os.tmpdir(), `skp-input-${Date.now()}.skp`);
      console.log(`[skp2obj] Writing ${Buffer.from(args.data).byteLength} bytes to ${skpPath}`);
      fs.writeFileSync(skpPath, Buffer.from(args.data));
    }
    console.log(`[skp2obj] Converting: ${skpPath} → ${tmpObj}`);

    return new Promise<{ data: ArrayBuffer; filePath: string } | null>((resolve) => {
      execFile(toolPath, [skpPath, tmpObj], { timeout: 300000, maxBuffer: 100 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) {
          console.error('[skp2obj] conversion failed:', stderr || err.message);
          resolve(null);
          return;
        }
        console.log('[skp2obj]', stderr.trim());
        try {
          const stat = fs.statSync(tmpObj);
          console.log(`[skp2obj] OBJ file size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
          const objData = fs.readFileSync(tmpObj);
          console.log(`[skp2obj] Read into buffer, sending to renderer...`);
          // Don't delete temp files yet — renderer needs MTL and textures from same directory
          // They'll be cleaned up on next conversion or app exit
          resolve({
            data: objData.buffer.slice(objData.byteOffset, objData.byteOffset + objData.byteLength),
            filePath: tmpObj,  // Pass temp OBJ path so renderer can find MTL/textures
          });
        } catch (readErr) {
          console.error('[skp2obj] failed to read output:', readErr);
          resolve(null);
        }
      });
    });
  });

  ipcMain.handle('file:read', async (_event, args: { filePath: string }) => {
    const data = fs.readFileSync(args.filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  });

  ipcMain.handle('file:write', async (_event, args: { filePath: string; data: ArrayBuffer }) => {
    try {
      atomicWriteBuffer(args.filePath, Buffer.from(args.data));
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('file:get-recent', async () => {
    return getRecentFiles();
  });

  ipcMain.handle('file:add-recent', async (_event, args: { filePath: string }) => {
    addRecentFile(args.filePath);
  });

  // -- Preferences ----------------------------------------------------------

  ipcMain.handle('prefs:get', async () => {
    return { ...preferences };
  });

  ipcMain.handle('prefs:set', async (_event, partial: Partial<UserPreferences>) => {
    const oldInterval = preferences.autoSaveInterval;
    preferences = { ...preferences, ...partial };
    savePreferences(preferences);
    if (partial.autoSaveInterval !== undefined && partial.autoSaveInterval !== oldInterval) {
      startAutoSaveTimer();
    }
    if (partial.theme !== undefined || partial.shortcuts !== undefined) {
      rebuildMenu();
    }
  });

  // -- Native modules (stubs — actual implementations delegate to native) ---

  ipcMain.handle('native:boolean', async (_event, args: {
    op: 'union' | 'subtract' | 'intersect';
    meshA: ArrayBuffer;
    meshB: ArrayBuffer;
  }) => {
    // Delegate to native addon when available.
    // For now, return meshA as a passthrough placeholder.
    return args.meshA;
  });

  ipcMain.handle('native:step-import', async (_event, args: { data: ArrayBuffer }) => {
    // Delegate to native STEP parser when available.
    return args.data;
  });

  // -- App commands ---------------------------------------------------------

  ipcMain.handle('app:get-version', async () => {
    return app.getVersion();
  });

  ipcMain.handle('app:get-user-data-path', async () => {
    return app.getPath('userData');
  });

  ipcMain.handle('app:quit', async () => {
    app.quit();
  });

  // -- AI Chat ---------------------------------------------------------------

  // @archigraph ai.chat
  ipcMain.handle('ai:chat', async (_event, args: {
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
    system: string;
  }) => {
    const apiKey = preferences.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { error: 'Anthropic API key not set. Go to Preferences > AI to enter your key.' };
    }

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: args.system,
      messages: args.messages,
      tools: args.tools,
    });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              resolve({ error: parsed.error.message || JSON.stringify(parsed.error) });
            } else {
              resolve(parsed);
            }
          } catch {
            resolve({ error: `Failed to parse API response: ${data.slice(0, 200)}` });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ error: `API request failed: ${err.message}` });
      });

      req.write(body);
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Application Menu
// ---------------------------------------------------------------------------

function sendMenuAction(action: MenuAction): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:action', { action });
  }
}

function buildRecentFilesSubmenu(): MenuItemConstructorOptions[] {
  if (preferences.recentFiles.length === 0) {
    return [{ label: 'No Recent Files', enabled: false }];
  }
  const items: MenuItemConstructorOptions[] = preferences.recentFiles.map(
    (filePath, index) => ({
      label: `${index + 1}. ${path.basename(filePath)}`,
      toolTip: filePath,
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            const data = fs.readFileSync(filePath);
            mainWindow.webContents.send('menu:action', { action: 'open' });
          } catch { /* file gone */ }
        }
      },
    }),
  );
  items.push({ type: 'separator' });
  items.push({
    label: 'Clear Recent Files',
    click: () => {
      preferences.recentFiles = [];
      savePreferences(preferences);
      rebuildMenu();
    },
  });
  return items;
}

function rebuildMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Preferences…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendMenuAction('preferences'),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),

    // File
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new'),
        },
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('open'),
        },
        {
          label: 'Open Recent',
          submenu: buildRecentFilesSubmenu(),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenuAction('save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendMenuAction('save-as'),
        },
        { type: 'separator' },
        {
          label: 'Import…',
          accelerator: 'CmdOrCtrl+I',
          click: () => sendMenuAction('import'),
        },
        {
          label: 'Export…',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendMenuAction('export'),
        },
        { type: 'separator' },
        ...(isMac ? [] : [{ role: 'quit' as const }]),
      ],
    },

    // Edit
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          click: () => sendMenuAction('undo'),
        },
        {
          label: 'Redo',
          click: () => sendMenuAction('redo'),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        {
          label: 'Delete',
          click: () => sendMenuAction('delete'),
        },
        { type: 'separator' },
        {
          label: 'Select All',
          click: () => sendMenuAction('select-all'),
        },
        ...(!isMac
          ? [
              { type: 'separator' as const },
              {
                label: 'Preferences…',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendMenuAction('preferences'),
              },
            ]
          : []),
      ],
    },

    // View
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom Extents',
          click: () => sendMenuAction('zoom-extents'),
        },
        {
          label: 'Zoom Window',
          click: () => sendMenuAction('zoom-window'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // Tools — no accelerators here; keyboard shortcuts are handled
    // in the renderer process to avoid Electron menu intercepting them.
    // Tool shortcuts: Space, L, R, C, A, P, M, Q, S, F, E, B, O, H, Z, T, D
    {
      label: 'Tools',
      submenu: [
        { label: 'Select (Space)', click: () => sendMenuAction('tool-select' as MenuAction) },
        { label: 'Line (L)', click: () => sendMenuAction('tool-line' as MenuAction) },
        { label: 'Rectangle (R)', click: () => sendMenuAction('tool-rectangle' as MenuAction) },
        { label: 'Circle (C)', click: () => sendMenuAction('tool-circle' as MenuAction) },
        { label: 'Arc (A)', click: () => sendMenuAction('tool-arc' as MenuAction) },
        { type: 'separator' },
        { label: 'Push/Pull (P)', click: () => sendMenuAction('tool-pushpull' as MenuAction) },
        { label: 'Move (M)', click: () => sendMenuAction('tool-move' as MenuAction) },
        { label: 'Rotate (Q)', click: () => sendMenuAction('tool-rotate' as MenuAction) },
        { label: 'Scale (S)', click: () => sendMenuAction('tool-scale' as MenuAction) },
        { label: 'Offset (F)', click: () => sendMenuAction('tool-offset' as MenuAction) },
        { type: 'separator' },
        { label: 'Eraser (E)', click: () => sendMenuAction('tool-eraser' as MenuAction) },
        { label: 'Paint Bucket (B)', click: () => sendMenuAction('tool-paint' as MenuAction) },
        { type: 'separator' },
        { label: 'Orbit (O)', click: () => sendMenuAction('tool-orbit' as MenuAction) },
        { label: 'Pan (H)', click: () => sendMenuAction('tool-pan' as MenuAction) },
        { label: 'Zoom (Z)', click: () => sendMenuAction('tool-zoom' as MenuAction) },
        { type: 'separator' },
        { label: 'Tape Measure (T)', click: () => sendMenuAction('tool-tape_measure' as MenuAction) },
        { label: 'Protractor (Shift+P)', click: () => sendMenuAction('tool-protractor' as MenuAction) },
        { label: 'Dimension (D)', click: () => sendMenuAction('tool-dimension' as MenuAction) },
      ],
    },

    // Help
    {
      label: 'Help',
      role: 'help',
      submenu: [
        {
          label: 'About DraftDown',
          click: () => sendMenuAction('about'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'DraftDown',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false, // needed for native module access via preload
    },
    show: false,
  });

  // Graceful show when ready
  win.once('ready-to-show', () => {
    win.show();
  });

  // Load the renderer entry point
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  return win;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let isQuitting = false;

function handleBeforeQuit(): void {
  if (isQuitting) return;
  isQuitting = true;

  stopAutoSaveTimer();

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  // Notify renderer so it can persist unsaved work
  mainWindow.webContents.send('app:before-quit', {});

  // Give the renderer up to SHUTDOWN_TIMEOUT_MS to wrap up, then force close
  const forceClose = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
  }, SHUTDOWN_TIMEOUT_MS);

  mainWindow.once('closed', () => {
    clearTimeout(forceClose);
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on('before-quit', (event) => {
  if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    handleBeforeQuit();
    // Allow the window to close after the renderer has had time
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      }
    }, SHUTDOWN_TIMEOUT_MS);
  }
});

// Increase renderer V8 heap limit for large models
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');

app.whenReady().then(() => {
  // 1. Load preferences
  preferences = loadPreferences();
  pruneRecentFiles();

  // 2. Register IPC handlers
  registerIpcHandlers();

  // 3. Create the main window
  mainWindow = createMainWindow();

  // Monitor for renderer crashes
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[CRASH] Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[CRASH] Renderer process became unresponsive');
  });

  // 4. Build application menu
  rebuildMenu();

  // 5. Start auto-save timer
  startAutoSaveTimer();

  // 6. Clean old autosave files
  cleanOldAutosaves();

  // macOS: re-create window when dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopAutoSaveTimer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
