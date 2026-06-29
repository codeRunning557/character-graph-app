import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = path.join(root, 'release', 'win-unpacked');
const exeName = readdirSync(unpacked).find((name) => name.endsWith('.exe') && name !== 'elevate.exe');

if (!exeName) {
  console.error('Packaged exe was not found.');
  process.exit(1);
}

const smokeDir = path.join(tmpdir(), 'character-graph-smoke');
mkdirSync(smokeDir, { recursive: true });
const smokeProfile = path.join(smokeDir, 'packaged-profile-' + Date.now());
for (const folder of ['user-data', 'cache', 'documents']) {
  mkdirSync(path.join(smokeProfile, folder), { recursive: true });
}
const smokeNovel = process.env.CHARACTER_GRAPH_SMOKE_IMPORT_PATH || path.join(smokeDir, 'packaged-novel-' + Date.now() + '.txt');
if (!process.env.CHARACTER_GRAPH_SMOKE_IMPORT_PATH) {
  writeFileSync(
    smokeNovel,
    ['第一章 初遇', '少年林岐在雨夜救下阿照，二人结为同伴。', '', '第二章 反目', '阿照误会林岐夺走族印，二人拔剑相向。'].join('\n'),
    'utf8'
  );
}

const child = spawn(path.join(unpacked, exeName), [], {
  cwd: unpacked,
  env: {
    ...process.env,
    CHARACTER_GRAPH_SMOKE: '1',
    CHARACTER_GRAPH_SMOKE_IMPORT_PATH: smokeNovel,
    CHARACTER_GRAPH_SMOKE_PROFILE: smokeProfile
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
let settled = false;

function stopChild() {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill();
  }
}

function finishFromOutput(code = 0) {
  if (settled) return;
  const match = output.match(/\[smoke\](\{.*\})/);
  if (!match) return;
  settled = true;
  clearTimeout(timer);
  const result = JSON.parse(match[1]);
  if (!result.apiReady || !result.projectCreated || result.chapterCount < 2) {
    console.error('Packaged smoke failed: ' + JSON.stringify(result, null, 2));
    stopChild();
    process.exit(1);
  }
  stopChild();
  process.exit(code ?? 0);
}

const timer = setTimeout(() => {
  settled = true;
  stopChild();
  console.error('Packaged smoke test timed out.');
  process.exit(1);
}, 45000);

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  finishFromOutput(0);
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
  finishFromOutput(0);
});

child.on('exit', (code) => {
  if (settled) return;
  clearTimeout(timer);
  const match = output.match(/\[smoke\](\{.*\})/);
  if (!match) {
    console.error('Packaged smoke result was not emitted.');
    process.exit(1);
  }
  finishFromOutput(code ?? 0);
});
