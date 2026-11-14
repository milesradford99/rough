// hj：画讲命令行。流程是 init → brief → 写分镜 → check → plan →（用户确认）→ stills →（用户确认）→ render
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, Path2D, loadImage } from '@napi-rs/canvas';
import YAML from 'yaml';
import { compile, type Compiled, type CScene } from '../core/compile';
import { lint, printIssues, planMarkdown } from '../core/lint';
import { drawFrame, drawStrokes, drawStroke, type Env } from '../core/render';
import { writeSfx } from '../core/sfx';
import { loadAlignment, fakeAlignment, resolveAnchor } from '../core/alignment';
import { searchIcons } from '../core/icons';
import { POSES, FACES, ACCESSORIES } from '../core/figure';
import { doodleDirs, buildElement, type El, type BuildCtx } from '../core/elements';
import { createHash } from 'node:crypto';
import { confirmCode, hasCode, reviewHtml, esc, STAGE_NAME, type Stage, type ReviewPage, type ReviewBlock } from '../core/review';
import { textStrokes } from '../core/text';
import { PATTERNS } from '../core/patterns';
import { loadPlan, checkPlan, planStoryboard, scaffold, planRegions, boardBox, segmentTimes, LAYOUTS, type Plan, type PlanBoard } from '../core/plan';
import type { Issue } from '../core/compile';
import { synthesize, synthesizeEdge, scriptHash, scriptWarnings, DEFAULT_SPEAKER, DEFAULT_EDGE_VOICE, EDGE_VOICES, KEY_ENV } from '../core/tts';
import { THEME, FORMATS } from '../core/theme';

const images = new Map<string, any>();
const env: Env = { createCanvas, Path2D, image: f => images.get(f) };
const penOpt = (c: Compiled): false | 'marker' | 'hand' => (c.meta.pen === 'hand' ? 'hand' : c.meta.pen ? 'marker' : false);
/** 位图要先解码好：画面是时间的纯函数，画的时候不能等 */
async function preload(c: Compiled) { for (const tl of c.tls) for (const s of tl.el.strokes) if (s.kind === 'image' && !images.has(s.file)) images.set(s.file, await loadImage(readFileSync(s.file))); }

/** 把配音、落笔音效、背景音乐混成一路。返回 ffmpeg 的 filter_complex 和要 map 的音轨 */
export function audioGraph(o: { voiceIn: number; sfxIn: number; musicIn: number; dur: number; volume: number; duck: boolean }): { filter: string; map: string } {
  const parts: string[] = [], mix: string[] = [];
  let voice = o.voiceIn > 0 ? `[${o.voiceIn}:a]` : '';
  if (o.musicIn > 0) {
    const fade = Math.min(2, o.dur / 4);
    parts.push(`[${o.musicIn}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${o.volume},afade=t=in:d=${Math.min(1.2, fade).toFixed(2)},afade=t=out:st=${Math.max(0, o.dur - fade).toFixed(2)}:d=${fade.toFixed(2)}[bg]`);
    if (voice && o.duck) {
      parts.push(`${voice}asplit=2[vo][key]`, `[bg][key]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=600[bgd]`);
      voice = '[vo]'; mix.push('[bgd]');
    } else mix.push('[bg]');
  }
  if (voice) mix.unshift(voice);
  if (o.sfxIn > 0) mix.push(`[${o.sfxIn}:a]`);
  if (!mix.length) return { filter: '', map: '' };
  if (mix.length === 1 && !parts.length) return { filter: '', map: mix[0].slice(1, -1) };
  parts.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest[a]`);
  return { filter: parts.join(';'), map: '[a]' };
}
process.stdout.on('error', () => process.exit(0)); // 输出被 head 之类截断时安静退出
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags: Record<string, string | true> = {};
const args: string[] = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]; else flags[k] = true; }
  else args.push(argv[i]);
}
const die = (msg: string): never => { console.error('✗ ' + msg); process.exit(1); };
const fmtT = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function load(dir: string, strict = true): Compiled {
  let c: Compiled;
  try { c = compile(dir); } catch (e: any) { return die(e.message); }
  c.issues = lint(c);
  const errors = c.issues.filter(i => i.level === 'error');
  if (strict && errors.length) { printIssues(c.issues); die('分镜有错误，先修掉再继续（hj check 可随时重查）。这次什么都没有生成：输出目录里如果有图，是上一次的旧图'); }
  return c;
}
const approvalsFile = (dir: string) => join(dir, 'approvals.json');
const approvals = (dir: string): any => (existsSync(approvalsFile(dir)) ? JSON.parse(readFileSync(approvalsFile(dir), 'utf8')) : {});
/** 只看计划、不编译场景：规划者写计划、交用户确认时用（这时候还没有场景文件） */
function planCtx(dir: string): { meta: any; fmt: (typeof FORMATS)[string]; al: ReturnType<typeof loadAlignment>; duration: number; plan: Plan; issues: Issue[] } | null {
  let plan: Plan | null;
  try { plan = loadPlan(dir); } catch (e: any) { return die(e.message); }
  if (!plan) return null;
  if (!existsSync(join(dir, 'project.yaml'))) die(`${dir} 里没有 project.yaml，这不是一个画讲项目（用 hj init 创建）`);
  const meta = YAML.parse(readFileSync(join(dir, 'project.yaml'), 'utf8')) ?? {}, fmt = FORMATS[meta.format ?? 'portrait'] ?? die('project.yaml: format 只能是 portrait 或 landscape');
  if (!existsSync(join(dir, meta.voice ?? 'voice/alignment.json'))) die(`找不到时间表 ${join(dir, meta.voice ?? 'voice/alignment.json')}：还没有配音。hj status ${dir} 看下一步`);
  const al = loadAlignment(join(dir, meta.voice ?? 'voice/alignment.json')), duration = al.duration + (meta.tail ?? 0.6);
  return { meta, fmt, al, duration, plan, issues: checkPlan(plan, al, fmt, duration) };
}
const hasScenes = (dir: string) => existsSync(join(dir, 'scenes')) && readdirSync(join(dir, 'scenes')).some(f => /\.ya?ml$/.test(f));
/** 全景定稿认的是“板上有哪些东西、各在哪个分区、各是哪一档大小”。微调位置不会让它失效 */
function lookHash(c: Compiled): string {
  const rows = c.scenes.map(sc => c.tls.filter(t => t.scene === sc.index && (t.drawT0 != null || t.appear) && !(t.gone != null && t.gone < sc.t1 - 0.3) && !['mark', 'arrow', 'line', 'note', 'axis'].includes(t.el.kind)).map(t => {
    const b = t.el.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2, rg = sc.regions?.find(r => cx >= r.box.x && cx <= r.box.x + r.box.w && cy >= r.box.y && cy <= r.box.y + r.box.h)?.name ?? '';
    return [t.el.id, t.el.kind, rg, t.el.kind === 'text' ? Math.round(+(t.el.src.size ?? 72) / 14) : Math.round(Math.max(b.w, b.h) / 70)].join(':');
  }).sort());
  return createHash('sha256').update(c.planHash + JSON.stringify(rows)).digest('hex').slice(0, 16);
}
const hashOf = (c: Compiled, stage: Stage) => (stage === 'plan' ? c.planHash : stage === 'look' ? lookHash(c) : c.keyHash);
const STEPS = ['朗读稿', '分镜计划', '全景定稿', '关键帧', '成片'];
function gate(c: Compiled, stage: Stage) {
  const a = approvals(c.dir);
  const label = stage === 'plan' ? (c.plan ? '分镜计划' : '文字分镜') : STAGE_NAME[stage], now = hashOf(c, stage);
  const how = stage === 'plan'
    ? `先运行 hj plan ${c.dir} 生成 storyboard.md${c.plan ? ' 和审片页（out/review/plan.html、plan.png）' : ''}，交给用户看；用户明确同意后运行 hj approve ${c.dir} plan --by "<用户的确认原话>"\n  想在交给用户之前自己先看看画面：hj stills ${c.dir} --draft（带水印的草稿，不需要确认）`
    : stage === 'look'
      ? `先运行 hj look ${c.dir} 出全景定稿的审片页（out/review/look.html、look.png），把图发给用户看；用户看图后回复确认码，再运行 hj approve ${c.dir} look --by "<用户的确认原话>"`
      : `先运行 hj stills ${c.dir} 出关键帧和审片页（out/review/keyframes.html、keyframes.png），把图发给用户看；用户看图后回复确认码，再运行 hj approve ${c.dir} keyframes --by "<用户的确认原话>"`;
  if (!a[stage]) die(`${label}还没有得到用户确认，不能继续。\n  ${how}`);
  const what = stage === 'plan' ? (c.plan ? '计划（plan.yaml）' : '分镜内容（场景划分 / 每拍画什么）') : stage === 'look' ? '板上的东西（增删了东西、换了分区，或换了大小的档位）' : '分镜内容（场景划分 / 每拍画什么）';
  if (a[stage].planHash !== now) die(`${label}确认之后，${what}又改过了（确认的是 ${a[stage].planHash}，现在是 ${now}），需要用户重新确认。\n  ${how}\n  只调位置、颜色、时长这类细节不会触发重新确认。`);
}

// ── 审片页：每道闸交给用户的那一页（out/review/<闸>.html + .png）。图上印着确认码 ──
const jpeg = async (cv: any, q = 82) => 'data:image/jpeg;base64,' + (await cv.encode('jpeg', q)).toString('base64');
/** 审片长图顶上的那一条：是哪一步、确认码 */
function bandOn(x: any, w: number, title: string, code: string): number {
  const h = 150;
  x.fillStyle = THEME.paper; x.fillRect(0, 0, w, h);
  const put = (txt: string, size: number, col: string, px: number, py: number) => { const t = textStrokes(txt, { size, color: col }); x.save(); x.translate(px < 0 ? w + px - t.w : px, py); drawStrokes(x, env, t.strokes); x.restore(); return t.w; };
  const cw = textStrokes(`确认 ${code}`, { size: 60, color: THEME.colors.red }).w;
  let tt = [...title]; while (tt.length > 4 && textStrokes(tt.join(''), { size: 46, color: THEME.ink }).w > w - cw - 120) tt = tt.slice(0, -1);
  put(tt.join('') + (tt.length < [...title].length ? '…' : ''), 46, THEME.ink, 28, 22);
  put('看完请回复右边的确认码', 30, THEME.colors.gray, 28, 92);
  x.fillStyle = '#fbeab8'; x.fillRect(w - cw - 56, 38, cw + 36, 84);
  put(`确认 ${code}`, 60, THEME.colors.red, -38, 46);
  x.strokeStyle = '#d8d2c2'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, h - 1); x.lineTo(w, h - 1); x.stroke();
  return h;
}
/** 几张图上下叠成一张长图，顶上加确认码 */
async function stackSheet(title: string, code: string, parts: any[]): Promise<Buffer> {
  const w = Math.max(900, ...parts.map(p => p.width)), hs = parts.reduce((n, p) => n + Math.round(p.height * Math.min(1, w / p.width)) + 20, 0);
  const cv = createCanvas(w, 150 + hs + 10), x = cv.getContext('2d');
  x.fillStyle = '#e9ecef'; x.fillRect(0, 0, cv.width, cv.height);
  let y = bandOn(x, w, title, code) + 14;
  for (const p of parts) { const k = Math.min(1, w / p.width), pw = Math.round(p.width * k), ph = Math.round(p.height * k); x.drawImage(p, Math.round((w - pw) / 2), y, pw, ph); y += ph + 20; }
  return cv.encode('png');
}
async function writeReview(dir: string, page: ReviewPage, sheet: Buffer) {
  const out = join(dir, 'out', 'review'); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${page.stage}.html`), reviewHtml(page));
  writeFileSync(join(out, `${page.stage}.png`), sheet);
  writeFileSync(join(out, `${page.stage}.json`), JSON.stringify({ stage: page.stage, hash: page.hash, at: new Date().toISOString() }) + '\n');
  console.log(`\n■ 交给用户审（${STAGE_NAME[page.stage]}）：\n  长图   ${resolve(out, page.stage + '.png')}\n  审片页 ${resolve(out, page.stage + '.html')}（图都嵌在里面，一个文件）\n  必须让用户看到图：把长图（或审片页）作为文件 / 图片发出来。只贴路径、只用文字描述，都不算给用户看过。\n  同时用两三句话说清楚这一步要用户决定什么，问题不超过三个，每个给出你的建议。\n  图上印着四位确认码。用户看图后回复“确认 <码>”，你再运行：hj approve ${dir} ${page.stage} --by "<用户原话>"\n  不要自己把码读出来替用户填；用户只说“可以”没带码，就请他看图上的码。`);
}
/** 一块板讲完时的全景：镜头固定在全景，画到最后一刻 */
function fullView(c: Compiled, sc: CScene, ctx: any, scale: number, bare = false) {
  const t = Math.min(c.scenes[sc.index + 1] ? sc.t1 - 0.72 : c.duration - 0.01, c.duration - 0.01);
  drawFrame(ctx, { ...c, cams: [{ t0: -1, t1: -1, to: sc.home, cut: true }] } as Compiled, t, env, { scale, subtitles: false, bare });
}
/** 眯眼图：缩得很小再放大，字都糊掉，只剩轻重。最显眼的那一团应该就是主角 */
function squintOf(cv: any): any {
  const out = createCanvas(Math.round(cv.width / 2.5), Math.round(cv.height / 2.5)), ox = out.getContext('2d');
  ox.imageSmoothingEnabled = true; ox.filter = `blur(${Math.max(4, Math.round(out.width / 60))}px)`;
  ox.drawImage(cv, 0, 0, out.width, out.height);
  return out;
}
/** 一眼看过去最重的几样：按占的面积算，字和有颜色的东西更抢眼 */
function heaviest(c: Compiled, sc: CScene, n = 3): string[] {
  const alive = c.tls.filter(t => t.scene === sc.index && (t.drawT0 != null || t.appear) && !(t.gone != null && t.gone < sc.t1 - 0.3) && !['mark', 'arrow', 'line', 'axis', 'note'].includes(t.el.kind));
  const w = (t: typeof alive[number]) => { const b = t.el.body ?? t.el.box, col = String(t.el.src.color ?? ''); return b.w * b.h * (t.el.kind === 'text' ? 1.5 : 1) * (col === 'gray' ? 0.5 : col === 'red' || col === 'blue' ? 1.25 : 1); };
  return alive.sort((a, b) => w(b) - w(a)).slice(0, n).map(t => (t.el.kind === 'text' ? `“${String(t.el.text).replace(/\n/g, ' ')}”` : t.el.id));
}
/** 计划的结构草图：分区、角色的真实长相、关系的箭头、主角。还没有任何场景文件时就能画 */
function planSketch(plan: Plan, b: PlanBoard, fmt: (typeof FORMATS)[string], dir: string): any {
  const B = boardBox(b, fmt), { regions } = planRegions(b, fmt), k = Math.min(1, 900 / B.w), M = 26;
  const cv = createCanvas(Math.round(B.w * k) + M * 2, Math.round(B.h * k) + M * 2), x = cv.getContext('2d');
  x.fillStyle = THEME.paper; x.fillRect(0, 0, cv.width, cv.height);
  x.translate(M, M); x.scale(k, k); x.lineCap = 'round'; x.lineJoin = 'round';
  const label = (txt: string, px: number, py: number, size: number, col: string) => { const t = textStrokes(txt, { size, color: col }); x.save(); x.translate(px, py); drawStrokes(x, env, t.strokes); x.restore(); };
  for (const [n, r] of Object.entries(regions)) {
    x.strokeStyle = '#c9a227'; x.lineWidth = 2; x.setLineDash([10, 9]); x.strokeRect(r[0] + 5, r[1] + 5, r[2] - 10, r[3] - 10); x.setLineDash([]);
    label(n, r[0] + 18, r[1] + 14, 30, '#a07d00');
    const d = b.regions[n] ?? ''; if (d) label([...d].slice(0, Math.max(6, Math.floor((r[2] - 80 - n.length * 22) / 30))).join(''), r[0] + 30 + n.length * 20, r[1] + 16, 26, THEME.colors.gray);
  }
  const els = new Map<string, El>(), life = new Map<string, [number, number]>();
  const ctx: BuildCtx = { scene: 'sketch', fmt: { ...fmt, board: { x: 0, y: 0, w: B.w, h: B.h } }, els, projectDir: dir, life, shade: false };
  const home = new Map<string, string>(), per = new Map<string, string[]>();
  for (const s of b.segments) for (const id of s.show) if (plan.cast[id] && !home.has(id) && s.in && regions[s.in]) { home.set(id, s.in); per.set(s.in, [...(per.get(s.in) ?? []), id]); }
  const add = (id: string, src: any) => { try { life.set(id, [0, 1]); els.set(id, buildElement(ctx, id, src)); } catch { life.delete(id); } };
  for (const [rn, ids] of per) {
    const r = regions[rn], size = Math.round(Math.max(90, Math.min(170, r[3] * 0.4, (r[2] / (ids.length + 0.6)) * 0.62)));
    ids.forEach((id, i) => { const lk = plan.cast[id].look, base = lk && typeof lk === 'object' && 'crowd' in lk ? lk.of : lk; add(id, { ...base, size: b.hero === id ? Math.round(size * 1.3) : size, label: plan.cast[id].name + (lk?.crowd ? ` ×${lk.crowd}` : ''), labelSize: 34, at: [r[0] + (r[2] * (i + 1)) / (ids.length + 1), r[1] + 62 + (r[3] - 62) * 0.44] }); });
  }
  // 这一区要画的“图”（横条、图表…）草图里画不出来：写一行说明，免得看起来是空的
  for (const [n, r] of Object.entries(regions)) { const ds = b.segments.filter(s => s.in === n && s.diagram).length; if (ds) label(`这里还有 ${ds} 处要画的图，见分段表`, r[0] + 30, r[1] + r[3] - 54, 26, THEME.colors.gray); }
  if (b.hero && !plan.cast[b.hero]) { const seg = b.segments.find(s => s.words.some(w => w.replace(/\s/g, '') === b.hero!.replace(/\s/g, ''))), r = seg?.in ? regions[seg.in] : undefined; if (r) add('__hero', { text: b.hero, size: 92, color: 'blue', at: [r[0] + r[2] * 0.5, r[1] + r[3] * 0.72] }); }
  const done = new Set<string>();
  for (const s of b.segments) for (const id of s.link) { const rl = plan.relations[id]; if (!rl || done.has(id) || !els.has(rl.from) || !els.has(rl.to)) continue; done.add(id); add('rel_' + id, { arrow: [rl.from, rl.to], ...(rl.label ? { label: rl.label, labelSize: 36 } : {}), pen: 5 }); }
  for (const e of els.values()) drawStrokes(x, env, e.strokes);
  if (els.has('__hero')) { const hb = els.get('__hero')!.box; label('主角', hb.x + hb.w + 14, hb.y + 6, 28, THEME.colors.red); }
  return cv;
}
/** 一个场景板上的三层信息各有几样（一模一样的重复元素算一样） */
function layers(c: Compiled, sc: CScene) {
  const shown = c.tls.filter(t => t.scene === sc.index && (t.drawT0 != null || t.appear));
  const seen = new Set<string>(); let main = 0, support = 0, notes = 0;
  for (const t of shown) {
    const e = t.el, k = e.kind;
    if (['figure', 'doodle', 'icon', 'parts'].includes(k)) { const sig = k + JSON.stringify([e.src.figure, e.src.doodle, e.src.icon, e.src.wear, e.src.size]); if (!seen.has(sig)) { seen.add(sig); main++; } if (e.src.label) notes++; }
    else if (k === 'note') notes++;
    else if (k === 'text') { if (/[0-9０-９%％½¼¾×÷=≠+＋]/.test(e.text ?? '')) support++; else if ((e.src.size ?? 72) <= 60) notes++; else main++; }
    else if (k === 'span') main++; // 区间条是图本身（横条、时间段），算主体
    else if (k === 'chart' || k === 'shape') support++;
    else if (k === 'arrow' || k === 'line') { support++; if (e.src.label) notes++; }
  }
  return { main, support: Math.min(support, 99), notes };
}

const PLAN_TEMPLATE = `# 计划：规划者的产物。写完后 hj check → hj plan → 交用户确认 → 执行者照它画。
# 这里不写坐标，只回答“讲的是一个什么系统”。写法和完整例子见技能里的 planner.md。
# 把下面的注释去掉、填上内容（现在整份是空的，hj 会拒绝往下走）。
#
# thesis: 用一句话说出全片的结论
#
# cast:                      # 角色：这件事里的人、机构、钱、货。每个定一个固定的长相（只能是画出来的东西）
#   bank: { name: 银行, look: { doodle: bank } }
#   me:   { name: 你,   look: { figure: stand } }
#
# relations:                 # 关系：谁对谁做了什么。这是系统的骨架，每一条都要在某一段画出来
#   deposit: { from: me, to: bank, label: 存 }
#
# boards:                    # 板：一块板是一张连在一起的图。放得下就一块；放不下再分，板和板之间要有共同的东西
#   - id: main
#     picture: 这块板讲完是一张什么图（有哪几块、什么形状、怎么连）
#     hero: "100"           # 主角：讲完后观众第一眼该看到的那样东西（一条板书的原文，或一个角色的 id）
#     # layout: flow         # 版式：现成的分区（hj layouts）。写了它就不用写下面的 grid
#     grid:                  # 板面怎么分：同名的格子连成一个分区
#       rows: [1, 2, 1]      # 每一行占多高（比例），可省
#       areas:
#         - [who, who]
#         - [loop, side]
#         - [sum, sum]
#     regions:               # 每个分区放什么
#       who: 谁、往哪儿存
#       loop: 第一圈
#       side: 钱去了哪儿
#       sum: 汇总
#     segments:              # 分段：按口播的顺序，每一段往板上添什么
#       - at: "假设你存进"   # 这一段从口播的哪几个字开始（从 brief.md 的“分句卡点”里抄）
#         act: 例子          # 设问 说法 理由 例子 算账 数据 对比 转折 推翻 结论 补充
#         in: who            # 画在哪个分区
#         show: [me, bank]   # 谁出场
#         link: [deposit]    # 画哪条关系
#         # diagram: 一条 100 的横条，红色的一成和蓝色的九成     # 要画的图（不是角色的那些：横条、时间轴、柱子…）
#         # revisit: [bank]  # 回头改前面画过的谁（打叉、改数字、再连一条线）
#         words: ["100"]     # 板书：只写关键词和数字，每条不超过 10 个字
#         intent: 你把 100 块存进银行
`;

function canvasFor(c: Compiled, scale: number) { const cv = createCanvas(Math.round(c.fmt.W * scale), Math.round(c.fmt.H * scale)); return { cv, ctx: cv.getContext('2d') }; }
function sceneArg(c: Compiled): CScene | null {
  if (!flags.scene) return null;
  return c.scenes.find(s => s.id === flags.scene || String(s.index + 1) === flags.scene || s.file.includes(String(flags.scene))) ?? die(`没有叫 "${flags.scene}" 的场景。现有：${c.scenes.map(s => s.id).join(' ')}`);
}

const commands: Record<string, () => Promise<void> | void> = {
  init() {
    const usage = '用法：hj init <项目目录> --voice <配音材料目录或 alignment.json> [--format portrait|landscape] [--title 标题]\n      或：hj init <项目目录> --script <朗读稿.txt>   （还没有配音：先建项目，稿子确认后用 hj voice 配）';
    const dir = args[0] ?? die(usage);
    const voice = typeof flags.voice === 'string' ? flags.voice : null, script = typeof flags.script === 'string' ? flags.script : null;
    if (!voice && !script) die('需要 --voice（已有配音和时间表）或 --script（只有稿子，之后用 hj voice 配音）\n' + usage);
    mkdirSync(join(dir, 'voice'), { recursive: true }); mkdirSync(join(dir, 'scenes'), { recursive: true });
    let alName = 'alignment.json', audio = '';
    if (script) { if (!existsSync(script)) die(`找不到朗读稿：${script}`); writeFileSync(join(dir, 'script.txt'), readFileSync(script, 'utf8').trim() + '\n'); }
    if (voice) {
      const srcAl = existsSync(join(voice, 'alignment.json')) ? join(voice, 'alignment.json') : existsSync(join(voice, 'subtitles.srt')) ? join(voice, 'subtitles.srt') : voice;
      if (!existsSync(srcAl)) die(`找不到时间表：${srcAl}`);
      alName = /\.srt$/i.test(srcAl) ? 'subtitles.srt' : 'alignment.json';
      copyFileSync(srcAl, join(dir, 'voice', alName));
      for (const n of ['narration.wav', 'narration.mp3', 'narration.m4a']) { const f = join(existsSync(join(voice, n)) ? voice : resolve(voice, '..'), n); if (existsSync(f)) { copyFileSync(f, join(dir, 'voice', n)); audio = 'voice/' + n; break; } }
    }
    const fmt = String(flags.format ?? 'portrait');
    if (!FORMATS[fmt]) die('format 只能是 portrait 或 landscape');
    if (!existsSync(join(dir, 'project.yaml'))) writeFileSync(join(dir, 'project.yaml'), `title: ${JSON.stringify(String(flags.title ?? basename(resolve(dir))))}\nformat: ${fmt}        # portrait 竖屏 1080×1920 / landscape 横屏 1920×1080\nfps: 30\nvoice: voice/${alName}\n${audio ? `audio: ${audio}` : '# audio: voice/narration.wav   # 配音文件放进 voice/ 后取消注释'}\nsubtitles: true\nsfx: true              # 落笔音效\npen: false             # 笔：false 不显示 / marker 一支马克笔 / hand 握着笔的手\n`);
    if (!existsSync(join(dir, 'plan.yaml'))) writeFileSync(join(dir, 'plan.yaml'), PLAN_TEMPLATE);
    if (!voice) { console.log(`✓ 项目已创建：${dir}（还没有配音）\n  朗读稿：script.txt\n下一步：hj voice ${dir} 会列出朗读稿、音色和要注意的读法。把它们给用户看，用户确认稿子后才能配音（付费接口）`); return; }
    console.log(`✓ 项目已创建：${dir}\n  时间表：voice/${alName}${audio ? `\n  配音：${audio}` : '\n  （没找到配音文件，渲染出来只有落笔音效；把 narration.wav 放进 voice/ 并在 project.yaml 里填 audio）'}\n下一步（规划者）：hj brief ${dir} 通读口播和时间，然后写 ${join(dir, 'plan.yaml')}。随时运行 hj status ${dir} 看现在该谁做什么`);
  },

  brief() {
    const dir = args[0] ?? die('用法：hj brief <项目目录>');
    const meta = YAML.parse(readFileSync(join(dir, 'project.yaml'), 'utf8'));
    const al = loadAlignment(join(dir, meta.voice ?? 'voice/alignment.json'));
    const L: string[] = [`# 口播简报`, '', `总时长 ${fmtT(al.duration)}，${al.units.length} 个字/词，${al.sentences.length} 句，平均每秒 ${(al.units.length / al.duration).toFixed(1)} 字。`, '',
      '每句后面的“停顿”是到下一句开口前的空隙——转场、擦板、提前起笔都该放在停顿里。', '带 ~波浪线~ 的字时间不可靠，尽量别把卡点落在它们上面。', '', '| # | 起 | 止 | 时长 | 停顿 | 口播 |', '|--:|--:|--:|--:|--:|---|'];
    al.sentences.forEach((s, i) => {
      const gap = al.sentences[i + 1] ? al.sentences[i + 1].start - s.end : 0;
      let txt = '';
      for (let k = s.from; k < s.to; k++) { const u = al.units[k]; txt += u.shaky ? `~${u.display}~` : u.display; }
      L.push(`| ${i + 1} | ${s.start.toFixed(2)} | ${s.end.toFixed(2)} | ${(s.end - s.start).toFixed(1)}s | ${gap > 0.02 ? gap.toFixed(2) + 's' : ''} | ${txt.replace(/~~/g, '')} |`);
    });
    // 分句：按逗号、顿号再切一层，每一小句的开口时间就是现成的卡点。
    // 在整条口播里出现不止一次的词组标出来：卡点写它要加 #2，或者换一个更长、只出现一次的片段
    const plain = al.units.map(u => u.display).join('');
    const count = (w: string) => { let n = 0, i = -1; while ((i = plain.indexOf(w, i + 1)) >= 0) n++; return n; };
    L.push('', '## 分句卡点', '', '每一小句开口的时间。`卡点` 一栏是可以直接写进 `at:` 的片段（在整条口播里只出现一次）；标了“重复”的词组在口播里不止一次，写它要加 `#2`、`#3`。', '', '| 起 | 分句 | 卡点 | 重复的词组 |', '|--:|---|---|---|');
    for (const sn of al.sentences) {
      let k = sn.from;
      while (k < sn.to) {
        let e = k; while (e < sn.to && !/[，、；：,;:]$/.test(al.units[e].display)) e++;
        e = Math.min(e + 1, sn.to);
        const txt = al.units.slice(k, e).map(u => u.display).join(''), core = txt.replace(/[，。、；：？！,.;:?!“”"' ]/g, '');
        if (core) {
          let anchor = '';
          for (let n = 3; n <= core.length && !anchor; n++) { const w = core.slice(0, n); if (count(w) === 1) anchor = w; }
          const reps: string[] = [];
          for (let n = 4; n >= 3; n--) for (let i = 0; i + n <= core.length; i++) { const w = core.slice(i, i + n); if (/^[\u4e00-\u9fff\d]+$/.test(w) && count(w) > 1 && !reps.some(r => r.includes(w) || w.includes(r))) reps.push(w); }
          L.push(`| ${al.units[k].start.toFixed(2)} | ${txt} | ${anchor ? '`' + anchor + '`' : '（整句都重复，用 #2）'} | ${reps.slice(0, 4).map(r => `${r}×${count(r)}`).join('、')} |`);
        }
        k = e;
      }
    }
    const out = L.join('\n') + '\n';
    writeFileSync(join(dir, 'brief.md'), out);
    console.log(out + `\n（已写入 ${join(dir, 'brief.md')}）`);
  },

  check() {
    const dir = args[0] ?? die('用法：hj check <项目目录>');
    // 规划阶段：有计划、还没有场景文件，只查计划
    const pc = planCtx(dir);
    if (pc && !hasScenes(dir)) {
      console.log(`计划：${pc.plan.boards.length} 块板，${pc.plan.boards.reduce((n, b) => n + b.segments.length, 0)} 段，${Object.keys(pc.plan.cast).length} 个角色，${Object.keys(pc.plan.relations).length} 条关系，时长 ${fmtT(pc.duration)}，计划版本 ${pc.plan.hash}\n`);
      const r = printIssues(pc.issues), a = approvals(dir);
      console.log(`确认状态：计划 ${a.plan ? (a.plan.planHash === pc.plan.hash ? '✓ 已确认' : '✗ 确认后又改过，需重新确认') : '未确认'}。还没有场景文件：计划确认后由执行者运行 hj scaffold ${dir}`);
      if (r.errors || (flags.strict && r.warns)) process.exit(1);
      return;
    }
    const c = load(dir, false);
    console.log(`${c.scenes.length} 个场景，${c.tls.length} 个元素，时长 ${fmtT(c.duration)}，${c.plan ? `计划版本 ${c.planHash}，画面版本 ${c.keyHash}` : `分镜版本 ${c.planHash}`}\n`);
    // 每个场景的三层信息各有多少：主体（人、物）/ 支撑（数字、图表、箭头）/ 批注（小字）。哪一层是 0，哪一层就该补
    for (const sc of c.scenes) {
      const L = layers(c, sc);
      console.log(`  ${String(sc.index + 1).padStart(2)}. ${sc.id.padEnd(18)} ${fmtT(sc.t0)}–${fmtT(sc.t1)}  ${String(sc.beats.length).padStart(2)} 拍  主体 ${L.main} · 支撑 ${L.support} · 批注 ${L.notes}${L.main && L.support && L.notes ? '' : '   ← 缺一层'}`);
    }
    console.log('');
    const r = printIssues(c.issues);
    const a = approvals(dir);
    console.log(`确认状态：${c.plan ? '计划' : '文字分镜'} ${a.plan ? (a.plan.planHash === c.planHash ? '✓ 已确认' : '✗ 确认后又改过，需重新确认') : '未确认'}${c.plan ? `；全景定稿 ${a.look ? (a.look.planHash === lookHash(c) ? '✓ 已确认' : '✗ 需重新确认') : '未确认'}` : ''}；关键帧 ${a.keyframes ? (a.keyframes.planHash === c.keyHash ? '✓ 已确认' : '✗ 需重新确认') : '未确认'}`);
    if (r.errors || (flags.strict && r.warns)) process.exit(1); // --strict：有警告也算失败（给 CI 用）
  },

  plan() {
    const dir = args[0] ?? die('用法：hj plan <项目目录>');
    const pc = planCtx(dir);
    if (pc) {
      // 有计划：分镜表由计划排出来，这时候不需要、也不看任何场景文件
      if (pc.issues.some(i => i.level === 'error')) { printIssues(pc.issues); die('计划有错误，先修掉再生成分镜表（hj check 可随时重查）'); }
      writeFileSync(join(dir, 'storyboard.md'), planStoryboard(pc.plan, pc.meta, pc.al, pc.fmt, pc.duration, pc.issues));
      const w = pc.issues.filter(i => i.level === 'warn').length;
      console.log(`✓ 分镜计划已生成：${join(dir, 'storyboard.md')}（计划版本 ${pc.plan.hash}）`);
      if (w) console.log(`  注意：还有 ${w} 个警告，已经原样写进了分镜计划的末尾。交给用户之前最好处理掉，或向用户说明。`);
      // 审片页：结构草图 + 分段表。计划这一步也要让用户看到图
      return (async () => {
        const { plan } = pc, code = confirmCode('plan', plan.hash), { times } = segmentTimes(plan, pc.al, pc.duration), nm = (id: string) => plan.cast[id]?.name ?? id;
        const sketches = plan.boards.map(b => planSketch(plan, b, pc.fmt, dir)), blocks: ReviewBlock[] = [];
        blocks.push({ heading: '这条片子讲的是什么', html: `<p><b>论点：</b>${esc(plan.thesis)}</p><p><b>角色：</b>${Object.values(plan.cast).map(c => esc(c.name)).join('、')}</p><p><b>关系（这件事的骨架）：</b>${Object.values(plan.relations).map(r => `${esc(nm(r.from))} →${r.label ? ` ${esc(r.label)} →` : ''} ${esc(nm(r.to))}`).join('；') || '（没有）'}</p>` });
        for (const [bi, b] of plan.boards.entries()) {
          const ts = times.filter(t => t.board === bi);
          const rows = b.segments.map((s, si) => { const t = ts[si], say = Number.isFinite(t?.t0) ? pc.al.units.filter(u => u.start >= t.t0 - 1e-6 && u.start < t.t1 - 1e-6).map(u => u.display).join('') : ''; const what = [s.show.length ? `出场：${s.show.map(nm).join('、')}` : '', s.link.length ? `连线：${s.link.map(id => { const r = plan.relations[id]; return r ? `${nm(r.from)}→${nm(r.to)}` : id; }).join('、')}` : '', s.diagram ? `图：${s.diagram}` : '', s.revisit.length ? `回头改：${s.revisit.map(nm).join('、')}` : '', s.joins.length ? `连到分区：${s.joins.join('、')}` : ''].filter(Boolean).join('；'); return `<tr><td>${si + 1}</td><td>${Number.isFinite(t?.t0) ? fmtT(Math.max(0, t.t0)) : '?'}</td><td>${esc(say)}</td><td>${esc(s.in ?? '')}</td><td>${esc(s.intent)}${what ? `<br><span style="color:var(--dim)">${esc(what)}</span>` : ''}</td><td>${esc(s.words.join('、'))}</td></tr>`; }).join('');
          blocks.push({ heading: `${plan.boards.length > 1 ? `第 ${bi + 1} 块板：` : '这块板：'}${b.id}`, note: `讲完是一张什么图：${b.picture}${b.hero ? `　主角（第一眼看到的）：${plan.cast[b.hero]?.name ?? b.hero}` : ''}${b.layout && LAYOUTS[b.layout] ? `　版式：${LAYOUTS[b.layout].title}` : ''}`, images: [{ src: await jpeg(sketches[bi], 88), caption: '结构草图', sub: '只表示谁在哪一区、谁连着谁、主角是谁。横条、图表这些“图”还没画，位置和大小也不是最后的样子。', wide: true }], html: `<div class="scroll"><table><tr><th>#</th><th>时间</th><th>口播</th><th>分区</th><th>画面上发生什么</th><th>板书</th></tr>${rows}</table></div>` });
        }
        const hero = plan.boards.map(b => (b.hero ? plan.cast[b.hero]?.name ?? `“${b.hero}”` : '')).filter(Boolean).join('、');
        await writeReview(dir, { title: String(pc.meta.title ?? '未命名'), stage: 'plan', code, hash: plan.hash, step: 2, steps: STEPS,
          lead: '动笔之前，先确认这条片子讲的是一个什么系统。这一步定的是结构：有哪些东西、怎么连、分成哪几块、谁是主角。改这些现在最便宜。',
          questions: [{ q: `结论是不是这一句：“${plan.thesis}”？`, fallback: '就按这一句' }, { q: '角色和它们之间的连线，是不是这件事的骨架？有没有缺的、多的、连错的？', fallback: '按草图上的来' }, { q: hero ? `讲完之后观众第一眼该看到的是 ${hero}，对吗？` : '每块板怎么分区、每一段画在哪儿，有没有不合理的？', fallback: hero ? '就让它最显眼' : '按表里的来' }],
          blocks, warnings: pc.issues.filter(i => i.level === 'warn').map(i => `${i.where}：${i.msg}`) }, await stackSheet(`分镜计划 · ${String(pc.meta.title ?? '')}`, code, sketches));
        console.log(`  分段表在 ${join(dir, 'storyboard.md')}，审片页里也有。用户同意之前，不出正式的图、不渲染。`);
      })();
    }
    const c = load(dir);
    const warns = c.issues.filter(i => i.level === 'warn');
    writeFileSync(join(dir, 'storyboard.md'), planMarkdown(c));
    console.log(`✓ 文字分镜表已生成：${join(dir, 'storyboard.md')}（分镜版本 ${c.planHash}）`);
    if (warns.length) console.log(`  注意：还有 ${warns.length} 个警告（hj check 查看）。交给用户之前最好处理掉，或向用户说明。`);
    console.log('把这份分镜表交给用户确认。用户同意之前不要出图、不要渲染。');
  },

  approve() {
    const dir = args[0], stage = args[1] as Stage | 'script';
    if (!dir || !['script', 'plan', 'look', 'keyframes'].includes(stage) || typeof flags.by !== 'string') die('用法：hj approve <项目目录> script|plan|look|keyframes --by "<用户的确认原话>"\n只有在用户明确表示同意之后才能运行。plan、look、keyframes 三道要用户看过图：原话里要带着图上的四位确认码。');
    const by = String(flags.by);
    if (stage === 'script') {
      // 朗读稿：用户确认的是这一版稿子的每一个字。改一个字就要重新确认
      const sf = join(dir, 'script.txt'); if (!existsSync(sf)) die(`没有朗读稿 ${sf}`);
      const a0 = approvals(dir), h = scriptHash(readFileSync(sf, 'utf8'));
      a0.script = { planHash: h, by, at: new Date().toISOString() };
      writeFileSync(approvalsFile(dir), JSON.stringify(a0, null, 2) + '\n');
      console.log(`✓ 已记录用户对朗读稿的确认（稿子版本 ${h}）。下一步：hj voice ${dir}`);
      return;
    }
    const a = approvals(dir), pc = stage === 'plan' ? planCtx(dir) : null;
    let hash: string, planned = !!pc;
    if (pc) { if (pc.issues.some(i => i.level === 'error')) { printIssues(pc.issues); die('计划有错误，不能确认'); } hash = pc.plan.hash; }
    else {
      const c = load(dir); planned = !!c.plan;
      if (stage === 'look' && !c.plan) die('这个项目没有 plan.yaml（老写法），没有“全景定稿”这一道：确认 plan 和 keyframes 两道即可');
      if (stage !== 'plan') gate(c, 'plan');
      if (stage === 'keyframes' && c.plan) gate(c, 'look');
      hash = hashOf(c, stage);
    }
    // 有图的三道：这一版的审片页要先生成出来，用户的原话里要带着图上的确认码
    if (planned || stage === 'keyframes') {
      const cmd = stage === 'plan' ? 'plan' : stage === 'look' ? 'look' : 'stills', rf = join(dir, 'out', 'review', `${stage}.json`);
      const seen = existsSync(rf) ? JSON.parse(readFileSync(rf, 'utf8')) : null;
      if (seen?.hash !== hash) die(`${seen ? `审片页是旧的（它是 ${seen.hash} 那一版，现在是 ${hash}）` : '这一版还没有生成审片页'}，用户不可能看过现在这一版。\n  先运行 hj ${cmd} ${dir}，把 ${join(dir, 'out', 'review', stage + '.png')} 发给用户看，再来确认。`);
      const code = confirmCode(stage, hash);
      if (!hasCode(by, code)) die(`用户的原话里没有确认码。\n  确认码是四位数，印在 ${join(dir, 'out', 'review', stage + '.png')}（和 ${stage}.html）上。它的用处是保证用户真的看到了图：\n  把那张图发给用户（作为图片 / 文件，不是路径），请用户看图后回复“确认 <四位数>”，再把用户的原话原样写进 --by。\n  不要自己从图里读出码来替用户填。用户说了“可以”但没带码，就请他看一眼图上的码。`);
    }
    a[stage] = { planHash: hash, by, at: new Date().toISOString() };
    writeFileSync(approvalsFile(dir), JSON.stringify(a, null, 2) + '\n');
    const next = stage === 'plan' ? (pc ? `执行者运行 hj scaffold ${dir}，照计划把场景画出来` : `hj stills ${dir}`) : stage === 'look' ? `hj stills ${dir} 出逐拍的关键帧，交给用户确认` : `hj render ${dir}`;
    console.log(`✓ 已记录用户对${stage === 'plan' ? (pc ? '分镜计划' : '文字分镜') : STAGE_NAME[stage]}的确认（版本 ${hash}）。下一步：${next}`);
  },

  // 全景定稿：每块板讲完时的全景。在逐拍的关键帧之前，先让用户确认构图和审美
  async look() {
    const dir = args[0] ?? die('用法：hj look <项目目录>   出全景定稿的审片页（每块板讲完时的全景）→ 交用户确认');
    const c = load(dir); await preload(c);
    const plan = c.plan ?? die('这个项目没有 plan.yaml（老写法），没有“全景定稿”这一道');
    gate(c, 'plan');
    const hash = lookHash(c), code = confirmCode('look', hash), blocks: ReviewBlock[] = [], parts: any[] = [];
    for (const sc of c.scenes) {
      const { cv, ctx } = canvasFor(c, 0.6); fullView(c, sc, ctx, 0.6);
      const sq = squintOf(cv), b = plan.boards.find(p => p.id === sc.id), top = heaviest(c, sc), hero = b?.hero ? plan.cast[b.hero]?.name ?? `“${b.hero}”` : '';
      const texts = c.tls.filter(t => t.scene === sc.index && (t.drawT0 != null || t.appear) && ['text', 'note'].includes(t.el.kind) && !(t.gone != null && t.gone < sc.t1 - 0.3));
      const sizes = [...new Set(texts.map(t => +(t.el.src.size ?? (t.el.kind === 'note' ? 46 : 72))))].sort((p, q) => q - p), reds = texts.filter(t => t.el.src.color === 'red').length;
      blocks.push({ heading: `${c.scenes.length > 1 ? `第 ${sc.index + 1} 块板：` : ''}${sc.id} 讲完时的全景`, note: b ? `计划里这块板是：${b.picture}` : '',
        html: `<div class="pair"><figure><img src="${await jpeg(cv, 88)}" alt="全景"><figcaption><b>全景</b><span>最下面约五分之一留给字幕，空着是对的。</span></figcaption></figure><figure><img src="${await jpeg(sq, 80)}" alt="眯眼图"><figcaption><b>眯眼看</b><span>字都糊掉，只剩轻重。最显眼的那一团，应该就是${hero || '结论'}。</span></figcaption></figure></div>
<table><tr><th>主角</th><td>${esc(hero || '计划里没有指定')}</td></tr><tr><th>一眼最重的三样</th><td>${esc(top.join('、'))}</td></tr><tr><th>字号</th><td>${sizes.length} 档（${sizes.join('、')}）</td></tr><tr><th>红字</th><td>${reds} 处</td></tr></table>` });
      parts.push(cv);
    }
    const heroes = plan.boards.map(b => (b.hero ? plan.cast[b.hero]?.name ?? `“${b.hero}”` : '')).filter(Boolean).join('、');
    await writeReview(dir, { title: String(c.meta.title ?? '未命名'), stage: 'look', code, hash, step: 3, steps: STEPS,
      lead: '这是每块板讲完时的样子。这一步定的是构图和审美：先看哪儿、挤不挤、好不好看。过程（每一拍怎么画出来）下一步再看。',
      questions: [{ q: heroes ? `第一眼看到的是不是 ${heroes}？` : '第一眼看到的，是不是这条片子的结论？', fallback: '是，主次没问题' }, { q: '有没有哪一块太挤、太空、歪了，或者看不懂是什么？', fallback: '没有' }, { q: '大小、颜色、角色的长相，有没有想换的？', fallback: '不换' }],
      blocks, warnings: c.issues.filter(i => i.level === 'warn').map(i => `${i.where}：${i.msg}`) }, await stackSheet(`全景定稿 · ${String(c.meta.title ?? '')}`, code, parts));
  },

  layouts() {
    console.log('版式：现成的分区方案。在 plan.yaml 的板里写 layout: 名字，就不用写 grid；分区名是固定的，segments 的 in 写它们。\n');
    for (const [k, v] of Object.entries(LAYOUTS)) {
      if (args[0] && args[0] !== k) continue;
      console.log(`■ ${k}  ${v.title}\n  什么时候用：${v.when}\n  靠什么连：${v.link}\n  分区：${Object.entries(v.regions).map(([n, d]) => `${n}（${d}）`).join('  ')}`);
      for (const [fn, g] of [['竖屏', v.portrait], ['横屏', v.landscape]] as const) console.log(`  ${fn}：\n${g.areas.map(r => '    ' + r.map(n => `[ ${n.padEnd(5)}]`).join('')).join('\n')}`);
      console.log('');
    }
    if (args[0] && !LAYOUTS[args[0]]) die(`没有叫 "${args[0]}" 的版式。可用：${Object.keys(LAYOUTS).join(' ')}`);
    console.log('都不合适就自己写 grid（rows / cols / areas）。');
  },

  // 配音：火山引擎豆包语音合成。付费接口：用户确认过这一版朗读稿才调用，不自动重试
  async voice() {
    if (flags.voices) { console.log('edge-tts 的音色（免费）。语速和音高不写时用表里的默认值：按这个语速，成片大约每秒 4.1–4.3 个字，画得过来\n'); for (const [id, v] of Object.entries(EDGE_VOICES)) console.log(`  ${id.padEnd(34)} ${v.name}　默认 ${v.rate} ${v.pitch}　${v.note}`); console.log(`\n火山引擎（付费）默认音色：${DEFAULT_SPEAKER}`); return; }
    const dir = args[0] ?? die('用法：hj voice <项目目录> [--engine volc|edge] [--speaker 音色id] [--rate 语速] [--pitch 音高] [--redo]\n  volc：火山引擎豆包语音（付费，默认）。--rate 是 -50..100 的整数\n  edge：edge-tts（免费）。--rate 形如 +8%，--pitch 形如 -4Hz；hj voice --voices 列出音色');
    const sf = join(dir, 'script.txt'), pf = join(dir, 'project.yaml');
    if (!existsSync(pf)) die(`${dir} 还不是一个项目。先运行 hj init ${dir} --script <朗读稿.txt>`);
    if (!existsSync(sf)) die(`没有朗读稿 ${sf}。把要读出来的字（不是屏幕上显示的字）写进去，UTF-8`);
    const engine = String(flags.engine ?? 'volc');
    if (!['volc', 'edge'].includes(engine)) die('--engine 只能是 volc（火山引擎，付费）或 edge（edge-tts，免费）');
    const text = readFileSync(sf, 'utf8').trim(), h = scriptHash(text), a = approvals(dir), paid = engine === 'volc';
    const speaker = typeof flags.speaker === 'string' ? flags.speaker : paid ? DEFAULT_SPEAKER : DEFAULT_EDGE_VOICE;
    const rate = paid ? (flags.rate != null ? Number(flags.rate) : 0) : typeof flags.rate === 'string' ? flags.rate : EDGE_VOICES[speaker]?.rate ?? '+0%';
    const pitch = paid ? '' : typeof flags.pitch === 'string' ? flags.pitch : EDGE_VOICES[speaker]?.pitch ?? '+0Hz';
    if (paid && (!Number.isInteger(rate) || (rate as number) < -50 || (rate as number) > 100)) die('火山引擎的 --rate 是 -50 到 100 的整数：0 原速，100 约两倍速');
    if (!paid && (!/^[+-]\d+%$/.test(String(rate)) || !/^[+-]\d+Hz$/.test(pitch))) die('edge 的 --rate 写成 +8% 这样（带正负号和百分号），--pitch 写成 -4Hz 这样');
    if (!paid && Math.abs(parseInt(pitch)) > 15) die('音高调整超过 ±15Hz 会有明显的变声器失真');
    const chars = text.replace(/[\s\p{P}]/gu, '').length, warns = scriptWarnings(text);
    const summary = `朗读稿（${sf}，${chars} 个字，按每秒 4 个字估约 ${Math.round(chars / 4)} 秒，稿子版本 ${h}）：\n\n${text.split('\n').map(l => '  ' + l).join('\n')}\n\n引擎：${paid ? '火山引擎（付费）' : 'edge-tts（免费）'}　音色：${speaker}${paid ? (rate ? `，语速 ${rate}` : '') : `，语速 ${rate}，音高 ${pitch}`}\n${warns.map(w => `! ${w}`).join('\n')}${warns.length ? '\n' : ''}`;
    // 付费引擎：用户确认过这一版稿子才调用。免费引擎不拦，但稿子的读法问题照样列出来
    if (paid && a.script?.planHash !== h) { console.log(summary); die(`${a.script ? '朗读稿在用户确认之后改过了，要重新确认。' : '这一版朗读稿还没有得到用户确认。'}火山引擎是付费接口，每次调用都花钱。\n  把上面的朗读稿全文、音色${warns.length ? '和带 ! 的读法问题' : ''}给用户看；用户明确同意后运行 hj approve ${dir} script --by "<用户的确认原话>"，再运行 hj voice ${dir}。\n  给密钥、说“继续”、批准大纲，都不等于确认了这一版稿子。\n  想先免费听个大概：hj voice ${dir} --engine edge（edge-tts，不需要密钥和确认）`); }
    const key = (process.env[KEY_ENV] ?? '').trim();
    if (paid && !key) die(`没有配置火山引擎的密钥。请用户自己在终端里设置环境变量（不要让用户把密钥贴进对话，也不要把它写进任何文件或命令行参数）：\n  export ${KEY_ENV}=<API Key>\n密钥在火山引擎控制台的“豆包语音”里创建，需要开通语音合成大模型（seed-tts-2.0）。配好之后重新运行 hj voice ${dir}\n  不想付费：hj voice ${dir} --engine edge（edge-tts，免费，不需要密钥）`);
    const metaF = join(dir, 'voice', 'metadata.json');
    if (paid && existsSync(metaF) && !flags.redo) { const m = JSON.parse(readFileSync(metaF, 'utf8')); if (m.provider === 'volcengine' && m.script_hash === h && m.speaker === speaker && (m.speech_rate ?? 0) === rate) die(`这一版稿子已经用同样的音色和语速配过了（${join(dir, 'voice', 'narration.wav')}，${Number(m.duration_seconds).toFixed(1)} 秒）。再配一次要再花一次钱：确实要重配加 --redo`); }
    if (!paid && warns.length) console.log(warns.map(w => `! ${w}`).join('\n'));
    const runs = join(dir, 'voice', 'runs'); mkdirSync(runs, { recursive: true });
    const out = join(runs, String(readdirSync(runs).length + 1).padStart(3, '0'));
    console.log(`开始配音（${paid ? '火山引擎' : 'edge-tts'}，${chars} 个字，音色 ${speaker}）…`);
    let r;
    try {
      r = paid
        ? await synthesize({ text, key, outDir: out, speaker, speechRate: rate as number, ...(typeof flags.context === 'string' ? { context: flags.context } : {}), ...(typeof flags.resource === 'string' ? { resource: flags.resource } : {}), ...(process.env.HJ_TTS_ENDPOINT ? { endpoint: process.env.HJ_TTS_ENDPOINT } : {}) })
        : await synthesizeEdge({ text, outDir: out, voice: speaker, rate: String(rate), pitch });
    } catch (e: any) { return die(`配音失败：${e.message}${paid ? `\n  没有自动重试。这次的记录在 ${out}/events.jsonl` : ''}`); }
    for (const f of ['narration.wav', 'alignment.json', 'metadata.json']) copyFileSync(join(out, f), join(dir, 'voice', f));
    // 项目设置里指到这条配音
    let py = readFileSync(pf, 'utf8');
    if (!/^audio:/m.test(py)) py = /^# audio:.*$/m.test(py) ? py.replace(/^# audio:.*$/m, 'audio: voice/narration.wav') : py.trimEnd() + '\naudio: voice/narration.wav\n';
    py = /^voice:/m.test(py) ? py.replace(/^voice:.*$/m, 'voice: voice/alignment.json') : py.trimEnd() + '\nvoice: voice/alignment.json\n';
    writeFileSync(pf, py);
    const cps = chars / r.duration;
    console.log(`✓ 配音完成：${join(dir, 'voice', 'narration.wav')}（${r.duration.toFixed(1)} 秒，每秒 ${cps.toFixed(1)} 个字，${r.units} 个字词${r.shaky ? `，其中 ${r.shaky} 个时间不可靠，hj brief 里用 ~波浪线~ 标出，卡点别落在它们上面` : ''}）${cps > 4.7 ? '\n  ! 语速偏快（每秒 4.7 个字以上，画面会被迫快进）：把语速调低一点重配' : ''}\n  先让用户听一遍。之后不要对音频做任何剪切、变速、去静音：时间表会失效。\n下一步：hj brief ${dir}`);
  },

  // 由计划生成场景骨架：每块板一个文件，角色、关系、板书和每一段的节拍都列好
  scaffold() {
    const dir = args[0] ?? die('用法：hj scaffold <项目目录> [--force]');
    const pc = planCtx(dir) ?? die('这个项目没有 plan.yaml。骨架是照计划生成的：先由规划者写计划');
    if (pc.issues.some(i => i.level === 'error')) { printIssues(pc.issues); die('计划有错误，先请规划者修掉'); }
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    const existing = readdirSync(join(dir, 'scenes')).filter(f => /\.ya?ml$/.test(f));
    pc.plan.boards.forEach((b, i) => {
      const had = existing.find(f => f.replace(/\.ya?ml$/, '').replace(/^\d+[-_]?/, '') === b.id), f = join(dir, 'scenes', had ?? `${String(i + 1).padStart(2, '0')}-${b.id}.yaml`);
      if (had && !flags.force) { console.log(`· 已有 ${f}，没有动它（要重新生成加 --force，会覆盖）`); return; }
      writeFileSync(f, scaffold(pc.plan, b, pc.fmt, pc.al, pc.duration));
      console.log(`✓ ${f}`);
    });
    console.log(`骨架里每样东西都还没摆位置。下一步：hj layout ${dir} 看落点 → 改场景文件 → hj check ${dir} → hj stills ${dir} --draft 看图`);
  },

  // 现在轮到谁、下一步做什么
  status() {
    const dir = args[0] ?? die('用法：hj status <项目目录>');
    if (!existsSync(join(dir, 'project.yaml'))) die(`${dir} 还不是一个项目。先运行 hj init ${dir} --voice <配音材料目录>`);
    const say = (role: string, what: string) => console.log(`现在轮到：${role}\n下一步：${what}`);
    { const m = YAML.parse(readFileSync(join(dir, 'project.yaml'), 'utf8')) ?? {}; if (!existsSync(join(dir, m.voice ?? 'voice/alignment.json'))) return say('配音', existsSync(join(dir, 'script.txt')) ? `还没有配音。运行 hj voice ${dir}：它会列出朗读稿和音色，给用户确认后再配（付费接口）。` : `还没有配音和时间表。把朗读稿写进 ${join(dir, 'script.txt')} 再运行 hj voice ${dir}；或把已有的配音材料（narration.wav + alignment.json）放进 ${join(dir, 'voice')}/。`); }
    if (!existsSync(join(dir, 'plan.yaml'))) { console.log('这个项目没有 plan.yaml（不走计划的老写法）。'); const c = load(dir, false), a = approvals(dir); printIssues(c.issues); console.log(`确认状态：文字分镜 ${a.plan?.planHash === c.planHash ? '✓' : '未确认'}；关键帧 ${a.keyframes?.planHash === c.keyHash ? '✓' : '未确认'}`); return; }
    let plan: Plan | null = null;
    try { plan = loadPlan(dir); } catch (e: any) { return say('规划者', `${e.message}\n  先运行 hj brief ${dir} 通读口播。`); }
    const pc = planCtx(dir)!, a = approvals(dir), pe = pc.issues.filter(i => i.level === 'error').length, pw = pc.issues.filter(i => i.level === 'warn').length;
    if (pe) return say('规划者', `计划有 ${pe} 个错误。运行 hj check ${dir} 看是哪些，修掉。`);
    if (!a.plan || a.plan.planHash !== plan!.hash) return say('规划者', `${a.plan ? '计划在用户确认之后又改过，需要重新确认。' : ''}${pw ? `计划还有 ${pw} 个警告（hj check ${dir}），先修掉或准备好向用户说明。` : ''}运行 hj plan ${dir}，把审片页（out/review/plan.png 或 plan.html）发给用户看；用户看图回复确认码后运行 hj approve ${dir} plan --by "<用户原话>"。`);
    if (!hasScenes(dir)) return say('执行者', `计划已确认。运行 hj scaffold ${dir} 生成场景骨架，然后照 executor.md 把每块板画完。`);
    const c = load(dir, false), ce = c.issues.filter(i => i.level === 'error').length, cw = c.issues.filter(i => i.level === 'warn').length;
    if (ce) return say('执行者', `场景有 ${ce} 个错误。运行 hj check ${dir} 看是哪些，修掉。`);
    if (!a.look || a.look.planHash !== lookHash(c)) return say('执行者', `${a.look ? '全景定稿确认之后，板上的东西又变了，需要重新确认。' : ''}${cw ? `还有 ${cw} 个警告（hj check ${dir}）：修掉，或准备好向用户说明。` : ''}先 hj stills ${dir} --draft 自己逐张看、改到满意；再 hj look ${dir} 出全景定稿的审片页，把图发给用户；用户看图回复确认码后运行 hj approve ${dir} look --by "<用户原话>"。`);
    if (!a.keyframes || a.keyframes.planHash !== c.keyHash) return say('执行者', `全景定稿已确认。${cw ? `还有 ${cw} 个警告（hj check ${dir}）：修掉，或准备好向用户说明。` : ''}运行 hj stills ${dir} 出逐拍的关键帧和审片页，把图发给用户；用户看图回复确认码后运行 hj approve ${dir} keyframes --by "<用户原话>"。`);
    say('执行者', `关键帧已确认。hj render ${dir} 出成片（out/video.mp4）；需要封面再 hj cover ${dir}。`);
  },

  // 布局线框：不画任何笔画，只把每个元素最后落在哪儿画成方框。写分镜时随时看，不需要用户确认
  async layout() {
    const dir = args[0] ?? die('用法：hj layout <项目目录> [--scene 场景]');
    const c = load(dir, false);
    const out = join(dir, 'out', 'layout'); mkdirSync(out, { recursive: true });
    const only = sceneArg(c), B = (only ?? c.scenes[0])?.board ?? c.fmt.board, k = 0.6, M = 30;
    const COL: Record<string, string> = { figure: '#2f6fb7', doodle: '#2f6fb7', icon: '#2f6fb7', parts: '#2f6fb7', text: '#3c8f4f', note: '#8a8580', shape: '#7556c2', chart: '#7556c2', mark: '#d9433a', arrow: '#e8792b', line: '#e8792b' };
    for (const sc of c.scenes) {
      if (only && sc !== only) continue;
      const shown = c.tls.filter(t => t.scene === sc.index && (t.drawT0 != null || t.appear));
      const cv = createCanvas(Math.round(B.w * k) + M * 2, Math.round(B.h * k) + M * 2), x = cv.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, cv.width, cv.height);
      x.strokeStyle = '#212529'; x.lineWidth = 2; x.setLineDash([8, 6]); x.strokeRect(M, M, B.w * k, B.h * k); x.setLineDash([]);
      const flagged = new Set(c.issues.filter(i => i.level !== 'info' && i.where.startsWith(sc.file + ' / 元素 ')).map(i => i.where.split('元素 ')[1]));
      const label = (txt: string, px: number, py: number, col: string) => { const t = textStrokes(txt, { size: 17, color: col }); x.save(); x.translate(px, py); drawStrokes(x, env, t.strokes); x.restore(); };
      // 分区：浅色底加名字，核对每样东西落在了哪一块
      for (const rg of sc.regions ?? []) {
        x.fillStyle = 'rgba(242,184,48,0.10)'; x.fillRect(M + rg.box.x * k, M + rg.box.y * k, rg.box.w * k, rg.box.h * k);
        x.strokeStyle = '#c9a227'; x.lineWidth = 1.5; x.setLineDash([4, 5]); x.strokeRect(M + rg.box.x * k, M + rg.box.y * k, rg.box.w * k, rg.box.h * k); x.setLineDash([]);
        label(rg.name, M + (rg.box.x + rg.box.w) * k - rg.name.length * 11 - 8, M + rg.box.y * k + 4, '#a07d00');
      }
      console.log(`\n■ ${sc.index + 1}. ${sc.id}（画板 ${B.w}×${B.h}，坐标是元素的外框）`);
      if (sc.regions?.length) console.log('  分区：' + sc.regions.map(rg => `${rg.name} [${rg.box.x.toFixed(0)}, ${rg.box.y.toFixed(0)}, ${rg.box.w.toFixed(0)}, ${rg.box.h.toFixed(0)}]`).join('  '));
      for (const t of shown) {
        const e = t.el, b = e.kind === 'note' ? e.solid : e.box, gone = t.gone != null && t.gone < sc.t1 - 0.7, mv = t.moves.length ? t.moves[t.moves.length - 1].to : [0, 0];
        const bx = M + (b.x + mv[0]) * k, by = M + (b.y + mv[1]) * k;
        x.globalAlpha = gone ? 0.3 : 1; x.strokeStyle = COL[e.kind] ?? '#000'; x.lineWidth = flagged.has(e.id) ? 4 : 1.5;
        if (e.kind === 'arrow' || e.kind === 'line') { if (e.path) { x.beginPath(); x.moveTo(M + e.path[0] * k, M + e.path[1] * k); for (let i = 2; i < e.path.length; i += 2) x.lineTo(M + e.path[i] * k, M + e.path[i + 1] * k); x.stroke(); } }
        else { if (e.kind === 'mark') x.setLineDash([4, 4]); if (flagged.has(e.id)) { x.fillStyle = 'rgba(217,67,58,0.12)'; x.fillRect(bx, by, b.w * k, b.h * k); } x.strokeRect(bx, by, b.w * k, b.h * k); x.setLineDash([]); }
        if (e.nudged && Math.hypot(e.nudged[0], e.nudged[1]) > 30) { x.strokeStyle = '#e8792b'; x.lineWidth = 2; x.setLineDash([3, 3]); x.strokeRect(bx - e.nudged[0] * k, by - e.nudged[1] * k, b.w * k, b.h * k); x.beginPath(); x.moveTo(bx - e.nudged[0] * k + b.w * k / 2, by - e.nudged[1] * k + b.h * k / 2); x.lineTo(bx + b.w * k / 2, by + b.h * k / 2); x.stroke(); x.setLineDash([]); }
        if (e.kind !== 'arrow' && e.kind !== 'line' && e.kind !== 'mark') label(e.id.slice(0, 14), bx + 3, by + 2, COL[e.kind] ?? '#000');
        x.globalAlpha = 1;
        console.log(`  ${e.id.padEnd(12)} ${e.kind.padEnd(7)} x ${String(Math.round(b.x + mv[0])).padStart(4)}…${String(Math.round(b.x + mv[0] + b.w)).padEnd(4)} y ${String(Math.round(b.y + mv[1])).padStart(4)}…${String(Math.round(b.y + mv[1] + b.h)).padEnd(4)}${e.text ? ' “' + e.text.replace(/\n/g, '/') + '”' : ''}${gone ? '  （中途擦掉）' : ''}${t.recalled ? '  （沿用）' : ''}${e.nudged && Math.hypot(e.nudged[0], e.nudged[1]) > 30 ? `  ← 被挪了 (${e.nudged[0].toFixed(0)}, ${e.nudged[1].toFixed(0)})` : ''}${e.snapped ? `  ← 已吸附对齐 (${e.snapped[0].toFixed(0)}, ${e.snapped[1].toFixed(0)})` : ''}${flagged.has(e.id) ? '  ← 有警告' : ''}`);
      }
      // 占用图：一眼看出哪儿挤、哪儿空
      const cols = 24, rows = Math.round(cols * B.h / B.w / 2), live = shown.filter(t => !(t.gone != null && t.gone < sc.t1 - 0.7) && !['mark', 'arrow', 'line'].includes(t.el.kind));
      let filled = 0; const map: string[] = [];
      for (let r0 = 0; r0 < rows; r0++) { let ln = ''; for (let c0 = 0; c0 < cols; c0++) { const cx = (c0 + 0.5) * B.w / cols, cy = (r0 + 0.5) * B.h / rows; const n = live.filter(t => { const b = t.el.solid; return cx >= b.x - 12 && cx <= b.x + b.w + 12 && cy >= b.y - 12 && cy <= b.y + b.h + 12; }).length; if (n) filled++; ln += n > 1 ? '▓' : n ? '█' : '·'; } map.push('    ' + ln); }
      console.log(`  场景结束时的占用（█ 有东西，▓ 叠着，· 空）：占了 ${Math.round(filled / (rows * cols) * 100)}%\n${map.join('\n')}`);
      const f = `${String(sc.index + 1).padStart(2, '0')}-${sc.id}.png`;
      writeFileSync(join(out, f), await cv.encode('png'));
    }
    console.log(`\n✓ 线框图已输出到 ${out}（蓝=人和物 绿=文字 灰=批注 紫=形状 红虚线=标记 橙=箭头和连线；粗红框=有警告；橙色虚框=被引擎挪走前的位置）\n这不是画面，只是位置。它不需要用户确认，写分镜时随时跑。`);
  },

  async stills() {
    const dir = args[0] ?? die('用法：hj stills <项目目录> [--draft] [--scene 场景] [--at 秒数或口播片段] [--guides]');
    const c = load(dir); await preload(c);
    // --draft：给写分镜的人自己看的草稿。半分辨率、打水印、单独存放，不需要确认，也不能当作交付
    const draft = !!flags.draft, sc0 = draft ? 0.5 : 1;
    if (!draft) { gate(c, 'plan'); if (c.plan) gate(c, 'look'); }
    const out = join(dir, 'out', draft ? 'draft' : 'stills'); mkdirSync(out, { recursive: true });
    const { cv, ctx } = canvasFor(c, sc0);
    const stamp = draft ? textStrokes('草稿 · 未确认', { size: 54, color: '#d9433a' }) : null;
    const frame = (t: number, o: { pen: boolean | 'marker' | 'hand'; guides?: boolean }) => {
      drawFrame(ctx, c, t, env, { scale: sc0, subtitles: true, ...o });
      if (stamp) for (const [fx, fy] of [[0.5, 0.045], [0.5, 0.93]]) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.6; ctx.translate(cv.width * fx - (stamp.w * 0.7) / 2, cv.height * fy); ctx.scale(0.7, 0.7); drawStrokes(ctx, env, stamp.strokes); ctx.restore(); }
    };
    const shot = async (t: number, name: string) => { frame(t, { pen: penOpt(c), guides: !!flags.guides }); writeFileSync(join(out, name), await cv.encode('png')); };
    if (flags.at != null) {
      const t = /^[\d.]+$/.test(String(flags.at)) ? +flags.at : resolveAnchor(c.al, String(flags.at)).time;
      await shot(t, `at-${t.toFixed(2)}.png`);
      console.log(`✓ ${join(out, `at-${t.toFixed(2)}.png`)}  （${fmtT(t)}）`);
      return;
    }
    const only = sceneArg(c);
    if (!only) for (const f of readdirSync(out)) if (/^(\d+-|sheet-)/.test(f)) rmSync(join(out, f));
    const sheets: string[] = [], sheetCvs: any[] = [], rblocks: ReviewBlock[] = [];
    for (const sc of c.scenes) {
      if (only && sc !== only) continue;
      const tiles: { t: number; label: string; file: string }[] = [];
      for (let bi = 0; bi < sc.beats.length; bi++) {
        const b = sc.beats[bi];
        const end = Math.max(b.t + 0.05, ...b.actions.map(a => a.t1));
        // 取这一拍“画完之后、下一拍之前”的一刻；场景最后一拍要避开转场镜头
        const cap = bi === sc.beats.length - 1 && c.scenes[sc.index + 1] ? sc.t1 - 0.7 : b.tEnd - 0.03;
        const t = Math.min(Math.max(b.t + 0.05, cap, Math.min(end + 0.03, sc.t1 - 0.7)), c.duration - 0.01);
        const file = `${String(sc.index + 1).padStart(2, '0')}-${sc.id}-${String(bi + 1).padStart(2, '0')}.png`;
        await shot(t, file);
        tiles.push({ t, label: `${sc.index + 1}.${bi + 1}  ${fmtT(t)}`, file });
      }
      if (!tiles.length) continue;
      // 联系表：一个场景一张，方便一眼看完
      const k = c.fmt.name === 'portrait' ? 0.3 : 0.34, cols = Math.min(tiles.length, c.fmt.name === 'portrait' ? 5 : 3), rows = Math.ceil(tiles.length / cols);
      const tw = Math.round(c.fmt.W * k), th = Math.round(c.fmt.H * k), pad = 16, cap = 44;
      const sheet = createCanvas(cols * (tw + pad) + pad, rows * (th + cap + pad) + pad), sx = sheet.getContext('2d');
      sx.fillStyle = '#e9ecef'; sx.fillRect(0, 0, sheet.width, sheet.height);
      for (let i = 0; i < tiles.length; i++) {
        const x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + cap + pad);
        frame(tiles[i].t, { pen: false });
        sx.drawImage(cv, x, y + cap, tw, th);
        sx.strokeStyle = '#adb5bd'; sx.lineWidth = 1; sx.strokeRect(x + 0.5, y + cap + 0.5, tw, th);
        const lab = textStrokes(tiles[i].label, { size: 28, color: '#212529' });
        sx.save(); sx.translate(x + 4, y + 6);
        drawStrokes(sx, env, lab.strokes);
        sx.restore();
      }
      const sf = `sheet-${String(sc.index + 1).padStart(2, '0')}-${sc.id}.png`;
      writeFileSync(join(out, sf), await sheet.encode('png')); sheets.push(sf); sheetCvs.push(sheet);
      if (draft) { // 眯眼图：自己先看主次
        const fv = canvasFor(c, 0.5); fullView(c, sc, fv.ctx, 0.5);
        writeFileSync(join(out, `squint-${String(sc.index + 1).padStart(2, '0')}-${sc.id}.png`), await squintOf(fv.cv).encode('png'));
        const b = c.plan?.boards.find(p => p.id === sc.id);
        console.log(`  ${sc.id}：一眼最重的三样是 ${heaviest(c, sc).join('、')}${b?.hero ? `；计划的主角是 ${c.plan!.cast[b.hero]?.name ?? `“${b.hero}”`}` : ''}。眯眼图 squint-${String(sc.index + 1).padStart(2, '0')}-${sc.id}.png：字都糊掉后最显眼的那一团，应该就是主角`);
      } else if (!only && flags.at == null) {
        const small = createCanvas(Math.round(cv.width * 0.4), Math.round(cv.height * 0.4)), smx = small.getContext('2d'), imgs = [];
        for (let i = 0; i < tiles.length; i++) { frame(tiles[i].t, { pen: false }); smx.drawImage(cv, 0, 0, small.width, small.height); const be = sc.beats[i]; imgs.push({ src: await jpeg(small, 78), caption: `${tiles[i].label}　${be.intent}`, sub: be.say ? `口播：${be.say}` : '' }); }
        rblocks.push({ heading: `${c.scenes.length > 1 ? `第 ${sc.index + 1} 块板：` : ''}${sc.id}（${tiles.length} 拍）`, note: '每张图是这一拍画完之后的样子。图下面是编号、这一拍画什么、这时候口播在说什么。', images: imgs, grid: true });
      }
    }
    if (draft) { console.log(`✓ 草稿关键帧已输出到 ${out}（半分辨率，带“草稿 · 未确认”水印）\n  每个场景一张联系表：${sheets.join('  ')}\n这是给你自己看的：逐张检查重叠、出界、难看、看不懂、和口播对不上，改到满意再交给用户。\n草稿不是交付物：不要把它当作关键帧请用户确认。交给用户的是审片页：${c.plan ? 'hj look（全景定稿）和 ' : ''}hj stills（关键帧，不带 --draft）。`); return; }
    console.log(`✓ 关键帧已输出到 ${out}\n  每个场景一张联系表：${sheets.join('  ')}\n  每一拍的全尺寸图：<场景序号>-<场景>-<拍>.png`);
    if (only) { console.log('只出了一个场景，没有更新审片页。交给用户确认要出全部：hj stills ' + dir); return; }
    const code = confirmCode('keyframes', c.keyHash);
    await writeReview(dir, { title: String(c.meta.title ?? '未命名'), stage: 'keyframes', code, hash: c.keyHash, step: 4, steps: c.plan ? STEPS : ['文字分镜', '关键帧', '成片'].map(String),
      lead: '这是每一拍画完之后的样子，按时间排。这一步定的是过程：每句话画的是不是它在说的事、节奏对不对。确认之后就渲染成片。',
      questions: [{ q: '有没有哪一拍画的不是口播正在说的事，或者出现得太早、太晚？（说编号）', fallback: '都对得上' }, { q: '有没有哪一拍太空、太满，或者停太久没东西看？', fallback: '没有' }, { q: '可以出成片了吗？', fallback: '可以' }],
      blocks: rblocks, warnings: c.issues.filter(i => i.level === 'warn').map(i => `${i.where}：${i.msg}`) }, await stackSheet(`关键帧 · ${String(c.meta.title ?? '')}`, code, sheetCvs));
  },

  async render() {
    const dir = args[0] ?? die('用法：hj render <项目目录> [--scene 场景 | --from 秒 --to 秒] [--draft] [--out 文件]');
    const c = load(dir); await preload(c);
    gate(c, 'plan'); if (c.plan) gate(c, 'look'); gate(c, 'keyframes');
    const only = sceneArg(c);
    const from = only ? Math.max(0, only.t0 - 0.6) : +(flags.from ?? 0), to = only ? only.t1 : +(flags.to ?? c.duration);
    const draft = !!flags.draft, scale = draft ? 0.5 : 1, fps = draft ? Math.min(15, c.fps) : c.fps;
    const outDir = join(dir, 'out'); mkdirSync(outDir, { recursive: true });
    const name = String(flags.out ?? join(outDir, `${only ? only.id : flags.from || flags.to ? `${from.toFixed(0)}-${to.toFixed(0)}` : 'video'}${draft ? '.draft' : ''}.mp4`));
    const { cv, ctx } = canvasFor(c, scale);
    const inputs: string[] = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${cv.width}x${cv.height}`, '-r', String(fps), '-i', '-'];
    const audio = c.meta.audio ? join(dir, c.meta.audio) : '';
    const hasVoice = !!audio && existsSync(audio), dur = to - from;
    let n = 0, voiceIn = -1, sfxIn = -1, musicIn = -1;
    if (hasVoice) { inputs.push('-ss', String(from), '-t', String(dur), '-i', audio); voiceIn = ++n; }
    else console.log('  （没有配音文件，成片只有落笔音效' + (c.meta.music ? '和背景音乐' : '') + '）');
    if (c.meta.sfx !== false) { const sfx = join(outDir, 'sfx.wav'); const r = writeSfx(c, sfx); console.log(`  音效：${r.mode === 'sparse' ? '稀疏' : '密集'}模式，全片 ${r.count} 声（平均每分钟 ${((r.count / c.duration) * 60).toFixed(0)} 声）`); inputs.push('-ss', String(from), '-t', String(dur), '-i', sfx); sfxIn = ++n; }
    // 背景音乐：循环铺满全片，淡入淡出；有配音时人一开口音乐自动压低（侧链压缩），停顿时再浮上来
    if (c.meta.music) {
      const music = join(dir, String(c.meta.music));
      if (!existsSync(music)) die(`project.yaml 里的 music 指向 ${c.meta.music}，但文件不存在`);
      inputs.push('-stream_loop', '-1', '-t', String(dur), '-i', music); musicIn = ++n;
      console.log(`  背景音乐：${c.meta.music}（音量 ${c.meta.musicVolume ?? 0.16}${hasVoice && c.meta.musicDuck !== false ? '，说话时自动压低' : ''}）`);
    }
    const ff = ['-y', '-loglevel', 'error', ...inputs];
    const g = audioGraph({ voiceIn, sfxIn, musicIn, dur, volume: +(c.meta.musicVolume ?? 0.16), duck: c.meta.musicDuck !== false });
    if (g.filter) ff.push('-filter_complex', g.filter);
    if (g.map) ff.push('-map', '0:v', '-map', g.map);
    ff.push('-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'medium', '-crf', draft ? '26' : '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', name);
    const p = spawn('ffmpeg', ff, { stdio: ['pipe', 'inherit', 'inherit'] });
    p.on('error', () => die('没有找到 ffmpeg，请先安装'));
    const done = new Promise<number>(r => p.on('close', code => r(code ?? 1)));
    const total = Math.round((to - from) * fps), started = Date.now();
    for (let i = 0; i < total; i++) {
      drawFrame(ctx, c, from + i / fps, env, { scale, subtitles: true, pen: penOpt(c) });
      if (!p.stdin.write(cv.data())) await new Promise(r => p.stdin.once('drain', r));
      if (i % (fps * 10) === 0 && i) console.log(`  ${fmtT(from + i / fps)} / ${fmtT(to)}  （${((i / total) * 100).toFixed(0)}%，已用 ${((Date.now() - started) / 1000).toFixed(0)}s）`);
    }
    p.stdin.end();
    if ((await done) !== 0) die('ffmpeg 合成失败');
    console.log(`✓ ${name}  （${fmtT(from)}–${fmtT(to)}，${total} 帧，${((Date.now() - started) / 1000).toFixed(0)}s）\n把这个视频文件发给用户看（发文件，不是路径）。用户提了修改意见，按 revising.md 判断该谁改。`);
  },

  // 封面：整块板的全景缩到下半张，上面是手写的大标题。平台的封面图 / 视频的第一眼
  async cover() {
    const dir = args[0] ?? die('用法：hj cover <项目目录> [--draft] [--out 文件]\n  标题写在 project.yaml：cover: { title: "两行以内\\n第二行", accent: 2, sub: "一句小字", at: "口播片段或秒数（默认片尾全景）" }');
    const c = load(dir); await preload(c);
    const draft = !!flags.draft, k = draft ? 0.5 : 1;
    if (!draft) gate(c, 'plan');
    const cfg = typeof c.meta.cover === 'object' && c.meta.cover ? c.meta.cover : {};
    const title = String(cfg.title ?? c.meta.title ?? '').trim();
    if (!title) die('封面需要标题：在 project.yaml 里写 cover: { title: "…" }');
    const lines = title.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 3 || lines.some(l => [...l].length > 9)) console.log('  ! 封面标题最好两行以内、每行不超过 8 个字：手机信息流里封面只有拇指大');
    const { W, H, board } = c.fmt, portrait = H > W;
    let t = c.duration - 0.05;
    if (cfg.at != null) { if (typeof cfg.at === 'number') t = cfg.at; else { try { t = resolveAnchor(c.al, String(cfg.at)).time + 3; } catch { die(`cover.at 写的 "${cfg.at}" 在口播里找不到`); } } }
    // 先画出那一刻的画面（不带字幕），裁出画板
    const src = createCanvas(W, H), sx = src.getContext('2d');
    drawFrame(sx, c, Math.min(Math.max(0, t), c.duration - 0.01), env, { scale: 1, subtitles: false, bare: true });
    const cv = createCanvas(Math.round(W * k), Math.round(H * k)), x = cv.getContext('2d');
    x.setTransform(k, 0, 0, k, 0, 0);
    drawFrame(x, { ...c, tls: [], subs: [] } as Compiled, 0, env, { scale: k, subtitles: false }); // 一张空白的纸
    x.setTransform(k, 0, 0, k, 0, 0);
    // 标题区：竖屏在上方三分之一，横屏在左边四成
    const T = portrait ? { x: 70, y: 150, w: W - 140, h: H * 0.3 } : { x: 90, y: 90, w: W * 0.4, h: H - 180 };
    const P = portrait ? { x: 50, y: T.y + T.h + 30, w: W - 100, h: H - (T.y + T.h + 30) - 150 } : { x: T.x + T.w + 40, y: 60, w: W - (T.x + T.w + 40) - 60, h: H - 120 };
    const ps = Math.min(P.w / board.w, P.h / board.h);
    x.drawImage(src, board.x, board.y, board.w, board.h, P.x + (P.w - board.w * ps) / 2, P.y + (P.h - board.h * ps) / 2, board.w * ps, board.h * ps);
    x.globalCompositeOperation = 'source-over';
    // 标题：字尽量大，撑满标题区的宽
    const sub = cfg.sub ? String(cfg.sub) : '', gap = 0.2;
    let size = portrait ? 210 : 170;
    const fit = () => { const ws = lines.map(l => textStrokes(l, { size, color: THEME.ink }).w); return Math.max(...ws) <= T.w && lines.length * size * (1 + gap) + (sub ? size * 0.55 : 0) <= T.h; };
    while (size > 60 && !fit()) size -= 6;
    const accent = cfg.accent == null ? lines.length : +cfg.accent; // 第几行用强调色（从 1 数），默认最后一行
    const total = lines.length * size * (1 + gap) + (sub ? size * 0.55 : 0);
    let y = T.y + (T.h - total) / 2;
    x.lineCap = 'round'; x.lineJoin = 'round';
    lines.forEach((l, i) => {
      const hot = i + 1 === accent, r = textStrokes(l, { size, color: hot ? THEME.colors.red : THEME.ink }), lx = portrait ? T.x + (T.w - r.w) / 2 : T.x;
      if (hot) { // 强调行底下一道黄色马克笔
        x.save(); x.globalCompositeOperation = 'multiply'; x.globalAlpha = 0.55; x.strokeStyle = THEME.colors.yellow; x.lineWidth = size * 0.42; x.lineCap = 'butt';
        x.beginPath(); x.moveTo(lx - size * 0.12, y + size * 0.74); x.quadraticCurveTo(lx + r.w / 2, y + size * 0.7, lx + r.w + size * 0.12, y + size * 0.76); x.stroke(); x.restore();
      }
      x.save(); x.translate(lx, y);
      for (const st of r.strokes) for (const dx of [0, 1.5]) { x.save(); x.translate(dx, 0); drawStroke(x, env, st, 1, 1); x.restore(); } // 描两遍，字更重
      x.restore(); x.globalAlpha = 1;
      y += size * (1 + gap);
    });
    if (sub) { const r = textStrokes(sub, { size: size * 0.36, color: THEME.colors.gray }); x.save(); x.translate(portrait ? T.x + (T.w - r.w) / 2 : T.x, y + size * 0.05); drawStrokes(x, env, r.strokes); x.restore(); }
    if (draft) { const stamp = textStrokes('草稿 · 未确认', { size: 54, color: '#d9433a' }); x.save(); x.globalAlpha = 0.6; x.translate(W / 2 - stamp.w / 2, H * 0.94); drawStrokes(x, env, stamp.strokes, 0.6); x.restore(); }
    const out = String(flags.out ?? join(dir, 'out', draft ? 'draft' : '', 'cover.png')); mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, await cv.encode('png'));
    console.log(`✓ 封面：${out}${draft ? '（草稿，带水印；正式封面需先确认文字分镜）' : ''}`);
  },

  assets() {
    const what = args[0];
    if (what === 'icons') {
      const q = args.slice(1).join(' ') || die('用法：hj assets icons <英文关键词…>   例：hj assets icons money bag');
      const r = searchIcons(q, +(flags.limit ?? 40));
      if (!r.length) console.log('没有匹配的图标，换个英文近义词试试');
      for (const it of r) console.log(`${it.name.padEnd(30)} ${it.category.padEnd(14)} ${it.tags}`);
    } else if (what === 'doodles') {
      console.log('名字                size 200 时的宽×高   说明（写了 label 的，下面再多出约 70px 的字）');
      for (const d of doodleDirs(args[1])) for (const f of readdirSync(d).filter(f => f.endsWith('.yaml')).sort()) {
        const y = YAML.parse(readFileSync(join(d, f), 'utf8')), bx = Array.isArray(y.box) ? y.box : [200, 200], k = 200 / Math.max(bx[0], bx[1]);
        const wh = `${Math.round(bx[0] * k)}×${Math.round(bx[1] * k)}`;
        console.log(`${f.replace('.yaml', '').padEnd(20)}${wh.padEnd(19)}${String(y.desc ?? '')}${y.vars ? '  可调：' + Object.keys(y.vars).join(' ') : ''}${y.anchors ? '  锚点：' + Object.keys(y.anchors).join(' ') : ''}`);
      }
    } else if (what === 'figure') {
      console.log('姿势 pose：' + Object.keys(POSES).join('  '));
      console.log('表情 face：' + Object.keys(FACES).filter(f => f !== 'none').join('  '));
      console.log('配饰 wear：' + ACCESSORIES.join('  '));
    } else if (what === 'colors') console.log(Object.entries(THEME.colors).map(([k, v]) => `${k} ${v}`).join('\n'));
    else if (what === 'sheet') return assetSheet();
    else die('用法：hj assets icons <关键词> | doodles [项目目录] | figure | colors | sheet [--out 文件] [--dir 手绘件目录]');
  },

  patterns() {
    const name = args[0];
    for (const [k, p] of Object.entries(PATTERNS)) {
      if (name && name !== k) continue;
      console.log(`■ ${k}  ${p.title}\n  什么时候用：${p.when}`);
      if (name) { console.log('  参数：'); for (const x of p.params) console.log('    ' + x); console.log('    area: [x, y, w, h]  只占画板的一部分（可省，默认整块画板），留出地方放自己的元素'); console.log('  步骤（在节拍的 do 里写 {step: 名字}）：'); for (const x of p.steps) console.log('    ' + x); }
      if (name) { // 附上一个能直接照着改的完整场景
        const ex = join(fileURLToPath(new URL('../../examples/patterns/scenes', import.meta.url)));
        const f = existsSync(ex) ? readdirSync(ex).find(x => x.includes('-' + k + '.')) : undefined;
        if (f) {
          // 手法自动起的元素名：照例子展开一遍，列出来。批注、标记、动作里引用它们时用这些名字
          try {
            const ps = YAML.parse(readFileSync(join(ex, f), 'utf8')).pattern, fmt = FORMATS.portrait, B = fmt.board;
            const out = p.build(ps, { fmt, A: { x: 20, y: 20, w: B.w - 40, h: B.h - 40 }, portrait: true, fail: (m: string) => { throw new Error(m); } });
            const what = (e: any) => ('figure' in e ? '小人' : 'text' in e ? `字“${String(e.text).slice(0, 6)}”` : 'doodle' in e ? `手绘件 ${e.doodle}` : 'arrow' in e ? '箭头' : 'line' in e ? '线' : 'shape' in e ? '形状' : 'mark' in e ? '标记' : 'note' in e ? '批注' : '元素');
            console.log('  例子展开后的元素名（给角色写了 id 的用你写的 id，其余是手法自动起的；第 N 项的名字里带 N）：\n    ' + out.elements.map(([id, e]) => `${id}（${what(e)}）`).join('  ') + '\n');
          } catch { /* 例子展开失败不影响说明 */ }
        }
        if (f) console.log(`  照着改的完整例子（examples/patterns/scenes/${f}）：\n\n` + readFileSync(join(ex, f), 'utf8').split('\n').map(l => '    ' + l).join('\n'));
      }
      console.log('');
    }
    if (!name) console.log('hj patterns <名字> 查看参数和步骤。九种手法的实际效果见 examples/patterns/');
    else if (!PATTERNS[name]) die(`没有叫 "${name}" 的手法。可用：${Object.keys(PATTERNS).join(' ')}`);
  },

  async import() {
    const usage = `用法：
  hj import excalidraw <素材库.excalidrawlib> --out <目录> [--only 名字,名字] [--prefix 前缀] [--text] [--source "出处"]
  hj import svg <文件.svg> --out <目录> [--name 名字] [--desc 说明] [--source "出处"] [--pen 2] [--rough 0.3] [--paper]
  hj import quickdraw <类别.ndjson> --sheet <候选图.png> [--count 48]          先出候选图，挑编号
  hj import quickdraw <类别.ndjson> --pick <编号> --name <名字> --out <目录> [--desc 说明] [--color 颜色]
导入的是几何形状，进来后由本项目的笔重新画；--out 一般是项目的 doodles/ 目录。导入前先核对素材的授权。`;
    const kind = args[0], file = args[1];
    if (!file || !existsSync(file)) die(usage);
    const im = await import('../core/importers');
    const save = (outDir: string, it: { name: string; doodle: any; skipped: string[] }) => {
      mkdirSync(outDir, { recursive: true });
      const f = join(outDir, it.name + '.yaml');
      if (existsSync(f) && !flags.force) { console.log(`- 跳过 ${it.name}：${f} 已存在（--force 覆盖）`); return; }
      writeFileSync(f, im.doodleYaml(it.doodle));
      console.log(`✓ ${it.name.padEnd(22)} ${it.doodle.parts.length} 个图形${it.skipped.length ? '  注意：' + it.skipped.join('；') : ''}`);
    };
    if (kind === 'excalidraw') {
      const outDir = flags.out ? String(flags.out) : die(usage);
      let items: any[];
      try { items = im.fromExcalidraw(JSON.parse(readFileSync(file, 'utf8')), { text: !!flags.text, source: flags.source ? String(flags.source) : undefined }); } catch (e: any) { return die(e.message); }
      const only = flags.only ? String(flags.only).split(',').map(s => s.trim()) : null;
      const miss = only?.filter(n => !items.some(i => i.name === n)) ?? [];
      if (miss.length) die(`素材库里没有：${miss.join(' ')}。可选：${items.map(i => i.name).join(' ')}`);
      for (const it of items) if (!only || only.includes(it.name)) save(outDir, { ...it, name: (flags.prefix ? String(flags.prefix) : '') + it.name });
      console.log(`\n看长相：hj assets sheet --dir ${outDir} --out sheet.png。不好看的直接删掉文件；名字、desc、颜色可以手改。`);
    } else if (kind === 'svg') {
      const outDir = flags.out ? String(flags.out) : die(usage);
      let it: any;
      try { it = im.fromSvg(readFileSync(file, 'utf8'), { name: flags.name ? String(flags.name) : im.slug(basename(file, '.svg')) || undefined, desc: flags.desc ? String(flags.desc) : undefined, source: flags.source ? String(flags.source) : undefined, pen: flags.pen ? +flags.pen : undefined, rough: flags.rough ? +flags.rough : undefined, paper: !!flags.paper }); } catch (e: any) { return die(e.message); }
      save(outDir, it);
    } else if (kind === 'quickdraw') {
      const all = im.parseQuickDraw(readFileSync(file, 'utf8')).filter(d => d.recognized);
      if (!all.length) die('文件里没有可用的画（需要 Quick Draw 的 simplified .ndjson）');
      if (flags.sheet) {
        const n = Math.min(all.length, +(flags.count ?? 48));
        await drawSheet(all.slice(0, n).map((d, i) => { const it = im.fromQuickDraw(d); return { src: { parts: it.doodle.parts, box: it.doodle.box, size: 200, shade: false }, label: String(i + 1) }; }), String(flags.sheet));
        console.log(`✓ ${flags.sheet}：前 ${n} 张候选（共 ${all.length} 张）。挑一张，再跑 --pick <编号> --name <名字> --out <目录>`);
      } else if (flags.pick) {
        const d = all[+flags.pick - 1] ?? die(`没有第 ${flags.pick} 张（共 ${all.length} 张）`);
        save(flags.out ? String(flags.out) : die(usage), im.fromQuickDraw(d, { name: flags.name ? im.slug(String(flags.name)) : undefined, desc: flags.desc ? String(flags.desc) : undefined, color: flags.color ? String(flags.color) : undefined }));
      } else die(usage);
    } else die(usage);
  },
  'fake-align'() {
    const f = args[0] ?? die('用法：hj fake-align <口播稿.txt> [--cps 4.5] > alignment.json   （没有配音时先造一份匀速时间表打草稿）');
    process.stdout.write(JSON.stringify(fakeAlignment(readFileSync(f, 'utf8'), +(flags.cps ?? 4.5)), null, 1));
  },
};

/** 素材一览图：所有姿势、表情、手绘件画在一张图上，供挑选。--dir 只画某个目录里的手绘件 */
async function assetSheet() {
  const items: { src: any; label: string }[] = [];
  const only = flags.dir ? String(flags.dir) : null;
  if (!only) {
    for (const p of Object.keys(POSES)) items.push({ src: { figure: p, size: 230 }, label: p });
    for (const f of Object.keys(FACES).filter(f => f !== 'none')) items.push({ src: { figure: 'stand', face: f, size: 230 }, label: 'face:' + f });
    for (const a of ACCESSORIES) items.push({ src: { figure: 'stand', wear: [a], accent: 'blue', size: 230 }, label: 'wear:' + a });
  } else if (!existsSync(only)) die(`找不到目录：${only}`);
  for (const d of only ? [only] : doodleDirs()) for (const f of readdirSync(d).filter(f => f.endsWith('.yaml')).sort()) { const y = YAML.parse(readFileSync(join(d, f), 'utf8')); items.push({ src: { parts: y.parts, box: y.box, vars: undefined, size: 200 }, label: f.replace('.yaml', '') }); if (y.vars) (items[items.length - 1].src as any).__vars = y.vars; }
  const out = String(flags.out ?? 'assets-sheet.png');
  await drawSheet(items, out);
  console.log(`✓ ${out}`);
}
async function drawSheet(items: { src: any; label: string }[], out: string) {
  const { buildElement } = await import('../core/elements');
  const fmt = { ...FORMATS.landscape, board: { x: 0, y: 0, w: 100000, h: 100000 } };
  const els = new Map<string, any>(), ctxB = { scene: 'sheet', fmt, els };
  const built = items.map((it, i) => {
    const { __vars, vars, ...src } = it.src;
    // 带可调项的手绘件按默认值画
    const sub = (v: any): any => (typeof v === 'string' && v.startsWith('$') ? (__vars ?? {})[v.slice(1)] ?? '' : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
    return { el: buildElement(ctxB, 'i' + i, { ...sub(src), at: [0, 0] }), label: it.label };
  });
  const cols = 8, cw = 290, chh = 330, rows = Math.ceil(built.length / cols);
  const cv = createCanvas(cols * cw, rows * chh), ctx = cv.getContext('2d');
  ctx.fillStyle = THEME.paper; ctx.fillRect(0, 0, cv.width, cv.height);
  built.forEach((it, i) => {
    const x = (i % cols) * cw + cw / 2, y = Math.floor(i / cols) * chh + 140, b = it.el.box;
    ctx.save(); ctx.translate(x - (b.x + b.w / 2), y - (b.y + b.h / 2));
    drawStrokes(ctx, env, it.el.strokes);
    ctx.restore(); ctx.globalAlpha = 1;
    const lab = textStrokes(it.label, { size: 26, color: '#495057' });
    ctx.save(); ctx.translate(x - lab.w / 2, Math.floor(i / cols) * chh + chh - 50);
    drawStrokes(ctx, env, lab.strokes);
    ctx.restore();
  });
  writeFileSync(out, await cv.encode('png'));
}

if (cmd === '--version' || cmd === '-v') { console.log(JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version); process.exit(0); }
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || !commands[cmd]) {
  console.log(`画讲 hj —— 把带时间表的口播做成“边画边讲”的手绘视频

  hj status <目录>                    现在轮到谁（配音 / 规划者 / 执行者）、下一步做什么。拿不准就跑它

  hj init <目录> --voice <配音材料>   建项目，导入已有的配音和时间表
  hj init <目录> --script <稿.txt>    建项目，只有稿子（之后用 hj voice 配音）
  hj voice <目录>                     配音（火山引擎，付费）：先列出朗读稿给用户确认，确认后才合成
  hj voice <目录> --engine edge       配音（edge-tts，免费）；hj voice --voices 列出音色和默认参数
  hj brief <目录>                     口播逐句时间简报（写计划前先读）

  规划者：
  hj check <目录>                     查计划（还没有场景时）；有场景后连画面一起查
  hj plan <目录>                      由 plan.yaml 排出分镜计划 storyboard.md → 交用户确认
  hj layouts [名字]                   版式：现成的分区方案（plan.yaml 里写 layout: 名字）
  hj approve <目录> script|plan|look|keyframes --by "<用户确认原话>"   后三道要带图上的确认码

  执行者：
  hj scaffold <目录>                  照计划生成场景骨架（每块板一个文件）
  hj layout <目录> [--scene x]        布局线框：每个元素最后落在哪儿（随时跑，不需要确认）
  hj stills <目录> --draft            草稿关键帧：带水印、半分辨率，自查用（不需要确认）
  hj look <目录>                      全景定稿：每块板讲完时的全景（需先确认计划）→ 交用户确认
  hj stills <目录> [--scene x]        出逐拍的关键帧（需先确认全景定稿）→ 交用户确认
  hj render <目录> [--scene x] [--draft]   渲染视频（需先确认关键帧）
  hj cover <目录> [--draft]                封面图：全景 + 手写大标题（标题写在 project.yaml 的 cover 里）

  素材：
  hj patterns [名字]                  表现手法：自带构图和动作编排的场景骨架
  hj assets doodles | figure | icons <关键词> | colors | sheet
  hj import excalidraw|svg|quickdraw <文件>   把外部手绘素材转成手绘件
  hj fake-align <稿.txt>              没配音时造匀速时间表打草稿

制作视频的完整说明在技能里：skills/huajiang/SKILL.md`);
  process.exit(!cmd || ['--help', '-h', 'help'].includes(cmd) ? 0 : 1);
}
try { await commands[cmd](); }
catch (e: any) {
  // 走到这里说明是框架自己的缺陷，不是分镜写错了
  console.error(`✗ 框架内部错误：${e?.message ?? e}\n${String(e?.stack ?? '').split('\n').slice(1, 6).join('\n')}\n这不是你的分镜的问题。请带上这段信息和触发它的场景文件报告给维护者。`);
  process.exit(2);
}
