// Use the bundled Monaco instead of @monaco-editor/react's default CDN copy:
// the editor works offline (desktop app), and nothing is fetched from a
// third-party server.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
