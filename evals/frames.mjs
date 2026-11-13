#!/usr/bin/env node
// 为打分准备画面：把写好分镜的 work/eval-<用例>/ 出一套“不带字幕”的草稿关键帧，
// 取每块板的全景终帧和三张中途画面，连同不含答案的题目，放到 work/eval-judge/<用例>/。
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
  // 一块板的片子：整块板的终帧（全景）是主角；再取几张中途的画面（近景和半成品），看每个切面清不清楚
  const frames = readdirSync(join(tmp, 'out/draft')).filter(f => /^\d+-.*-\d+\.png$/.test(f)).sort();
  const boards = new Map();
  for (const f of frames) { const k = f.replace(/-\d+\.png$/, ''); if (!boards.has(k)) boards.set(k, []); boards.get(k).push(f); }
  const last = new Map();
  for (const [board, fs] of boards) {
    copyFileSync(join(tmp, 'out/draft', fs[fs.length - 1]), join(out, `${board}-全景.png`)); last.set(board, 1);
    // 中途取三张，均匀分布（不含最后一张）
    const mids = [0.25, 0.5, 0.75].map(q => fs[Math.min(fs.length - 2, Math.round(q * (fs.length - 1)))]).filter((f, i, a) => f && a.indexOf(f) === i);
    if (fs.length >= 4) mids.forEach((f, i) => copyFileSync(join(tmp, 'out/draft', f), join(out, `${board}-中途${i + 1}.png`)));
  }
  // 题目去掉答案
  const y = readFileSync(join(root, 'evals/cases', c, 'case.yaml'), 'utf8');
  writeFileSync(join(out, 'questions.yaml'), y.slice(y.indexOf('questions:')).split('\n').filter(l => !/^\s*answer:/.test(l)).join('\n'));
  rmSync(tmp, { recursive: true, force: true });
  console.log(`✓ ${c} → work/eval-judge/${c}/（${last.size} 块板：全景终帧和中途画面 + questions.yaml）`);
}
