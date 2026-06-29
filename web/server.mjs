import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chardet from 'chardet';
import iconv from 'iconv-lite';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'out', 'renderer');
const dataRoot = process.env.CHARACTER_GRAPH_WEB_DATA || path.join(root, 'web-data');
const projectsRoot = path.join(dataRoot, 'projects');
const configFile = path.join(dataRoot, 'model.config.json');
const llmRequestTimeoutMs = 60_000;
const analysisConcurrency = 3;
const analysisMaxRetries = 2;
const analysisChunkSize = 15_000;
const analysisChunkOverlap = 500;
let SQL = null;
const analysisJobs = new Map();
const projectWriteQueues = new Map();

const presets = [
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
    id: 'custom',
    name: '自定义 OpenAI-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'custom-model',
    supportsJson: true,
    apiKeyLabel: 'API_KEY',
    notes: 'Use this for any provider that exposes /chat/completions.'
  }
];

const defaultConfig = {
  provider: 'deepseek',
  baseUrl: presets[0].baseUrl,
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxTokens: 4096,
  supportsJson: true,
  reasoningMode: 'off'
};

async function getSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs({
    locateFile: (file) => path.join(root, 'node_modules', 'sql.js', 'dist', file)
  });
  return SQL;
}

function safeName(value) {
  return String(value || 'novel').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'novel';
}

function projectDir(projectPath) {
  return path.join(projectsRoot, safeName(projectPath));
}

function dbPath(projectPath) {
  return path.join(projectDir(projectPath), 'graph.sqlite');
}

function projectMetaPath(projectPath) {
  return path.join(projectDir(projectPath), 'project.json');
}

function analysisStatePath(projectPath) {
  return path.join(projectDir(projectPath), 'analysis.state.json');
}

function idleAnalysisProgress() {
  return {
    status: 'idle',
    targetChapterId: null,
    targetOrderIndex: null,
    total: 0,
    completed: 0,
    failed: 0,
    remaining: 0,
    activeChapterTitles: [],
    errors: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    elapsedMs: 0,
    estimatedRemainingMs: null,
    concurrency: analysisConcurrency
  };
}

function analysisSnapshot(runtime) {
  const state = runtime.state;
  const active = state.status === 'running' || state.status === 'paused';
  const elapsedMs = active && state.startedAt
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

async function persistAnalysisProgress(projectPath, runtime) {
  const snapshot = analysisSnapshot(runtime);
  runtime.state = snapshot;
  const payload = JSON.stringify(snapshot, null, 2);
  runtime.persistQueue = runtime.persistQueue
    .catch(() => undefined)
    .then(() => writeFile(analysisStatePath(projectPath), payload, 'utf8'));
  await runtime.persistQueue;
}

async function readAnalysisProgress(projectPath) {
  const runtime = analysisJobs.get(projectPath);
  if (runtime) return analysisSnapshot(runtime);
  if (!existsSync(analysisStatePath(projectPath))) return idleAnalysisProgress();
  const stored = {
    ...idleAnalysisProgress(),
    ...JSON.parse(await readFile(analysisStatePath(projectPath), 'utf8'))
  };
  if (stored.status === 'running') stored.status = 'paused';
  return stored;
}

async function withProjectDbWrite(projectPath, action) {
  const previous = projectWriteQueues.get(projectPath) ?? Promise.resolve();
  let release = () => undefined;
  const gate = new Promise((resolve) => {
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

async function openDb(projectPath) {
  const sql = await getSql();
  const file = dbPath(projectPath);
  const db = existsSync(file) ? new sql.Database(await readFile(file)) : new sql.Database();
  createSchema(db);
  return db;
}

async function saveDb(projectPath, db) {
  await mkdir(projectDir(projectPath), { recursive: true });
  await writeFile(dbPath(projectPath), Buffer.from(db.export()));
  db.close();
}

function createSchema(db) {
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

function query(db, sql, params = [], map = (row) => row) {
  const stmt = db.prepare(sql, params);
  const rows = [];
  while (stmt.step()) rows.push(map(stmt.getAsObject()));
  stmt.free();
  return rows;
}

function scalar(db, sql, params = []) {
  const stmt = db.prepare(sql, params);
  const value = stmt.step() ? Object.values(stmt.getAsObject())[0] : null;
  stmt.free();
  return value;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function ensureProject(name) {
  await mkdir(projectsRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = `${safeName(name)}-${stamp}`;
  const dir = projectDir(id);
  await mkdir(path.join(dir, 'originals'), { recursive: true });
  await mkdir(path.join(dir, 'exports'), { recursive: true });
  const summary = { name: safeName(name), path: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeFile(projectMetaPath(id), JSON.stringify(summary, null, 2), 'utf8');
  const db = await openDb(id);
  await saveDb(id, db);
  return summary;
}

async function openLatestProject() {
  await mkdir(projectsRoot, { recursive: true });
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(projectsRoot);
  const summaries = [];
  for (const name of names) {
    const meta = path.join(projectsRoot, name, 'project.json');
    if (existsSync(meta)) summaries.push(JSON.parse(await readFile(meta, 'utf8')));
  }
  summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return summaries[0] ?? null;
}

async function readLlmConfig() {
  if (!existsSync(configFile)) return defaultConfig;
  return { ...defaultConfig, ...JSON.parse(await readFile(configFile, 'utf8')) };
}

async function writeLlmConfig(config) {
  await mkdir(dataRoot, { recursive: true });
  const merged = { ...defaultConfig, ...config };
  await writeFile(configFile, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

async function graphData(projectPath) {
  const db = await openDb(projectPath);
  const chapters = query(db, 'SELECT id, title, order_index, substr(content, 1, 1200) AS content, length(content) AS content_length, source_file FROM chapters ORDER BY order_index ASC, id ASC', [], (row) => ({
    id: Number(row.id),
    title: String(row.title),
    orderIndex: Number(row.order_index),
    content: String(row.content),
    sourceFile: String(row.source_file),
    contentLength: Number(row.content_length)
  }));
  const characters = query(db, "SELECT * FROM characters WHERE status != 'rejected' ORDER BY name ASC", [], (row) => ({
    id: Number(row.id),
    name: String(row.name),
    aliases: safeJson(String(row.aliases_json), []),
    summary: String(row.summary ?? ''),
    tags: safeJson(String(row.tags_json), []),
    firstChapterId: row.first_chapter_id === null ? null : Number(row.first_chapter_id),
    status: String(row.status)
  }));
  const relationships = query(db, `WITH pairs AS (
      SELECT MIN(id) AS id,
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
    ORDER BY p.id ASC`, [], (row) => ({
    id: Number(row.id),
    sourceCharacterId: Number(row.source_character_id),
    targetCharacterId: Number(row.target_character_id),
    sourceName: String(row.source_name),
    targetName: String(row.target_name),
    type: String(row.type || '关系'),
    status: String(row.status || 'confirmed'),
    strength: Number(row.strength || 3),
    summary: String(row.summary ?? '').split(',').filter(Boolean).join('\n'),
    confidence: Number(row.confidence || 0.6)
  }));
  const events = query(db, `WITH relation_pairs AS (
      SELECT MIN(id) AS canonical_id,
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
    ORDER BY e.order_index ASC, e.id ASC`, [], (row) => ({
    id: Number(row.id),
    relationshipId: Number(row.canonical_relationship_id),
    chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
    chapterTitle: row.chapter_title === null ? null : String(row.chapter_title),
    summary: String(row.summary),
    evidence: String(row.evidence),
    orderIndex: Number(row.order_index),
    status: String(row.status)
  }));
  const statusEvents = query(db, `SELECT se.*, ch.name AS character_name, c.title AS chapter_title
    FROM character_status_events se
    JOIN characters ch ON ch.id = se.character_id
    LEFT JOIN chapters c ON c.id = se.chapter_id
    ORDER BY c.order_index ASC, se.id ASC`, [], (row) => ({
    id: Number(row.id),
    characterId: Number(row.character_id),
    characterName: String(row.character_name),
    chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
    chapterTitle: row.chapter_title === null ? null : String(row.chapter_title),
    status: String(row.status),
    evidence: String(row.evidence ?? '')
  }));
  const candidates = query(db, `SELECT ce.*, c.title AS chapter_title
    FROM candidate_extractions ce
    LEFT JOIN chapters c ON c.id = ce.chapter_id
    ORDER BY ce.id DESC`, [], (row) => ({
    id: Number(row.id),
    chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
    chapterTitle: row.chapter_title === null ? null : String(row.chapter_title),
    kind: String(row.kind),
    payload: safeJson(String(row.payload_json), {}),
    status: String(row.status),
    error: String(row.error ?? ''),
    createdAt: String(row.created_at)
  }));
  await saveDb(projectPath, db);
  return { chapters, characters, relationships, events, statusEvents, candidates };
}

function decodeNovel(buffer) {
  const detected = String(chardet.detect(buffer) || 'utf8').toLowerCase();
  const encoding = detected.includes('gb') || detected.includes('big5') ? detected : 'utf8';
  return iconv.decode(buffer, encoding).replace(/^\uFEFF/, '');
}

function splitChapters(text) {
  const markdown = /^#{1,6}\s+.+$/gm;
  const chinese = /^(?:第\s*[零一二三四五六七八九十百千万\d]+\s*[章节回卷集].*|[零一二三四五六七八九十百千万\d]+[、.．]\s*.+)$/gm;
  const matches = [...text.matchAll(markdown)].length >= 2 ? [...text.matchAll(markdown)] : [...text.matchAll(chinese)];
  if (matches.length < 2) return [{ title: '全文', content: text.trim() }];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const next = matches[index + 1]?.index ?? text.length;
    const content = text.slice(start, next).trim();
    return { title: match[0].replace(/^#+\s*/, '').trim(), content };
  }).filter((chapter) => chapter.content);
}

async function importNovelBytes(projectPath, fileName, buffer) {
  const text = decodeNovel(buffer);
  const chapters = splitChapters(text);
  const dir = projectDir(projectPath);
  await mkdir(path.join(dir, 'originals'), { recursive: true });
  await writeFile(path.join(dir, 'originals', safeName(fileName)), buffer);
  const db = await openDb(projectPath);
  const currentCount = scalar(db, 'SELECT COUNT(*) FROM chapters') ?? 0;
  chapters.forEach((chapter, index) => {
    db.run('INSERT INTO chapters (title, order_index, content, source_file) VALUES (?, ?, ?, ?)', [
      chapter.title,
      currentCount + index + 1,
      chapter.content,
      fileName
    ]);
  });
  await saveDb(projectPath, db);
  return graphData(projectPath);
}

function extractionPrompt(chapter) {
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
${chapter.content}`;
}

function parseExtraction(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('模型没有返回 JSON 对象。');
  const parsed = JSON.parse(candidate.slice(first, last + 1));
  return {
    characters: Array.isArray(parsed.characters) ? parsed.characters : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    statusEvents: Array.isArray(parsed.statusEvents) ? parsed.statusEvents : []
  };
}

async function callLlm(config, chapter, signal) {
  if (config.provider !== 'ollama' && !String(config.apiKey || '').trim()) {
    throw new Error('请先在“模型”里填写 API Key，并点击“保存配置”。');
  }
  const client = new OpenAI({
    apiKey: config.apiKey || 'ollama',
    baseURL: config.baseUrl,
    timeout: llmRequestTimeoutMs,
    maxRetries: 0
  });
  const extraBody = {};
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
      { role: 'system', content: '你只输出可解析 JSON。所有结论必须来自用户提供的小说章节。' },
      { role: 'user', content: extractionPrompt(chapter) }
    ],
    ...extraBody
  }, { signal });
  return parseExtraction(response.choices[0]?.message?.content ?? '');
}

function splitChapterForAnalysis(chapter) {
  if (chapter.content.length <= analysisChunkSize) return [chapter];
  const chunks = [];
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

function mergeExtractions(results) {
  const characters = new Map();
  const relationships = new Map();
  const statusEvents = new Map();
  for (const result of results) {
    for (const character of result.characters) {
      const name = String(character.name || '').trim();
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
      const pair = [String(relationship.source).trim(), String(relationship.target).trim()].sort().join('|');
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
      statusEvents.set(String(event.character).trim() + '|' + event.status, event);
    }
  }
  return {
    characters: [...characters.values()],
    relationships: [...relationships.values()],
    statusEvents: [...statusEvents.values()]
  };
}

function abortableDelay(ms, signal) {
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

async function callChapterWithRetry(config, chapter, signal) {
  const results = [];
  for (const chunk of splitChapterForAnalysis(chapter)) {
    let lastError = null;
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

async function persistAnalysisCandidate(projectPath, chapterId, extraction) {
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

async function persistAnalysisError(projectPath, chapterId, message) {
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

async function runAnalysisWorker(projectPath, runtime) {
  while (runtime.nextIndex < runtime.chapters.length) {
    while (runtime.state.status === 'paused') {
      await abortableDelay(200);
      if (runtime.state.status === 'cancelled') return;
    }
    if (runtime.state.status !== 'running') return;
    const chapter = runtime.chapters[runtime.nextIndex];
    runtime.nextIndex += 1;
    runtime.activeTitles.add(chapter.title);
    const controller = new AbortController();
    runtime.abortControllers.add(controller);
    runtime.state.updatedAt = new Date().toISOString();
    await persistAnalysisProgress(projectPath, runtime);
    try {
      const extraction = await callChapterWithRetry(runtime.config, chapter, controller.signal);
      if (runtime.state.status !== 'cancelled') {
        await persistAnalysisCandidate(projectPath, chapter.id, extraction);
        runtime.state.completed += 1;
      }
    } catch (error) {
      if (runtime.state.status !== 'cancelled' && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        runtime.state.failed += 1;
        runtime.state.errors = [...runtime.state.errors, chapter.title + ': ' + message].slice(-20);
        await persistAnalysisError(projectPath, chapter.id, message);
      }
    } finally {
      runtime.activeTitles.delete(chapter.title);
      runtime.abortControllers.delete(controller);
      runtime.state.updatedAt = new Date().toISOString();
      await persistAnalysisProgress(projectPath, runtime);
    }
  }
}

async function runAnalysisJob(projectPath, runtime) {
  try {
    const workerCount = Math.min(analysisConcurrency, runtime.chapters.length);
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

async function startAnalysisJob(projectPath, upToChapterId) {
  const active = analysisJobs.get(projectPath);
  if (active && (active.state.status === 'running' || active.state.status === 'paused')) {
    return analysisSnapshot(active);
  }
  const config = await readLlmConfig();
  if (config.provider !== 'ollama' && !String(config.apiKey || '').trim()) {
    throw new Error('请先点击“模型”，填写 DeepSeek API Key，保存后再生成谱系图。');
  }
  const db = await openDb(projectPath);
  const limitOrder = upToChapterId ? scalar(db, 'SELECT order_index FROM chapters WHERE id = ?', [upToChapterId]) : null;
  if (upToChapterId && limitOrder === null) {
    await saveDb(projectPath, db);
    throw new Error('章节不存在。');
  }
  const chapters = query(db,
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
  await saveDb(projectPath, db);
  const now = new Date().toISOString();
  const runtime = {
    state: {
      status: chapters.length ? 'running' : 'completed',
      targetChapterId: upToChapterId ?? null,
      targetOrderIndex: limitOrder,
      total: chapters.length,
      completed: 0,
      failed: 0,
      remaining: chapters.length,
      activeChapterTitles: [],
      errors: [],
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      estimatedRemainingMs: null,
      concurrency: analysisConcurrency
    },
    chapters,
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

async function pauseAnalysisJob(projectPath) {
  const runtime = analysisJobs.get(projectPath);
  if (!runtime) return readAnalysisProgress(projectPath);
  if (runtime.state.status === 'running') runtime.state.status = 'paused';
  runtime.state.updatedAt = new Date().toISOString();
  await persistAnalysisProgress(projectPath, runtime);
  return analysisSnapshot(runtime);
}

async function resumeAnalysisJob(projectPath) {
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

async function cancelAnalysisJob(projectPath) {
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
function findCharacterId(db, name, aliases) {
  const byName = scalar(db, 'SELECT id FROM characters WHERE name = ? LIMIT 1', [name]);
  if (byName) return Number(byName);
  const rows = query(db, 'SELECT id, aliases_json FROM characters', [], (row) => ({ id: Number(row.id), aliases: safeJson(String(row.aliases_json), []) }));
  const names = new Set([name, ...aliases].map((item) => item.trim()).filter(Boolean));
  return rows.find((row) => row.aliases.some((alias) => names.has(alias)))?.id ?? null;
}

function upsertCharacter(db, input, chapterId) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('人物名为空。');
  const aliases = [...new Set((input.aliases ?? []).map((item) => String(item).trim()).filter(Boolean))];
  const tags = [...new Set((input.tags ?? []).map((item) => String(item).trim()).filter(Boolean))];
  const existingId = findCharacterId(db, name, aliases);
  if (existingId) {
    const existing = query(db, 'SELECT aliases_json, tags_json, summary FROM characters WHERE id = ?', [existingId], (row) => ({
      aliases: safeJson(String(row.aliases_json), []),
      tags: safeJson(String(row.tags_json), []),
      summary: String(row.summary ?? '')
    }))[0];
    db.run(`UPDATE characters
      SET aliases_json = ?, tags_json = ?, summary = CASE WHEN summary = '' THEN ? ELSE summary END
      WHERE id = ?`, [
      JSON.stringify([...new Set([...existing.aliases, ...aliases])]),
      JSON.stringify([...new Set([...existing.tags, ...tags])]),
      input.summary ?? '',
      existingId
    ]);
    return existingId;
  }
  db.run(`INSERT INTO characters (name, aliases_json, summary, tags_json, first_chapter_id, status)
    VALUES (?, ?, ?, ?, ?, 'confirmed')`, [name, JSON.stringify(aliases), input.summary ?? '', JSON.stringify(tags), chapterId]);
  return Number(scalar(db, 'SELECT last_insert_rowid()'));
}

function normalizeCharacterStatus(value) {
  const text = String(value || '').toLowerCase();
  if (/死亡|已死|身亡|战死|陨落|dead|died|killed/.test(text)) return 'dead';
  if (/退场|离队|离开主线|退出|retired|left/.test(text)) return 'retired';
  if (/不再使用|不再登场|后续不再|弃用|unused|inactive/.test(text)) return 'unused';
  if (/活跃|登场|active/.test(text)) return 'active';
  return null;
}

function upsertCharacterStatusEvent(db, characterId, chapterId, status, evidence) {
  if (status === 'active') return;
  const existing = scalar(db, `SELECT id FROM character_status_events
    WHERE character_id = ?
      AND ((chapter_id IS NULL AND ? IS NULL) OR chapter_id = ?)
      AND status = ?
    LIMIT 1`, [characterId, chapterId, chapterId, status]);
  if (existing) return;
  db.run('INSERT INTO character_status_events (character_id, chapter_id, status, evidence) VALUES (?, ?, ?, ?)', [characterId, chapterId, status, evidence || '']);
}

function orderedPair(a, b) {
  return a <= b ? [a, b] : [b, a];
}

function upsertRelationship(db, sourceId, targetId, type, summary, strength, confidence) {
  const [left, right] = orderedPair(sourceId, targetId);
  const existingId = scalar(db, 'SELECT id FROM relationships WHERE source_character_id = ? AND target_character_id = ? AND type = ? LIMIT 1', [left, right, type]);
  if (existingId) {
    db.run(`UPDATE relationships
      SET summary = CASE WHEN summary = '' THEN ? ELSE summary END,
          strength = MAX(strength, ?),
          confidence = MAX(confidence, ?)
      WHERE id = ?`, [summary, strength, confidence, existingId]);
    return Number(existingId);
  }
  db.run(`INSERT INTO relationships
    (source_character_id, target_character_id, type, status, strength, summary, confidence)
    VALUES (?, ?, ?, 'confirmed', ?, ?, ?)`, [left, right, type, strength, summary, confidence]);
  return Number(scalar(db, 'SELECT last_insert_rowid()'));
}

function applyExtraction(db, chapterId, result) {
  for (const character of result.characters) {
    if (!character.name) continue;
    const characterId = upsertCharacter(db, character, chapterId);
    const inferredStatus = normalizeCharacterStatus([...(character.tags ?? []), character.summary ?? ''].join(' '));
    if (inferredStatus) upsertCharacterStatusEvent(db, characterId, chapterId, inferredStatus, character.evidence ?? character.summary ?? '');
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
    const events = relationship.events?.length ? relationship.events : relationship.evidence ? [{ summary: relationship.summary || relationship.type || '关系证据', evidence: relationship.evidence }] : [];
    events.forEach((event, index) => {
      db.run(`INSERT INTO bond_events
        (relationship_id, chapter_id, summary, evidence, order_index, status)
        VALUES (?, ?, ?, ?, ?, 'confirmed')`, [relationshipId, chapterId, event.summary || '', event.evidence || '', index]);
    });
  }
}

async function analyzeNovel(projectPath, upToChapterId) {
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
}
async function handleApi(req, res, url) {
  const json = async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  if (req.method === 'GET' && url.pathname === '/api/llm/presets') return sendJson(res, presets);
  if (req.method === 'GET' && url.pathname === '/api/llm/config') return sendJson(res, await readLlmConfig());
  if (req.method === 'POST' && url.pathname === '/api/llm/config') return sendJson(res, await writeLlmConfig(await json()));
  if (req.method === 'POST' && url.pathname === '/api/llm/test') {
    try {
      const config = await json();
      const client = new OpenAI({ apiKey: config.apiKey || 'ollama', baseURL: config.baseUrl, timeout: llmRequestTimeoutMs, maxRetries: 0 });
      await client.chat.completions.create({ model: config.model, messages: [{ role: 'user', content: '{"ok":true}' }], max_tokens: 64, temperature: 0 });
      return sendJson(res, { ok: true, message: '模型连接成功。' });
    } catch (error) {
      return sendJson(res, { ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/analysis/progress/')) {
    const projectPath = decodeURIComponent(url.pathname.slice('/api/analysis/progress/'.length));
    return sendJson(res, await readAnalysisProgress(projectPath));
  }
  if (req.method === 'POST' && url.pathname === '/api/analysis/start') {
    const body = await json();
    return sendJson(res, await startAnalysisJob(body.projectPath, body.upToChapterId ?? null));
  }
  if (req.method === 'POST' && url.pathname === '/api/analysis/pause') {
    const body = await json();
    return sendJson(res, await pauseAnalysisJob(body.projectPath));
  }
  if (req.method === 'POST' && url.pathname === '/api/analysis/resume') {
    const body = await json();
    return sendJson(res, await resumeAnalysisJob(body.projectPath));
  }
  if (req.method === 'POST' && url.pathname === '/api/analysis/cancel') {
    const body = await json();
    return sendJson(res, await cancelAnalysisJob(body.projectPath));
  }  if (req.method === 'POST' && url.pathname === '/api/projects') {
    const body = await json();
    return sendJson(res, await ensureProject(body.name));
  }
  if (req.method === 'GET' && url.pathname === '/api/projects/open') return sendJson(res, await openLatestProject());
  if (req.method === 'GET' && url.pathname.startsWith('/api/projects/')) {
    return sendJson(res, await graphData(decodeURIComponent(url.pathname.slice('/api/projects/'.length))));
  }
  if (req.method === 'POST' && url.pathname === '/api/novel/import') {
    const body = await json();
    return sendJson(res, await importNovelBytes(body.projectPath, body.fileName || 'novel.txt', Buffer.from(body.bytesBase64, 'base64')));
  }
  if (req.method === 'POST' && url.pathname === '/api/llm/analyze-novel') {
    const body = await json();
    return sendJson(res, await analyzeNovel(body.projectPath, body.upToChapterId ?? null));
  }
  if (req.method === 'POST' && url.pathname === '/api/llm/analyze-chapter') {
    const body = await json();
    const db = await openDb(body.projectPath);
    const chapter = query(db, 'SELECT * FROM chapters WHERE id = ?', [body.chapterId], (row) => ({
      id: Number(row.id),
      title: String(row.title),
      orderIndex: Number(row.order_index),
      content: String(row.content),
      sourceFile: String(row.source_file),
      contentLength: String(row.content).length
    }))[0];
    const extraction = await callChapterWithRetry(await readLlmConfig(), chapter);
    db.run("INSERT INTO candidate_extractions (chapter_id, kind, payload_json, status) VALUES (?, 'batch', ?, 'pending')", [body.chapterId, JSON.stringify(extraction)]);
    await saveDb(body.projectPath, db);
    return sendJson(res, await graphData(body.projectPath));
  }
  if (req.method === 'POST' && url.pathname === '/api/candidates/confirm') {
    const body = await json();
    const db = await openDb(body.projectPath);
    const candidate = query(db, 'SELECT * FROM candidate_extractions WHERE id = ?', [body.candidateId], (row) => ({
      chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
      payload: safeJson(String(row.payload_json), { characters: [], relationships: [], statusEvents: [] })
    }))[0];
    if (candidate) {
      applyExtraction(db, candidate.chapterId, candidate.payload);
      db.run("UPDATE candidate_extractions SET status = 'confirmed' WHERE id = ?", [body.candidateId]);
    }
    await saveDb(body.projectPath, db);
    return sendJson(res, await graphData(body.projectPath));
  }
  if (req.method === 'POST' && url.pathname === '/api/candidates/confirm-pending') {
    const body = await json();
    const db = await openDb(body.projectPath);
    const limitOrder = body.upToChapterId
      ? scalar(db, 'SELECT order_index FROM chapters WHERE id = ?', [body.upToChapterId])
      : null;
    const candidates = query(
      db,
      "SELECT ce.* FROM candidate_extractions ce LEFT JOIN chapters c ON c.id = ce.chapter_id WHERE ce.kind = 'batch' AND ce.status = 'pending' AND (? IS NULL OR c.order_index <= ?) ORDER BY c.order_index ASC, ce.id ASC",
      [limitOrder, limitOrder],
      (row) => ({
        id: Number(row.id),
        chapterId: row.chapter_id === null ? null : Number(row.chapter_id),
        payload: safeJson(String(row.payload_json), { characters: [], relationships: [], statusEvents: [] })
      })
    );
    for (const candidate of candidates) {
      applyExtraction(db, candidate.chapterId, candidate.payload);
      db.run("UPDATE candidate_extractions SET status = 'confirmed' WHERE id = ?", [candidate.id]);
    }
    await saveDb(body.projectPath, db);
    return sendJson(res, await graphData(body.projectPath));
  }  if (req.method === 'POST' && url.pathname === '/api/candidates/reject') {
    const body = await json();
    const db = await openDb(body.projectPath);
    db.run("UPDATE candidate_extractions SET status = 'rejected' WHERE id = ?", [body.candidateId]);
    await saveDb(body.projectPath, db);
    return sendJson(res, await graphData(body.projectPath));
  }
  if (req.method === 'POST' && url.pathname === '/api/characters/update') {
    const body = await json();
    const db = await openDb(body.projectPath);
    const c = body.character;
    db.run('UPDATE characters SET name = ?, aliases_json = ?, summary = ?, tags_json = ?, status = ? WHERE id = ?', [
      c.name,
      JSON.stringify(c.aliases),
      c.summary,
      JSON.stringify(c.tags),
      c.status,
      c.id
    ]);
    await saveDb(body.projectPath, db);
    return sendJson(res, await graphData(body.projectPath));
  }
  if (req.method === 'POST' && url.pathname === '/api/relationships/update') {
    const body = await json();
    const db = await openDb(body.projectPath);
    const r = body.relationship;
    db.run('UPDATE relationships SET type = ?, strength = ?, summary = ?, confidence = ?, status = ? WHERE id = ?', [
      r.type,
      r.strength,
      r.summary,
      r.confidence,
      r.status,
      r.id
    ]);
    await saveDb(body.projectPath, db);
    return sendJson(res, await graphData(body.projectPath));
  }
  if (req.method === 'POST' && url.pathname === '/api/graph/export') {
    const body = await json();
    const data = await graphData(body.projectPath);
    const output = path.join(projectDir(body.projectPath), 'exports', `graph-${Date.now()}.json`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(data, null, 2), 'utf8');
    return sendJson(res, { path: output });
  }

  send(res, 404, 'Not found');
}

function sendJson(res, value) {
  send(res, 200, JSON.stringify(value), 'application/json; charset=utf-8');
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const relativePath = pathname.replace(/^[/\\]+/, '');
  const file = path.normalize(path.join(publicDir, relativePath));
  if (!file.startsWith(publicDir)) return send(res, 403, 'Forbidden');
  const target = existsSync(file) ? file : path.join(publicDir, 'index.html');
  const ext = path.extname(target).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  createReadStream(target).pipe(res);
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    send(res, 500, error instanceof Error ? error.message : String(error));
  }
});

const port = Number(process.env.PORT || 4173);
await mkdir(dataRoot, { recursive: true });
server.listen(port, () => {
  console.log(`Character graph web app: http://localhost:${port}`);
  console.log(`Data directory: ${dataRoot}`);
});
