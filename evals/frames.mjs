#!/usr/bin/env node
// 为打分准备画面：把写好分镜的 work/eval-<用例>/ 出一套“不带字幕”的草稿关键帧，
// 挑出每个场景的最后一帧，连同不含答案的题目，放到 work/eval-judge/<用例>/。
// 用法：node evals/frames.mjs [用例前缀 …]      例：node evals/frames.mjs 01 07
import { readdirSync, existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const want = process.argv.slice(2);
const cases = readdirSync(join(root, 'evals/cases')).filter(c => !want.length || want.some(w => c.startsWith(w))).sort();
for (const c of cases) {
  const proj = join(root, 'work', `eval-${c}`);
  if (!existsSync(join(proj, 'scenes')) || !readdirSync(join(proj, 'scenes')).some(f => f.endsWith('.yaml'))) { console.log(`- ${c}：还没有分镜，跳过`); continue; }
  const out = join(root, 'work/eval-judge', c), tmp = join(out, '.proj');
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  cpSync(proj, tmp, { recursive: true, filter: s => !s.includes(`${proj}/out`) });
  // 关掉字幕：题目要靠画面答，不能靠读字幕
  const py = join(tmp, 'project.yaml');
  writeFileSync(py, readFileSync(py, 'utf8').split('\n').filter(l => !/^subtitles:/.test(l)).join('\n') + '\nsubtitles: false\n');
  try { execFileSync('node', [join(root, 'bin/hj.mjs'), 'stills', tmp, '--draft'], { stdio: 'pipe' }); }
  catch (e) { console.log(`✗ ${c}：出图失败（分镜有错误？）\n${String(e.stdout ?? '').split('\n').slice(-6).join('\n')}`); rmSync(tmp, { recursive: true, force: true }); continue; }
  // 每个场景的最后一帧：<场景序号>-<场景>-<拍>.png 里拍号最大的那张
  const last = new Map();
  for (const f of readdirSync(join(tmp, 'out/draft')).filter(f => /^\d+-.*-\d+\.png$/.test(f)).sort()) last.set(f.replace(/-\d+\.png$/, ''), f);
  for (const [scene, f] of last) copyFileSync(join(tmp, 'out/draft', f), join(out, `${scene}.png`));
  // 题目去掉答案
  const y = readFileSync(join(root, 'evals/cases', c, 'case.yaml'), 'utf8');
  writeFileSync(join(out, 'questions.yaml'), y.slice(y.indexOf('questions:')).split('\n').filter(l => !/^\s*answer:/.test(l)).join('\n'));
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ ${c} → work/eval-judge/${c}/（${last.size} 个场景的终帧 + questions.yaml）`);
}
