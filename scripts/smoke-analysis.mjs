import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(url, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Web server did not start in time.');
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(baseUrl + route, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options.headers
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || response.statusText);
  return text ? JSON.parse(text) : null;
}

function requestedChapters(prompt) {
  const matches = [...prompt.matchAll(/章节ID：(\d+)\n章节序号：(\d+)\n章节标题：([^\n]+)/g)];
  if (matches.length) {
    return matches.map((match) => ({
      chapterId: Number(match[1]),
      orderIndex: Number(match[2]),
      title: match[3].trim()
    }));
  }
  const title = /章节标题：([^\n]+)/.exec(prompt)?.[1]?.trim() || '未知章节';
  return [{ chapterId: null, orderIndex: null, title }];
}

function extractionForChapter(chapter) {
  const suffix = String(chapter.orderIndex || chapter.title).padStart(3, '0');
  return {
    characters: [
      { name: '主角', aliases: [], summary: '主角', tags: ['主角'], evidence: chapter.title },
      { name: '人物' + suffix, aliases: [], summary: chapter.title, tags: [], evidence: chapter.title }
    ],
    statusEvents: [],
    relationships: [
      {
        source: '主角',
        target: '人物' + suffix,
        type: '同行',
        summary: chapter.title + '同行',
        strength: 3,
        confidence: 0.9,
        evidence: chapter.title,
        events: [{ summary: chapter.title + '事件', evidence: chapter.title }]
      }
    ]
  };
}

const attempts = new Map();
let activeRequests = 0;
let maxActiveRequests = 0;
let modelCalls = 0;

const mockServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const prompt = body.messages?.find((message) => message.role === 'user')?.content || '';
  const chapters = requestedChapters(prompt);
  const key = chapters.map((chapter) => chapter.orderIndex || chapter.title).join(',');
  const count = (attempts.get(key) || 0) + 1;
  attempts.set(key, count);
  modelCalls += 1;
  activeRequests += 1;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

  await new Promise((resolve) => setTimeout(resolve, 140));
  activeRequests -= 1;

  if (chapters.some((chapter) => chapter.orderIndex === 51) && count === 1) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'temporary mock failure' } }));
    return;
  }

  const payload = chapters.length > 1 || chapters[0].chapterId !== null
    ? { chapters: chapters.map((chapter) => ({ chapterId: chapter.chapterId, chapterTitle: chapter.title, ...extractionForChapter(chapter) })) }
    : extractionForChapter(chapters[0]);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'mock',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }]
  }));
});

const dataDir = await mkdtemp(path.join(tmpdir(), 'character-graph-analysis-'));
let webServer;

try {
  const mockPort = await listen(mockServer);
  const portProbe = createServer();
  const webPort = await listen(portProbe);
  await close(portProbe);

  process.env.PORT = String(webPort);
  process.env.CHARACTER_GRAPH_WEB_DATA = dataDir;
  ({ server: webServer } = await import('../web/server.mjs'));

  const baseUrl = 'http://127.0.0.1:' + webPort;
  await waitFor(baseUrl);

  const project = await request(baseUrl, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'AnalysisSmoke' })
  });

  await request(baseUrl, '/api/llm/config', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:' + mockPort + '/v1',
      apiKey: 'local-smoke-key',
      model: 'mock-model',
      temperature: 0,
      maxTokens: 4096,
      supportsJson: true,
      reasoningMode: 'off'
    })
  });

  const novel = Array.from({ length: 104 }, (_, index) => {
    const order = index + 1;
    const padded = String(order).padStart(3, '0');
    return '# 第' + padded + '章 批量' + padded + '\n主角与人物' + padded + '同行。';
  }).join('\n');

  const imported = await request(baseUrl, '/api/novel/import', {
    method: 'POST',
    body: JSON.stringify({
      projectPath: project.path,
      fileName: 'smoke.md',
      bytesBase64: Buffer.from(novel, 'utf8').toString('base64')
    })
  });
  assert(imported.chapters.length === 104, 'Expected 104 imported chapters.');

  let progress = await request(baseUrl, '/api/analysis/start', {
    method: 'POST',
    body: JSON.stringify({
      projectPath: project.path,
      upToChapterId: imported.chapters[103].id
    })
  });
  assert(progress.total === 104, 'Expected the full chapter range to be queued.');
  assert(progress.concurrency === 2, 'Expected batch analysis concurrency to be 2.');

  progress = await request(baseUrl, '/api/analysis/pause', {
    method: 'POST',
    body: JSON.stringify({ projectPath: project.path })
  });
  assert(progress.status === 'paused', 'Pause did not change task status.');

  progress = await request(baseUrl, '/api/analysis/resume', {
    method: 'POST',
    body: JSON.stringify({ projectPath: project.path })
  });
  assert(progress.status === 'running', 'Resume did not restart the task.');

  const started = Date.now();
  while (progress.status === 'running' || progress.status === 'paused') {
    if (Date.now() - started > 30_000) throw new Error('Analysis smoke test timed out.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    progress = await request(baseUrl, '/api/analysis/progress/' + encodeURIComponent(project.path));
  }

  assert(progress.status === 'completed', 'Analysis did not complete: ' + JSON.stringify(progress.errors));
  assert(progress.completed === 104, 'Expected all 104 chapters to complete.');
  assert(progress.failed === 0, 'Expected retries to recover all failures.');
  assert(maxActiveRequests >= 2, 'Expected concurrent batch model requests.');
  assert([...attempts.keys()].some((key) => key.includes('51') && attempts.get(key) >= 2), 'Expected the failed batch to retry.');
  assert(modelCalls <= 6, 'Expected batch analysis, not one model call per chapter.');

  const beforeConfirm = await request(baseUrl, '/api/projects/' + encodeURIComponent(project.path));
  const pending = beforeConfirm.candidates.filter((candidate) => candidate.status === 'pending').length;
  assert(beforeConfirm.characters.length === 0, 'Candidates polluted the confirmed graph.');
  assert(beforeConfirm.relationships.length === 0, 'Candidate relationships polluted the graph.');
  assert(pending === 104, 'Expected 104 pending chapter candidates.');

  const confirmed = await request(baseUrl, '/api/candidates/confirm-pending', {
    method: 'POST',
    body: JSON.stringify({
      projectPath: project.path,
      upToChapterId: imported.chapters[103].id
    })
  });
  assert(confirmed.characters.length >= 105, 'Bulk confirmation did not create characters.');
  assert(confirmed.relationships.length >= 104, 'Bulk confirmation did not create relationships.');

  console.log(JSON.stringify({
    chapters: progress.completed,
    modelCalls,
    maxConcurrency: maxActiveRequests,
    pendingBeforeConfirm: pending,
    charactersAfterConfirm: confirmed.characters.length,
    relationshipsAfterConfirm: confirmed.relationships.length
  }));
} finally {
  if (webServer) await close(webServer);
  await close(mockServer);
  await rm(dataDir, { recursive: true, force: true });
}
