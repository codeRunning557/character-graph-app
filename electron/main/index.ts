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

const llmRequestTimeoutMs = 60_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let SQL: SqlJsStatic | null = null;

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
  return `你是小说人物关系抽取器。只根据给定章节文本抽取，不要补充常识，不要编造。
statusEvents 只在原文明确说明人物死亡、退场、封存、离开主线、后续不再使用时输出；不要因为人物本章未出现就判断 unused。

输出严格 JSON，结构如下：
{
  "characters": [
    {"name": "人物名", "aliases": ["别名"], "summary": "本章中可证实的人物信息", "tags": ["身份或阵营"], "evidence": "原文证据片段"}
  ],
  "statusEvents": [
    {"character": "人物名", "status": "active/dead/retired/unused", "evidence": "原文明确证据片段"}
  ],
  "relationships": [
    {
      "source": "人物A",
      "target": "人物B",
      "type": "师徒/亲族/敌对/盟友/暧昧/主仆/同族/交易/未知等",
      "summary": "二人关系与羁绊摘要",
      "strength": 1到5的整数,
      "confidence": 0到1的小数,
      "evidence": "原文证据片段",
      "events": [{"summary": "关键事件", "evidence": "原文证据片段"}]
    }
  ]
}

章节标题：${chapter.title}

章节正文：
${chapter.content.slice(0, 18000)}`;
}

function parseExtraction(raw: string): ExtractionResult {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('模型没有返回 JSON 对象。');
  const parsed = JSON.parse(candidate.slice(first, last + 1)) as Partial<ExtractionResult>;
  return {
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    statusEvents: Array.isArray(parsed.statusEvents) ? parsed.statusEvents : []
  };
}

async function callLlm(config: LlmConfig, chapter: Chapter): Promise<ExtractionResult> {
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
      { role: 'user', content: extractionPrompt(chapter) }
    ],
    ...extraBody
  });
  const content = response.choices[0]?.message?.content ?? '';
  return parseExtraction(content);
}

function findCharacterId(db: Database, name: string, aliases: string[]): number | null {
  const byName = scalar<number>(db, 'SELECT id FROM characters WHERE name = ? LIMIT 1', [name]);
  if (byName) return byName;
  const rows = query<{ id: number; aliases: string[] }>(
    db,
    'SELECT id, aliases_json FROM characters',
    [],
    (row) => ({ id: Number(row.id), aliases: safeJson<string[]>(String(row.aliases_json), []) })
  );
  const names = new Set([name, ...aliases].map((item) => item.trim()).filter(Boolean));
  return rows.find((row) => row.aliases.some((alias) => names.has(alias)))?.id ?? null;
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
    const existing = query<{ aliases: string[]; tags: string[]; summary: string }>(
      db,
      'SELECT aliases_json, tags_json, summary FROM characters WHERE id = ?',
      [existingId],
      (row) => ({
        aliases: safeJson<string[]>(String(row.aliases_json), []),
        tags: safeJson<string[]>(String(row.tags_json), []),
        summary: String(row.summary ?? '')
      })
    )[0];
    db.run(
      `UPDATE characters
       SET aliases_json = ?, tags_json = ?, summary = CASE WHEN summary = '' THEN ? ELSE summary END
       WHERE id = ?`,
      [
        JSON.stringify([...new Set([...existing.aliases, ...aliases])]),
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
    const extraction = await callLlm(config, chapter);
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
  const config = await readLlmConfig(projectPath);
  if (config.provider !== 'ollama' && !config.apiKey.trim()) {
    throw new Error('请先点击“模型”，填写 DeepSeek API Key，保存后再生成谱系图。');
  }
  const db = await openDb(projectPath);
  const limitOrder = upToChapterId
    ? scalar<number>(db, 'SELECT order_index FROM chapters WHERE id = ?', [upToChapterId])
    : null;
  if (upToChapterId && limitOrder === null) {
    await saveDb(projectPath, db);
    throw new Error('章节不存在。');
  }
  const chapters = query<Chapter>(
    db,
    `SELECT c.*
     FROM chapters c
     WHERE (? IS NULL OR c.order_index <= ?)
       AND NOT EXISTS (
       SELECT 1 FROM candidate_extractions ce
       WHERE ce.chapter_id = c.id
         AND (
           (ce.kind = 'batch' AND ce.status = 'confirmed')
           OR ce.kind = 'error'
         )
     )
     ORDER BY c.order_index ASC, c.id ASC`,
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
  let processed = 0;
  const errors: string[] = [];
  for (const chapter of chapters) {
    try {
      const extraction = await callLlm(config, chapter);
      db.run(
        `INSERT INTO candidate_extractions (chapter_id, kind, payload_json, status)
         VALUES (?, 'batch', ?, 'pending')`,
        [chapter.id, JSON.stringify(extraction)]
      );
      applyExtraction(db, chapter.id, extraction);
      db.run(
        `UPDATE candidate_extractions
         SET status = 'confirmed'
         WHERE id = last_insert_rowid()`
      );
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${chapter.title}: ${message}`);
      db.run(
        `INSERT INTO candidate_extractions (chapter_id, kind, payload_json, status, error)
         VALUES (?, 'error', '{}', 'error', ?)`,
        [chapter.id, message]
      );
      break;
    }
  }
  await saveDb(projectPath, db);
  return {
    graph: await graphData(projectPath),
    processed,
    remaining: Math.max(0, chapters.length - processed),
    errors
  };
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
  if (candidate.kind === 'batch') {
    applyExtraction(db, candidate.chapterId, candidate.payload as ExtractionResult);
  }
  db.run("UPDATE candidate_extractions SET status = 'confirmed' WHERE id = ?", [candidateId]);
  await saveDb(projectPath, db);
  return graphData(projectPath);
});

ipcMain.handle('candidate:reject', async (_event, projectPath: string, candidateId: number) => {
  const db = await openDb(projectPath);
  db.run("UPDATE candidate_extractions SET status = 'rejected' WHERE id = ?", [candidateId]);
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
