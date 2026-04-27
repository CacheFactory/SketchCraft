// @archigraph process.main
// IPC channel type definitions for Electron main <-> renderer communication

export interface UserPreferences {
  units: 'mm' | 'cm' | 'm' | 'inches' | 'feet';
  unitSystem: 'metric' | 'imperial';
  gridSpacing: number;
  snapEnabled: boolean;
  autoSaveInterval: number;
  theme: 'light' | 'dark';
  shortcuts: Record<string, string>;
  recentFiles: string[];
  defaultTemplate: string;
  renderQuality: 'low' | 'medium' | 'high';
  anthropicApiKey: string;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  units: 'm',
  unitSystem: 'metric',
  gridSpacing: 1,
  snapEnabled: true,
  autoSaveInterval: 300000, // 5 minutes
  theme: 'dark',
  shortcuts: {
    'tool.select': 'Space',
    'tool.line': 'L',
    'tool.rectangle': 'R',
    'tool.circle': 'C',
    'tool.arc': 'A',
    'tool.pushpull': 'P',
    'tool.move': 'M',
    'tool.rotate': 'Q',
    'tool.scale': 'S',
    'tool.offset': 'F',
    'tool.eraser': 'E',
    'tool.paint': 'B',
    'tool.orbit': 'O',
    'tool.pan': 'H',
    'tool.zoom': 'Z',
    'tool.tape_measure': 'T',
    'tool.polygon': 'G',
    'tool.protractor': 'Shift+P',
    'tool.dimension': 'D',
    'tool.text': 'Shift+T',
    'tool.follow_me': 'Shift+F',
    'tool.section_plane': 'Shift+X',
    'tool.axes': 'Shift+A',
    'undo': 'CmdOrCtrl+Z',
    'redo': 'CmdOrCtrl+Shift+Z',
    'delete': 'Delete',
    'select-all': 'CmdOrCtrl+A',
  },
  recentFiles: [],
  defaultTemplate: 'default',
  renderQuality: 'high',
  anthropicApiKey: '',
};

export type MenuAction =
  | 'new' | 'open' | 'save' | 'save-as'
  | 'import' | 'export'
  | 'undo' | 'redo'
  | 'cut' | 'copy' | 'paste' | 'delete' | 'select-all'
  | 'zoom-extents' | 'zoom-window'
  | 'preferences' | 'about';

export interface MainProcessAPI {
  'file:open': () => Promise<{ filePath: string; data: ArrayBuffer } | null>;
  'file:save': (args: { filePath: string; data: ArrayBuffer }) => Promise<boolean>;
  'file:save-as': (args: { data: ArrayBuffer; defaultName: string }) => Promise<{ filePath: string } | null>;
  'file:export': (args: { data: ArrayBuffer; format: string; defaultName: string }) => Promise<{ filePath: string } | null>;
  'file:import': (args: { formats: string[] }) => Promise<{ filePath: string; data: ArrayBuffer; format: string } | null>;
  'file:read': (args: { filePath: string }) => Promise<ArrayBuffer>;
  'file:write': (args: { filePath: string; data: ArrayBuffer }) => Promise<boolean>;
  'file:get-recent': () => Promise<string[]>;
  'file:add-recent': (args: { filePath: string }) => Promise<void>;
  'prefs:get': () => Promise<UserPreferences>;
  'prefs:set': (prefs: Partial<UserPreferences>) => Promise<void>;
  'native:boolean': (args: { op: 'union' | 'subtract' | 'intersect'; meshA: ArrayBuffer; meshB: ArrayBuffer }) => Promise<ArrayBuffer>;
  'native:step-import': (args: { data: ArrayBuffer }) => Promise<ArrayBuffer>;
  'file:convert-skp': (args: { filePath: string; data?: ArrayBuffer }) => Promise<{ data: ArrayBuffer; filePath: string } | null>;
  'app:get-version': () => Promise<string>;
  'app:get-user-data-path': () => Promise<string>;
  'app:quit': () => Promise<void>;
  'ai:chat': (args: { messages: Array<{ role: string; content: unknown }>; tools: unknown[]; system: string }) => Promise<unknown>;
}

export interface RendererEvents {
  'menu:action': { action: MenuAction };
  'file:auto-save-tick': {};
  'app:before-quit': {};
}

// The window.api type exposed by preload
export interface WindowAPI {
  invoke<K extends keyof MainProcessAPI>(
    channel: K,
    ...args: Parameters<MainProcessAPI[K]>
  ): ReturnType<MainProcessAPI[K]>;
  on<K extends keyof RendererEvents>(
    channel: K,
    handler: (data: RendererEvents[K]) => void
  ): () => void;
  off<K extends keyof RendererEvents>(
    channel: K,
    handler: (data: RendererEvents[K]) => void
  ): void;
}

declare global {
  interface Window {
    api: WindowAPI;
  }
}
