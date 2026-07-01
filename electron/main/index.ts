import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chardet from 'chardet';
import iconv from 'iconv-lite';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import OpenAI from 'openai';
import type {
  AnalysisProgress,
  BondEvent,
  CandidateExtraction,
  Chapter,
  CharacterNode,
  CharacterStatusEvent,
  ExtractionResult,
  GraphData,
  LlmConfig,
  LlmPreset,
  ProjectSummary,
  RelationshipEdge
} from '../../src/shared/types';

const llmRequestTimeoutMs = 180_000;
const analysisConcurrency = 2;
const analysisMaxRetries = 2;
const analysisBatchMaxChapters = 50;
const analysisBatchCharBudget = 250_000;
const analysisChunkSize = 15_000;
const analysisChunkOverlap = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let SQL: SqlJsStatic | null = null;

const smokeProfileRoot = process.env.CHARACTER_GRAPH_SMOKE_PROFILE;
if (smokeProfileRoot) {
  app.setPath('userData', path.join(smokeProfileRoot, 'user-data'));
  app.setPath('cache', path.join(smokeProfileRoot, 'cache'));
  app.setPath('documents', path.join(smokeProfileRoot, 'documents'));
}

interface AnalysisTask {
  id: string;
  chapters: Chapter[];
  label: string;
}

interface AnalysisBatchOutcome {
  results: Map<number, ExtractionResult>;
  failures: Map<number, string>;
}

interface AnalysisRuntime {
  state: AnalysisProgress;
  tasks: AnalysisTask[];
  config: LlmConfig;
  nextIndex: number;
  activeTitles: Set<string>;
  abortControllers: Set<AbortController>;
  persistQueue: Promise<void>;
}

const analysisJobs = new Map<string, AnalysisRuntime>();
const projectWriteQueues = new Map<string, Promise<void>>();

const presets: LlmPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    supportsJson: true,
    apiKeyLabel: 'DEEPSEEK_API_KEY',
    notes: 'OpenAI-compatible. Supports DeepSeek API keys and current DeepSeek model names.'
  },
  {
    id: 'kimi',
    name: 'Kimi / 月之暗面',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
    supportsJson: true,
    apiKeyLabel: 'MOONSHOT_API_KEY',
    notes: 'OpenAI-compatible Kimi platform endpoint.'
  },
  {
    id: 'dashscope',
    name: '通义千问 / DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    supportsJson: true,
    apiKeyLabel: 'DASHSCOPE_API_KEY',
    notes: 'OpenAI-compatible DashScope endpoint.'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    supportsJson: true,
    apiKeyLabel: 'ZHIPU_API_KEY',
    notes: 'OpenAI-compatible GLM endpoint.'
  },
  {
    id: 'doubao',
    name: '豆包 / 火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6',
    supportsJson: true,
    apiKeyLabel: 'ARK_API_KEY',
    notes: 'Use the endpoint model name configured in your Volcengine console.'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'MiniMax-Text-01',
    supportsJson: true,
    apiKeyLabel: 'MINIMAX_API_KEY',
    notes: 'OpenAI-compatible MiniMax endpoint where enabled.'
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    supportsJson: true,
    apiKeyLabel: 'SILICONFLOW_API_KEY',
    notes: 'Aggregator endpoint for Chinese and open models.'
  },
  {
    id: 'ollama',
    name: 'Ollama 本地模型',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    supportsJson: false,
    apiKeyLabel: 'OLLAMA_API_KEY',
    notes: 'Local OpenAI-compatible endpoint. API key can be any non-empty value.'
  },
  {
    id: 'custom',
    name: '自定义 OpenAI-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'custom-model',
    supportsJson: true,
    apiKeyLabel: 'API_KEY',
    notes: 'Use this for any provider that exposes /chat/completions.'
  }
];

const defaultConfig: LlmConfig = {
  provider: 'deepseek',
  baseUrl: presets[0].baseUrl,
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxTokens: 4096,
  supportsJson: true,
  reasoningMode: 'off'
};

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#f7f4ee',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  if ((!app.isPackaged && process.env.CHARACTER_GRAPH_SMOKE !== '1') || process.env.CHARACTER_GRAPH_DEBUG === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  if (process.env.CHARACTER_GRAPH_SMOKE === '1') {
    win.webContents.once('did-finish-load', async () => {
      try {
        const smokeImportPath = JSON.stringify(process.env.CHARACTER_GRAPH_SMOKE_IMPORT_PATH ?? '');
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            const buttonTexts = Array.from(document.querySelectorAll('button')).map((button) => button.textContent.trim());
            const project = await window.characterGraph.createProject('SmokeTest-' + Date.now());
            const importPath = ${smokeImportPath};
            const graph = importPath
              ? await window.characterGraph.importNovelFromPath(project.path, importPath)
              : await window.characterGraph.loadProject(project.path);
            const originalConfig = await window.characterGraph.loadLlmConfig(null);
            await window.characterGraph.saveLlmConfig(project.path, {
              provider: 'deepseek',
              baseUrl: 'https://api.deepseek.com',
              apiKey: '',
              model: 'deepseek-chat',
              temperature: 0.2,
              maxTokens: 4096,
              supportsJson: true,
              reasoningMode: 'off'
            });
            let analyzeError = '';
            try {
              await window.characterGraph.analyzeNovel(project.path);
            } catch (error) {
              analyzeError = error instanceof Error ? error.message : String(error);
            }
            await window.characterGraph.saveLlmConfig(null, originalConfig);
            return {
              title: document.title,
              apiReady: Boolean(window.characterGraph && window.characterGraph.getPresets),
              buttonTexts,
              modelButtonDisabled: Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('模型'))?.disabled ?? null,
              exportButtonDisabled: Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('导出'))?.disabled ?? null,
              projectCreated: Boolean(project && project.path),
              chapterCount: graph.chapters.length,
              analyzeError
            };
          })()
        `);
        console.log(`[smoke]${JSON.stringify(result)}`);
        app.exit(result.apiReady && result.projectCreated && result.analyzeError ? 0 : 1);
      } catch (error) {
        console.error('[smoke-error]', error);
        app.exit(1);
      }
    });
  }
}

async function getSql(): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  SQL = await initSqlJs({
    locateFile: () =>
      app.isPackaged
        ? path.join(process.resourcesPath, 'sql-wasm.wasm')
        : path.join(app.getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm')
  });
  return SQL;
}

function dbPath(projectPath: string): string {
  return path.join(projectPath, 'graph.sqlite');
}

function configPath(projectPath: string): string {
  return path.join(projectPath, 'model.config.json');
}

function analysisStatePath(projectPath: string): string {
  return path.join(projectPath, 'analysis.state.json');
}

function idleAnalysisProgress(): AnalysisProgress {
  return {
    status: 'idle',
    targetChapterId: null,
    targetOrderIndex: null,
    scopeTotal: 0,
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    batchCount: 0,
    batchMaxChapters: analysisBatchMaxChapters,
    activeChapterTitles: [],
    errors: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    elapsedMs: 0,
    estimatedRemainingMs: null,
    concurrency: analysisConcurrency
  };
}

function analysisSnapshot(runtime: AnalysisRuntime): AnalysisProgress {
  const state = runtime.state;
  const isActive = state.status === 'running' || state.status === 'paused';
  const elapsedMs = isActive && state.startedAt
    ? Math.max(state.elapsedMs, Date.now() - Date.parse(state.startedAt))
    : state.elapsedMs;
  const finished = state.completed + state.failed;
  const averageMs = finished > 0 ? elapsedMs / finished : 0;
  return {
    ...state,
    elapsedMs,
    remaining: Math.max(0, state.total - finished),
    activeChapterTitles: [...runtime.activeTitles],
    estimatedRemainingMs: averageMs > 0
      ? Math.round((Math.max(0, state.total - finished) * averageMs) / analysisConcurrency)
      : null
  };
}

async function persistAnalysisProgress(projectPath: string, runtime: AnalysisRuntime): Promise<void> {
  const snapshot = analysisSnapshot(runtime);
  runtime.state = snapshot;
  const payload = JSON.stringify(snapshot, null, 2);
  runtime.persistQueue = runtime.persistQueue
    .catch(() => undefined)
    .then(() => writeFile(analysisStatePath(projectPath), payload, 'utf8'));
  await runtime.persistQueue;
}

async function readAnalysisProgress(projectPath: string): Promise<AnalysisProgress> {
  const runtime = analysisJobs.get(projectPath);
  if (runtime) return analysisSnapshot(runtime);
  if (!existsSync(analysisStatePath(projectPath))) return idleAnalysisProgress();
  const stored = {
    ...idleAnalysisProgress(),
    ...(JSON.parse(await readFile(analysisStatePath(projectPath), 'utf8')) as Partial<AnalysisProgress>)
  };
  if (stored.status === 'running') stored.status = 'paused';
  return stored;
}

async function withProjectDbWrite(
  projectPath: string,
  action: (db: Database) => void
): Promise<void> {
  const previous = projectWriteQueues.get(projectPath) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  projectWriteQueues.set(projectPath, queued);
  await previous.catch(() => undefined);
  try {
    const db = await openDb(projectPath);
    action(db);
    await saveDb(projectPath, db);
  } finally {
    release();
    if (projectWriteQueues.get(projectPath) === queued) projectWriteQueues.delete(projectPath);
  }
}

function globalConfigPath(): string {
  return path.join(app.getPath('userData'), 'model.config.json');
}

function projectsRoot(): string {
  return path.join(app.getPath('documents'), 'CharacterGraphProjects');
}

function projectMetaPath(projectPath: string): string {
  return path.join(projectPath, 'project.json');
}

async function openDb(projectPath: string): Promise<Database> {
  const sql = await getSql();
  const file = dbPath(projectPath);
  const db = existsSync(file) ? new sql.Database(await readFile(file)) : new sql.Database();
  createSchema(db);
  return db;
}

async function saveDb(projectPath: string, db: Database): Promise<void> {
  const bytes = db.export();
  await writeFile(dbPath(projectPath), Buffer.from(bytes));
  db.close();
}

function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_file TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      first_chapter_id INTEGER,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_character_id INTEGER NOT NULL,
      target_character_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      strength INTEGER NOT NULL DEFAULT 3,
      summary TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.6,
      UNIQUE(source_character_id, target_character_id, type)
    );
    CREATE TABLE IF NOT EXISTS bond_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      relationship_id INTEGER NOT NULL,
      chapter_id INTEGER,
      summary TEXT NOT NULL,
      evidence TEXT NOT NULL,
      order_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'confirmed'
    );
    CREATE TABLE IF NOT EXISTS character_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      chapter_id INTEGER,
      status TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS candidate_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function query<T>(db: Database, sql: string, params: SqlValue[] = [], map: (row: Record<string, unknown>) => T): T[] {
  const stmt = db.prepare(sql, params);
  const rows: T[] = [];
  while (stmt.step()) rows.push(map(stmt.getAsObject()));
  stmt.free();
  return rows;
}

function scalar<T>(db: Database, sql: string, params: SqlValue[] = []): T | null {
  const stmt = db.prepare(sql, params);
  const value = stmt.step() ? (Object.values(stmt.getAsObject())[0] as T) : null;
  stmt.free();
  return value;
}

async function readProjectSummary(projectPath: string): Promise<ProjectSummary> {
  const raw = await readFile(projectMetaPath(projectPath), 'utf8');
  return JSON.parse(raw) as ProjectSummary;
}

async function writeProjectSummary(projectPath: string, summary: ProjectSummary): Promise<void> {
  await writeFile(projectMetaPath(projectPath), JSON.stringify(summary, null, 2), 'utf8');
}

async function ensureProject(projectPath: string, name: string): Promise<ProjectSummary> {
  await mkdir(projectPath, { recursive: true });
  await mkdir(path.join(projectPath, 'originals'), { recursive: true });
  await mkdir(path.join(projectPath, 'exports'), { recursive: true });
  const now = new Date().toISOString();
  const summary: ProjectSummary = existsSync(projectMetaPath(projectPath))
    ? await readProjectSummary(projectPath)
    : { name, path: projectPath, createdAt: now, updatedAt: now };
  summary.updatedAt = now;
  await writeProjectSummary(projectPath, summary);
  const db = await openDb(projectPath);
  await saveDb(projectPath, db);
  return summary;
}

async function readLlmConfig(projectPath: string | null): Promise<LlmConfig> {
  if (existsSync(globalConfigPath())) {
    return { ...defaultConfig, ...(JSON.parse(await readFile(globalConfigPath(), 'utf8')) as Partial<LlmConfig>) };
  }
  if (projectPath && existsSync(configPath(projectPath))) {
    const migrated = { ...defaultConfig, ...(JSON.parse(await readFile(configPath(projectPath), 'utf8')) as Partial<LlmConfig>) };
    await writeLlmConfig(null, migrated);
    return migrated;
  }
  return defaultConfig;
}

async function writeLlmConfig(_projectPath: string | null, config: LlmConfig): Promise<LlmConfig> {
  await mkdir(path.dirname(globalConfigPath()), { recursive: true });
  await writeFile(globalConfigPath(), JSON.stringify(config, null, 2), 'utf8');
  return config;
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function graphData(projectPath: string): Promise<GraphData> {
  const db = await openDb(projectPath);
  const chapters = query<Chapter>(
    db,
    'SELECT id, title, order_index, substr(content, 1, 1200) AS content, length(content) AS content_length, source_file FROM chapters ORDER BY order_index ASC, id ASC',
    [],
    (row) => ({
      id: Number(row.id),
      title: String(row.title),
      orderIndex: Number(row.order_index),
      content: String(row.content),
      sourceFile: String(row.source_file),
      contentLength: Number(row.content_length)
    })
  );
  const characters = query<CharacterNode>(
    db,
    "SELECT * FROM characters WHERE status != 'rejected' ORDER BY name ASC",
    [],
    (row) => ({
      id: Number(row.id),
      name: String(row.name),
      aliases: safeJson<string[]>(String(row.aliases_json), []),
      summary: String(row.summary ?? ''),
      tags: safeJson<string[]>(String(row.tags_json), []),
      firstChapterId: row.first_chapter_id === null ? null : Number(row.first_chapter_id),
      status: String(row.status) as CharacterNode['status']
    })
  );
  const relationships = query<RelationshipEdge>(
    db,
    `WITH pairs AS (
       SELECT
         MIN(id) AS id,
         CASE WHEN source_character_id < target_character_id THEN source_character_id ELSE target_character_id END AS source_character_id,
         CASE WHEN source_character_id < target_character_id THEN target_character_id ELSE source_character_id END AS target_character_id,
         group_concat(DISTINCT type) AS type,
         MAX(strength) AS strength,
         group_concat(DISTINCT NULLIF(summary, '')) AS summary,
         MAX(confidence) AS confidence,
         MIN(status) AS status
       FROM relationships
       WHERE status != 'rejected'
       GROUP BY
         CASE WHEN source_character_id < target_character_id THEN source_character_id ELSE target_character_id END,
         CASE WHEN source_character_id < target_character_id THEN target_character_id ELSE source_character_id END
     )
     SELECT p.*, sc.name AS source_name, tc.name AS target_name
     FROM pairs p
     JOIN characters sc ON sc.id = p.source_character_id
     JOIN characters tc ON tc.id = p.target_character_id
     ORDER BY p.id ASC`,
    [],
    (row) => ({
      id: Number(row.id),
      sourceCharacterId: Number(row.source_character_id),
      targetCharacterId: Number(row.target_character_id),
      sourceName: String(row.source_name),
      targetName: String(row.target_name),
      type: String(row.type || '关系'),
      status: String(row.status || 'confirmed') as RelationshipEdge['status'],
      strength: Number(row.strength || 3),
      summary: String(row.summary ?? '').split(',').filter(Boolean).join('\n'),
      confidence: Number(row.confidence || 0.6)
    })
  );
  const events = query<BondEvent>(
    db,
    `WITH relation_pairs AS (
       SELECT
         MIN(id) AS canonical_id,
         CASE WHEN source_character_id < target_character_id THEN source_character_id ELSE target_character_id END AS source_character_id,
         CASE WHEN source_character_id < target_character_id THEN target_character_id ELSE source_character_id END AS target_character_id
       FROM relationships
       WHERE status != 'rejected'
       GROUP BY
         CASE WHEN source_character_id < target_character_id THEN source_character_id ELSE target_character_id END,
         CASE WHEN source_character_id < target_character_id THEN target_character_id ELSE source_character_id END
     )
     SELECT e.*, c.title AS chapter_title, rp.canonical_id AS canonical_relationship_id
     FROM bond_events e
     JOIN relationships r ON r.id = e.relationship_id
     JOIN relation_pairs rp
       ON rp.source_character_id = CASE WHEN r.source_character_id < r.target_character_id THEN r.source_character_id ELSE r.target_character_id END
      AND rp.target_character_id = CASE WHEN r.source_character_id < r.target_character_id THEN r.target_character_id ELSE r.source_character_id END
     LEFT JOIN chapters c ON c.id = e.chapter_id
     WHERE e.status != 'rejected'
     ORDER BY e.order_index ASC, e.id ASC`,
    [],
    (row) => ({
      id: Number(row.id),
      relationshipId: Number(row.canonical_relationship_id),
      chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
      chapterTitle: row.chapter_title === null ? null : String(row.chapter_title),
      summary: String(row.summary),
      evidence: String(row.evidence),
      orderIndex: Number(row.order_index),
      status: String(row.status) as BondEvent['status']
    })
  );
  const statusEvents = query<CharacterStatusEvent>(
    db,
    `SELECT se.*, ch.name AS character_name, c.title AS chapter_title
     FROM character_status_events se
     JOIN characters ch ON ch.id = se.character_id
     LEFT JOIN chapters c ON c.id = se.chapter_id
     ORDER BY c.order_index ASC, se.id ASC`,
    [],
    (row) => ({
      id: Number(row.id),
      characterId: Number(row.character_id),
      characterName: String(row.character_name),
      chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
      chapterTitle: row.chapter_title === null ? null : String(row.chapter_title),
      status: String(row.status) as CharacterStatusEvent['status'],
      evidence: String(row.evidence ?? '')
    })
  );
  const candidates = query<CandidateExtraction>(
    db,
    `SELECT ce.*, c.title AS chapter_title
     FROM candidate_extractions ce
     LEFT JOIN chapters c ON c.id = ce.chapter_id
     ORDER BY ce.id DESC`,
    [],
    (row) => ({
      id: Number(row.id),
      chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
      chapterTitle: row.chapter_title === null ? null : String(row.chapter_title),
      kind: String(row.kind) as CandidateExtraction['kind'],
      payload: safeJson<unknown>(String(row.payload_json), null),
      status: String(row.status) as CandidateExtraction['status'],
      error: String(row.error ?? ''),
      createdAt: String(row.created_at)
    })
  );
  await saveDb(projectPath, db);
  return { chapters, characters, relationships, events, statusEvents, candidates };
}

function normalizeEncodingName(name: string | null): string {
  if (!name) return 'utf8';
  const lower = name.toLowerCase();
  if (lower.includes('gb') || lower.includes('big5')) return 'gb18030';
  if (lower.includes('utf-16le')) return 'utf16-le';
  if (lower.includes('utf-16be')) return 'utf16-be';
  return 'utf8';
}

async function readChineseText(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const encoding = normalizeEncodingName(chardet.detect(buffer));
  return iconv.decode(buffer, encoding).replace(/^\uFEFF/, '');
}

function splitChapters(text: string): Array<{ title: string; content: string }> {
  const normalized = text.replace(/\r\n/g, '\n');
  const heading = /^(?:#{1,3}\s*)?(第[零〇一二三四五六七八九十百千万\d]+[章节回卷集部].*|楔子|序章|引子|尾声)\s*$/gm;
  const matches = [...normalized.matchAll(heading)];
  if (!matches.length) {
    const chunkSize = 6000;
    const chunks: Array<{ title: string; content: string }> = [];
    for (let start = 0, index = 1; start < normalized.length; start += chunkSize, index += 1) {
      chunks.push({
        title: `自动分块 ${index}`,
        content: normalized.slice(start, start + chunkSize).trim()
      });
    }
    return chunks.filter((chapter) => chapter.content.length > 0);
  }

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const next = matches[index + 1]?.index ?? normalized.length;
    return {
      title: match[1].trim(),
      content: normalized.slice(start, next).trim()
    };
  });
}

async function importNovelFile(projectPath: string, filePath: string): Promise<GraphData> {
  const sourceName = path.basename(filePath);
  const text = await readChineseText(filePath);
  const chapters = splitChapters(text);
  const originalsPath = path.join(projectPath, 'originals', sourceName);
  await copyFile(filePath, originalsPath);
  const db = await openDb(projectPath);
  const currentCount = scalar<number>(db, 'SELECT COUNT(*) FROM chapters') ?? 0;
  chapters.forEach((chapter, index) => {
    db.run(
      'INSERT INTO chapters (title, order_index, content, source_file) VALUES (?, ?, ?, ?)',
      [chapter.title, currentCount + index + 1, chapter.content, sourceName]
    );
  });
  await saveDb(projectPath, db);
  return graphData(projectPath);
}

function extractionPrompt(chapter: Chapter): string {
  return [
    '你是小说人物关系抽取器。只根据给定章节文本抽取，不要补充常识，不要编造。statusEvents 只在原文明示人物死亡、退场、封存、离开主线、后续不再使用时输出；不要因为人物本章未出现就判断 unused。',
    '输出严格 JSON，结构如下：',
    '{',
    '  "characters": [',
    '    {"name": "人物名", "aliases": ["别名"], "summary": "本章中可证实的人物信息", "tags": ["身份或阵营"], "evidence": "原文证据片段"}',
    '  ],',
    '  "statusEvents": [',
    '    {"character": "人物名", "status": "active/dead/retired/unused", "evidence": "原文明示证据片段"}',
    '  ],',
    '  "relationships": [',
    '    {',
    '      "source": "人物A",',
    '      "target": "人物B",',
    '      "type": "师徒/亲族/敌对/盟友/暧昧/主仆/同族/交易/未知等",',
    '      "summary": "二人关系与羁绊摘要",',
    '      "strength": 1到5的整数,',
    '      "confidence": 0到1的小数,',
    '      "evidence": "原文证据片段",',
    '      "events": [{"summary": "关键事件", "evidence": "原文证据片段"}]',
    '    }',
    '  ]',
    '}',
    '',
    '章节标题：' + chapter.title,
    '',
    '章节正文：' + chapter.content
  ].join('\n');
}

function batchExtractionPrompt(chapters: Chapter[]): string {
  const chapterTexts = chapters.map((chapter) => [
    '---',
    '章节ID：' + chapter.id,
    '章节序号：' + chapter.orderIndex,
    '章节标题：' + chapter.title,
    '章节正文：',
    chapter.content
  ].join('\n')).join('\n\n');

  return [
    '你是小说人物关系抽取器。现在一次给你多章文本，请分别按章节抽取人物、别名、关系、羁绊、事件和人物状态。',
    '',
    '硬性规则：',
    '1. 只根据给定章节原文抽取，不要补充常识，不要编造。',
    '2. 必须按章节分别返回；每个结果必须带 chapterId，且 chapterId 必须来自输入。',
    '3. 人物、关系、事件都必须有原文 evidence。',
    '4. 两个人之间互为朋友、盟友、敌人等，只输出一条关系，不要输出 A->B 和 B->A 两条。',
    '5. statusEvents 只在原文明示死亡、退场、封存、离开主线、后续不再使用时输出；不要因为人物本批次后续没出现就判断 unused。',
    '6. 不要把后面章节的信息提前写进前面章节。关系和状态发生在哪一章，就放在哪一章的结果里。',
    '7. 输出必须是可解析 JSON，不要 Markdown，不要解释文字。',
    '',
    '输出结构：',
    '{',
    '  "chapters": [',
    '    {',
    '      "chapterId": 章节ID数字,',
    '      "chapterTitle": "章节标题",',
    '      "characters": [',
    '        {"name": "人物名", "aliases": ["别名"], "summary": "本章中可证实的人物信息", "tags": ["身份或阵营"], "evidence": "原文证据片段"}',
    '      ],',
    '      "statusEvents": [',
    '        {"character": "人物名", "status": "active/dead/retired/unused", "evidence": "原文明示证据片段"}',
    '      ],',
    '      "relationships": [',
    '        {',
    '          "source": "人物A",',
    '          "target": "人物B",',
    '          "type": "师徒/亲族/敌对/盟友/朋友/暧昧/主仆/同族/交易/未知等",',
    '          "summary": "二人关系与羁绊摘要",',
    '          "strength": 1到5的整数,',
    '          "confidence": 0到1的小数,',
    '          "evidence": "原文证据片段",',
    '          "events": [{"summary": "关键事件", "evidence": "原文证据片段"}]',
    '        }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '',
    '本批次共 ' + chapters.length + ' 章：',
    chapterTexts
  ].join('\n');
}

function parseJsonObject(raw: string): unknown {
  const fence = String.fromCharCode(96).repeat(3);
  let candidate = raw;
  const fenceStart = raw.indexOf(fence);
  if (fenceStart >= 0) {
    const afterFence = raw.slice(fenceStart + fence.length).replace(/^json\s*/i, '');
    const fenceEnd = afterFence.indexOf(fence);
    candidate = fenceEnd >= 0 ? afterFence.slice(0, fenceEnd) : afterFence;
  }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('模型没有返回 JSON 对象。');
  return JSON.parse(candidate.slice(first, last + 1));
}

function normalizeExtraction(value: unknown): ExtractionResult {
  const parsed = value && typeof value === 'object' ? value as Partial<ExtractionResult> : {};
  return {
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    statusEvents: Array.isArray(parsed.statusEvents) ? parsed.statusEvents : []
  };
}

function parseExtraction(raw: string): ExtractionResult {
  return normalizeExtraction(parseJsonObject(raw));
}

function parseBatchExtraction(raw: string, chapters: Chapter[]): Map<number, ExtractionResult> {
  const parsed = parseJsonObject(raw);
  const root = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const items = Array.isArray(root.chapters)
    ? root.chapters
    : Array.isArray(root.results)
      ? root.results
      : null;

  if (!items && chapters.length === 1) {
    return new Map([[chapters[0].id, normalizeExtraction(root)]]);
  }
  if (!items) throw new Error('模型没有返回 chapters 数组。');

  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const byOrderIndex = new Map(chapters.map((chapter) => [chapter.orderIndex, chapter]));
  const results = new Map<number, ExtractionResult>();

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rawId = record.chapterId ?? record.chapter_id ?? record.id;
    const rawOrder = record.orderIndex ?? record.order_index ?? record.chapterOrder ?? record.chapter_order;
    const chapterId = Number(rawId);
    const orderIndex = Number(rawOrder);
    const chapter = Number.isFinite(chapterId) && byId.has(chapterId)
      ? byId.get(chapterId)
      : Number.isFinite(orderIndex)
        ? byOrderIndex.get(orderIndex)
        : undefined;
    if (!chapter) continue;
    const current = results.get(chapter.id);
    const next = normalizeExtraction(record);
    results.set(chapter.id, current ? mergeExtractions([current, next]) : next);
  }

  const missing = chapters.filter((chapter) => !results.has(chapter.id));
  if (missing.length) {
    throw new Error('模型漏返回章节：' + missing.slice(0, 5).map((chapter) => chapter.title).join('、'));
  }
  return results;
}

async function requestLlm(config: LlmConfig, prompt: string, signal?: AbortSignal): Promise<string> {
  if (config.provider !== 'ollama' && !config.apiKey.trim()) {
    throw new Error('请先在“模型”里填写 API Key，并点击“保存配置”。');
  }
  const client = new OpenAI({
    apiKey: config.apiKey || 'ollama',
    baseURL: config.baseUrl,
    timeout: llmRequestTimeoutMs,
    maxRetries: 0
  });
  const extraBody: Record<string, unknown> = {};
  if (config.provider === 'deepseek' && config.reasoningMode !== 'off') {
    extraBody.thinking = { type: 'enabled' };
    extraBody.reasoning_effort = config.reasoningMode === 'high' ? 'high' : 'medium';
  }
  const response = await client.chat.completions.create({
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    response_format: config.supportsJson ? { type: 'json_object' } : undefined,
    messages: [
      {
        role: 'system',
        content: '你只输出可解析 JSON。所有结论必须来自用户提供的小说章节。'
      },
      { role: 'user', content: prompt }
    ],
    ...extraBody
  }, { signal });
  return response.choices[0]?.message?.content ?? '';
}

async function callLlm(config: LlmConfig, chapter: Chapter, signal?: AbortSignal): Promise<ExtractionResult> {
  return parseExtraction(await requestLlm(config, extractionPrompt(chapter), signal));
}

async function callBatchLlm(config: LlmConfig, chapters: Chapter[], signal?: AbortSignal): Promise<Map<number, ExtractionResult>> {
  return parseBatchExtraction(await requestLlm(config, batchExtractionPrompt(chapters), signal), chapters);
}

function splitChapterForAnalysis(chapter: Chapter): Chapter[] {
  if (chapter.content.length <= analysisChunkSize) return [chapter];
  const chunks: Chapter[] = [];
  let start = 0;
  let part = 1;
  while (start < chapter.content.length) {
    let end = Math.min(chapter.content.length, start + analysisChunkSize);
    if (end < chapter.content.length) {
      const paragraphBreak = chapter.content.lastIndexOf('\n', end);
      if (paragraphBreak > start + Math.floor(analysisChunkSize * 0.6)) end = paragraphBreak;
    }
    const content = chapter.content.slice(start, end).trim();
    if (content) {
      chunks.push({
        ...chapter,
        title: chapter.title + '（分段 ' + part + '）',
        content,
        contentLength: content.length
      });
      part += 1;
    }
    if (end >= chapter.content.length) break;
    start = Math.max(start + 1, end - analysisChunkOverlap);
  }
  return chunks;
}

function mergeExtractions(results: ExtractionResult[]): ExtractionResult {
  const characters = new Map<string, ExtractionResult['characters'][number]>();
  const relationships = new Map<string, ExtractionResult['relationships'][number]>();
  const statusEvents = new Map<string, NonNullable<ExtractionResult['statusEvents']>[number]>();

  for (const result of results) {
    for (const character of result.characters) {
      const name = character.name?.trim();
      if (!name) continue;
      const existing = characters.get(name);
      characters.set(name, existing ? {
        ...existing,
        aliases: [...new Set([...(existing.aliases ?? []), ...(character.aliases ?? [])])],
        tags: [...new Set([...(existing.tags ?? []), ...(character.tags ?? [])])],
        summary: existing.summary || character.summary,
        evidence: existing.evidence || character.evidence
      } : character);
    }
    for (const relationship of result.relationships) {
      if (!relationship.source || !relationship.target) continue;
      const pair = [relationship.source.trim(), relationship.target.trim()].sort().join('|');
      const key = pair + '|' + (relationship.type || '未知');
      const existing = relationships.get(key);
      relationships.set(key, existing ? {
        ...existing,
        strength: Math.max(existing.strength ?? 1, relationship.strength ?? 1),
        confidence: Math.max(existing.confidence ?? 0, relationship.confidence ?? 0),
        summary: existing.summary || relationship.summary,
        evidence: existing.evidence || relationship.evidence,
        events: [...(existing.events ?? []), ...(relationship.events ?? [])]
      } : relationship);
    }
    for (const event of result.statusEvents ?? []) {
      if (!event.character || !event.status) continue;
      statusEvents.set(event.character.trim() + '|' + event.status, event);
    }
  }

  return {
    characters: [...characters.values()],
    relationships: [...relationships.values()],
    statusEvents: [...statusEvents.values()]
  };
}

function createAnalysisTasks(chapters: Chapter[]): AnalysisTask[] {
  const tasks: AnalysisTask[] = [];
  let current: Chapter[] = [];
  let currentChars = 0;

  const flush = (): void => {
    if (!current.length) return;
    const first = current[0];
    const last = current[current.length - 1];
    tasks.push({
      id: first.id + '-' + last.id,
      chapters: current,
      label: current.length === 1
        ? first.title
        : first.title + ' 至 ' + last.title + '（' + current.length + '章）'
    });
    current = [];
    currentChars = 0;
  };

  for (const chapter of chapters) {
    if (chapter.content.length > analysisBatchCharBudget) {
      flush();
      tasks.push({ id: String(chapter.id), chapters: [chapter], label: chapter.title });
      continue;
    }
    if (current.length >= analysisBatchMaxChapters || (current.length > 0 && currentChars + chapter.content.length > analysisBatchCharBudget)) {
      flush();
    }
    current.push(chapter);
    currentChars += chapter.content.length;
  }
  flush();
  return tasks;
}

async function callBatchWithRetry(config: LlmConfig, chapters: Chapter[], signal?: AbortSignal): Promise<Map<number, ExtractionResult>> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= analysisMaxRetries; attempt += 1) {
    try {
      return await callBatchLlm(config, chapters, signal);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt < analysisMaxRetries) await abortableDelay(1200 * (attempt + 1), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callChaptersWithFallback(config: LlmConfig, chapters: Chapter[], signal?: AbortSignal): Promise<AnalysisBatchOutcome> {
  if (!chapters.length) return { results: new Map(), failures: new Map() };

  if (!(chapters.length === 1 && chapters[0].content.length > analysisBatchCharBudget)) {
    try {
      return { results: await callBatchWithRetry(config, chapters, signal), failures: new Map() };
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }

  if (chapters.length === 1) {
    const chapter = chapters[0];
    try {
      return {
        results: new Map([[chapter.id, await callChapterWithRetry(config, chapter, signal)]]),
        failures: new Map()
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        results: new Map(),
        failures: new Map([[chapter.id, error instanceof Error ? error.message : String(error)]])
      };
    }
  }

  const midpoint = Math.ceil(chapters.length / 2);
  const left = await callChaptersWithFallback(config, chapters.slice(0, midpoint), signal);
  const right = await callChaptersWithFallback(config, chapters.slice(midpoint), signal);
  return {
    results: new Map([...left.results, ...right.results]),
    failures: new Map([...left.failures, ...right.failures])
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('分析已取消'));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('分析已取消'));
    }, { once: true });
  });
}

async function callChapterWithRetry(
  config: LlmConfig,
  chapter: Chapter,
  signal?: AbortSignal
): Promise<ExtractionResult> {
  const results: ExtractionResult[] = [];
  for (const chunk of splitChapterForAnalysis(chapter)) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= analysisMaxRetries; attempt += 1) {
      try {
        results.push(await callLlm(config, chunk, signal));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (attempt < analysisMaxRetries) await abortableDelay(1200 * (attempt + 1), signal);
      }
    }
    if (lastError) throw lastError;
  }
  return mergeExtractions(results);
}

async function persistAnalysisCandidate(
  projectPath: string,
  chapterId: number,
  extraction: ExtractionResult
): Promise<void> {
  await withProjectDbWrite(projectPath, (db) => {
    db.run(
      "UPDATE candidate_extractions SET status = 'rejected' WHERE chapter_id = ? AND kind = 'error' AND status = 'error'",
      [chapterId]
    );
    db.run(
      "INSERT INTO candidate_extractions (chapter_id, kind, payload_json, status) VALUES (?, 'batch', ?, 'pending')",
      [chapterId, JSON.stringify(extraction)]
    );
  });
}

async function persistAnalysisError(
  projectPath: string,
  chapterId: number,
  message: string
): Promise<void> {
  await withProjectDbWrite(projectPath, (db) => {
    db.run(
      "UPDATE candidate_extractions SET status = 'rejected' WHERE chapter_id = ? AND kind = 'error' AND status = 'error'",
      [chapterId]
    );
    db.run(
      "INSERT INTO candidate_extractions (chapter_id, kind, payload_json, status, error) VALUES (?, 'error', '{}', 'error', ?)",
      [chapterId, message]
    );
  });
}

function isAnalysisCancelled(runtime: AnalysisRuntime): boolean {
  return runtime.state.status === 'cancelled';
}
async function runAnalysisWorker(projectPath: string, runtime: AnalysisRuntime): Promise<void> {
  while (runtime.nextIndex < runtime.tasks.length) {
    while (runtime.state.status === 'paused') {
      await abortableDelay(200);
      if (isAnalysisCancelled(runtime)) return;
    }
    if (runtime.state.status !== 'running') return;

    const task = runtime.tasks[runtime.nextIndex];
    runtime.nextIndex += 1;
    runtime.activeTitles.add(task.label);
    const controller = new AbortController();
    runtime.abortControllers.add(controller);
    runtime.state.updatedAt = new Date().toISOString();
    await persistAnalysisProgress(projectPath, runtime);

    try {
      const outcome = await callChaptersWithFallback(runtime.config, task.chapters, controller.signal);
      if (!isAnalysisCancelled(runtime)) {
        for (const chapter of task.chapters) {
          const extraction = outcome.results.get(chapter.id);
          const failure = outcome.failures.get(chapter.id);
          if (extraction) {
            await persistAnalysisCandidate(projectPath, chapter.id, extraction);
            runtime.state.completed += 1;
          } else {
            const message = failure || '模型没有返回该章节结果。';
            runtime.state.failed += 1;
            runtime.state.errors = [...runtime.state.errors, chapter.title + ': ' + message].slice(-20);
            await persistAnalysisError(projectPath, chapter.id, message);
          }
        }
      }
    } catch (error) {
      if (!isAnalysisCancelled(runtime) && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        for (const chapter of task.chapters) {
          runtime.state.failed += 1;
          runtime.state.errors = [...runtime.state.errors, chapter.title + ': ' + message].slice(-20);
          await persistAnalysisError(projectPath, chapter.id, message);
        }
      }
    } finally {
      runtime.activeTitles.delete(task.label);
      runtime.abortControllers.delete(controller);
      runtime.state.updatedAt = new Date().toISOString();
      await persistAnalysisProgress(projectPath, runtime);
    }
  }
}

async function runAnalysisJob(projectPath: string, runtime: AnalysisRuntime): Promise<void> {
  try {
    const workerCount = Math.min(analysisConcurrency, runtime.tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => runAnalysisWorker(projectPath, runtime)));
    if (runtime.state.status === 'running') {
      runtime.state.status = runtime.state.failed === runtime.state.total && runtime.state.total > 0
        ? 'error'
        : 'completed';
    }
  } catch (error) {
    runtime.state.status = 'error';
    runtime.state.errors = [
      ...runtime.state.errors,
      error instanceof Error ? error.message : String(error)
    ].slice(-20);
  } finally {
    runtime.activeTitles.clear();
    runtime.state.elapsedMs = runtime.state.startedAt
      ? Date.now() - Date.parse(runtime.state.startedAt)
      : runtime.state.elapsedMs;
    runtime.state.updatedAt = new Date().toISOString();
    await persistAnalysisProgress(projectPath, runtime);
  }
}

async function startAnalysisJob(projectPath: string, upToChapterId?: number | null): Promise<AnalysisProgress> {
  const active = analysisJobs.get(projectPath);
  if (active && (active.state.status === 'running' || active.state.status === 'paused')) {
    return analysisSnapshot(active);
  }

  const config = await readLlmConfig(projectPath);
  if (config.provider !== 'ollama' && !config.apiKey.trim()) {
    throw new Error('请先点击“模型”，填写 DeepSeek API Key，保存后再生成谱系图。');
  }

  const db = await openDb(projectPath);
  const limitOrder = upToChapterId ? scalar<number>(db, 'SELECT order_index FROM chapters WHERE id = ?', [upToChapterId]) : null;
  if (upToChapterId && limitOrder === null) {
    await saveDb(projectPath, db);
    throw new Error('章节不存在。');
  }
  const scopeTotal = scalar<number>(db, 'SELECT COUNT(*) FROM chapters WHERE (? IS NULL OR order_index <= ?)', [limitOrder, limitOrder]) ?? 0;
  const chapters = query<Chapter>(
    db,
    "SELECT c.* FROM chapters c WHERE (? IS NULL OR c.order_index <= ?) AND NOT EXISTS (SELECT 1 FROM candidate_extractions ce WHERE ce.chapter_id = c.id AND ce.kind = 'batch' AND ce.status IN ('pending', 'confirmed')) ORDER BY c.order_index ASC, c.id ASC",
    [limitOrder, limitOrder],
    (row) => ({
      id: Number(row.id),
      title: String(row.title),
      orderIndex: Number(row.order_index),
      content: String(row.content),
      sourceFile: String(row.source_file),
      contentLength: String(row.content).length
    })
  );
  const skipped = Math.max(0, scopeTotal - chapters.length);
  await saveDb(projectPath, db);

  const tasks = createAnalysisTasks(chapters);
  const now = new Date().toISOString();
  const runtime: AnalysisRuntime = {
    state: {
      status: chapters.length ? 'running' : 'completed',
      targetChapterId: upToChapterId ?? null,
      targetOrderIndex: limitOrder,
      scopeTotal,
      total: chapters.length,
      completed: 0,
      failed: 0,
      skipped,
      remaining: chapters.length,
      batchCount: tasks.length,
      batchMaxChapters: analysisBatchMaxChapters,
      activeChapterTitles: [],
      errors: [],
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      estimatedRemainingMs: null,
      concurrency: analysisConcurrency
    },
    tasks,
    config,
    nextIndex: 0,
    activeTitles: new Set(),
    abortControllers: new Set(),
    persistQueue: Promise.resolve()
  };
  analysisJobs.set(projectPath, runtime);
  await persistAnalysisProgress(projectPath, runtime);
  if (chapters.length) void runAnalysisJob(projectPath, runtime);
  return analysisSnapshot(runtime);
}

async function pauseAnalysisJob(projectPath: string): Promise<AnalysisProgress> {
  const runtime = analysisJobs.get(projectPath);
  if (!runtime) return readAnalysisProgress(projectPath);
  if (runtime.state.status === 'running') runtime.state.status = 'paused';
  runtime.state.updatedAt = new Date().toISOString();
  await persistAnalysisProgress(projectPath, runtime);
  return analysisSnapshot(runtime);
}

async function resumeAnalysisJob(projectPath: string): Promise<AnalysisProgress> {
  const runtime = analysisJobs.get(projectPath);
  if (runtime && runtime.state.status === 'paused') {
    runtime.state.status = 'running';
    runtime.state.updatedAt = new Date().toISOString();
    await persistAnalysisProgress(projectPath, runtime);
    return analysisSnapshot(runtime);
  }
  const stored = await readAnalysisProgress(projectPath);
  return startAnalysisJob(projectPath, stored.targetChapterId);
}

async function cancelAnalysisJob(projectPath: string): Promise<AnalysisProgress> {
  const runtime = analysisJobs.get(projectPath);
  if (!runtime) return readAnalysisProgress(projectPath);
  runtime.state.status = 'cancelled';
  runtime.state.elapsedMs = runtime.state.startedAt
    ? Date.now() - Date.parse(runtime.state.startedAt)
    : runtime.state.elapsedMs;
  runtime.state.updatedAt = new Date().toISOString();
  runtime.abortControllers.forEach((controller) => controller.abort());
  await persistAnalysisProgress(projectPath, runtime);
  return analysisSnapshot(runtime);
}
function findCharacterId(db: Database, name: string, aliases: string[]): number | null {
  const names = new Set([name, ...aliases].map((item) => item.trim()).filter(Boolean));
  const rows = query<{ id: number; name: string; aliases: string[] }>(
    db,
    'SELECT id, name, aliases_json FROM characters',
    [],
    (row) => ({
      id: Number(row.id),
      name: String(row.name),
      aliases: safeJson<string[]>(String(row.aliases_json), [])
    })
  );
  return rows.find((row) => names.has(row.name) || row.aliases.some((alias) => names.has(alias)))?.id ?? null;
}

function upsertCharacter(
  db: Database,
  input: { name: string; aliases?: string[]; summary?: string; tags?: string[] },
  chapterId: number | null
): number {
  const name = input.name.trim();
  if (!name) throw new Error('人物名为空。');
  const aliases = [...new Set((input.aliases ?? []).map((item) => item.trim()).filter(Boolean))];
  const tags = [...new Set((input.tags ?? []).map((item) => item.trim()).filter(Boolean))];
  const existingId = findCharacterId(db, name, aliases);
  if (existingId) {
    const existing = query<{ name: string; aliases: string[]; tags: string[]; summary: string }>(
      db,
      'SELECT name, aliases_json, tags_json, summary FROM characters WHERE id = ?',
      [existingId],
      (row) => ({
        name: String(row.name),
        aliases: safeJson<string[]>(String(row.aliases_json), []),
        tags: safeJson<string[]>(String(row.tags_json), []),
        summary: String(row.summary ?? '')
      })
    )[0];
    const mergedAliases = new Set([...existing.aliases, ...aliases]);
    if (existing.name !== name) mergedAliases.add(name);
    mergedAliases.delete(existing.name);
    db.run(
      `UPDATE characters
       SET aliases_json = ?, tags_json = ?, summary = CASE WHEN summary = '' THEN ? ELSE summary END
       WHERE id = ?`,
      [
        JSON.stringify([...mergedAliases]),
        JSON.stringify([...new Set([...existing.tags, ...tags])]),
        input.summary ?? '',
        existingId
      ]
    );
    return existingId;
  }
  db.run(
    `INSERT INTO characters (name, aliases_json, summary, tags_json, first_chapter_id, status)
     VALUES (?, ?, ?, ?, ?, 'confirmed')`,
    [name, JSON.stringify(aliases), input.summary ?? '', JSON.stringify(tags), chapterId]
  );
  return Number(scalar<number>(db, 'SELECT last_insert_rowid()'));
}

function orderedPair(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

function upsertRelationship(
  db: Database,
  sourceId: number,
  targetId: number,
  type: string,
  summary: string,
  strength: number,
  confidence: number
): number {
  const [left, right] = orderedPair(sourceId, targetId);
  const existingId = scalar<number>(
    db,
    'SELECT id FROM relationships WHERE source_character_id = ? AND target_character_id = ? AND type = ? LIMIT 1',
    [left, right, type]
  );
  if (existingId) {
    db.run(
      `UPDATE relationships
       SET summary = CASE WHEN summary = '' THEN ? ELSE summary END,
           strength = MAX(strength, ?),
           confidence = MAX(confidence, ?)
       WHERE id = ?`,
      [summary, strength, confidence, existingId]
    );
    return existingId;
  }
  db.run(
    `INSERT INTO relationships
     (source_character_id, target_character_id, type, status, strength, summary, confidence)
     VALUES (?, ?, ?, 'confirmed', ?, ?, ?)`,
    [left, right, type, strength, summary, confidence]
  );
  return Number(scalar<number>(db, 'SELECT last_insert_rowid()'));
}

function normalizeCharacterStatus(value: string): CharacterStatusEvent['status'] | null {
  const text = value.toLowerCase();
  if (/死亡|已死|身亡|战死|陨落|dead|died|killed/.test(text)) return 'dead';
  if (/退场|离队|离开主线|退出|retired|left/.test(text)) return 'retired';
  if (/不再使用|不再登场|后续不再|弃用|unused|inactive/.test(text)) return 'unused';
  if (/活跃|登场|active/.test(text)) return 'active';
  return null;
}

function upsertCharacterStatusEvent(
  db: Database,
  characterId: number,
  chapterId: number | null,
  status: CharacterStatusEvent['status'],
  evidence: string
): void {
  if (status === 'active') return;
  const existing = scalar<number>(
    db,
    `SELECT id FROM character_status_events
     WHERE character_id = ?
       AND ((chapter_id IS NULL AND ? IS NULL) OR chapter_id = ?)
       AND status = ?
     LIMIT 1`,
    [characterId, chapterId, chapterId, status]
  );
  if (existing) return;
  db.run(
    `INSERT INTO character_status_events (character_id, chapter_id, status, evidence)
     VALUES (?, ?, ?, ?)`,
    [characterId, chapterId, status, evidence]
  );
}

function applyExtraction(db: Database, chapterId: number | null, result: ExtractionResult): void {
  for (const character of result.characters) {
    if (!character.name) continue;
    const characterId = upsertCharacter(db, character, chapterId);
    const inferredStatus = normalizeCharacterStatus(
      [...(character.tags ?? []), character.summary ?? ''].join(' ')
    );
    if (inferredStatus) {
      upsertCharacterStatusEvent(db, characterId, chapterId, inferredStatus, character.evidence ?? character.summary ?? '');
    }
  }
  for (const event of result.statusEvents ?? []) {
    if (!event.character) continue;
    const status = normalizeCharacterStatus(event.status);
    if (!status) continue;
    const characterId = upsertCharacter(db, { name: event.character, tags: [status] }, chapterId);
    upsertCharacterStatusEvent(db, characterId, chapterId, status, event.evidence ?? '');
  }
  for (const relationship of result.relationships) {
    if (!relationship.source || !relationship.target) continue;
    const sourceId = upsertCharacter(db, { name: relationship.source }, chapterId);
    const targetId = upsertCharacter(db, { name: relationship.target }, chapterId);
    if (sourceId === targetId) continue;
    const relationshipId = upsertRelationship(
      db,
      sourceId,
      targetId,
      relationship.type || '未知',
      relationship.summary || '',
      Math.max(1, Math.min(5, Number(relationship.strength ?? 3))),
      Math.max(0, Math.min(1, Number(relationship.confidence ?? 0.6)))
    );
    const events = relationship.events?.length
      ? relationship.events
      : relationship.evidence
        ? [{ summary: relationship.summary || relationship.type || '关系证据', evidence: relationship.evidence }]
        : [];
    events.forEach((event, index) => {
      db.run(
        `INSERT INTO bond_events
         (relationship_id, chapter_id, summary, evidence, order_index, status)
         VALUES (?, ?, ?, ?, ?, 'confirmed')`,
        [relationshipId, chapterId, event.summary || '', event.evidence || '', index]
      );
    });
  }
}
function clearConfirmedGraph(db: Database): void {
  db.run('DELETE FROM bond_events');
  db.run('DELETE FROM relationships');
  db.run('DELETE FROM character_status_events');
  db.run('DELETE FROM characters');
}

function rebuildConfirmedGraph(db: Database): void {
  const candidates = query<{ chapterId: number | null; payload: ExtractionResult }>(
    db,
    `SELECT ce.chapter_id, ce.payload_json
     FROM candidate_extractions ce
     LEFT JOIN chapters c ON c.id = ce.chapter_id
     WHERE ce.kind = 'batch' AND ce.status = 'confirmed'
     ORDER BY COALESCE(c.order_index, 2147483647), ce.id ASC`,
    [],
    (row) => ({
      chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
      payload: safeJson<ExtractionResult>(String(row.payload_json), { characters: [], relationships: [], statusEvents: [] })
    })
  );
  clearConfirmedGraph(db);
  for (const candidate of candidates) applyExtraction(db, candidate.chapterId, candidate.payload);
}

ipcMain.handle('project:create', async (_event, name: string) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const projectName = (name.trim() || `人物谱系图-${stamp}`).replace(/[<>:"/\\|?*]/g, '_');
  const projectPath = path.join(projectsRoot(), projectName);
  return ensureProject(projectPath, projectName);
});

ipcMain.handle('project:open', async () => {
  const result = await dialog.showOpenDialog({
    title: '打开人物谱系图项目',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = result.filePaths[0];
  if (!existsSync(projectMetaPath(selected))) {
    throw new Error('所选目录不是人物谱系图项目。');
  }
  return readProjectSummary(selected);
});

ipcMain.handle('project:load', async (_event, projectPath: string) => graphData(projectPath));

ipcMain.handle('novel:import', async (_event, projectPath: string) => {
  const result = await dialog.showOpenDialog({
    title: '导入小说文本',
    filters: [
      { name: '小说文本', extensions: ['txt', 'md'] },
      { name: '全部文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths[0]) return graphData(projectPath);
  return importNovelFile(projectPath, result.filePaths[0]);
});

ipcMain.handle('novel:import-path', async (_event, projectPath: string, filePath: string) => {
  return importNovelFile(projectPath, filePath);
});

ipcMain.handle('llm:presets', async () => presets);

ipcMain.handle('llm:load-config', async (_event, projectPath: string) => {
  return readLlmConfig(projectPath || null);
});

ipcMain.handle('llm:save-config', async (_event, projectPath: string | null, config: LlmConfig) => {
  return writeLlmConfig(projectPath || null, config);
});

ipcMain.handle('llm:test', async (_event, config: LlmConfig) => {
  try {
    if (config.provider !== 'ollama' && !config.apiKey.trim()) {
      return { ok: false, message: '请先填写 API Key。' };
    }
    const client = new OpenAI({
      apiKey: config.apiKey || 'ollama',
      baseURL: config.baseUrl,
      timeout: llmRequestTimeoutMs,
      maxRetries: 0
    });
    await client.chat.completions.create({
      model: config.model,
      messages: [{ role: 'user', content: '回复 JSON：{"ok":true}' }],
      max_tokens: 64,
      temperature: 0
    });
    return { ok: true, message: '模型连接成功。' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('llm:analyze-chapter', async (_event, projectPath: string, chapterId: number) => {
  const config = await readLlmConfig(projectPath);
  const db = await openDb(projectPath);
  const chapter = query<Chapter>(
    db,
    'SELECT * FROM chapters WHERE id = ?',
    [chapterId],
    (row) => ({
      id: Number(row.id),
      title: String(row.title),
      orderIndex: Number(row.order_index),
      content: String(row.content),
      sourceFile: String(row.source_file),
      contentLength: String(row.content).length
    })
  )[0];
  if (!chapter) {
    await saveDb(projectPath, db);
    throw new Error('章节不存在。');
  }
  try {
    const extraction = await callChapterWithRetry(config, chapter);
    db.run(
      `INSERT INTO candidate_extractions (chapter_id, kind, payload_json, status)
       VALUES (?, 'batch', ?, 'pending')`,
      [chapterId, JSON.stringify(extraction)]
    );
  } catch (error) {
    db.run(
      `INSERT INTO candidate_extractions (chapter_id, kind, payload_json, status, error)
       VALUES (?, 'error', '{}', 'error', ?)`,
      [chapterId, error instanceof Error ? error.message : String(error)]
    );
  }
  await saveDb(projectPath, db);
  return graphData(projectPath);
});

ipcMain.handle('llm:analyze-novel', async (_event, projectPath: string, upToChapterId?: number | null) => {
  let progress = await startAnalysisJob(projectPath, upToChapterId);
  while (progress.status === 'running') {
    await abortableDelay(200);
    progress = await readAnalysisProgress(projectPath);
  }
  return {
    graph: await graphData(projectPath),
    processed: progress.completed,
    remaining: progress.remaining,
    errors: progress.errors
  };
});

ipcMain.handle('analysis:start', async (_event, projectPath: string, upToChapterId?: number | null) => {
  return startAnalysisJob(projectPath, upToChapterId);
});

ipcMain.handle('analysis:progress', async (_event, projectPath: string) => {
  return readAnalysisProgress(projectPath);
});

ipcMain.handle('analysis:pause', async (_event, projectPath: string) => {
  return pauseAnalysisJob(projectPath);
});

ipcMain.handle('analysis:resume', async (_event, projectPath: string) => {
  return resumeAnalysisJob(projectPath);
});

ipcMain.handle('analysis:cancel', async (_event, projectPath: string) => {
  return cancelAnalysisJob(projectPath);
});
ipcMain.handle('candidate:confirm', async (_event, projectPath: string, candidateId: number) => {
  const db = await openDb(projectPath);
  const candidate = query<CandidateExtraction>(
    db,
    'SELECT * FROM candidate_extractions WHERE id = ?',
    [candidateId],
    (row) => ({
      id: Number(row.id),
      chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
      chapterTitle: null,
      kind: String(row.kind) as CandidateExtraction['kind'],
      payload: safeJson<ExtractionResult>(String(row.payload_json), { characters: [], relationships: [] }),
      status: String(row.status) as CandidateExtraction['status'],
      error: String(row.error ?? ''),
      createdAt: String(row.created_at)
    })
  )[0];
  if (!candidate) {
    await saveDb(projectPath, db);
    throw new Error('候选记录不存在。');
  }
  db.run("UPDATE candidate_extractions SET status = 'confirmed' WHERE id = ?", [candidateId]);
  rebuildConfirmedGraph(db);
  await saveDb(projectPath, db);
  return graphData(projectPath);
});

ipcMain.handle('candidate:confirm-pending', async (
  _event,
  projectPath: string,
  upToChapterId?: number | null
) => {
  const db = await openDb(projectPath);
  const limitOrder = upToChapterId
    ? scalar<number>(db, 'SELECT order_index FROM chapters WHERE id = ?', [upToChapterId])
    : null;
  const candidates = query<{ id: number; chapterId: number | null; payload: ExtractionResult }>(
    db,
    "SELECT ce.* FROM candidate_extractions ce LEFT JOIN chapters c ON c.id = ce.chapter_id WHERE ce.kind = 'batch' AND ce.status = 'pending' AND (? IS NULL OR c.order_index <= ?) ORDER BY c.order_index ASC, ce.id ASC",
    [limitOrder, limitOrder],
    (row) => ({
      id: Number(row.id),
      chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
      payload: safeJson<ExtractionResult>(String(row.payload_json), { characters: [], relationships: [] })
    })
  );
  for (const candidate of candidates) {
    db.run("UPDATE candidate_extractions SET status = 'confirmed' WHERE id = ?", [candidate.id]);
  }
  rebuildConfirmedGraph(db);
  await saveDb(projectPath, db);
  return graphData(projectPath);
});
ipcMain.handle('candidate:reject', async (_event, projectPath: string, candidateId: number) => {
  const db = await openDb(projectPath);
  db.run("UPDATE candidate_extractions SET status = 'rejected' WHERE id = ?", [candidateId]);
  rebuildConfirmedGraph(db);
  await saveDb(projectPath, db);
  return graphData(projectPath);
});

ipcMain.handle('character:update', async (_event, projectPath: string, character: CharacterNode) => {
  const db = await openDb(projectPath);
  db.run(
    `UPDATE characters
     SET name = ?, aliases_json = ?, summary = ?, tags_json = ?, status = ?
     WHERE id = ?`,
    [
      character.name,
      JSON.stringify(character.aliases),
      character.summary,
      JSON.stringify(character.tags),
      character.status,
      character.id
    ]
  );
  await saveDb(projectPath, db);
  return graphData(projectPath);
});

ipcMain.handle('relationship:update', async (_event, projectPath: string, relationship: RelationshipEdge) => {
  const db = await openDb(projectPath);
  db.run(
    `UPDATE relationships
     SET type = ?, status = ?, strength = ?, summary = ?, confidence = ?
     WHERE id = ?`,
    [
      relationship.type,
      relationship.status,
      relationship.strength,
      relationship.summary,
      relationship.confidence,
      relationship.id
    ]
  );
  await saveDb(projectPath, db);
  return graphData(projectPath);
});

ipcMain.handle('graph:export', async (_event, projectPath: string) => {
  const data = await graphData(projectPath);
  const output = path.join(projectPath, 'exports', `graph-${Date.now()}.json`);
  await writeFile(output, JSON.stringify(data, null, 2), 'utf8');
  return output;
});

app.whenReady().then(() => {
  void getSql();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
