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

const attempts = new Map();
let activeRequests = 0;
let maxActiveRequests = 0;
let modelCalls = 0;

const mockServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const prompt = body.messages?.find((message) => message.role === 'user')?.content || '';
  const title = /章节标题：([^\n]+)/.exec(prompt)?.[1]?.trim() || '未知章节';
  const count = (attempts.get(title) || 0) + 1;
  attempts.set(title, count);
  modelCalls += 1;
  activeRequests += 1;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

  await new Promise((resolve) => setTimeout(resolve, 140));
  activeRequests -= 1;

  if (title.startsWith('第二章') && count === 1) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'temporary mock failure' } }));
    return;
  }

  const suffix = title.replace(/[（）\s]/g, '').slice(0, 24);
  const extraction = {
    characters: [
      { name: '主角', aliases: [], summary: '主角', tags: ['主角'], evidence: '主角出现' },
      { name: '人物' + suffix, aliases: [], summary: title, tags: [], evidence: title }
    ],
    statusEvents: [],
    relationships: [
      {
        source: '主角',
        target: '人物' + suffix,
        type: '同行',
        summary: title + '同行',
        strength: 3,
        confidence: 0.9,
        evidence: title,
        events: [{ summary: title + '事件', evidence: title }]
      }
    ]
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'mock',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(extraction) }, finish_reason: 'stop' }]
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
      maxTokens: 1024,
      supportsJson: true,
      reasoningMode: 'off'
    })
  });

  const longText = '第三章 超长章节\n' + '主角与长篇人物同行。\n'.repeat(1400);
  const novel = [
    '第一章 初遇\n主角遇见人物甲。',
    '第二章 波折\n主角与人物乙同行。',
    longText,
    '第四章 收束\n主角与人物丁同行。'
  ].join('\n');

  const imported = await request(baseUrl, '/api/novel/import', {
    method: 'POST',
    body: JSON.stringify({
      projectPath: project.path,
      fileName: 'smoke.txt',
      bytesBase64: Buffer.from(novel, 'utf8').toString('base64')
    })
  });
  assert(imported.chapters.length === 4, 'Expected 4 imported chapters.');

  let progress = await request(baseUrl, '/api/analysis/start', {
    method: 'POST',
    body: JSON.stringify({
      projectPath: project.path,
      upToChapterId: imported.chapters[3].id
    })
  });
  assert(progress.total === 4, 'Expected the full chapter range to be queued.');

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
    progress = await request(
      baseUrl,
      '/api/analysis/progress/' + encodeURIComponent(project.path)
    );
  }

  assert(progress.status === 'completed', 'Analysis did not complete: ' + JSON.stringify(progress.errors));
  assert(progress.completed === 4, 'Expected all 4 chapters to complete.');
  assert(progress.failed === 0, 'Expected retries to recover all failures.');
  assert(maxActiveRequests >= 2, 'Expected concurrent model requests.');
  assert((attempts.get('第二章 波折') || 0) >= 2, 'Expected the failed chapter to retry.');
  assert(modelCalls >= 6, 'Expected retries and long-chapter chunking to add model calls.');

  const beforeConfirm = await request(
    baseUrl,
    '/api/projects/' + encodeURIComponent(project.path)
  );
  assert(beforeConfirm.characters.length === 0, 'Candidates polluted the confirmed graph.');
  assert(beforeConfirm.relationships.length === 0, 'Candidate relationships polluted the graph.');
  assert(beforeConfirm.candidates.filter((candidate) => candidate.status === 'pending').length === 4, 'Expected 4 pending chapter candidates.');

  const confirmed = await request(baseUrl, '/api/candidates/confirm-pending', {
    method: 'POST',
    body: JSON.stringify({
      projectPath: project.path,
      upToChapterId: imported.chapters[3].id
    })
  });
  assert(confirmed.characters.length >= 5, 'Bulk confirmation did not create characters.');
  assert(confirmed.relationships.length >= 4, 'Bulk confirmation did not create relationships.');

  console.log(JSON.stringify({
    chapters: progress.completed,
    retries: attempts.get('第二章 波折'),
    modelCalls,
    maxConcurrency: maxActiveRequests,
    pendingBeforeConfirm: 4,
    charactersAfterConfirm: confirmed.characters.length,
    relationshipsAfterConfirm: confirmed.relationships.length
  }));
} finally {
  if (webServer) await close(webServer);
  await close(mockServer);
  await rm(dataDir, { recursive: true, force: true });
}