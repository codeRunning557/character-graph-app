import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import cytoscape, { type Core, type EventObject } from 'cytoscape';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  FileInput,
  FolderOpen,
  GitBranch,
  ListChecks,
  Loader2,
  Pause,
  Play,
  Save,
  Settings,
  Sparkles,
  Timer,
  Trash2,
  X
} from 'lucide-react';
import type {
  AnalysisProgress,
  BondEvent,
  CandidateExtraction,
  Chapter,
  CharacterNode,
  GraphData,
  ExtractionResult,
  LlmConfig,
  LlmPreset,
  ProjectSummary,
  RelationshipEdge
} from './shared/types';

type Selection =
  | { type: 'character'; id: number }
  | { type: 'relationship'; id: number }
  | { type: 'chapter'; id: number }
  | { type: 'candidate'; id: number }
  | null;

type DiagnosticStatus = 'not-started' | 'pending' | 'confirmed' | 'rejected' | 'error' | 'mixed';

interface DiagnosticRelationship {
  source: string;
  target: string;
  type: string;
  summary: string;
}

interface DiagnosticStatusEvent {
  character: string;
  status: string;
  evidence: string;
}

interface ChapterDiagnostic {
  chapter: Chapter;
  candidateStatus: DiagnosticStatus;
  candidateIds: number[];
  pendingCandidates: number;
  confirmedCandidates: number;
  rejectedCandidates: number;
  errorCandidates: number;
  extractedCharacters: string[];
  extractedRelationships: DiagnosticRelationship[];
  extractedStatusEvents: DiagnosticStatusEvent[];
  confirmedEventCount: number;
  visibleConfirmedEventCount: number;
  confirmedRelationshipLabels: string[];
  hiddenCharacters: string[];
  errors: string[];
  note: string;
}

interface GraphDiagnostics {
  scopeLabel: string;
  scopeChapterCount: number;
  totals: {
    pendingCandidates: number;
    confirmedCandidates: number;
    rejectedCandidates: number;
    errorCandidates: number;
    extractedCharacterMentions: number;
    extractedRelationshipMentions: number;
    confirmedEvents: number;
    visibleCharacters: number;
    visibleRelationships: number;
    hiddenCharacters: number;
  };
  warnings: string[];
  chapters: ChapterDiagnostic[];
  hiddenCharacterNames: string[];
}

const emptyGraph: GraphData = {
  chapters: [],
  characters: [],
  relationships: [],
  events: [],
  statusEvents: [],
  candidates: []
};

const defaultConfig: LlmConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxTokens: 4096,
  supportsJson: true,
  reasoningMode: 'off'
};

export function App(): ReactElement {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [graph, setGraph] = useState<GraphData>(emptyGraph);
  const [chapterLimitId, setChapterLimitId] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [status, setStatus] = useState('未打开项目');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<LlmConfig>(defaultConfig);
  const [presets, setPresets] = useState<LlmPreset[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisProgress | null>(null);
  const analysisSyncedAt = useRef('');
  const cyRef = useRef<Core | null>(null);
  const graphHost = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!window.characterGraph) {
      setStatus('Electron preload API 未加载。请重新打包或用 release/win-unpacked 启动。');
      return;
    }
    void Promise.all([
      window.characterGraph.getPresets(),
      window.characterGraph.loadLlmConfig(null)
    ]).then(([nextPresets, nextConfig]) => {
      setPresets(nextPresets);
      setConfig(nextConfig);
    });
  }, []);

  useEffect(() => {
    analysisSyncedAt.current = '';
    if (!project) {
      setAnalysis(null);
      return;
    }
    let disposed = false;
    let timer: number | null = null;

    const poll = async (): Promise<void> => {
      try {
        const progress = await window.characterGraph.getAnalysisProgress(project.path);
        if (disposed) return;
        setAnalysis(progress);
        if (progress.status === 'running' || progress.status === 'paused') {
          const active = progress.activeChapterTitles.length
            ? '；正在处理：' + progress.activeChapterTitles.join('、')
            : '';
          setStatus(
            (progress.status === 'paused' ? '已暂停：' : '正在分析：') +
            (progress.completed + progress.failed) + '/' + progress.total + ' 章，' +
            '耗时 ' + formatDuration(progress.elapsedMs) +
            (progress.estimatedRemainingMs ? '，预计剩余 ' + formatDuration(progress.estimatedRemainingMs) : '') +
            active
          );
        }
        if (
          ['completed', 'cancelled', 'error'].includes(progress.status) &&
          progress.updatedAt !== analysisSyncedAt.current
        ) {
          analysisSyncedAt.current = progress.updatedAt;
          const data = await window.characterGraph.loadProject(project.path);
          if (disposed) return;
          setGraph(data);
          const resultText = progress.status === 'cancelled'
            ? '任务已取消'
            : progress.status === 'error'
              ? '任务失败'
              : '分析完成';
          setStatus(
            resultText + '：成功 ' + progress.completed + ' 章，失败 ' + progress.failed + ' 章，' +
            '耗时 ' + formatDuration(progress.elapsedMs) + '。' +
            (data.candidates.some((candidate) => candidate.status === 'pending')
              ? '请确认候选后生成正式图谱。'
              : '')
          );
        }
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) timer = window.setTimeout(() => void poll(), 700);
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [project]);
  useEffect(() => {
    if (!graphHost.current) return;
    const cy = cytoscape({
      container: graphHost.current,
      elements: [],
      minZoom: 0.25,
      maxZoom: 2.2,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            width: 'mapData(degree, 0, 8, 38, 72)',
            height: 'mapData(degree, 0, 8, 38, 72)',
            'background-color': '#334155',
            color: '#172033',
            'font-family': 'Inter, "Microsoft YaHei", sans-serif',
            'font-size': 13,
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 8,
            'overlay-opacity': 0,
            'border-width': 2,
            'border-color': '#f4efe6'
          }
        },
        {
          selector: 'edge',
          style: {
            label: 'data(label)',
            width: 'mapData(strength, 1, 5, 1.5, 5)',
            'line-color': '#9a6b4f',
            'target-arrow-shape': 'none',
            'curve-style': 'straight',
            color: '#5d4033',
            'font-size': 11,
            'text-background-color': '#f7f4ee',
            'text-background-opacity': 0.88,
            'text-background-padding': '3px',
            'overlay-opacity': 0
          }
        },
        {
          selector: 'node:selected',
          style: {
            'background-color': '#1f766e',
            'border-color': '#d9b46e',
            'border-width': 4
          }
        },
        {
          selector: 'edge:selected',
          style: {
            'line-color': '#1f766e',
            'target-arrow-color': '#1f766e'
          }
        }
      ]
    });
    cy.on('tap', 'node', (event: EventObject) => {
      setSelection({ type: 'character', id: Number(event.target.id().replace('c-', '')) });
    });
    cy.on('tap', 'edge', (event: EventObject) => {
      setSelection({ type: 'relationship', id: Number(event.target.id().replace('r-', '')) });
    });
    cy.on('tap', (event: EventObject) => {
      if (event.target === cy) setSelection(null);
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  const chapterLimit = useMemo(
    () => graph.chapters.find((chapter) => chapter.id === chapterLimitId) ?? null,
    [chapterLimitId, graph.chapters]
  );
  const scopedGraph = useMemo(
    () => buildChapterScopedGraph(graph, chapterLimit),
    [chapterLimit, graph]
  );
  const diagnostics = useMemo(
    () => buildGraphDiagnostics(graph, scopedGraph, chapterLimit),
    [chapterLimit, graph, scopedGraph]
  );
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const degree = new Map<number, number>();
    scopedGraph.relationships.forEach((relationship) => {
      degree.set(relationship.sourceCharacterId, (degree.get(relationship.sourceCharacterId) ?? 0) + 1);
      degree.set(relationship.targetCharacterId, (degree.get(relationship.targetCharacterId) ?? 0) + 1);
    });
    const linearPositions = buildLinearPositions(scopedGraph.characters, scopedGraph.relationships);
    cy.elements().remove();
    cy.add([
      ...scopedGraph.characters.map((character) => ({
        group: 'nodes' as const,
        position: linearPositions.get(character.id) ?? { x: 0, y: 0 },
        data: {
          id: `c-${character.id}`,
          label: character.name,
          degree: degree.get(character.id) ?? 0
        }
      })),
      ...scopedGraph.relationships.map((relationship) => ({
        group: 'edges' as const,
        data: {
          id: `r-${relationship.id}`,
          source: `c-${relationship.sourceCharacterId}`,
          target: `c-${relationship.targetCharacterId}`,
          label: relationship.type,
          strength: relationship.strength
        }
      }))
    ]);
    cy.layout({
      name: 'preset',
      animate: false,
      fit: true,
      padding: 90
    }).run();
  }, [scopedGraph.characters, scopedGraph.relationships]);

  const selectedChapter = useMemo(
    () =>
      selection?.type === 'chapter'
        ? graph.chapters.find((chapter) => chapter.id === selection.id) ?? null
        : null,
    [graph.chapters, selection]
  );
  const selectedCharacter = useMemo(
    () =>
      selection?.type === 'character'
        ? scopedGraph.characters.find((character) => character.id === selection.id) ?? null
        : null,
    [scopedGraph.characters, selection]
  );
  const selectedRelationship = useMemo(
    () =>
      selection?.type === 'relationship'
        ? scopedGraph.relationships.find((relationship) => relationship.id === selection.id) ?? null
        : null,
    [scopedGraph.relationships, selection]
  );
  const selectedCandidate = useMemo(
    () =>
      selection?.type === 'candidate'
        ? graph.candidates.find((candidate) => candidate.id === selection.id) ?? null
        : null,
    [graph.candidates, selection]
  );
  const relationshipEvents = useMemo(
    () =>
      selectedRelationship
        ? scopedGraph.events.filter((event) => event.relationshipId === selectedRelationship.id)
        : [],
    [scopedGraph.events, selectedRelationship]
  );
  const pendingCandidates = graph.candidates.filter((candidate) => candidate.status === 'pending');
  const analysisRunning = analysis?.status === 'running';
  const analysisPaused = analysis?.status === 'paused';
  const analysisVisible = analysis && analysis.status !== 'idle';
  const analysisPercent = analysis && analysis.total > 0
    ? Math.min(100, Math.round(((analysis.completed + analysis.failed) / analysis.total) * 100))
    : analysis?.status === 'completed'
      ? 100
      : 0;

  async function runTask<T>(message: string, task: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setStatus(message);
    try {
      const result = await task();
      setStatus('完成');
      return result;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createProject(): Promise<void> {
    const name = `小说谱系-${new Date().toLocaleString('zh-CN').replace(/[/:\\\s]/g, '-')}`;
    const created = await runTask('正在创建项目', () => window.characterGraph.createProject(name));
    if (!created) return;
    setProject(created);
    const [data, nextConfig] = await Promise.all([
      window.characterGraph.loadProject(created.path),
      window.characterGraph.loadLlmConfig(created.path)
    ]);
    setGraph(data);
    setConfig(nextConfig);
    setChapterLimitId(null);
  }

  async function openProject(): Promise<void> {
    const opened = await runTask('正在打开项目', () => window.characterGraph.openProject());
    if (!opened) return;
    setProject(opened);
    const [data, nextConfig] = await Promise.all([
      window.characterGraph.loadProject(opened.path),
      window.characterGraph.loadLlmConfig(opened.path)
    ]);
    setGraph(data);
    setConfig(nextConfig);
    setChapterLimitId(null);
  }

  async function importNovel(): Promise<void> {
    if (!project) return;
    const data = await runTask('正在导入并分章', () => window.characterGraph.importNovel(project.path));
    if (data) {
      setGraph(data);
      setChapterLimitId(null);
    }
  }

  async function analyzeNovel(): Promise<void> {
    if (!project) return;
    try {
      const progress = analysisPaused
        ? await window.characterGraph.resumeAnalysis(project.path)
        : await window.characterGraph.startAnalysis(project.path, chapterLimit?.id ?? null);
      setAnalysis(progress);
      analysisSyncedAt.current = '';
      setStatus(
        progress.total
          ? '分析任务已启动：3 路并发，失败章节自动重试，结果将进入候选区。'
          : '所选范围内没有需要重新分析的章节。'
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function pauseAnalysis(): Promise<void> {
    if (!project) return;
    const progress = await window.characterGraph.pauseAnalysis(project.path);
    setAnalysis(progress);
  }

  async function resumeAnalysis(): Promise<void> {
    if (!project) return;
    const progress = await window.characterGraph.resumeAnalysis(project.path);
    setAnalysis(progress);
  }

  async function cancelAnalysis(): Promise<void> {
    if (!project) return;
    const progress = await window.characterGraph.cancelAnalysis(project.path);
    setAnalysis(progress);
  }

  async function confirmPendingCandidates(): Promise<void> {
    if (!project || !pendingCandidates.length) return;
    const data = await runTask('正在批量确认候选并生成正式图谱', () =>
      window.characterGraph.confirmPendingCandidates(project.path, chapterLimit?.id ?? null)
    );
    if (data) {
      setGraph(data);
      setStatus(
        '已确认候选，正式图谱已更新' +
        (analysis ? '；本次生成耗时 ' + formatDuration(analysis.elapsedMs) : '') +
        '。'
      );
    }
  }
  async function analyzeChapter(chapterId: number): Promise<void> {
    if (!project) return;
    const data = await runTask('正在调用模型分析章节', () =>
      window.characterGraph.analyzeChapter(project.path, chapterId)
    );
    if (data) {
      setGraph(data);
      setChapterLimitId(chapterId);
    }
  }

  async function confirmCandidate(candidateId: number): Promise<void> {
    if (!project) return;
    const data = await runTask('正在确认候选结果', () =>
      window.characterGraph.confirmCandidate(project.path, candidateId)
    );
    if (data) setGraph(data);
  }

  async function rejectCandidate(candidateId: number): Promise<void> {
    if (!project) return;
    const data = await runTask('正在驳回候选结果', () =>
      window.characterGraph.rejectCandidate(project.path, candidateId)
    );
    if (data) setGraph(data);
  }

  async function saveConfig(nextConfig = config): Promise<void> {
    const saved = await runTask('正在保存模型配置', () =>
      window.characterGraph.saveLlmConfig(project?.path ?? null, nextConfig)
    );
    if (saved) setConfig(saved);
  }

  async function testConfig(): Promise<void> {
    const result = await runTask('正在测试模型连接', () => window.characterGraph.testLlm(config));
    if (result) setStatus(result.message);
  }

  async function exportGraph(): Promise<void> {
    if (!project) return;
    const output = await runTask('正在导出图谱 JSON', () => window.characterGraph.exportGraph(project.path));
    if (output) setStatus(`已导出：${output}`);
  }

  function applyPreset(id: string): void {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    setConfig((current) => ({
      ...current,
      provider: preset.id,
      baseUrl: preset.baseUrl,
      model: preset.model,
      supportsJson: preset.supportsJson
    }));
  }

  function selectChapterScope(chapter: Chapter): void {
    setSelection({ type: 'chapter', id: chapter.id });
    setChapterLimitId(chapter.id);
    setStatus(`图谱范围已切换为第 1-${chapter.orderIndex} 章`);
  }

  function showFullGraph(): void {
    setSelection(null);
    setChapterLimitId(null);
    setStatus('图谱范围已切换为全书');
  }

  return (
    <div className="app-shell">
      <aside className="left-rail">
        <div className="brand">
          <GitBranch size={25} />
          <div>
            <strong>人物谱系图</strong>
            <span>{project ? project.name : '本地项目'}</span>
          </div>
        </div>

        <div className="toolbar">
          <button onClick={createProject}>
            <Sparkles size={16} />
            新建
          </button>
          <button onClick={openProject}>
            <FolderOpen size={16} />
            打开
          </button>
        </div>

        <button className="wide-action" disabled={!project || busy} onClick={importNovel}>
          <FileInput size={17} />
          导入 TXT / MD
        </button>

        <button
          className="wide-action"
          disabled={!project || !graph.chapters.length || busy || analysisRunning}
          onClick={analysisPaused ? resumeAnalysis : analyzeNovel}
        >
          {analysisRunning ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
          {analysisRunning ? '正在生成谱系图' : analysisPaused ? '继续生成谱系图' : '生成/继续谱系图'}
        </button>

        {analysisVisible && (
          <section className="analysis-progress" aria-label="分析进度">
            <div className="analysis-progress-head">
              <span className={'analysis-state ' + analysis.status}>{analysisStatusText(analysis.status)}</span>
              <span><Timer size={13} />{formatDuration(analysis.elapsedMs)}</span>
            </div>
            <div className="progress-track" aria-label={'完成 ' + analysisPercent + '%'}>
              <span style={{ width: analysisPercent + '%' }} />
            </div>
            <div className="analysis-metrics">
              <span>{analysis.completed + analysis.failed}/{analysis.total} 章</span>
              <span>{analysis.failed ? analysis.failed + ' 章失败' : analysis.concurrency + ' 路并发'}</span>
            </div>
            {analysis.activeChapterTitles.length > 0 && (
              <p title={analysis.activeChapterTitles.join('、')}>
                {analysis.activeChapterTitles.join('、')}
              </p>
            )}
            <div className="analysis-controls">
              {analysisRunning && (
                <button title="暂停分析" aria-label="暂停分析" onClick={pauseAnalysis}>
                  <Pause size={15} />
                </button>
              )}
              {analysisPaused && (
                <button title="继续分析" aria-label="继续分析" onClick={resumeAnalysis}>
                  <Play size={15} />
                </button>
              )}
              {(analysisRunning || analysisPaused) && (
                <button title="取消分析" aria-label="取消分析" onClick={cancelAnalysis}>
                  <X size={15} />
                </button>
              )}
              {analysis.estimatedRemainingMs !== null && analysisRunning && (
                <span>约剩 {formatDuration(analysis.estimatedRemainingMs)}</span>
              )}
            </div>
          </section>
        )}

        <section className="rail-section">
          <div className="section-title">
            <span>章节</span>
            <small>{graph.chapters.length}</small>
          </div>
          <div className="scroll-list">
            <button className={!chapterLimitId ? 'list-item active' : 'list-item'} onClick={showFullGraph}>
              <span>全书</span>
            </button>
            {graph.chapters.map((chapter) => (
              <button
                className={chapterLimitId === chapter.id ? 'list-item active' : 'list-item'}
                key={chapter.id}
                onClick={() => selectChapterScope(chapter)}
              >
                <span>{chapter.title}</span>
                <Play size={14} onClick={(event) => {
                  event.stopPropagation();
                  void analyzeChapter(chapter.id);
                }} />
              </button>
            ))}
          </div>
        </section>

        <section className="rail-section candidates">
          <div className="section-title">
            <span>候选</span>
            <div className="candidate-actions">
              <small>{pendingCandidates.length}</small>
              <button
                title="确认当前范围内全部候选"
                disabled={!pendingCandidates.length || busy || analysisRunning || analysisPaused}
                onClick={confirmPendingCandidates}
              >
                <CheckCheck size={14} />
                确认全部
              </button>
            </div>
          </div>
          <div className="scroll-list">
            {graph.candidates.slice(0, 30).map((candidate) => (
              <button
                className={
                  selection?.type === 'candidate' && selection.id === candidate.id ? 'list-item active' : 'list-item'
                }
                key={candidate.id}
                onClick={() => setSelection({ type: 'candidate', id: candidate.id })}
              >
                <span>{candidate.chapterTitle ?? candidate.kind}</span>
                <em className={`badge ${candidate.status}`}>{candidate.status}</em>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="path-label">{project?.path ?? '请选择或创建一个项目'}</span>
            <strong>{scopedGraph.characters.length} 人物 / {scopedGraph.relationships.length} 关系 / {scopedGraph.events.length} 事件</strong>
            <span className="scope-label">
              {chapterLimit ? `当前图谱：第 1-${chapterLimit.orderIndex} 章` : '当前图谱：全书'}
            </span>
          </div>
          <div className="top-actions">
            <button disabled={!project || !graph.chapters.length} onClick={() => setShowDiagnostics(true)}>
              <ListChecks size={16} />
              诊断
            </button>
            <button disabled={busy || analysisRunning || analysisPaused} onClick={() => setShowSettings(true)}>
              <Settings size={16} />
              模型
            </button>
            <button disabled={!project || busy} onClick={exportGraph}>
              <Save size={16} />
              导出
            </button>
          </div>
        </header>

        <div className="graph-stage">
          <div className="graph-canvas" ref={graphHost} />
          {!scopedGraph.characters.length && (
            <motion.div
              className="empty-state"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <GitBranch size={40} />
              <h1>导入小说，确认候选，生成谱系图</h1>
              <p>候选关系不会直接污染正式图谱；确认后才会显示为人物节点和关系线。</p>
            </motion.div>
          )}
        </div>

        <footer className="statusbar">
          {busy ? <Loader2 className="spin" size={15} /> : <CircleAlert size={15} />}
          <span>{status}</span>
        </footer>
      </main>

      <aside className="inspector">
        <Inspector
          project={project}
          chapter={selectedChapter}
          character={selectedCharacter}
          relationship={selectedRelationship}
          events={relationshipEvents}
          candidate={selectedCandidate}
          onGraph={setGraph}
          onConfirm={confirmCandidate}
          onReject={rejectCandidate}
        />
      </aside>

      <AnimatePresence>
        {showDiagnostics && (
          <motion.div className="modal-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <DiagnosticsPanel
              diagnostics={diagnostics}
              onClose={() => setShowDiagnostics(false)}
              onSelectChapter={(chapter) => {
                selectChapterScope(chapter);
                setShowDiagnostics(false);
              }}
            />
          </motion.div>
        )}
        {showSettings && (
          <motion.div className="modal-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="settings-panel" initial={{ y: 18 }} animate={{ y: 0 }} exit={{ y: 18 }}>
              <div className="modal-title">
                <div>
                  <strong>模型配置</strong>
                  <span>支持 DeepSeek、Kimi、通义千问、智谱 GLM、Ollama 和自定义兼容端点</span>
                </div>
                <button onClick={() => setShowSettings(false)}>关闭</button>
              </div>
              <label>
                供应商
                <select value={config.provider} onChange={(event) => applyPreset(event.target.value)}>
                  {presets.map((preset) => (
                    <option value={preset.id} key={preset.id}>{preset.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Base URL
                <input value={config.baseUrl} onChange={(event) => setConfig({ ...config, baseUrl: event.target.value })} />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  value={config.apiKey}
                  onChange={(event) => setConfig({ ...config, apiKey: event.target.value })}
                  placeholder="本地保存，不上传到除所选模型端点之外的地方"
                />
              </label>
              <div className="field-row">
                <label>
                  模型
                  <input value={config.model} onChange={(event) => setConfig({ ...config, model: event.target.value })} />
                </label>
                <label>
                  Max Tokens
                  <input
                    type="number"
                    value={config.maxTokens}
                    onChange={(event) => setConfig({ ...config, maxTokens: Number(event.target.value) })}
                  />
                </label>
              </div>
              <div className="field-row">
                <label>
                  Temperature
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="1"
                    value={config.temperature}
                    onChange={(event) => setConfig({ ...config, temperature: Number(event.target.value) })}
                  />
                </label>
                <label>
                  推理模式
                  <select
                    value={config.reasoningMode}
                    onChange={(event) =>
                      setConfig({ ...config, reasoningMode: event.target.value as LlmConfig['reasoningMode'] })
                    }
                  >
                    <option value="off">关闭</option>
                    <option value="auto">自动</option>
                    <option value="high">高</option>
                  </select>
                </label>
              </div>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={config.supportsJson}
                  onChange={(event) => setConfig({ ...config, supportsJson: event.target.checked })}
                />
                使用 JSON response_format
              </label>
              <div className="modal-actions">
                <button disabled={busy} onClick={testConfig}>测试连接</button>
                <button disabled={busy} className="primary" onClick={() => void saveConfig()}>
                  保存配置
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DiagnosticsPanel({
  diagnostics,
  onClose,
  onSelectChapter
}: {
  diagnostics: GraphDiagnostics;
  onClose: () => void;
  onSelectChapter: (chapter: Chapter) => void;
}): ReactElement {
  return (
    <motion.div className="diagnostics-panel" initial={{ y: 18 }} animate={{ y: 0 }} exit={{ y: 18 }}>
      <div className="modal-title diagnostics-title">
        <div>
          <strong>生成诊断</strong>
          <span>{diagnostics.scopeLabel}</span>
        </div>
        <button onClick={onClose}>关闭</button>
      </div>

      <div className="diagnostic-metrics">
        <article>
          <strong>{diagnostics.scopeChapterCount}</strong>
          <span>范围章节</span>
        </article>
        <article>
          <strong>{diagnostics.totals.pendingCandidates}</strong>
          <span>待确认</span>
        </article>
        <article>
          <strong>{diagnostics.totals.confirmedCandidates}</strong>
          <span>已确认候选</span>
        </article>
        <article>
          <strong>{diagnostics.totals.errorCandidates}</strong>
          <span>错误章节</span>
        </article>
        <article>
          <strong>{diagnostics.totals.visibleCharacters}</strong>
          <span>图上人物</span>
        </article>
        <article>
          <strong>{diagnostics.totals.visibleRelationships}</strong>
          <span>图上关系</span>
        </article>
      </div>

      {diagnostics.warnings.length > 0 && (
        <div className="diagnostic-warnings">
          {diagnostics.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      <div className="diagnostic-chapters">
        {diagnostics.chapters.map((item) => (
          <article className="diagnostic-chapter" key={item.chapter.id}>
            <button className="diagnostic-row-head" onClick={() => onSelectChapter(item.chapter)}>
              <span>第 {item.chapter.orderIndex} 章</span>
              <strong>{item.chapter.title}</strong>
              <em className={'diagnostic-badge ' + item.candidateStatus}>{diagnosticStatusText(item.candidateStatus)}</em>
            </button>
            <div className="diagnostic-row-grid">
              <span>候选 {item.pendingCandidates + item.confirmedCandidates + item.rejectedCandidates + item.errorCandidates}</span>
              <span>人物 {item.extractedCharacters.length}</span>
              <span>关系 {item.extractedRelationships.length}</span>
              <span>正式事件 {item.confirmedEventCount}</span>
              <span>图上事件 {item.visibleConfirmedEventCount}</span>
              <span>{item.note}</span>
            </div>
            {item.errors.length > 0 && (
              <div className="diagnostic-error-list">
                {item.errors.slice(0, 2).map((error) => <p key={error}>{error}</p>)}
              </div>
            )}
            {item.extractedCharacters.length > 0 && (
              <div className="diagnostic-line-list">
                <span>抽取人物</span>
                <p>{item.extractedCharacters.slice(0, 14).join('、')}</p>
              </div>
            )}
            {item.extractedRelationships.length > 0 && (
              <div className="diagnostic-line-list">
                <span>抽取关系</span>
                <p>{item.extractedRelationships.slice(0, 8).map(relationshipLabel).join('；')}</p>
              </div>
            )}
            {item.confirmedRelationshipLabels.length > 0 && (
              <div className="diagnostic-line-list">
                <span>已入图关系</span>
                <p>{item.confirmedRelationshipLabels.join('；')}</p>
              </div>
            )}
            {item.hiddenCharacters.length > 0 && (
              <div className="diagnostic-line-list muted">
                <span>本章隐藏</span>
                <p>{item.hiddenCharacters.join('、')}</p>
              </div>
            )}
          </article>
        ))}
      </div>
    </motion.div>
  );
}

interface InspectorProps {
  project: ProjectSummary | null;
  chapter: Chapter | null;
  character: CharacterNode | null;
  relationship: RelationshipEdge | null;
  events: BondEvent[];
  candidate: CandidateExtraction | null;
  onGraph: (graph: GraphData) => void;
  onConfirm: (id: number) => Promise<void>;
  onReject: (id: number) => Promise<void>;
}

function Inspector(props: InspectorProps): ReactElement {
  const { project, chapter, character, relationship, events, candidate, onGraph, onConfirm, onReject } = props;
  const [characterDraft, setCharacterDraft] = useState<CharacterNode | null>(null);
  const [relationshipDraft, setRelationshipDraft] = useState<RelationshipEdge | null>(null);

  useEffect(() => setCharacterDraft(character), [character]);
  useEffect(() => setRelationshipDraft(relationship), [relationship]);

  if (!project) {
    return (
      <div className="placeholder">
        <FolderOpen size={26} />
        <strong>未打开项目</strong>
        <p>新建或打开项目后，导入小说文本开始分析。</p>
      </div>
    );
  }

  if (chapter) {
    return (
      <div className="detail-flow">
        <Header title={chapter.title} meta={`第 ${chapter.orderIndex} 段 / ${chapter.sourceFile}`} />
        <pre className="chapter-preview">{chapter.content.slice(0, 5000)}</pre>
      </div>
    );
  }

  if (candidate) {
    return (
      <div className="detail-flow">
        <Header title="候选抽取" meta={candidate.chapterTitle ?? candidate.kind} />
        {candidate.error && <p className="error-text">{candidate.error}</p>}
        <pre className="json-preview">{JSON.stringify(candidate.payload, null, 2)}</pre>
        <div className="button-row">
          <button disabled={candidate.status !== 'pending'} onClick={() => void onConfirm(candidate.id)}>
            <Check size={16} />
            确认入图
          </button>
          <button disabled={candidate.status !== 'pending'} onClick={() => void onReject(candidate.id)}>
            <Trash2 size={16} />
            驳回
          </button>
        </div>
      </div>
    );
  }

  if (characterDraft) {
    return (
      <div className="detail-flow">
        <Header title={characterDraft.name} meta="人物" />
        <label>
          姓名
          <input value={characterDraft.name} onChange={(event) => setCharacterDraft({ ...characterDraft, name: event.target.value })} />
        </label>
        <label>
          别名
          <input
            value={characterDraft.aliases.join('，')}
            onChange={(event) =>
              setCharacterDraft({ ...characterDraft, aliases: splitTags(event.target.value) })
            }
          />
        </label>
        <label>
          标签
          <input
            value={characterDraft.tags.join('，')}
            onChange={(event) => setCharacterDraft({ ...characterDraft, tags: splitTags(event.target.value) })}
          />
        </label>
        <label>
          简介
          <textarea
            value={characterDraft.summary}
            onChange={(event) => setCharacterDraft({ ...characterDraft, summary: event.target.value })}
          />
        </label>
        <button
          className="primary"
          onClick={async () => {
            const data = await window.characterGraph.updateCharacter(project.path, characterDraft);
            onGraph(data);
          }}
        >
          <Save size={16} />
          保存人物
        </button>
      </div>
    );
  }

  if (relationshipDraft) {
    return (
      <div className="detail-flow">
        <Header
          title={`${relationshipDraft.sourceName} / ${relationshipDraft.targetName}`}
          meta="关系线"
        />
        <label>
          关系类型
          <input
            value={relationshipDraft.type}
            onChange={(event) => setRelationshipDraft({ ...relationshipDraft, type: event.target.value })}
          />
        </label>
        <label>
          强度 {relationshipDraft.strength}
          <input
            type="range"
            min="1"
            max="5"
            value={relationshipDraft.strength}
            onChange={(event) => setRelationshipDraft({ ...relationshipDraft, strength: Number(event.target.value) })}
          />
        </label>
        <label>
          羁绊摘要
          <textarea
            value={relationshipDraft.summary}
            onChange={(event) => setRelationshipDraft({ ...relationshipDraft, summary: event.target.value })}
          />
        </label>
        <button
          className="primary"
          onClick={async () => {
            const data = await window.characterGraph.updateRelationship(project.path, relationshipDraft);
            onGraph(data);
          }}
        >
          <Save size={16} />
          保存关系
        </button>
        <div className="events">
          <div className="section-title">
            <span>事件</span>
            <small>{events.length}</small>
          </div>
          {events.map((event) => (
            <article key={event.id} className="event-row">
              <strong>{event.summary}</strong>
              <span>{event.chapterTitle}</span>
              <p>{event.evidence}</p>
            </article>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="placeholder">
      <ChevronDown size={26} />
      <strong>选择对象</strong>
      <p>点击人物节点、关系线、章节或候选记录查看详情。</p>
    </div>
  );
}

function Header({ title, meta }: { title: string; meta: string }): ReactElement {
  return (
    <div className="detail-header">
      <span>{meta}</span>
      <h2>{title}</h2>
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + ' 秒';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? minutes + ' 分 ' + rest + ' 秒' : minutes + ' 分钟';
  const hours = Math.floor(minutes / 60);
  return hours + ' 小时 ' + (minutes % 60) + ' 分';
}

function analysisStatusText(status: AnalysisProgress['status']): string {
  const labels: Record<AnalysisProgress['status'], string> = {
    idle: '未开始',
    running: '分析中',
    paused: '已暂停',
    cancelled: '已取消',
    completed: '已完成',
    error: '有错误'
  };
  return labels[status];
}
function splitTags(value: string): string[] {
  return value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildGraphDiagnostics(graph: GraphData, scopedGraph: GraphData, limit: Chapter | null): GraphDiagnostics {
  const limitOrderIndex = limit?.orderIndex ?? Number.POSITIVE_INFINITY;
  const scopeChapters = graph.chapters.filter((chapter) => chapter.orderIndex <= limitOrderIndex);
  const scopeChapterIds = new Set(scopeChapters.map((chapter) => chapter.id));
  const candidatesByChapter = new Map<number, CandidateExtraction[]>();

  graph.candidates.forEach((candidate) => {
    if (candidate.chapterId === null || !scopeChapterIds.has(candidate.chapterId)) return;
    const current = candidatesByChapter.get(candidate.chapterId) ?? [];
    current.push(candidate);
    candidatesByChapter.set(candidate.chapterId, current);
  });

  const relationshipsById = new Map(graph.relationships.map((relationship) => [relationship.id, relationship]));
  const visibleRelationshipIds = new Set(scopedGraph.relationships.map((relationship) => relationship.id));
  const hiddenByChapter = new Map<number, string[]>();
  const hiddenCharacterNames = uniqueStrings(
    graph.statusEvents
      .filter((event) => isInactiveStatus(event.status))
      .filter((event) => event.chapterId === null || scopeChapterIds.has(event.chapterId))
      .map((event) => event.characterName)
  );

  graph.statusEvents.forEach((event) => {
    if (!isInactiveStatus(event.status) || event.chapterId === null || !scopeChapterIds.has(event.chapterId)) return;
    const current = hiddenByChapter.get(event.chapterId) ?? [];
    current.push(event.characterName + '（' + inactiveStatusText(event.status) + '）');
    hiddenByChapter.set(event.chapterId, uniqueStrings(current));
  });

  const chapters = scopeChapters.map((chapter): ChapterDiagnostic => {
    const candidates = candidatesByChapter.get(chapter.id) ?? [];
    const batchPayloads = candidates
      .filter((candidate) => candidate.kind === 'batch')
      .map((candidate) => normalizeExtractionPayload(candidate.payload));
    const pendingCandidates = candidates.filter((candidate) => candidate.status === 'pending').length;
    const confirmedCandidates = candidates.filter((candidate) => candidate.status === 'confirmed').length;
    const rejectedCandidates = candidates.filter((candidate) => candidate.status === 'rejected').length;
    const errorCandidates = candidates.filter((candidate) => candidate.status === 'error' || candidate.kind === 'error').length;
    const extractedRelationships = uniqueRelationships(batchPayloads.flatMap((payload) => payload.relationships));
    const chapterEvents = graph.events.filter((event) => event.chapterId === chapter.id);
    const confirmedRelationshipLabels = uniqueStrings(chapterEvents.map((event) => {
      const relationship = relationshipsById.get(event.relationshipId);
      if (!relationship) return event.summary;
      return relationship.sourceName + ' - ' + relationship.targetName + '（' + relationship.type + '）';
    })).slice(0, 10);
    const visibleConfirmedEventCount = chapterEvents.filter((event) => visibleRelationshipIds.has(event.relationshipId)).length;
    const errors = candidates.map((candidate) => candidate.error).filter(Boolean);
    const candidateStatus = chapterDiagnosticStatus(candidates);

    return {
      chapter,
      candidateStatus,
      candidateIds: candidates.map((candidate) => candidate.id),
      pendingCandidates,
      confirmedCandidates,
      rejectedCandidates,
      errorCandidates,
      extractedCharacters: uniqueStrings(batchPayloads.flatMap((payload) => payload.characters.map((character) => cleanText(character.name)))).slice(0, 24),
      extractedRelationships,
      extractedStatusEvents: batchPayloads.flatMap((payload) => payload.statusEvents ?? []).map((event) => ({
        character: cleanText(event.character),
        status: cleanText(event.status),
        evidence: cleanText(event.evidence ?? '')
      })).filter((event) => event.character).slice(0, 12),
      confirmedEventCount: chapterEvents.length,
      visibleConfirmedEventCount,
      confirmedRelationshipLabels,
      hiddenCharacters: hiddenByChapter.get(chapter.id) ?? [],
      errors,
      note: diagnosticNote(candidateStatus, extractedRelationships.length, chapterEvents.length, visibleConfirmedEventCount)
    };
  });

  const totals = chapters.reduce((acc, chapter) => ({
    pendingCandidates: acc.pendingCandidates + chapter.pendingCandidates,
    confirmedCandidates: acc.confirmedCandidates + chapter.confirmedCandidates,
    rejectedCandidates: acc.rejectedCandidates + chapter.rejectedCandidates,
    errorCandidates: acc.errorCandidates + chapter.errorCandidates,
    extractedCharacterMentions: acc.extractedCharacterMentions + chapter.extractedCharacters.length,
    extractedRelationshipMentions: acc.extractedRelationshipMentions + chapter.extractedRelationships.length,
    confirmedEvents: acc.confirmedEvents + chapter.confirmedEventCount,
    visibleCharacters: scopedGraph.characters.length,
    visibleRelationships: scopedGraph.relationships.length,
    hiddenCharacters: hiddenCharacterNames.length
  }), {
    pendingCandidates: 0,
    confirmedCandidates: 0,
    rejectedCandidates: 0,
    errorCandidates: 0,
    extractedCharacterMentions: 0,
    extractedRelationshipMentions: 0,
    confirmedEvents: 0,
    visibleCharacters: scopedGraph.characters.length,
    visibleRelationships: scopedGraph.relationships.length,
    hiddenCharacters: hiddenCharacterNames.length
  });

  const warnings: string[] = [];
  if (scopeChapters.length > 0 && chapters.every((chapter) => chapter.candidateStatus === 'not-started')) {
    warnings.push('当前范围还没有任何章节候选，说明尚未生成或生成任务没有写入候选区。');
  }
  if (totals.pendingCandidates > 0) {
    warnings.push('还有 ' + totals.pendingCandidates + ' 条候选未确认，未确认内容不会进入正式图谱。');
  }
  if (totals.errorCandidates > 0) {
    warnings.push('有 ' + totals.errorCandidates + ' 条错误记录，需要重跑对应章节。');
  }
  if (totals.confirmedCandidates > 0 && scopedGraph.relationships.length === 0) {
    warnings.push('候选已经确认，但当前图上没有关系线，重点检查状态过滤、章节范围和事件写入。');
  }
  if (hiddenCharacterNames.length > 0) {
    warnings.push('当前范围隐藏了 ' + hiddenCharacterNames.length + ' 个死亡、退场或不再使用的人物。');
  }

  return {
    scopeLabel: limit ? '当前范围：第 1-' + limit.orderIndex + ' 章' : '当前范围：全书',
    scopeChapterCount: scopeChapters.length,
    totals,
    warnings,
    chapters,
    hiddenCharacterNames
  };
}

function normalizeExtractionPayload(payload: unknown): ExtractionResult {
  const value = payload && typeof payload === 'object' ? payload as Partial<ExtractionResult> : {};
  return {
    characters: Array.isArray(value.characters) ? value.characters : [],
    relationships: Array.isArray(value.relationships) ? value.relationships : [],
    statusEvents: Array.isArray(value.statusEvents) ? value.statusEvents : []
  };
}

function chapterDiagnosticStatus(candidates: CandidateExtraction[]): DiagnosticStatus {
  if (!candidates.length) return 'not-started';
  const statuses = new Set(candidates.map((candidate) => candidate.kind === 'error' ? 'error' : candidate.status));
  if (statuses.has('error')) return 'error';
  if (statuses.has('pending')) return 'pending';
  if (statuses.has('confirmed') && statuses.has('rejected')) return 'mixed';
  if (statuses.has('confirmed')) return 'confirmed';
  if (statuses.has('rejected')) return 'rejected';
  return 'mixed';
}

function diagnosticNote(status: DiagnosticStatus, extractedRelationships: number, confirmedEvents: number, visibleEvents: number): string {
  if (status === 'not-started') return '未分析';
  if (status === 'error') return '需要重跑';
  if (status === 'pending') return '待确认';
  if (status === 'rejected') return '已驳回';
  if (confirmedEvents === 0 && extractedRelationships > 0) return '候选未入图';
  if (confirmedEvents > 0 && visibleEvents === 0) return '被当前过滤隐藏';
  if (confirmedEvents > 0) return '已入图';
  return '无关系事件';
}

function diagnosticStatusText(status: DiagnosticStatus): string {
  const labels: Record<DiagnosticStatus, string> = {
    'not-started': '未分析',
    pending: '待确认',
    confirmed: '已确认',
    rejected: '已驳回',
    error: '错误',
    mixed: '混合'
  };
  return labels[status];
}

function relationshipLabel(relationship: DiagnosticRelationship): string {
  return relationship.source + ' - ' + relationship.target + '（' + (relationship.type || '关系') + '）';
}

function uniqueRelationships(relationships: ExtractionResult['relationships']): DiagnosticRelationship[] {
  const byKey = new Map<string, DiagnosticRelationship>();
  relationships.forEach((relationship) => {
    const source = cleanText(relationship.source);
    const target = cleanText(relationship.target);
    if (!source || !target || source === target) return;
    const ordered = [source, target].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const type = cleanText(relationship.type || '关系');
    const key = ordered[0] + '|' + ordered[1] + '|' + type;
    if (!byKey.has(key)) {
      byKey.set(key, {
        source,
        target,
        type,
        summary: cleanText(relationship.summary)
      });
    }
  });
  return [...byKey.values()].slice(0, 32);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isInactiveStatus(status: string): boolean {
  return status === 'dead' || status === 'retired' || status === 'unused';
}

function inactiveStatusText(status: string): string {
  if (status === 'dead') return '死亡';
  if (status === 'retired') return '退场';
  if (status === 'unused') return '不再使用';
  return status;
}

function buildChapterScopedGraph(graph: GraphData, limit: Chapter | null): GraphData {
  const chapterOrder = new Map(graph.chapters.map((chapter) => [chapter.id, chapter.orderIndex]));
  const limitOrderIndex = limit?.orderIndex ?? Number.POSITIVE_INFINITY;
  const allowedChapterIds = new Set(
    graph.chapters
      .filter((chapter) => chapter.orderIndex <= limitOrderIndex)
      .map((chapter) => chapter.id)
  );
  const inactiveCharacterIds = new Set(
    graph.statusEvents
      .filter((event) => event.status === 'dead' || event.status === 'retired' || event.status === 'unused')
      .filter((event) => {
        if (event.chapterId === null) return true;
        const orderIndex = chapterOrder.get(event.chapterId);
        return orderIndex !== undefined && orderIndex <= limitOrderIndex;
      })
      .map((event) => event.characterId)
  );
  const events = graph.events.filter((event) => {
    if (event.chapterId === null) return true;
    const orderIndex = chapterOrder.get(event.chapterId);
    return orderIndex !== undefined && orderIndex <= limitOrderIndex;
  });
  const relationshipIds = new Set(events.map((event) => event.relationshipId));
  const eventsByRelationship = new Map<number, BondEvent[]>();
  events.forEach((event) => {
    const current = eventsByRelationship.get(event.relationshipId) ?? [];
    current.push(event);
    eventsByRelationship.set(event.relationshipId, current);
  });
  const relationships = graph.relationships
    .filter((relationship) =>
      relationshipIds.has(relationship.id) &&
      !inactiveCharacterIds.has(relationship.sourceCharacterId) &&
      !inactiveCharacterIds.has(relationship.targetCharacterId)
    )
    .map((relationship) => {
      const scopedSummary = [...new Set((eventsByRelationship.get(relationship.id) ?? [])
        .map((event) => event.summary.trim())
        .filter(Boolean))]
        .join('\n');
      return scopedSummary ? { ...relationship, summary: scopedSummary } : relationship;
    });
  const visibleRelationshipIds = new Set(relationships.map((relationship) => relationship.id));
  const visibleEvents = events.filter((event) => visibleRelationshipIds.has(event.relationshipId));
  const characterIds = new Set<number>();

  relationships.forEach((relationship) => {
    characterIds.add(relationship.sourceCharacterId);
    characterIds.add(relationship.targetCharacterId);
  });
  graph.characters.forEach((character) => {
    if (
      !inactiveCharacterIds.has(character.id) &&
      (character.firstChapterId === null || allowedChapterIds.has(character.firstChapterId))
    ) {
      characterIds.add(character.id);
    }
  });

  return {
    chapters: graph.chapters,
    characters: graph.characters.filter((character) => characterIds.has(character.id)),
    relationships,
    events: visibleEvents,
    statusEvents: graph.statusEvents,
    candidates: graph.candidates
  };
}

function buildLinearPositions(
  characters: CharacterNode[],
  relationships: RelationshipEdge[]
): Map<number, { x: number; y: number }> {
  const adjacency = new Map<number, Set<number>>();
  characters.forEach((character) => adjacency.set(character.id, new Set()));
  relationships.forEach((relationship) => {
    adjacency.get(relationship.sourceCharacterId)?.add(relationship.targetCharacterId);
    adjacency.get(relationship.targetCharacterId)?.add(relationship.sourceCharacterId);
  });

  const visited = new Set<number>();
  const components: number[][] = [];
  const degree = (id: number): number => adjacency.get(id)?.size ?? 0;

  for (const character of [...characters].sort((a, b) => degree(b.id) - degree(a.id))) {
    if (visited.has(character.id)) continue;
    const queue = [character.id];
    const component: number[] = [];
    visited.add(character.id);
    while (queue.length) {
      const current = queue.shift() as number;
      component.push(current);
      const next = [...(adjacency.get(current) ?? [])]
        .filter((id) => !visited.has(id))
        .sort((a, b) => degree(b) - degree(a));
      next.forEach((id) => {
        visited.add(id);
        queue.push(id);
      });
    }
    components.push(component);
  }

  const positions = new Map<number, { x: number; y: number }>();
  const columnGap = 170;
  const rowGap = 145;
  let row = 0;
  components.forEach((component) => {
    const columns = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(component.length * 1.8))));
    component.forEach((id, index) => {
      positions.set(id, {
        x: (index % columns) * columnGap,
        y: (row + Math.floor(index / columns)) * rowGap
      });
    });
    row += Math.ceil(component.length / columns) + 1;
  });
  return positions;
}
