#!/usr/bin/env node
// 为评测集里的每个用例准备一个可以写分镜的项目：work/eval-<NN>-<slug>/
// 用法：node evals/prepare.mjs [--cps 4.5] [--format portrait|landscape] [用例前缀…]
// 可重复运行；已经有场景文件的项目一律不动。
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = join(root, 'evals/cases');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const cps = opt('cps', '4.5'), format = opt('format', 'portrait');
const only = argv; // 其余参数当作用例名前缀，如 03 或 03-coffee

const hj = (...a) => spawnSync(process.execPath, [join(root, 'bin/hj.mjs'), ...a], { encoding: 'utf8', cwd: root });
let failed = 0;
for (const name of readdirSync(cases).filter(n => /^\d+-/.test(n)).sort()) {
  if (only.length && !only.some(p => name.startsWith(p))) continue;
  const script = join(cases, name, 'script.txt');
  if (!existsSync(script)) { console.error(`✗ ${name}：缺 script.txt`); failed++; continue; }
  const proj = join(root, 'work', 'eval-' + name);
  const scenes = join(proj, 'scenes');
  if (existsSync(scenes) && readdirSync(scenes).some(f => /\.ya?ml$/.test(f))) { console.log(`- ${name}：已有场景，跳过`); continue; }
  const voice = join(proj, 'voice-src');
  mkdirSync(voice, { recursive: true });
  const al = hj('fake-align', script, '--cps', cps);
  if (al.status !== 0) { console.error(`✗ ${name}：fake-align 失败\n${al.stderr}`); failed++; continue; }
  writeFileSync(join(voice, 'alignment.json'), al.stdout);
  const init = hj('init', proj, '--voice', voice, '--format', format, '--title', 'eval-' + name);
  if (init.status !== 0) { console.error(`✗ ${name}：init 失败\n${init.stdout}${init.stderr}`); failed++; continue; }
  console.log(`✓ ${name} → work/eval-${name}`);
}
process.exit(failed ? 1 : 0);
