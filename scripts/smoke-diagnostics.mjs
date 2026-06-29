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
  const title = new RegExp('章节标题：([^\\n]+)').exec(prompt)?.[1]?.trim() || '未知章节';
  return [{ chapterId: null, orderIndex: null, title }];
}

function extractionForTitle(title) {
  const base = {
    characters: [{ name: '主角', aliases: [], summary: '主角', tags: ['主角'], evidence: title }],
    relationships: [],
    statusEvents: []
  };

  if (title.includes('第一章')) {
    base.characters.push({ name: '旧友', aliases: ['庞友'], summary: '主角旧友', tags: [], evidence: '旧友与主角同行' });
    base.relationships.push({
      source: '主角',
      target: '旧友',
      type: '朋友',
      summary: '两人互为朋友',
      strength: 4,
      confidence: 0.95,
      evidence: '旧友与主角同行',
      events: [{ summary: '旧友与主角同行', evidence: '旧友与主角同行' }]
    });
  } else if (title.includes('第二章')) {
    base.characters.push({ name: '师姐', aliases: [], summary: '指点主角', tags: [], evidence: '师姐提醒主角' });
    base.relationships.push({
      source: '主角',
      target: '师姐',
      type: '同门',
      summary: '师姐指点主角',
      strength: 3,
      confidence: 0.9,
      evidence: '师姐提醒主角',
      events: [{ summary: '师姐提醒主角', evidence: '师姐提醒主角' }]
    });
  } else if (title.includes('第三章')) {
    base.characters.push(
      { name: '旧友', aliases: ['庞友'], summary: '主角旧友', tags: [], evidence: '旧友殒命' },
      { name: '对手', aliases: [], summary: '伏击主角', tags: [], evidence: '对手出手' }
    );
    base.relationships.push({
      source: '主角',
      target: '对手',
      type: '敌对',
      summary: '对手伏击主角',
      strength: 5,
      confidence: 0.92,
      evidence: '对手出手',
      events: [{ summary: '对手伏击主角', evidence: '对手出手' }]
    });
    base.statusEvents.push({ character: '旧友', status: 'dead', evidence: '旧友殒命' });
  } else {
    base.characters.push({ name: '后期人物', aliases: [], summary: '第四章才出现', tags: [], evidence: title });
    base.relationships.push({
      source: '主角',
      target: '后期人物',
      type: '未知',
      summary: '第四章关系',
      strength: 2,
      confidence: 0.7,
      evidence: title,
      events: [{ summary: '第四章关系', evidence: title }]
    });
  }

  return base;
}

function scopedGraph(graph, upToOrderIndex) {
  const chapterOrder = new Map(graph.chapters.map((chapter) => [chapter.id, chapter.orderIndex]));
  const allowedChapterIds = new Set(
    graph.chapters.filter((chapter) => chapter.orderIndex <= upToOrderIndex).map((chapter) => chapter.id)
  );
  const inactiveCharacterIds = new Set(
    graph.statusEvents
      .filter((event) => event.status === 'dead' || event.status === 'retired' || event.status === 'unused')
      .filter((event) => event.chapterId === null || allowedChapterIds.has(event.chapterId))
      .map((event) => event.characterId)
  );
  const events = graph.events.filter((event) => {
    if (event.chapterId === null) return true;
    return (chapterOrder.get(event.chapterId) || 0) <= upToOrderIndex;
  });
  const relationshipIds = new Set(events.map((event) => event.relationshipId));
  const relationships = graph.relationships.filter((relationship) =>
    relationshipIds.has(relationship.id) &&
    !inactiveCharacterIds.has(relationship.sourceCharacterId) &&
    !inactiveCharacterIds.has(relationship.targetCharacterId)
  );
  const characterIds = new Set();
  relationships.forEach((relationship) => {
    characterIds.add(relationship.sourceCharacterId);
    characterIds.add(relationship.targetCharacterId);
  });
  graph.characters.forEach((character) => {
    if (!inactiveCharacterIds.has(character.id) && (character.firstChapterId === null || allowedChapterIds.has(character.firstChapterId))) {
      characterIds.add(character.id);
    }
  });
  return {
    characters: graph.characters.filter((character) => characterIds.has(character.id)),
    relationships
  };
}

const modelCalls = [];
const mockServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const prompt = body.messages?.find((message) => message.role === 'user')?.content || '';
  const chapters = requestedChapters(prompt);
  modelCalls.push(chapters.map((chapter) => chapter.title));
  const payload = chapters.length > 1 || chapters[0].chapterId !== null
    ? { chapters: chapters.map((chapter) => ({ chapterId: chapter.chapterId, chapterTitle: chapter.title, ...extractionForTitle(chapter.title) })) }
    : extractionForTitle(chapters[0].title);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'mock-diagnostics',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }]
  }));
});

const dataDir = await mkdtemp(path.join(tmpdir(), 'character-graph-diagnostics-'));
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
    body: JSON.stringify({ name: 'DiagnosticsSmoke' })
  });

  await request(baseUrl, '/api/llm/config', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:' + mockPort + '/v1',
      apiKey: 'local-diagnostics-key',
      model: 'mock-diagnostics',
      temperature: 0,
      maxTokens: 2048,
      supportsJson: true,
      reasoningMode: 'off'
    })
  });

  const novel = [
    ['第一章 旧友同行', '主角与旧友同行。'].join('\n'),
    ['第二章 师姐提醒', '师姐提醒主角。'].join('\n'),
    ['第三章 旧友殒命', '旧友殒命，对手出手。'].join('\n'),
    ['第四章 后期人物', '后期人物才在这里出现。'].join('\n')
  ].join('\n');

  const imported = await request(baseUrl, '/api/novel/import', {
    method: 'POST',
    body: JSON.stringify({
      projectPath: project.path,
      fileName: 'diagnostics.txt',
      bytesBase64: Buffer.from(novel, 'utf8').toString('base64')
    })
  });
  assert(imported.chapters.length === 4, 'Expected 4 imported chapters.');

  let progress = await request(baseUrl, '/api/analysis/start', {
    method: 'POST',
    body: JSON.stringify({ projectPath: project.path, upToChapterId: imported.chapters[2].id })
  });
  assert(progress.total === 3, 'Selecting chapter 3 should queue chapters 1-3 only.');

  const started = Date.now();
  while (progress.status === 'running' || progress.status === 'paused') {
    if (Date.now() - started > 20_000) throw new Error('Diagnostics smoke test timed out.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    progress = await request(baseUrl, '/api/analysis/progress/' + encodeURIComponent(project.path));
  }

  assert(progress.status === 'completed', 'Analysis did not complete.');
  assert(modelCalls.length === 1, 'Expected chapters 1-3 to be analyzed in one batch.');
  assert(modelCalls[0].length === 3, 'Expected exactly 3 chapters in the batch.');
  assert(modelCalls[0].every((title) => !title.includes('第四章')), 'Chapter 4 should not be analyzed.');

  const beforeConfirm = await request(baseUrl, '/api/projects/' + encodeURIComponent(project.path));
  const pending = beforeConfirm.candidates.filter((candidate) => candidate.status === 'pending');
  assert(pending.length === 3, 'Expected 3 pending candidates before confirmation.');
  assert(beforeConfirm.characters.length === 0, 'Pending candidates should not pollute graph characters.');

  const confirmed = await request(baseUrl, '/api/candidates/confirm-pending', {
    method: 'POST',
    body: JSON.stringify({ projectPath: project.path, upToChapterId: imported.chapters[2].id })
  });
  const names = new Set(confirmed.characters.map((character) => character.name));
  assert(names.has('主角'), 'Missing main character.');
  assert(names.has('旧友'), 'Missing chapter 1 character.');
  assert(names.has('师姐'), 'Missing chapter 2 character.');
  assert(names.has('对手'), 'Missing chapter 3 character.');
  assert(!names.has('后期人物'), 'Chapter 4 character leaked into 1-3 graph.');
  assert(confirmed.candidates.filter((candidate) => candidate.status === 'confirmed').length === 3, 'Expected 3 confirmed candidates.');
  assert(confirmed.statusEvents.some((event) => event.characterName === '旧友' && event.status === 'dead'), 'Expected dead status event for hidden character.');

  const visible = scopedGraph(confirmed, 3);
  assert(!visible.characters.some((character) => character.name === '旧友'), 'Dead character should be hidden in scoped graph.');
  assert(visible.relationships.length === 2, 'Expected visible relationships after dead character is hidden.');

  console.log(JSON.stringify({
    queuedChapters: progress.total,
    modelCalls: modelCalls.length,
    batchSize: modelCalls[0].length,
    pendingBeforeConfirm: pending.length,
    confirmedCharacters: confirmed.characters.length,
    confirmedRelationships: confirmed.relationships.length,
    visibleCharacters: visible.characters.length,
    visibleRelationships: visible.relationships.length,
    hiddenCharacter: '旧友'
  }));
} finally {
  if (webServer) await close(webServer);
  await close(mockServer);
  await rm(dataDir, { recursive: true, force: true });
}
