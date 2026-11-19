// 计划（plan.yaml）：规划者交给执行者的标准产物。
// 规划者回答“讲的是一个什么系统”：有哪些东西（cast）、它们之间什么关系（relations）、
// 分几块板、每块怎么分区、每一段口播往板上添什么。不写坐标。
// 执行者照着它把每一段落成场景文件。这个模块负责：读、查计划、算分区、出骨架、查执行是否照做、排成给用户看的分镜表。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { resolveAnchor, stripPunct, type Alignment } from './alignment';
import { FORMATS, type Format } from './theme';
import type { Compiled, Issue, TL } from './compile';
import { loadDoodle } from './elements';
import { iconExists } from './icons';
import { loadAppendix, type Appendix } from './appendix';
import { POSES, ACCESSORIES } from './figure';
import { loadStory, MOVES, type Story } from './story';

export interface PlanCast { name: string; look: any }
export interface PlanRelation { from: string; to: string; label?: string }
export interface PlanSegment {
  at: string; act?: string; in?: string; intent: string;
  show: string[]; link: string[]; revisit: string[]; words: string[];
  /** 这一段画一条线，把本分区和这些分区连起来（括号、斜线、汇总的箭头：不是角色之间的关系，但把板连成一张图） */
  joins: string[];
  diagram?: string; pattern?: string;
}
export interface PlanBoard {
  id: string; picture: string; size?: number | number[]; recall?: string;
  /** size 是引擎按内容量算出来的（计划里没写，或写了 auto） */
  autoSize?: boolean;
  /** 主角：这块板讲完后，观众第一眼该看到的那样东西（通常是结论）。写一条板书的原文，或一个角色的 id */
  hero?: string;
  /** 版式：现成的分区方案（hj layouts）。写了它就不用写 grid */
  layout?: string;
  grid: { rows?: number[]; cols?: number[]; areas: string[][] };
  regions: Record<string, string>;
  segments: PlanSegment[];
}
export interface Plan { thesis: string; cast: Record<string, PlanCast>; relations: Record<string, PlanRelation>; boards: PlanBoard[]; hash: string; /** 片尾的滚动附录（appendix.yaml），算在计划里：用户确认计划时一并确认 */ appendix?: Appendix }

/** 版式：把“这件事的形状”做成现成的分区。竖屏和横屏各一套比例，分区名固定 */
export interface Layout { title: string; when: string; link: string; regions: Record<string, string>; portrait: PlanBoard['grid']; landscape: PlanBoard['grid'] }
export const LAYOUTS: Record<string, Layout> = {
  flow: { title: '一路推下来', when: '因果、推演、算账：一步推出下一步，最后落到结论', link: '每一步用向下（横屏向右）的箭头接到下一步',
    regions: { a: '第一步：起点、前提', b: '第二步', c: '第三步：转折或关键的一步', sum: '结论' },
    portrait: { rows: [24, 28, 28, 20], areas: [['a'], ['b'], ['c'], ['sum']] }, landscape: { rows: [68, 32], cols: [1, 1, 1], areas: [['a', 'b', 'c'], ['sum', 'sum', 'sum']] } },
  stack: { title: '几行共用一根轴', when: '几样东西比长短、比时间、比多少：对齐本身就是论证', link: '所有横条左对齐、共用一根轴；汇总从它们往下连',
    regions: { head: '谁、规则、前提', rows: '几行左对齐的横条或时间段', sum: '汇总、结论' },
    portrait: { rows: [24, 54, 22], areas: [['head'], ['rows'], ['sum']] }, landscape: { rows: [22, 78], cols: [68, 32], areas: [['head', 'head'], ['rows', 'sum']] } },
  compare: { title: '两组对照', when: '两种情况、两个方案、以前和现在', link: '两组里对应的东西对齐（竖屏两组上下排、对齐同一列；横屏左右排、对齐同一行）；最后一条把两组括起来',
    regions: { head: '比的是什么', a: '一组', b: '另一组', sum: '差别、结论' },
    portrait: { rows: [20, 30, 30, 20], areas: [['head'], ['a'], ['b'], ['sum']] }, landscape: { rows: [16, 60, 24], cols: [1, 1], areas: [['head', 'head'], ['a', 'b'], ['sum', 'sum']] } },
  cycle: { title: '转一圈', when: '钱、货、信息在几方之间流转', link: '圈上的箭头首尾相接；结论写在圈的中间或下面',
    regions: { head: '起因、谁在场', loop: '转起来的圈', sum: '转完之后的结果' },
    portrait: { rows: [23, 54, 23], areas: [['head'], ['loop'], ['sum']] }, landscape: { rows: [24, 76], cols: [64, 36], areas: [['loop', 'head'], ['loop', 'sum']] } },
  hub: { title: '几股力量指向一件事', when: '几个原因、几方压力作用在同一样东西上', link: '四周的每一区都有一条箭头指向中间',
    regions: { core: '被作用的那件事（结论落在这里）', f1: '第一股力量', f2: '第二股力量', f3: '第三股力量', f4: '第四股力量' },
    portrait: { rows: [30, 40, 30], cols: [1, 1], areas: [['f1', 'f2'], ['core', 'core'], ['f3', 'f4']] }, landscape: { rows: [1, 1], cols: [28, 44, 28], areas: [['f1', 'core', 'f2'], ['f3', 'core', 'f4']] } },
  tree: { title: '拆开来看', when: '拆解、分类、一笔账怎么分', link: '从根往下分叉的线；底部把几块加回去',
    regions: { root: '被拆的那样东西', parts: '拆出来的几块，并排对齐', sum: '加回去、结论' },
    portrait: { rows: [25, 50, 25], areas: [['root'], ['parts'], ['sum']] }, landscape: { rows: [24, 50, 26], areas: [['root'], ['parts'], ['sum']] } },
};

/** 板该放大多少：估这块板要放的东西各占多少地方，凑到“全景不挤”的密度。
 *  全景是缩小的整块板，推近才是原大——东西多的板自动变大，全景里每样东西就小一点、空隙多一点。 */
export function autoBoardSize(b: Pick<PlanBoard, 'segments' | 'hero'>, fmtName: string): number {
  return Math.min(AUTO_MAX, Math.max(1, Math.round(boardNeed(b, fmtName) * 20) / 20)); // 再大，全景里的小字就看不清了：更多的内容该分板
}
/** 按内容量估出来的板该有多大（不封顶） */
export function boardNeed(b: Pick<PlanBoard, 'segments' | 'hero'>, fmtName: string): number {
  const fb = FORMATS[fmtName] ?? FORMATS.portrait;
  const cast = new Set(b.segments.flatMap(s => s.show)).size, links = new Set(b.segments.flatMap(s => s.link)).size;
  const words = [...new Set(b.segments.flatMap(s => s.words))];
  const need = cast * 48000 + links * 26000 + b.segments.filter(s => s.diagram || s.pattern).length * 90000
    + b.segments.reduce((n, s) => n + s.revisit.length * 12000 + s.joins.length * 15000, 0)
    + words.reduce((n, w) => n + (w === b.hero ? wordLen(w) * 108 * 150 : wordLen(w) * 56 * 90), 0);
  return Math.sqrt(need / (AUTO_FILL * fb.board.w * fb.board.h));
}
const AUTO_FILL = 0.46;
/** 自动定的板最大几屏。超过 1.6 屏，全景里的小字已经偏小（检查会提醒） */
export const AUTO_MAX = 2.0;
/** 一块板放得下多少字的板书：和 hj check 对画面的检查用同一个数（每一屏的面积 110 字） */
export const WORDS_PER_SCREEN = 110;
/** 每块板的大小。它不算在计划的版本号里：调大小是构图的事，由全景定稿那一道确认 */
export const boardSizes = (plan: Pick<Plan, 'boards'>) => plan.boards.map(b => [b.id, b.size ?? 1]);

export const ACTS = ['设问', '说法', '理由', '例子', '算账', '数据', '对比', '转折', '推翻', '结论', '补充'];
/** 角色的长相只能是“画出来的东西”，不能是一行字或一个框 */
const LOOKS = ['figure', 'doodle', 'icon', 'image', 'video', 'parts'];
const W = 'plan.yaml';
const arr = (v: any): string[] => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const fmtT = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
/** 板书的长度：汉字算一个，字母数字符号算半个 */
export const wordLen = (s: string) => Math.ceil([...s.replace(/\s/g, '')].reduce((n, ch) => n + (/[⺀-鿿＀-￯]/.test(ch) ? 1 : 0.5), 0));
const norm = (s: string) => String(s).replace(/\s/g, '');

function longestCommon(a: string, b: string): number {
  let best = 0; const prev = new Uint16Array(b.length + 1), cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) { for (let j = 1; j <= b.length; j++) { cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0; if (cur[j] > best) best = cur[j]; } prev.set(cur); }
  return best;
}

/** 读 plan.yaml。没有这个文件返回 null（不走计划的老项目）；文件在但没填，抛错 */
export function loadPlan(dir: string): Plan | null {
  const f = join(dir, W);
  if (!existsSync(f)) return null;
  let raw: any;
  try { raw = YAML.parse(readFileSync(f, 'utf8'), { prettyErrors: true }); } catch (e: any) { throw new Error(`plan.yaml 的 YAML 写错了：${e.message}`); }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.boards) || !raw.boards.length) throw new Error('plan.yaml 还没有填。先由规划者把计划写完（论点、角色、关系、板和分段），hj check 通过、用户确认之后，执行者才开始写场景。写法见技能里的 planner.md');
  let fmtName = 'portrait';
  try { fmtName = String((YAML.parse(readFileSync(join(dir, 'project.yaml'), 'utf8')) ?? {}).format ?? 'portrait'); } catch { /* 没有 project.yaml 时按竖屏 */ }
  const gridOf = (b: any): PlanBoard['grid'] => {
    const lay = b?.layout != null && !b?.grid ? LAYOUTS[String(b.layout)] : undefined;
    if (lay) return JSON.parse(JSON.stringify(fmtName === 'landscape' ? lay.landscape : lay.portrait));
    return { ...(Array.isArray(b?.grid?.rows) ? { rows: b.grid.rows.map(Number) } : {}), ...(Array.isArray(b?.grid?.cols) ? { cols: b.grid.cols.map(Number) } : {}), areas: Array.isArray(b?.grid?.areas) ? b.grid.areas.map((r: any) => arr(r)) : [] };
  };
  const cast: Record<string, PlanCast> = {};
  for (const [k, v] of Object.entries(raw.cast ?? {}) as [string, any][]) cast[k] = { name: String(v?.name ?? k), look: v?.look };
  const relations: Record<string, PlanRelation> = {};
  for (const [k, v] of Object.entries(raw.relations ?? {}) as [string, any][]) relations[k] = { from: String(v?.from ?? ''), to: String(v?.to ?? ''), ...(v?.label != null ? { label: String(v.label) } : {}) };
  const boards: PlanBoard[] = raw.boards.map((b: any, i: number) => ({
    id: String(b?.id ?? `board${i + 1}`), picture: String(b?.picture ?? ''), ...(b?.size != null && b.size !== 'auto' ? { size: b.size } : {}), ...(b?.recall != null ? { recall: String(b.recall) } : {}),
    ...(b?.hero != null ? { hero: String(b.hero) } : {}), ...(b?.layout != null ? { layout: String(b.layout) } : {}),
    grid: gridOf(b),
    // 用了版式又没写 regions 的分区，用版式自带的说明
    regions: { ...(b?.layout != null && !b?.grid && LAYOUTS[String(b.layout)] ? LAYOUTS[String(b.layout)].regions : {}), ...Object.fromEntries(Object.entries(b?.regions ?? {}).map(([k, v]) => [k, String(v ?? '')])) },
    segments: (Array.isArray(b?.segments) ? b.segments : []).map((s: any) => ({
      at: String(s?.at ?? ''), ...(s?.act != null ? { act: String(s.act) } : {}), ...(s?.in != null ? { in: String(s.in) } : {}), intent: String(s?.intent ?? ''),
      show: arr(s?.show), link: arr(s?.link), revisit: arr(s?.revisit), words: arr(s?.words), joins: arr(s?.joins),
      ...(s?.diagram != null ? { diagram: String(s.diagram) } : {}), ...(s?.pattern != null ? { pattern: String(s.pattern) } : {}),
    })),
  }));
  // 没写 size（或写 auto）的板：按内容量定大小。沿用别的板（recall）的，和那块板一样大
  for (const b of boards) if (b.size == null && !b.recall) { b.size = autoBoardSize(b, fmtName); b.autoSize = true; }
  for (const b of boards) if (b.size == null && b.recall) { const o = boards.find(x => x.id === b.recall); if (o?.size != null) { b.size = o.size; b.autoSize = true; } }
  const ap = loadAppendix(dir);
  const plan = { thesis: String(raw.thesis ?? ''), cast, relations, boards, ...(ap.appendix ? { appendix: ap.appendix } : {}) };
  // 板的大小不算进计划的版本号：放大缩小只改构图，不改讲什么。它算在全景定稿和关键帧的版本号里
  const hash = createHash('sha256').update(JSON.stringify({ ...plan, boards: boards.map(({ size: _s, autoSize: _a, ...rest }) => rest) })).digest('hex').slice(0, 16);
  // 记下原始字段，检查时报“不认识的字段”（不参与版本号）
  return Object.assign({ ...plan, hash }, { __raw: raw });
}

/** 这块板的画板有多大（屏幕画板的几倍） */
export function boardBox(b: PlanBoard, fmt: Format): { w: number; h: number } {
  const s = b.size ?? 1, k = Array.isArray(s) ? s.map(Number) : [+s, +s];
  return { w: Math.round(fmt.board.w * (k[0] || 1)), h: Math.round(fmt.board.h * (k[1] ?? k[0] ?? 1)) };
}

/** 格子 → 每个分区的矩形。areas 像 CSS 的 grid-template-areas：同名的格子连成一块，必须是矩形 */
export function planRegions(b: PlanBoard, fmt: Format): { regions: Record<string, [number, number, number, number]>; errors: string[] } {
  const errors: string[] = [], regions: Record<string, [number, number, number, number]> = {};
  const A = b.grid.areas, R = A.length, C = R ? A[0].length : 0;
  if (!R || !C) return { regions, errors: ['grid.areas 要写成几行几列的分区名，如 [[top, top], [left, right]]'] };
  if (A.some(r => r.length !== C)) return { regions, errors: ['grid.areas 每一行的格子数要一样'] };
  const rows = b.grid.rows ?? Array(R).fill(1), cols = b.grid.cols ?? Array(C).fill(1);
  if (rows.length !== R || rows.some(v => !(v > 0))) errors.push(`grid.rows 要给 ${R} 个正数（每一行占多高的比例）`);
  if (cols.length !== C || cols.some(v => !(v > 0))) errors.push(`grid.cols 要给 ${C} 个正数（每一列占多宽的比例）`);
  if (errors.length) return { regions, errors };
  const B = boardBox(b, fmt), sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const ys = [0], xs = [0];
  for (const v of rows) ys.push(ys[ys.length - 1] + (v / sum(rows)) * B.h);
  for (const v of cols) xs.push(xs[xs.length - 1] + (v / sum(cols)) * B.w);
  const names = [...new Set(A.flat())].filter(n => n !== '.');
  for (const n of names) {
    let r0 = R, r1 = -1, c0 = C, c1 = -1, cells = 0;
    A.forEach((row, r) => row.forEach((cell, c) => { if (cell === n) { r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); cells++; } }));
    if (cells !== (r1 - r0 + 1) * (c1 - c0 + 1)) { errors.push(`分区 "${n}" 在 grid.areas 里不是一个矩形`); continue; }
    regions[n] = [Math.round(xs[c0]), Math.round(ys[r0]), Math.round(xs[c1 + 1] - xs[c0]), Math.round(ys[r1 + 1] - ys[r0])];
  }
  return { regions, errors };
}

export interface SegTime { board: number; seg: number; t0: number; t1: number; /** 卡点那几个字开口的时刻（第一段的 t0 是片头，这个才是字的位置） */ anchor: number }
/** 每一段的起止时间。锚点找不到的那一段时间是 NaN */
export function segmentTimes(plan: Plan, al: Alignment, duration: number): { times: SegTime[]; errors: Issue[] } {
  const times: SegTime[] = [], errors: Issue[] = [];
  let prev = 0;
  plan.boards.forEach((b, bi) => b.segments.forEach((s, si) => {
    let t = NaN, anchor = NaN;
    try {
      const r = resolveAnchor(al, s.at, [prev, Infinity]);
      anchor = r.time;
      t = bi === 0 && si === 0 ? Math.min(r.time, 0) : r.time; // 第一段从片头算起
      if (times.length && !(r.time > prev)) { errors.push({ level: 'error', where: `${W} / ${b.id} 第 ${si + 1} 段`, msg: `at "${s.at}" 没有排在上一段之后：分段要按口播的顺序写` }); t = NaN; }
      else prev = r.time;
    } catch (e: any) {
      const needle = stripPunct(String(s.at).replace(/#\d+.*$/, '').replace(/@end.*$/, '')), any = !!needle && al.flat.includes(needle);
      errors.push({ level: 'error', where: `${W} / ${b.id} 第 ${si + 1} 段`, msg: any
        ? `at "${s.at}" 在上一段的起点（${fmtT(prev)}）之后找不到。分段要按口播的顺序写；重复出现的词从上一段之后数起（之后第一次出现不用加 #，第二次才写 #2）。也可能是上一段的 at 卡到了更靠后的地方`
        : `at "${s.at}" 在口播稿里找不到，请逐字核对原文。从 brief.md 的“分句卡点”里抄一个片段` });
    }
    times.push({ board: bi, seg: si, t0: t, t1: NaN, anchor });
  }));
  for (let i = 0; i < times.length; i++) { let n = i + 1; while (n < times.length && Number.isNaN(times[n].t0)) n++; times[i].t1 = n < times.length ? times[n].t0 : duration; }
  return { times, errors };
}

/** 查计划本身：格式对不对、锚点在不在、是不是一个连起来的系统、是不是又在写字 */
export function checkPlan(plan: Plan, al: Alignment, fmt: Format, duration: number, projectDir?: string): Issue[] {
  const out: Issue[] = [];
  const err = (where: string, msg: string) => out.push({ level: 'error', where, msg });
  const warn = (where: string, msg: string) => out.push({ level: 'warn', where, msg });
  const raw = (plan as any).__raw ?? {};
  for (const k of Object.keys(raw)) if (!['thesis', 'cast', 'relations', 'boards', 'note'].includes(k)) err(W, `不认识字段 "${k}"。可用：thesis cast relations boards note`);
  if (wordLen(plan.thesis) < 6) err(W, 'thesis 没有写：用一句话说出全片的结论。说不出来，说明还没想清楚这条片子讲什么');

  // ── 角色和关系 ──
  const castIds = Object.keys(plan.cast), relIds = Object.keys(plan.relations);
  for (const [id, c] of Object.entries(plan.cast)) {
    const where = `${W} / cast.${id}`;
    if (!/^[A-Za-z][\w-]*$/.test(id)) err(where, '角色的 id 用英文字母开头的短名（如 bank、boss），场景里的元素要用它');
    const kinds = c.look && typeof c.look === 'object' ? LOOKS.filter(k => k in c.look) : [];
    if (c.look && typeof c.look === 'object' && 'crowd' in c.look) { const of = c.look.of; if (!of || !LOOKS.some(k => k in of)) err(where, 'look 是一群（crowd）时，of 里要写每一个长什么样：{ crowd: 6, cols: 3, of: { figure: stand } }'); }
    else if (kinds.length !== 1) err(where, `look 要写这个角色长什么样，而且只能是画出来的东西：${LOOKS.join(' / ')}，或一群 { crowd: N, of: {…} }。如 { doodle: bank }、{ figure: stand, wear: [tophat] }。不能是一行字或一个方框（hj assets doodles / figure 查现成的）`);
    // 长相里点名的素材必须真的有：不然计划能过检查，执行者一动笔就卡死，而他又不能改计划
    const one = c.look && typeof c.look === 'object' ? ('crowd' in c.look ? c.look.of : c.look) : null;
    if (one && typeof one === 'object') {
      if (one.doodle != null && !loadDoodle(String(one.doodle), projectDir)) err(where, `没有叫 "${one.doodle}" 的手绘件。运行 hj assets doodles 看有哪些，换一个现成的；都不合适就换成图标（hj assets icons <英文关键词>）或小人`);
      for (const k of ['image', 'video']) if (one[k] != null && projectDir && !existsSync(join(projectDir, String(one[k])))) err(where, `找不到${k === 'video' ? '视频' : '图片'} ${one[k]}（路径相对项目目录）。真实的照片、截图、视频片段由用户提供，放进项目的 media/ 目录；没有就换成手绘件或小人，不要写一个不存在的文件`);
      if (one.icon != null && !iconExists(String(one.icon))) err(where, `没有叫 "${one.icon}" 的图标。运行 hj assets icons <英文关键词> 搜（只认英文，如 sun、court）`);
      if (one.figure != null && !POSES[String(one.figure)]) err(where, `小人没有 "${one.figure}" 这个姿势。可用：${Object.keys(POSES).join(' ')}`);
      for (const w of arr(one.wear)) if (!(ACCESSORIES as readonly string[]).includes(w)) err(where, `小人没有 "${w}" 这个配饰。可用：${ACCESSORIES.join(' ')}`);
    }
    if (relIds.includes(id)) err(where, `角色和关系都叫 "${id}"，换一个名字`);
  }
  for (const [id, r] of Object.entries(plan.relations)) {
    const where = `${W} / relations.${id}`;
    if (!/^[A-Za-z][\w-]*$/.test(id)) err(where, '关系的 id 用英文字母开头的短名（如 lend、tax），场景里画这条关系的箭头要叫这个名字');
    for (const end of [r.from, r.to]) if (!plan.cast[end]) err(where, `"${end}" 不是 cast 里的角色。关系要连两个角色：{ from: 角色, to: 角色, label: 小字 }`);
    if (r.label && wordLen(r.label) > 6) err(where, `label "${r.label}" 太长：箭头上的小字不超过 6 个字`);
  }
  // 系统连没连起来：把角色当点、关系当边，应该是一整张网
  if (castIds.length >= 2) {
    const parent = new Map(castIds.map(c => [c, c])), find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
    for (const r of Object.values(plan.relations)) if (parent.has(r.from) && parent.has(r.to)) parent.set(find(r.from), find(r.to));
    const groups = new Map<string, string[]>(); for (const c of castIds) { const g = find(c); groups.set(g, [...(groups.get(g) ?? []), c]); }
    if (!relIds.length) warn(W, 'relations 是空的：只有一堆角色、没有关系，就不是一个系统。写出谁给谁钱、谁导致谁、谁挡住谁');
    else if (groups.size > 1) warn(W, `系统没有连起来：${[...groups.values()].map(g => `{${g.map(c => plan.cast[c].name).join('、')}}`).join(' 和 ')} 之间没有任何关系。观众看到的会是几张互不相干的图。找出它们之间的那条线（谁影响谁），写进 relations`);
  }

  // ── 板 ──
  const { times, errors } = segmentTimes(plan, al, duration);
  out.push(...errors);
  const tOf = (bi: number, si: number) => times.find(t => t.board === bi && t.seg === si)!;
  const narration = al.flat;
  const seenBoard = new Set<string>(), shownAnywhere = new Set<string>(), linkedAnywhere = new Set<string>();
  const boardIds = new Map<string, Set<string>>();
  plan.boards.forEach((b, bi) => {
    const where = `${W} / ${b.id}`, rb = raw.boards?.[bi] ?? {};
    for (const k of Object.keys(rb)) if (!['id', 'picture', 'size', 'recall', 'hero', 'layout', 'grid', 'regions', 'segments', 'note'].includes(k)) err(where, `板不认识字段 "${k}"。可用：id picture size recall hero layout grid regions segments note`);
    if (b.layout != null && rb.grid != null) err(where, 'layout 和 grid 只写一个：layout 是现成的分区，grid 是自己划分区');
    else if (b.layout != null && !LAYOUTS[b.layout]) { err(where, `没有叫 "${b.layout}" 的版式。可用：${Object.entries(LAYOUTS).map(([k, v]) => `${k}（${v.title}）`).join(' ')}。hj layouts 看每种怎么分；都不合适就自己写 grid`); return; }
    if (!/^[A-Za-z][\w-]*$/.test(b.id)) err(where, '板的 id 用英文字母开头的短名（如 main、credit），场景文件会叫 scenes/NN-<id>.yaml');
    if (seenBoard.has(b.id)) err(where, `板的 id "${b.id}" 重复了`);
    seenBoard.add(b.id);
    // 说的是左右，分的是上下（或反过来）：picture 和 intent 是给用户和执行者看的，方位要和分区对得上
    { const cols = Math.max(1, ...b.grid.areas.map(r => r.length)), rows = b.grid.areas.length, said = [b.picture, ...b.segments.map(s => s.intent)].join(' ');
      const lr = /左栏|右栏|左右两栏|左半|右半/.exec(said), ud = /上半|下半|上下两栏/.exec(said);
      if (lr && cols < 2) warn(where, `picture 或 intent 里写了“${lr[0]}”，但这块板的分区只有一列，是上下排的${b.layout ? `（版式 ${b.layout} 在${fmt.name === 'portrait' ? '竖屏' : '横屏'}下就是这样分的，hj layouts ${b.layout} 可以看）` : ''}。照实际的分区改写成“上面、下面”，或者自己写 grid 分成左右两列`);
      if (ud && rows < 2) warn(where, `picture 或 intent 里写了“${ud[0]}”，但这块板的分区只有一行，是左右排的。照实际的分区改写成“左边、右边”，或者自己写 grid 分成上下两行`);
    }
    if (wordLen(b.picture) < 10) err(where, 'picture 没有写清楚：这块板讲完是一张什么图（有哪几块、什么形状、怎么连）。这句话会原样给用户看');
    // 容量：在规划时就估一下这块板装不装得下，别等画完一百多样东西才发现挤
    { const k = Array.isArray(b.size) ? b.size.map(Number) : [+(b.size ?? 1), +(b.size ?? 1)], area = (k[0] || 1) * (k[1] ?? k[0] ?? 1);
      const chars = [...new Set(b.segments.flatMap(s => s.words))].reduce((n, w) => n + wordLen(w), 0), need = boardNeed(b, fmt.name);
      if (b.autoSize && need > AUTO_MAX + 0.05) warn(where, `这块板的内容按量算要 ${need.toFixed(1)} 屏大，自动定的大小最多 ${AUTO_MAX} 屏，装不下会很挤。把它拆成两块板（后一块 recall 前一块），或者删掉次要的板书和角色；确实要一块板就写 size: ${Math.min(5, Math.ceil(need * 10) / 10)}（全景里的字会更小）`);
      else if (chars > WORDS_PER_SCREEN * area * 0.85) warn(where, `这块板的板书一共 ${chars} 个字，${+area.toFixed(2)} 屏的板放 ${Math.round(WORDS_PER_SCREEN * area)} 个字就满了。画完会显得挤：删掉一些板书（留给字幕），${b.autoSize ? '或者写 size 把板放大' : '或者把 size 调大'}`);
      else if (b.autoSize && +(b.size ?? 1) > 1.6) warn(where, `这块板的内容多，引擎把它放到了 ${b.size} 屏大：全景里每样东西只有原大的 ${Math.round(100 / +(b.size ?? 1))}%，小字会看不清。能拆就拆成两块板（后一块 recall 前一块）；不拆就让主角和关键数字用大字`);
    }
    if (b.recall && !plan.boards.slice(0, bi).some(p => p.id === b.recall)) err(where, `recall 要写前面某块板的 id，没有找到 "${b.recall}"`);
    const { regions, errors: ge } = planRegions(b, fmt);
    for (const m of ge) err(where, m);
    const rnames = Object.keys(regions);
    for (const rn of rnames) { if (!b.regions[rn]) err(where, `分区 "${rn}" 没有说明：在 regions 里写一句这一区放什么`); if (plan.cast[rn] || plan.relations[rn]) err(where, `分区 "${rn}" 和角色或关系重名了，换一个名字`); }
    for (const rn of Object.keys(b.regions)) if (!regions[rn] && !ge.length) err(where, `regions 里的 "${rn}" 不在 grid.areas 里`);
    if (!b.segments.length) { err(where, 'segments 是空的：把这块板对应的口播分成段，每段写往板上添什么'); return; }

    const home = new Map<string, string>(); // 角色 / 关系第一次出现在哪个分区
    const ids = new Set<string>(); boardIds.set(b.id, ids);
    const usedRegions = new Set<string>(), edges: [string, string][] = [];
    let revisits = 0;
    b.segments.forEach((s, si) => {
      const sw = `${where} 第 ${si + 1} 段（${s.at}）`, rs = rb.segments?.[si] ?? {}, tm = tOf(bi, si);
      for (const k of Object.keys(rs)) if (!['at', 'act', 'in', 'intent', 'show', 'link', 'revisit', 'joins', 'words', 'diagram', 'pattern', 'note'].includes(k)) err(sw, `分段不认识字段 "${k}"。可用：at act in intent show link revisit joins diagram pattern words note`);
      if (!s.at) err(sw, '缺少 at：这一段从口播的哪几个字开始');
      if (wordLen(s.intent) < 4) err(sw, '缺少 intent：用一句人话写这一段画面上发生什么');
      if (s.act && !ACTS.includes(s.act)) err(sw, `act 写这段话在论证里干什么，从这些里选：${ACTS.join(' ')}`);
      if (!s.in) err(sw, `缺少 in：这一段画在哪个分区（${rnames.join(' ')}）`);
      else if (!regions[s.in] && !ge.length) err(sw, `in 写了 "${s.in}"，但这块板没有这个分区。有：${rnames.join(' ')}`);
      else usedRegions.add(s.in);
      for (const id of s.show) { if (!plan.cast[id]) err(sw, `show 里的 "${id}" 不是 cast 里的角色。要画的图不是角色时写进 diagram`); else { shownAnywhere.add(id); ids.add(id); if (!home.has(id) && s.in) home.set(id, s.in); } }
      for (const id of s.link) {
        const r = plan.relations[id];
        if (!r) { err(sw, `link 里的 "${id}" 不是 relations 里的关系`); continue; }
        linkedAnywhere.add(id); ids.add(id);
        for (const end of [r.from, r.to]) if (plan.cast[end] && !home.has(end) && !(b.recall && boardIds.get(b.recall)?.has(end))) err(sw, `关系 "${id}" 连着 ${plan.cast[end].name}（${end}），但它到这一段还没出场。先在这一段或更早的 show 里让它出场`);
        if (s.in) { for (const end of [r.from, r.to]) { const h = home.get(end); if (h && h !== s.in) edges.push([h, s.in]); } const hf = home.get(r.from), ht = home.get(r.to); if (hf && ht && hf !== ht) edges.push([hf, ht]); if (!home.has(id)) home.set(id, s.in); }
      }
      for (const id of s.revisit) {
        if (!plan.cast[id] && !plan.relations[id]) { err(sw, `revisit 里的 "${id}" 既不是角色也不是关系`); continue; }
        const h = home.get(id);
        if (!h && !(b.recall && boardIds.get(b.recall)?.has(id))) err(sw, `revisit 是“回头改前面画过的东西”，但 "${id}" 在这之前还没画过`);
        else { revisits++; if (h && s.in && h !== s.in) edges.push([h, s.in]); }
      }
      for (const j of s.joins) {
        if (!regions[j] && !ge.length) err(sw, `joins 里的 "${j}" 不是这块板的分区。有：${rnames.join(' ')}`);
        else if (j === s.in) err(sw, `joins 写的是“这一段画一条线，连到别的哪个分区”，不能是自己所在的分区 "${j}"`);
        else if (s.in) edges.push([j, s.in]);
      }
      if (!s.show.length && !s.link.length && !s.revisit.length && !s.joins.length && !s.diagram && !s.pattern) err(sw, '这一段只有字，没有画：show（让谁出场）、link（画哪条关系）、diagram（画一个什么图）、revisit（回头改谁）、joins（画一条线连到别的分区）至少写一样。只想得到“写几个字”，说明这句话还没想透：它里面的东西是什么、发生了什么');
      if (s.words.length > 4) warn(sw, `这一段要写 ${s.words.length} 处板书，太多了：一段最多三四处，其余的话留给字幕`);
      for (const w of s.words) {
        if (wordLen(w) > 10) err(sw, `板书 "${w}" 有 ${wordLen(w)} 个字：板书只写关键词、数字、标签，不超过 10 个字。整句话留给字幕`);
        const lc = longestCommon(stripPunct(w), narration);
        if (lc >= 7) err(sw, `板书 "${w}" 照抄了口播里连续 ${lc} 个字。画面演示口播，不抄写口播：换成一个数、一个词，或者干脆画出来`);
      }
      if (Number.isFinite(tm.t0) && Number.isFinite(tm.t1)) {
        const d = tm.t1 - tm.t0;
        if (d > 25) warn(sw, `这一段讲了 ${d.toFixed(0)} 秒，只安排了一件事。拆成两三段：这二十几秒里先后提到了什么、发生了什么`);
        if (d < 1.2) warn(sw, `这一段只有 ${d.toFixed(1)} 秒，画不完一样东西。和相邻的段合并`);
      }
    });
    for (const rn of rnames) if (!usedRegions.has(rn)) warn(where, `分区 "${rn}" 没有任何一段画在里面：全景缺了一块。${b.layout ? `版式 ${b.layout} 自带这个分区；用不上就换一种版式（hj layouts），或者自己写 grid` : '去掉它，或者把该放这儿的段落写上'}`);
    // 长线：一条关系的两头住在不挨着的分区里，这条线只能从中间的分区穿过去，压住那里的东西
    for (const id of new Set(b.segments.flatMap(s => s.link))) {
      const r = plan.relations[id], hf = r && home.get(r.from), ht = r && home.get(r.to), A = hf && regions[hf], C = ht && regions[ht];
      if (!r || !A || !C || hf === ht) continue;
      const gx = Math.max(A[0] - (C[0] + C[2]), C[0] - (A[0] + A[2])), gy = Math.max(A[1] - (C[1] + C[3]), C[1] - (A[1] + A[3]));
      if (Math.max(gx, gy) <= 2) continue; // 挨着（共用一条边或一个角）
      const mid = (v: number[]) => [v[0] + v[2] / 2, v[1] + v[3] / 2], [ax, ay] = mid(A), [cx, cy] = mid(C);
      const between = rnames.filter(n => n !== hf && n !== ht && regions[n]).filter(n => { const R = regions[n]; for (let k = 1; k < 20; k++) { const x = ax + ((cx - ax) * k) / 20, y = ay + ((cy - ay) * k) / 20; if (x > R[0] && x < R[0] + R[2] && y > R[1] && y < R[1] + R[3]) return true; } return false; });
      warn(where, `关系 ${id}（${plan.cast[r.from]?.name} → ${plan.cast[r.to]?.name}）的两头分别在分区 "${hf}" 和 "${ht}"，${between.length ? `中间隔着 ${between.map(n => `"${n}"`).join('、')}` : '两个分区不挨着'}：这条线要穿过半块板，压住中间的东西。让其中一个角色在挨着对方的分区出场（改它第一次 show 的那一段的 in）；或者去掉这条关系，讲到这里时回头改对方（revisit）`);
    }
    // 主角：讲完之后第一眼该看到谁。它决定了执行者把谁画得最大、周围留白最多
    const allWords = new Set(b.segments.flatMap(s => s.words).map(norm));
    if (!b.hero) warn(where, `没有指定主角（hero）：这块板讲完后，观众第一眼该看到哪样东西？通常是结论的那个数或那个词。写 hero: "板书原文"（${[...new Set(b.segments.filter(s => s.act === '结论').flatMap(s => s.words))].slice(0, 3).map(w => `"${w}"`).join('、') || 'words 里的一条'}）或一个角色的 id。不指定，板上的东西就一样大，没有主次`);
    else if (!allWords.has(norm(b.hero)) && !(plan.cast[b.hero] && ids.has(b.hero))) err(where, `hero 写的 "${b.hero}" 既不是这块板某一段的板书（words 的原文），也不是在这块板出场的角色。主角必须是板上真有的东西`);
    else if (allWords.has(norm(b.hero)) && wordLen(b.hero) > 6) warn(where, `主角 "${b.hero}" 有 ${wordLen(b.hero)} 个字。主角要画得最大，越短越有力：一个数、一个词（不超过 6 个字）`);
    // 分区之间有没有连起来：关系跨过分区、或者回头去改别的分区里的东西，都算一条连线
    if (rnames.length >= 2) {
      const parent = new Map(rnames.map(r => [r, r])), find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
      for (const [a, c] of edges) if (parent.has(a) && parent.has(c)) parent.set(find(a), find(c));
      const used = rnames.filter(r => usedRegions.has(r)), groups = new Set(used.map(find));
      if (used.length >= 2 && groups.size > 1) {
        const lone = used.filter(r => used.filter(o => find(o) === find(r)).length === 1);
        warn(where, `分区之间没有连起来${lone.length ? `：${lone.map(r => `"${r}"`).join('、')} 是孤岛` : ''}。现在这块板是几页摆在一起，镜头挨个走一遍，和翻页没有区别。三种连法：一条关系跨过分区（两头的角色在不同的分区）；讲到后面时回头去改前面那一区的东西（revisit）；画一条线把两个分区连起来（joins：括号、汇总的箭头、贯穿几行的斜线）`);
      }
    }
    const first = tOf(bi, 0), lastT = tOf(bi, b.segments.length - 1), dur = (lastT?.t1 ?? NaN) - (first?.t0 ?? NaN);
    if (dur >= 45 && !revisits) warn(where, `这块板讲了 ${dur.toFixed(0)} 秒，没有一次回头（revisit）。一块板的好处就是讲到后面能回到前面的图上打叉、改数字、连线；一次都不回头，前面画的东西就只是摆设`);
    if (plan.boards.length >= 2 && dur < 30) warn(where, `这块板只讲 ${dur.toFixed(0)} 秒。板分得太碎就是翻页：把它并进相邻的板，当成那块板的一个分区`);
  });
  for (const id of castIds) if (!shownAnywhere.has(id)) err(`${W} / cast.${id}`, `${plan.cast[id].name} 没有在任何一段出场（show）。用不到就删掉`);
  for (const id of relIds) if (!linkedAnywhere.has(id)) err(`${W} / relations.${id}`, '这条关系没有在任何一段画出来（link）。关系是全片最值钱的几笔，每一条都要落到某一段上');
  // 多块板：板和板之间要有共同的东西，不然就是几条不相干的短片
  if (plan.boards.length >= 2) for (const b of plan.boards) {
    const mine = boardIds.get(b.id) ?? new Set<string>();
    const shared = plan.boards.some(o => o.id !== b.id && [...(boardIds.get(o.id) ?? [])].some(x => mine.has(x)));
    if (!shared && !b.recall && !plan.boards.some(o => o.recall === b.id)) warn(`${W} / ${b.id}`, '这块板和别的板没有任何共同的角色或关系，也没有沿用（recall）。分成几块板时，要有贯穿的东西把它们串起来：同一个角色再出场、一条关系从上一块板连过来，或者先画一张总图、后面每块板 recall 它');
  }
  if (projectDir) { const { story } = loadStory(projectDir); if (story) out.push(...planVsStory(plan, story, al, duration)); }
  return out;
}

/** 导演的简报落到计划里：惊叹那一句单独起一段，让观众猜的那一句也单独起一段 */
function storySegment(plan: Plan, al: Alignment, duration: number, say: string): { seg: PlanSegment; t0: number; t1: number; time: number; board: PlanBoard } | null | undefined {
  let time: number;
  try { time = resolveAnchor(al, say).time; } catch { return undefined; }
  const { times } = segmentTimes(plan, al, duration);
  for (const tm of times) if (Math.abs(tm.anchor - time) < 0.35) { const board = plan.boards[tm.board]; return { seg: board.segments[tm.seg], t0: tm.t0, t1: tm.t1, time, board }; }
  return null;
}
function planVsStory(plan: Plan, story: Story, al: Alignment, duration: number): Issue[] {
  const out: Issue[] = [];
  const aha = storySegment(plan, al, duration, story.aha.say), pre = storySegment(plan, al, duration, story.predict.say);
  if (aha === null) out.push({ level: 'error', where: W, msg: `导演定的惊叹点是“${story.aha.say}”。计划里要有一段正好从这一句开始（at: "${story.aha.say}"）：这一段是全片的揭晓，act 写转折、推翻或结论，intent 写清楚画面怎么变——简报里写的是“${story.aha.see}”` });
  else if (aha && !['转折', '推翻', '结论', '对比', '算账', '数据'].includes(aha.seg.act ?? '')) out.push({ level: 'warn', where: W, msg: `惊叹那一段（${aha.seg.at}）的 act 是“${aha.seg.act ?? '没写'}”。它是全片的揭晓：转折、推翻或结论` });
  if (aha) {
    if (!aha.board.hero) out.push({ level: 'warn', where: `${W} / ${aha.board.id}`, msg: `惊叹点在这块板上，板却没有主角（hero）。揭晓的那样东西就是主角` });
    if (!/变|长|缩|滚|涨|跌|走|流|亮|打开|展开|收|放大|翻/.test(aha.seg.intent)) out.push({ level: 'warn', where: W, msg: `惊叹那一段的 intent“${aha.seg.intent}”没有说画面怎么变。照简报写：${story.aha.see}` });
  }
  if (pre === null) out.push({ level: 'warn', where: W, msg: `导演要观众在“${story.predict.say}”这里先猜一下。给它单独一段（act: 设问）：画面停在问题上，留个问号或空位，答案留到惊叹那一段` });
  return out;
}

/** 由计划生成一块板的场景骨架：角色、关系、板书、每一段的节拍都列好，位置留给执行者 */
/** 计划的卡点是“从上一段往后找”，场景的卡点是“在整块板的口播里找”。同一个词在这块板里出现过几次，就要写成 #n */
function sceneAnchor(al: Alignment, at: string, boardStart: number, time: number): string {
  if (/#\d+/.test(at) === false && !/@end|[+-]\d/.test(at)) {
    const needle = stripPunct(at); let n = 0;
    for (let i = al.flat.indexOf(needle); i >= 0; i = al.flat.indexOf(needle, i + 1)) { const t = al.units[al.flatUnit[i]].start; if (t >= boardStart - 1e-6 && t <= time + 1e-6) n++; }
    return n > 1 ? `${at}#${n}` : at;
  }
  const m = at.match(/^(.*?)#(\d+)(.*)$/); if (!m) return at;
  const needle = stripPunct(m[1]); let n = 0;
  for (let i = al.flat.indexOf(needle); i >= 0; i = al.flat.indexOf(needle, i + 1)) { const t = al.units[al.flatUnit[i]].start; if (t >= boardStart - 1e-6 && t <= time + 1e-6) n++; }
  return n > 1 ? `${m[1]}#${n}${m[3]}` : `${m[1]}${m[3]}`;
}

/** 一段里的板书各在什么时候说到：板书和口播共有的最长一截（至少两个字），在这一段里第一次说出来的时刻。
 *  离段首超过 1.5 秒的，返回成单独的一拍（同一时刻说到的几处合成一拍） */
export function spokenLater(al: Alignment, words: { id: string; w: string }[], t0: number, t1: number): { at: string; time: number; ids: string[] }[] {
  const idx = al.units.map((u, i) => [u, i] as const).filter(([u]) => u.start >= t0 - 1e-6 && u.start < t1 - 1e-6).map(([, i]) => i);
  if (!idx.length) return [];
  const f0 = al.flatUnit.indexOf(idx[0]), f1 = al.flatUnit.lastIndexOf(idx[idx.length - 1]) + 1, seg = al.flat.slice(f0, f1);
  const out: { at: string; time: number; ids: string[] }[] = [];
  for (const { id, w } of words) {
    const p = stripPunct(w);
    let hit: { sub: string; k: number } | null = null;
    for (let n = Math.min(p.length, 8); n >= 2 && !hit; n--) for (let a = 0; a + n <= p.length; a++) { const sub = p.slice(a, a + n), k = seg.indexOf(sub); if (k >= 0 && (!hit || k < hit.k)) hit = { sub, k }; }
    if (!hit) continue;
    const time = al.units[al.flatUnit[f0 + hit.k]].start;
    if (time - t0 < 1.5 || time >= t1 - 0.3) continue;
    const same = out.find(x => Math.abs(x.time - time) < 0.6);
    if (same) same.ids.push(id); else out.push({ at: hit.sub, time, ids: [id] });
  }
  return out.sort((a, b) => a.time - b.time);
}

export function scaffold(plan: Plan, b: PlanBoard, fmt: Format, al: Alignment, duration: number): string {
  const B = boardBox(b, fmt), { regions } = planRegions(b, fmt), L: string[] = [];
  const bi = plan.boards.indexOf(b), ts = segmentTimes(plan, al, duration).times.filter(t => t.board === bi), boardStart = bi === 0 ? 0 : ts[0]?.anchor ?? 0;
  const q = (s: string) => JSON.stringify(s);
  L.push(`# 板 ${b.id}：由 plan.yaml 生成的骨架（hj scaffold）。`, `# 全景：${b.picture}`, '#', '# 开口的位置（from）、全景（intent）、分区（regions）、板的大小（board）都由计划决定，不要在这里写。', `# 画板 ${B.w}×${B.h}。分区的坐标 [x, y, 宽, 高]：`);
  for (const [n, r] of Object.entries(regions)) L.push(`#   ${n.padEnd(8)} [${r.join(', ')}]  ${b.regions[n] ?? ''}`);
  L.push('#', '# 你要做的：给每样东西定位置和大小（in: 分区 之后，at 相对那个分区），把每一拍的 do 写完，把标了“要你画”的图画出来。', '# 不要增删角色（cast）和关系，不要加计划之外超过 4 个字的板书，每一段的 at 不要改。',
    '# 大小写档位，不写数字。字：hero（主角，一块板一处）key（关键数字和词）label（标签、小账）note（批注）；东西：big mid small。',
    ...(b.hero ? [`# 主角：${plan.cast[b.hero] ? plan.cast[b.hero].name : `“${b.hero}”`}。讲完之后它是全板最显眼的东西。`] : []), 'elements:');
  const firstIn = new Map<string, string>(), texts: { id: string; w: string; seg: number }[] = [];
  const local = new Set<string>();
  b.segments.forEach((s, si) => { for (const id of [...s.show, ...s.link]) if (!firstIn.has(id) && s.in) firstIn.set(id, s.in); s.words.forEach(w => { if (!texts.some(t => t.w === w)) texts.push({ id: `w${texts.length + 1}`, w, seg: si }); }); });
  for (const s of b.segments) for (const id of s.show) if (!local.has(id) && plan.cast[id]) { local.add(id); L.push(`  ${id}: { cast: ${id}, size: ${b.hero === id ? 'big' : 'mid'}, in: ${firstIn.get(id)} }    # ${plan.cast[id].name}${b.hero === id ? '（主角）' : ''}`); }
  for (const s of b.segments) for (const id of s.link) if (!local.has(id) && plan.relations[id]) {
    const r = plan.relations[id]; local.add(id);
    const ends = local.has(r.from) && local.has(r.to);
    L.push(`  ${id}: { arrow: [${ends ? `${r.from}, ${r.to}` : `[100, 100], [300, 100]`}]${r.label ? `, label: ${q(r.label)}` : ''} }    # 关系：${plan.cast[r.from]?.name} → ${plan.cast[r.to]?.name}${ends ? '' : '（有一头在沿用的板上或还没定义：把端点改成那个元素的名字）'}`);
  }
  const isHero = (w: string) => !!b.hero && norm(w) === norm(b.hero);
  for (const t of texts) L.push(`  ${t.id}: { text: ${q(t.w)}, size: ${isHero(t.w) ? 'hero' : 'key'}, in: ${b.segments[t.seg].in} }${isHero(t.w) ? '    # 主角：全板最大，周围留白，别的东西不要比它抢眼' : ''}`);
  L.push('beats:');
  b.segments.forEach((s, si) => {
    const draw = [...s.show.filter(id => b.segments.slice(0, si).every(p => !p.show.includes(id))), ...s.link.filter(id => b.segments.slice(0, si).every(p => !p.link.includes(id))), ...texts.filter(t => t.seg === si).map(t => t.id)];
    L.push(`  # ── 第 ${si + 1} 段 · ${s.act ?? ''} · 分区 ${s.in} ──`);
    for (const j of s.joins) L.push(`  # 要你画一条线，把分区 ${j} 和 ${s.in} 连起来（箭头、括号、连线：两头分别落在两个分区里）`);
    if (s.diagram) L.push(`  # 要你画的图：${s.diagram}${s.pattern ? `（可以用手法 ${s.pattern}：hj patterns ${s.pattern}）` : ''}`);
    else if (s.pattern) L.push(`  # 可以用手法 ${s.pattern}：hj patterns ${s.pattern}`);
    // 板书说到才写：这一段口播里过一会儿才说到的板书，单独起一拍卡在说到它的那几个字上
    const later = Number.isFinite(ts[si]?.anchor) ? spokenLater(al, texts.filter(t => t.seg === si).map(t => ({ id: t.id, w: t.w })), ts[si].anchor, ts[si].t1) : [];
    const lateIds = new Set(later.flatMap(x => x.ids)), first = draw.filter(id => !lateIds.has(id));
    L.push(`  - at: ${q(Number.isFinite(ts[si]?.anchor) ? sceneAnchor(al, s.at, boardStart, ts[si].anchor) : s.at)}`, `    intent: ${q(s.intent)}`, '    do:');
    if (first.length) L.push(`      - draw: [${first.join(', ')}]`);
    for (const id of s.revisit) L.push(`      - draw: { mark: circle, target: ${id} }    # 回头改 ${plan.cast[id]?.name ?? id}：换成更贴切的动作（打叉、划掉、改数字、换表情、再连一条线）`);
    if (!first.length && !s.revisit.length) L.push(later.length ? '      - wait: 0.1    # 这一段先说的话还没有画面：把这一段要画的东西放到这一拍' : '      - wait: 0.1    # 这一段的图还没画：在 elements 里定义它，然后在这里 draw');
    for (const x of later) L.push(`  - at: ${q(sceneAnchor(al, x.at, boardStart, x.time))}    # 说到“${x.at}”才写（${fmtT(x.time)}）`, `    intent: ${q(`写下${x.ids.map(id => `“${texts.find(t => t.id === id)!.w}”`).join('、')}`)}`, '    do:', `      - draw: [${x.ids.join(', ')}]`);
  });
  return L.join('\n') + '\n';
}

/** 给用户确认的分镜表：由计划排出来，这时候还没有任何画面 */
export function planStoryboard(plan: Plan, meta: any, al: Alignment, fmt: Format, duration: number, issues: Issue[]): string {
  const L: string[] = [], { times } = segmentTimes(plan, al, duration);
  const nm = (id: string) => plan.cast[id]?.name ?? id;
  const lookOf = (l: any): string => (!l || typeof l !== 'object' ? '' : 'crowd' in l ? `一群（${l.crowd} 个）${lookOf(l.of)}` : l.doodle ? `手绘件 ${l.doodle}` : l.figure ? `小人${l.wear ? `，戴 ${arr(l.wear).join('、')}` : ''}` : l.icon ? `图标 ${l.icon}` : l.image ? `图片 ${l.image}` : l.video ? `视频 ${l.video}` : '自己画的图形');
  L.push(`# 分镜计划：${meta.title ?? '未命名'}`, '');
  L.push(`画幅 ${fmt.name === 'portrait' ? '竖屏 9:16' : '横屏 16:9'} · 时长 ${fmtT(duration)} · ${plan.boards.length} 块板 · 计划版本 \`${plan.hash}\``, '');
  L.push('> 这是动笔之前的计划，还没有画面，只有一张结构草图（`out/review/plan.png`，和这份表一起看）。请按这个顺序看：**论点**对不对；**角色和关系**是不是这件事的骨架；每块板的**全景**和**分区**；最后逐段看“画面”一栏是不是在**演示**口播讲的事，而不是把话再写一遍。确认之后才会开始画。', '');
  L.push(`**论点：** ${plan.thesis}`, '');
  L.push('## 角色', '', '| 角色 | 长相（全片不变） |', '|---|---|');
  for (const c of Object.values(plan.cast)) L.push(`| ${c.name} | ${lookOf(c.look)} |`);
  L.push('', '## 关系（这件事的骨架）', '');
  if (!Object.keys(plan.relations).length) L.push('（没有）');
  for (const r of Object.values(plan.relations)) L.push(`- ${nm(r.from)} →${r.label ? ` ${r.label} →` : ''} ${nm(r.to)}`);
  L.push('');
  plan.boards.forEach((b, bi) => {
    const ts = times.filter(t => t.board === bi), B = boardBox(b, fmt);
    L.push(`## ${plan.boards.length > 1 ? `第 ${bi + 1} 块板：` : ''}${b.id}　${fmtT(Math.max(0, ts[0]?.t0 ?? 0))}–${fmtT(ts[ts.length - 1]?.t1 ?? duration)}`, '');
    L.push(`**全景：** ${b.picture}`, '');
    if (b.hero) L.push(`**主角（讲完后第一眼看到的）：** ${plan.cast[b.hero] ? plan.cast[b.hero].name : `“${b.hero}”`}`, '');
    if (b.layout && LAYOUTS[b.layout]) L.push(`**版式：** ${LAYOUTS[b.layout].title}（${LAYOUTS[b.layout].link}）`, '');
    if (B.w > fmt.board.w + 1 || B.h > fmt.board.h + 1) L.push(`这块板比屏幕大（${+(B.w / fmt.board.w).toFixed(2)} 屏宽、${+(B.h / fmt.board.h).toFixed(2)} 屏高${b.autoSize ? '，引擎按这块板的内容量定的；想自己定就写 size' : ''}）：全景是缩小的整块板，镜头走近才是原大。`, '');
    if (b.recall) L.push(`板上一开始就有 ${b.recall} 那块板留下的画面，在它上面接着讲。`, '');
    L.push('板面怎么分：', '', '```');
    const dw = (n: string) => [...n].reduce((k, ch) => k + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0), wd = Math.max(...b.grid.areas.flat().map(dw), 4) + 2;
    for (const row of b.grid.areas) L.push(row.map(n => `[ ${n}${' '.repeat(wd - dw(n) - 1)}]`).join(''));
    L.push('```', '', '| 分区 | 放什么 |', '|---|---|');
    for (const [n, d] of Object.entries(b.regions)) L.push(`| ${n} | ${d} |`);
    L.push('', '| 时间 | 口播 | 这段在干什么 | 分区 | 画面 | 板书 |', '|---|---|---|---|---|---|');
    b.segments.forEach((s, si) => {
      const t = ts[si], say = Number.isFinite(t?.t0) ? al.units.filter(u => u.start >= t.t0 - 1e-6 && u.start < t.t1 - 1e-6).map(u => u.display).join('') : '（锚点没找到）';
      const extra = [s.show.length ? `出场：${s.show.map(nm).join('、')}` : '', s.link.length ? `连线：${s.link.map(id => { const r = plan.relations[id]; return r ? `${nm(r.from)}→${nm(r.to)}` : id; }).join('、')}` : '', s.diagram ? `图：${s.diagram}` : '', s.revisit.length ? `回头改：${s.revisit.map(id => plan.relations[id] ? `${nm(plan.relations[id].from)}→${nm(plan.relations[id].to)}` : nm(id)).join('、')}` : '', s.joins.length ? `连到分区：${s.joins.join('、')}` : ''].filter(Boolean).join('；');
      L.push(`| ${Number.isFinite(t?.t0) ? fmtT(Math.max(0, t.t0)) : '?'} | ${say} | ${s.act ?? ''} | ${s.in ?? ''} | ${s.intent}${extra ? `<br>${extra}` : ''} | ${s.words.join('、')} |`);
    });
    L.push('');
  });
  const warns = issues.filter(i => i.level === 'warn');
  if (warns.length) { L.push('## 尚未解决的问题', '', '下面是自动检查发现、但规划者没有处理的问题。确认前请留意：', ''); for (const w of warns) L.push(`- **${w.where}**：${w.msg}`); L.push(''); }
  return L.join('\n');
}

/** 执行者有没有照计划做：角色、关系、分段的卡点、回头、板书 */
export function conform(c: Compiled): Issue[] {
  const plan = c.plan; if (!plan) return [];
  const out: Issue[] = [];
  const err = (where: string, msg: string) => out.push({ level: 'error', where, msg });
  const warn = (where: string, msg: string) => out.push({ level: 'warn', where, msg });
  const { times } = segmentTimes(plan, c.al, c.duration);
  const allowed = new Set<string>();
  for (const cst of Object.values(plan.cast)) allowed.add(norm(cst.name));
  for (const r of Object.values(plan.relations)) if (r.label) allowed.add(norm(r.label));
  for (const b of plan.boards) for (const s of b.segments) for (const w of s.words) allowed.add(norm(w));

  plan.boards.forEach((b, bi) => {
    const sc = c.scenes.find(s => s.id === b.id);
    if (!sc) return; // 缺场景文件在编译时已经报过
    const use = c.castUse?.get(sc.file) ?? { els: new Map<string, string>(), pattern: new Set<string>(), declared: new Set<string>() };
    const tls = c.tls.filter(t => t.scene === sc.index), shownAt = (t: TL) => t.recalled ? sc.t0 - 1 : t.drawT0 ?? t.appear?.t ?? NaN;
    /** 代表某个角色 / 关系的元素（人群的成员叫 <id>1…<id>N） */
    const elsOf = (id: string): TL[] => tls.filter(t => { if (t.el.id === id && plan.relations[id]) return true; for (const [eid, cn] of use.els) if (cn === id && (t.el.id === eid || (t.el.id.startsWith(eid) && /^\d+$/.test(t.el.id.slice(eid.length))))) return true; return false; });
    const firstShown = (id: string) => Math.min(...elsOf(id).map(shownAt).filter(Number.isFinite), Infinity);
    const acts = sc.beats.flatMap(be => be.actions);
    const introduced = new Set<string>();
    b.segments.forEach((s, si) => {
      const tm = times.find(t => t.board === bi && t.seg === si)!; if (!Number.isFinite(tm.t0)) return;
      const where = `${sc.file} / 第 ${si + 1} 段（${s.at}）`, t0 = tm.t0, t1 = tm.t1;
      if (!sc.beats.some(be => Math.abs(be.anchor - tm.anchor) < 0.08)) { const want = sceneAnchor(c.al, s.at, bi === 0 ? 0 : sc.t0, tm.anchor); err(where, `计划里这一段从 "${s.at}"（${fmtT(tm.anchor)}）开始，场景里没有卡在这一刻的节拍。加一拍 at: "${want}"（一段里可以再加别的拍，但段的起点不能丢）`); }
      for (const id of s.show) {
        if (introduced.has(id)) continue; introduced.add(id);
        const ft = firstShown(id);
        if (!elsOf(id).length) { if (!use.pattern.has(id)) err(where, `计划要 ${plan.cast[id].name}（${id}）在这一段出场，场景里没有它。在 elements 里写 ${id}: { cast: ${id}, in: ${s.in} }，然后在这一段 draw`); }
        else if (ft === Infinity) err(where, `${plan.cast[id].name}（${id}）定义了但从没画出来。计划要它在这一段出场：在这一段的节拍里 draw`);
        else if (ft < t0 - 1.2 && ft >= sc.t0) err(where, `${plan.cast[id].name}（${id}）在 ${fmtT(ft)} 就画了，但计划是说到 "${s.at}"（${fmtT(t0)}）才出场。说到什么，才画什么`);
        else if (ft >= t1) err(where, `${plan.cast[id].name}（${id}）到 ${fmtT(ft)} 才画，但计划是在这一段（${fmtT(t0)}–${fmtT(t1)}）出场`);
      }
      for (const id of s.link) {
        if (introduced.has(id)) continue; introduced.add(id);
        const r = plan.relations[id], ft = firstShown(id);
        if (!elsOf(id).length) err(where, `计划要在这一段画出关系 ${id}（${plan.cast[r.from]?.name} → ${plan.cast[r.to]?.name}），场景里没有叫 "${id}" 的元素。画这条关系的箭头（或连线）要叫这个名字：${id}: { arrow: [${r.from}, ${r.to}]${r.label ? `, label: ${r.label}` : ''} }`);
        else if (ft === Infinity) err(where, `关系 ${id} 定义了但从没画出来：在这一段的节拍里 draw`);
        else if (ft < t0 - 1.2 || ft >= t1) err(where, `关系 ${id} 在 ${fmtT(ft)} 画，但计划是在这一段（${fmtT(t0)}–${fmtT(t1)}）`);
      }
      let revisited = false;
      for (const id of s.revisit) {
        const olds = new Set(elsOf(id).filter(t => shownAt(t) < t0 - 0.3).map(t => t.el.id));
        const touched = acts.some(a => a.t0 >= t0 - 0.6 && a.t0 < t1 && a.verb !== 'camera' && a.ids.some(i => olds.has(i) && a.verb !== 'draw'))
          || tls.some(t => { const st = shownAt(t); if (!(st >= t0 - 0.6 && st < t1)) return false; const tg = t.el.src?.target, ends = [].concat(t.el.src?.arrow ?? [], t.el.src?.line ?? []).filter((x: any) => typeof x === 'string').map((x: string) => x.split('.')[0]); return arr(tg).some(x => olds.has(x)) || (ends as string[]).some(x => olds.has(x)); });
        if (touched) revisited = true;
        if (!touched) err(where, `计划要在这一段回头改 ${plan.cast[id]?.name ?? '关系 ' + id}（${id}），这一段里没有任何动作落在它身上。在它上面打叉、划掉、圈出来（mark），加批注（note），换姿势表情，或者从它再连一条线出去`);
      }
      // 这一段有没有真的画东西（不是只写字）
      const news = tls.filter(t => { const st = shownAt(t); return st >= t0 - 1.2 && st < t1; });
      const nonText = news.some(t => !['text', 'note'].includes(t.el.kind) && !(t.el.kind === 'shape' && t.el.src?.inside != null)) /* 框里写字还是字 */ || acts.some(a => a.t0 >= t0 - 0.6 && a.t0 < t1 && !['draw', 'camera', 'wait', 'pop', 'fade', 'count'].includes(a.verb));
      const hit = (bx: { x: number; y: number; w: number; h: number }, rn: string) => { const r = sc.regions?.find(x => x.name === rn)?.box; return !!r && bx.x < r.x + r.w && bx.x + bx.w > r.x && bx.y < r.y + r.h && bx.y + bx.h > r.y; };
      for (const j of s.joins) if (s.in && !news.some(t => ['arrow', 'line', 'mark', 'span', 'shape'].includes(t.el.kind) && hit(t.el.box, j) && hit(t.el.box, s.in!))) err(where, `计划要在这一段画一条线，把分区 "${j}" 和 "${s.in}" 连起来，这一段新画的东西里没有哪一条线同时碰到这两个分区。画一条箭头、连线或括号，两头分别落在两个分区里`);
      if (!nonText && !revisited) err(where, news.length ? '这一段只写了字，没有画任何东西。计划里这一段是有画面的：把它画出来（手绘件、小人、箭头、横条、图表、标记）' : '这一段什么都没画。照计划的 intent 把它画出来');
      // 画在计划指定的分区里
      const rg = sc.regions?.find(r => r.name === s.in);
      if (rg) {
        const body = news.filter(t => !['arrow', 'line', 'mark', 'note', 'axis'].includes(t.el.kind));
        const inside = body.filter(t => { const bx = t.el.box, cx = bx.x + bx.w / 2, cy = bx.y + bx.h / 2; return cx >= rg.box.x - 20 && cx <= rg.box.x + rg.box.w + 20 && cy >= rg.box.y - 20 && cy <= rg.box.y + rg.box.h + 20; });
        if (body.length >= 2 && inside.length < body.length / 2) warn(where, `计划把这一段放在分区 "${s.in}"，但这一段新画的 ${body.length} 样东西里只有 ${inside.length} 样在里面。给它们写 in: ${s.in}`);
      }
    });
    // 计划之外的东西
    for (const t of tls) {
      if (!use.declared.has(t.el.id) || t.recalled) continue;
      if (['figure', 'doodle', 'icon', 'image', 'video'].includes(t.el.kind) && !use.els.has(t.el.id)) err(`${sc.file} / 元素 ${t.el.id}`, `这是计划之外的东西：它不是从角色表来的。执行者不添角色。它是计划里的某个角色就写成 { cast: 角色名, … }；确实需要一样新东西，请规划者把它加进 plan.yaml 的 cast`);
    }
    const extras: string[] = [];
    for (const t of tls) {
      if (t.recalled || (t.drawT0 == null && !t.appear)) continue;
      const strs = [t.el.src?.text, t.el.src?.note, t.el.src?.label, t.el.src?.inside].filter((x: any) => typeof x === 'string' || typeof x === 'number').map(String);
      for (const s0 of strs) {
        const whole = norm(s0.replace(/\n/g, '')); if (!whole || allowed.has(whole) || s0.split('\n').every(ln => allowed.has(norm(ln)))) continue;
        if (wordLen(whole) > 4) err(`${sc.file} / 元素 ${t.el.id}`, `板书 "${s0.replace(/\n/g, ' ')}" 不在计划里。执行者可以自己加不超过 4 个字的小标签，更长的字必须是计划 words 里的原文。要么删掉、换成画，要么请规划者加进计划`);
        else extras.push(whole);
      }
    }
    // 主角是不是板上最显眼的：字最大，或者东西最大
    if (b.hero) {
      const alive = tls.filter(t => !t.recalled && (t.drawT0 != null || t.appear) && !(t.gone != null && t.gone < sc.t1 - 0.3));
      const szOf = (t: TL) => +(t.el.src?.size ?? 72);
      if (plan.cast[b.hero]) {
        const mine = elsOf(b.hero).filter(t => alive.includes(t)), big = (t: TL) => Math.max(t.el.body?.w ?? t.el.box.w, t.el.body?.h ?? t.el.box.h);
        const rival = alive.filter(t => ['figure', 'doodle', 'icon', 'image', 'video', 'parts'].includes(t.el.kind) && !mine.includes(t)).sort((x, y) => big(y) - big(x))[0];
        if (!mine.length) warn(sc.file, `主角 ${plan.cast[b.hero].name}（${b.hero}）到这块板讲完时已经不在板上了。主角要留到最后`);
        else if (rival && big(rival) > Math.max(...mine.map(big)) * 0.95) warn(`${sc.file} / 元素 ${mine[0].el.id}`, `计划的主角是 ${plan.cast[b.hero].name}，但 "${rival.el.id}" 画得和它一样大或更大。主角写 size: big，其余的东西写 mid 或 small`);
      } else {
        const mine = alive.filter(t => t.el.kind === 'text' && norm(String(t.el.src?.text ?? '')) === norm(b.hero!));
        const rival = alive.filter(t => t.el.kind === 'text' && !mine.includes(t)).sort((x, y) => szOf(y) - szOf(x))[0];
        if (!mine.length) warn(sc.file, `主角“${b.hero}”到这块板讲完时不在板上（没画，或者被擦掉了）。主角要留到最后：它是观众带走的那一样东西`);
        else if (rival && szOf(rival) > Math.max(...mine.map(szOf)) / 1.3) warn(`${sc.file} / 元素 ${mine[0].el.id}`, `计划的主角是“${b.hero}”（字号 ${Math.max(...mine.map(szOf))}），但“${String(rival.el.src?.text).replace(/\n/g, ' ')}”的字号是 ${szOf(rival)}，差得不够开，一眼分不出谁是主角。主角写 size: hero，其余的字用 key / label / note`);
        else {
          // 主角周围要有留白：外扩一圈里不该挤着别的东西
          const hb = mine[0].el.box, pad = Math.min(hb.h * 0.35, 40), crowd = alive.filter(t => t !== mine[0] && !['mark', 'arrow', 'line', 'axis', 'note'].includes(t.el.kind) && !arr(t.el.src?.target).includes(mine[0].el.id) && t.el.solid.x < hb.x + hb.w + pad && t.el.solid.x + t.el.solid.w > hb.x - pad && t.el.solid.y < hb.y + hb.h + pad && t.el.solid.y + t.el.solid.h > hb.y - pad);
          if (crowd.length >= 2) warn(`${sc.file} / 元素 ${mine[0].el.id}`, `主角“${b.hero}”被 ${crowd.slice(0, 4).map(t => `"${t.el.id}"`).join('、')} 贴着围住了。主角靠留白显出来：把它们挪开一点（至少隔开半个字高），或者挪到主角的同一侧排整齐`);
        }
      }
    }
    const planned = new Set(b.segments.flatMap(s => s.words)).size;
    if (extras.length > Math.max(6, planned)) warn(sc.file, `这块板上有 ${extras.length} 处计划之外的小字（计划里的板书一共 ${planned} 处）：${[...new Set(extras)].slice(0, 8).join('、')}…。小标签加多了，板就成了字堆`);
  });
  // 惊叹那一段：画面上的东西要在观众眼前变，不能只是又画了一样新东西
  const { story } = loadStory(c.dir);
  if (story) {
    const aha = storySegment(plan, c.al, c.duration, story.aha.say);
    const sc = aha ? c.scenes.find(x => x.id === aha.board.id) : undefined;
    if (aha && sc) {
      const acts = sc.beats.flatMap(be => be.actions).filter(a => a.t0 >= aha.t0 - 0.6 && a.t0 < aha.t1);
      const moved = acts.filter(a => (MOVES as readonly string[]).includes(a.verb));
      const where = `${sc.file} / 惊叹那一段（${aha.seg.at}）`;
      if (!moved.length) err(where, `这一段是全片的揭晓，导演要的是：${story.aha.see}。用一个“变”的动作做出来（${MOVES.join(' ')}），不要只是再画一样新东西。简报写的是 ${story.aha.move}`);
      else if (!moved.some(a => a.verb === story.aha.move)) warn(where, `简报定的揭晓动作是 ${story.aha.move}，这一段用的是 ${[...new Set(moved.map(a => a.verb))].join('、')}。换了做法要有理由，向用户说明`);
    }
  }
  return out;
}
