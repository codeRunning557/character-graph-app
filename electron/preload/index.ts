import { contextBridge, ipcRenderer } from 'electron';
import type { AppApi, CharacterNode, LlmConfig, RelationshipEdge } from '../../src/shared/types';

const api: AppApi = {
  createProject: (name: string) => ipcRenderer.invoke('project:create', name),
  openProject: () => ipcRenderer.invoke('project:open'),
  loadProject: (projectPath: string) => ipcRenderer.invoke('project:load', projectPath),
  importNovel: (projectPath: string) => ipcRenderer.invoke('novel:import', projectPath),
  importNovelFromPath: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke('novel:import-path', projectPath, filePath),
  saveLlmConfig: (projectPath: string | null, config: LlmConfig) =>
    ipcRenderer.invoke('llm:save-config', projectPath, config),
  loadLlmConfig: (projectPath: string | null) => ipcRenderer.invoke('llm:load-config', projectPath),
  testLlm: (config: LlmConfig) => ipcRenderer.invoke('llm:test', config),
  analyzeChapter: (projectPath: string, chapterId: number) =>
    ipcRenderer.invoke('llm:analyze-chapter', projectPath, chapterId),
  analyzeNovel: (projectPath: string, upToChapterId?: number | null) =>
    ipcRenderer.invoke('llm:analyze-novel', projectPath, upToChapterId),
  startAnalysis: (projectPath: string, upToChapterId?: number | null) =>
    ipcRenderer.invoke('analysis:start', projectPath, upToChapterId),
  getAnalysisProgress: (projectPath: string) => ipcRenderer.invoke('analysis:progress', projectPath),
  pauseAnalysis: (projectPath: string) => ipcRenderer.invoke('analysis:pause', projectPath),
  resumeAnalysis: (projectPath: string) => ipcRenderer.invoke('analysis:resume', projectPath),
  cancelAnalysis: (projectPath: string) => ipcRenderer.invoke('analysis:cancel', projectPath),
  confirmCandidate: (projectPath: string, candidateId: number) =>
    ipcRenderer.invoke('candidate:confirm', projectPath, candidateId),
  confirmPendingCandidates: (projectPath: string, upToChapterId?: number | null) =>
    ipcRenderer.invoke('candidate:confirm-pending', projectPath, upToChapterId),
  rejectCandidate: (projectPath: string, candidateId: number) =>
    ipcRenderer.invoke('candidate:reject', projectPath, candidateId),
  updateCharacter: (projectPath: string, character: CharacterNode) =>
    ipcRenderer.invoke('character:update', projectPath, character),
  updateRelationship: (projectPath: string, relationship: RelationshipEdge) =>
    ipcRenderer.invoke('relationship:update', projectPath, relationship),
  exportGraph: (projectPath: string) => ipcRenderer.invoke('graph:export', projectPath),
  getPresets: () => ipcRenderer.invoke('llm:presets')
};

contextBridge.exposeInMainWorld('characterGraph', api);
