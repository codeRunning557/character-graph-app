import { spawn } from 'node:child_process';
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
const smokeNovel = process.env.CHARACTER_GRAPH_SMOKE_IMPORT_PATH || path.join(smokeDir, `packaged-novel-${Date.now()}.txt`);
if (!process.env.CHARACTER_GRAPH_SMOKE_IMPORT_PATH) {
  writeFileSync(
    smokeNovel,
    '第一章 初遇\n少年林岐在雨夜救下阿照，二人结为同伴。\n\n第二章 反目\n阿照误会林岐夺走族印，二人拔剑相向。\n',
    'utf8'
  );
}

const child = spawn(path.join(unpacked, exeName), [], {
  cwd: unpacked,
  env: { ...process.env, CHARACTER_GRAPH_SMOKE: '1', CHARACTER_GRAPH_SMOKE_IMPORT_PATH: smokeNovel },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
const timer = setTimeout(() => {
  child.kill();
  console.error('Packaged smoke test timed out.');
  process.exit(1);
}, 25000);

child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

child.on('exit', (code) => {
  clearTimeout(timer);
  const match = output.match(/\[smoke\](\{.*\})/);
  if (!match) {
    console.error('Packaged smoke result was not emitted.');
    process.exit(1);
  }
  const result = JSON.parse(match[1]);
  if (!result.apiReady || !result.projectCreated || result.chapterCount < 2) {
    console.error(`Packaged smoke failed: ${JSON.stringify(result, null, 2)}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
