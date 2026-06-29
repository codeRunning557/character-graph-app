import type {
  AnalysisProgress,
  AnalyzeNovelResult,
  AppApi,
  CharacterNode,
  GraphData,
  LlmConfig,
  LlmPreset,
  ProjectSummary,
  RelationshipEdge
} from './shared/types';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      ...options.headers
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

function chooseNovelFile(projectPath: string): Promise<GraphData> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,text/plain,text/markdown';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('未选择文件'));

      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }

      try {
        resolve(await api<GraphData>('/novel/import', {
          method: 'POST',
          body: JSON.stringify({
            projectPath,
            fileName: file.name,
            bytesBase64: btoa(binary)
          })
        }));
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

export function installWebApi(): void {
  if (window.characterGraph) return;

  const webApi: AppApi = {
    createProject: (name: string) => api<ProjectSummary>('/projects', { method: 'POST', body: JSON.stringify({ name }) }),
    openProject: () => api<ProjectSummary | null>('/projects/open'),
    loadProject: (projectPath: string) => api<GraphData>(`/projects/${encodeURIComponent(projectPath)}`),
    importNovel: (projectPath: string) => chooseNovelFile(projectPath),
    importNovelFromPath: () => Promise.reject(new Error('网页版不支持按本地路径导入，请使用“导入 TXT / MD”。')),
    saveLlmConfig: (_projectPath: string | null, config: LlmConfig) =>
      api<LlmConfig>('/llm/config', { method: 'POST', body: JSON.stringify(config) }),
    loadLlmConfig: () => api<LlmConfig>('/llm/config'),
    testLlm: (config: LlmConfig) =>
      api<{ ok: boolean; message: string }>('/llm/test', { method: 'POST', body: JSON.stringify(config) }),
    analyzeChapter: (projectPath: string, chapterId: number) =>
      api<GraphData>('/llm/analyze-chapter', { method: 'POST', body: JSON.stringify({ projectPath, chapterId }) }),
    analyzeNovel: (projectPath: string, upToChapterId?: number | null) =>
      api<AnalyzeNovelResult>('/llm/analyze-novel', { method: 'POST', body: JSON.stringify({ projectPath, upToChapterId }) }),
    startAnalysis: (projectPath: string, upToChapterId?: number | null) =>
      api<AnalysisProgress>('/analysis/start', { method: 'POST', body: JSON.stringify({ projectPath, upToChapterId }) }),
    getAnalysisProgress: (projectPath: string) =>
      api<AnalysisProgress>('/analysis/progress/' + encodeURIComponent(projectPath)),
    pauseAnalysis: (projectPath: string) =>
      api<AnalysisProgress>('/analysis/pause', { method: 'POST', body: JSON.stringify({ projectPath }) }),
    resumeAnalysis: (projectPath: string) =>
      api<AnalysisProgress>('/analysis/resume', { method: 'POST', body: JSON.stringify({ projectPath }) }),
    cancelAnalysis: (projectPath: string) =>
      api<AnalysisProgress>('/analysis/cancel', { method: 'POST', body: JSON.stringify({ projectPath }) }),
    confirmCandidate: (projectPath: string, candidateId: number) =>
      api<GraphData>('/candidates/confirm', { method: 'POST', body: JSON.stringify({ projectPath, candidateId }) }),
    confirmPendingCandidates: (projectPath: string, upToChapterId?: number | null) =>
      api<GraphData>('/candidates/confirm-pending', { method: 'POST', body: JSON.stringify({ projectPath, upToChapterId }) }),
    rejectCandidate: (projectPath: string, candidateId: number) =>
      api<GraphData>('/candidates/reject', { method: 'POST', body: JSON.stringify({ projectPath, candidateId }) }),
    updateCharacter: (projectPath: string, character: CharacterNode) =>
      api<GraphData>('/characters/update', { method: 'POST', body: JSON.stringify({ projectPath, character }) }),
    updateRelationship: (projectPath: string, relationship: RelationshipEdge) =>
      api<GraphData>('/relationships/update', { method: 'POST', body: JSON.stringify({ projectPath, relationship }) }),
    exportGraph: async (projectPath: string) => {
      const result = await api<{ path: string }>('/graph/export', { method: 'POST', body: JSON.stringify({ projectPath }) });
      return result.path;
    },
    getPresets: () => api<LlmPreset[]>('/llm/presets')
  };

  window.characterGraph = webApi;
}
