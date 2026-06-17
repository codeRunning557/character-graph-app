import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import cytoscape, { type Core, type EventObject } from 'cytoscape';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  ChevronDown,
  CircleAlert,
  FileInput,
  FolderOpen,
  GitBranch,
  Loader2,
  Play,
  Save,
  Settings,
  Sparkles,
  Trash2
} from 'lucide-react';
import type {
  BondEvent,
  CandidateExtraction,
  Chapter,
  CharacterNode,
  GraphData,
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

const emptyGraph: GraphData = {
  chapters: [],
  characters: [],
  relationships: [],
  events: [],
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
  const [selection, setSelection] = useState<Selection>(null);
  const [status, setStatus] = useState('未打开项目');
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<LlmConfig>(defaultConfig);
  const [presets, setPresets] = useState<LlmPreset[]>([]);
  const [showSettings, setShowSettings] = useState(false);
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

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const degree = new Map<number, number>();
    graph.relationships.forEach((relationship) => {
      degree.set(relationship.sourceCharacterId, (degree.get(relationship.sourceCharacterId) ?? 0) + 1);
      degree.set(relationship.targetCharacterId, (degree.get(relationship.targetCharacterId) ?? 0) + 1);
    });
    const linearPositions = buildLinearPositions(graph.characters, graph.relationships);
    cy.elements().remove();
    cy.add([
      ...graph.characters.map((character) => ({
        group: 'nodes' as const,
        position: linearPositions.get(character.id) ?? { x: 0, y: 0 },
        data: {
          id: `c-${character.id}`,
          label: character.name,
          degree: degree.get(character.id) ?? 0
        }
      })),
      ...graph.relationships.map((relationship) => ({
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
  }, [graph.characters, graph.relationships]);

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
        ? graph.characters.find((character) => character.id === selection.id) ?? null
        : null,
    [graph.characters, selection]
  );
  const selectedRelationship = useMemo(
    () =>
      selection?.type === 'relationship'
        ? graph.relationships.find((relationship) => relationship.id === selection.id) ?? null
        : null,
    [graph.relationships, selection]
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
        ? graph.events.filter((event) => event.relationshipId === selectedRelationship.id)
        : [],
    [graph.events, selectedRelationship]
  );
  const pendingCandidates = graph.candidates.filter((candidate) => candidate.status === 'pending');

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
  }

  async function importNovel(): Promise<void> {
    if (!project) return;
    const data = await runTask('正在导入并分章', () => window.characterGraph.importNovel(project.path));
    if (data) setGraph(data);
  }

  async function analyzeNovel(): Promise<void> {
    if (!project) return;
    const startedAt = performance.now();
    const result = await runTask('正在生成谱系图：本次最多分析 3 个未处理章节', () =>
      window.characterGraph.analyzeNovel(project.path)
    );
    if (result) {
      setGraph(result.graph);
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      const elapsedText =
        elapsedSeconds < 60
          ? `${elapsedSeconds.toFixed(1)} 秒`
          : `${(elapsedSeconds / 60).toFixed(2)} 分钟`;
      setStatus(
        result.errors.length
          ? `本批处理 ${result.processed} 章，剩余 ${result.remaining} 章，耗时 ${elapsedText}；错误：${result.errors[0]}`
          : `本批处理 ${result.processed} 章，剩余 ${result.remaining} 章，耗时 ${elapsedText}。继续点击可处理下一批。`
      );
    }
  }

  async function analyzeChapter(chapterId: number): Promise<void> {
    if (!project) return;
    const data = await runTask('正在调用模型分析章节', () =>
      window.characterGraph.analyzeChapter(project.path, chapterId)
    );
    if (data) setGraph(data);
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

        <button className="wide-action" disabled={!project || !graph.chapters.length || busy} onClick={analyzeNovel}>
          <Sparkles size={17} />
          生成/继续谱系图
        </button>

        <section className="rail-section">
          <div className="section-title">
            <span>章节</span>
            <small>{graph.chapters.length}</small>
          </div>
          <div className="scroll-list">
            {graph.chapters.map((chapter) => (
              <button
                className={selection?.type === 'chapter' && selection.id === chapter.id ? 'list-item active' : 'list-item'}
                key={chapter.id}
                onClick={() => setSelection({ type: 'chapter', id: chapter.id })}
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
            <small>{pendingCandidates.length}</small>
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
            <strong>{graph.characters.length} 人物 / {graph.relationships.length} 关系 / {graph.events.length} 事件</strong>
          </div>
          <div className="top-actions">
            <button disabled={busy} onClick={() => setShowSettings(true)}>
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
          {!graph.characters.length && (
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

function splitTags(value: string): string[] {
  return value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
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
