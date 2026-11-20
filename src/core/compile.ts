// 编译器：项目目录（project.yaml + scenes/*.yaml + 时间表）→ 一条算好绝对时间的时间线。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { loadAlignment, resolveAnchor, buildSubtitles, type Alignment, type SubLine } from './alignment';
import { buildElement, SrcError, KINDS, THING_TIERS, depsOf, decimalsOf, loadDoodle, type El, type BuildCtx } from './elements';
import { EASES, numberIn, remade, type Morph } from './live';
import { POSES, FACES, type Pose } from './figure';
import { FORMATS, THEME, color, setStyle, isInk, type Format } from './theme';
import { type Pt, type Box, type Stroke, unionBox, cloneStrokes } from './strokes';
import { PATTERNS } from './patterns';
import { loadPlan, planRegions, checkPlan, boardSizes, type Plan } from './plan';
import { loadAppendix, layoutAppendix, appendixTiming, APPENDIX_DELAY, type AppendixLayout } from './appendix';

export interface Issue { level: 'error' | 'warn' | 'info'; where: string; msg: string }
export interface Tween { t0: number; t1: number; from: number; to: number; ease?: string }
export interface TL {
  el: El; order: number; scene: number;
  drawT0?: number; drawT1?: number; sched?: Float64Array; // 每笔 [起, 止]
  appear?: { t: number; kind: 'pop' | 'fade'; dur: number };
  moves: { t0: number; t1: number; from: Pt; to: Pt; path?: number[]; base?: Pt; linear?: boolean; ease?: string }[];
  alpha: Tween[]; scale: Tween[];
  shakes: { t0: number; t1: number; kind: 'shake' | 'pulse' | 'nod' }[];
  poses: { t0: number; t1: number; from: Pose; to: Pose; faceFrom: string; faceTo: string }[];
  erase?: number; // 所属擦除组
  gone?: number;
  compress?: number;
  /** 从前面的场景沿用过来的：进场时已经在板上 */
  recalled?: boolean;
  /** 参数随时间的变化（change / grow / count） */
  morphs: Morph[];
  /** 它引用的、会挪动或变化的元素：它们一变，它就照新的样子重新生成（箭头跟着两头走、标签跟着横条走） */
  live?: string[];
  /** become 时从原地走过去、变成另一样东西的那个替身 */
  ghost?: boolean;
  /** 换一组参数、按另一组周围元素重新生成自己（不再避让） */
  remake?: (patch: Record<string, any>, els: Map<string, El>) => El;
}
/** 流动：小记号沿着一条或几条首尾相接的线走（钱在转、货在送、消息在传） */
export interface FlowFx { scene: number; t0: number; t1: number; ids: string[]; token: Stroke[]; n: number; loop: number }
/** 点亮：顺着一条线用荧光笔描一遍，until 之后淡掉 */
export interface TraceFx { scene: number; id: string; t0: number; t1: number; color: string; w: number; until: number }
export interface EraseGroup { t0: number; t1: number; style: 'wipe' | 'fade'; path: number[]; width: number; scene: number }
export interface CamSeg { t0: number; t1: number; to: Cam; cut?: boolean; /** 对准的是一个分区（一块地盘），不是具体的东西 */ region?: boolean }
export interface Cam { cx: number; cy: number; zoom: number }
export interface CAction { verb: string; ids: string[]; t0: number; t1: number; natural: number; desc: string }
export interface CBeat { at: string | number; t: number; /** 卡点那几个字开口的时刻（t 是减去 lead 之后的起笔时刻） */ anchor: number; tEnd: number; intent: string; actions: CAction[]; say: string; shaky: boolean; compress: number }
export interface CScene { recall?: string; id: string; file: string; index: number; t0: number; t1: number; origin: Pt; intent: string; enter: string; beats: CBeat[]; els: string[]; say: string; home: Cam; regions?: { name: string; box: Box }[]; /** 这块板的画板（可能比屏幕大） */ board: Box; /** 这块板在世界里占的宽度 */ span: number }
export interface Compiled {
  dir: string; meta: any; fmt: Format; fps: number; al: Alignment; duration: number;
  scenes: CScene[]; tls: TL[]; erases: EraseGroup[]; cams: CamSeg[]; subs: SubLine[]; issues: Issue[];
  /** 第一道确认（计划 / 文字分镜）认的版本 */
  planHash: string;
  /** 第二道确认（关键帧）认的版本：计划加上每一拍画什么 */
  keyHash: string;
  /** 规划者的计划（有 plan.yaml 时） */
  plan?: Plan;
  /** 整条片子多长：口播讲完（duration）再加上附录 */
  total: number;
  /** 片尾的滚动附录：排在最后一块板的正下方，t0 起镜头往下走 */
  /** 片尾附录：t0 起全景虚化，附录顶端从画面上的 start 滚上去 dist 像素（屏幕坐标），t1 结束 */
  appendix?: { layout: AppendixLayout; t0: number; t1: number; from: Cam; start: number; dist: number; speed: number };
  castUse?: Map<string, CastUse>;
  /** 画在元素之上的效果：流动的小记号、点亮的路线 */
  fx: { flows: FlowFx[]; traces: TraceFx[]; /** become 时走过去的替身：只画，不进元素清单 */ ghosts: TL[] };
}

const NATURAL: Record<string, number> = { expand: 1.0, collapse: 0.9, become: 1.4, change: 0.8, grow: 0.9, count: 1.1, move: 0.6, walk: 1.1, scale: 0.5, pose: 0.35, face: 0.15, pop: 0.3, fade: 0.35, hide: 0.2, erase: 0.55, camera: 1.1, shake: 0.5, pulse: 0.45, nod: 0.5 };
const VERBS = ['draw', 'erase', 'move', 'walk', 'scale', 'change', 'grow', 'count', 'flow', 'become', 'trace', 'expand', 'collapse', 'pose', 'face', 'pop', 'fade', 'hide', 'shake', 'pulse', 'nod', 'camera', 'wait'];
const ACTION_OPTS = ['dur', 'at', 'with', 'to', 'from', 'by', 'along', 'style', 'face', 'pad', 'zoom', 'delay', 'ease', 'token', 'n', 'loop', 'keep', 'color', 'size'];
const pathLen = (p?: number[]) => { let L = 0; if (p) for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return L; };
/** change 能改哪些参数：每种元素只开放几样，改的是“量”，不是换一样东西 */
const CHANGE_KEYS: Record<string, string[]> = { span: ['span', 'h', 'color'], chart: ['data', 'color'], shape: ['w', 'h', 'size', 'color'], text: ['color'], note: ['color'], arrow: ['color'], line: ['color'], mark: ['color'], doodle: ['color'], icon: ['color'], parts: ['color'] };
/** 让元素出现的动作 */
const APPEAR = ['draw', 'pop', 'fade', 'grow', 'count'];
const SCENE_GAP = 260;
/** 自动取景最多推近多少：再大线条会显得粗笨 */
const FRAME_MAX = 1.4;

export function naturalDraw(el: El): number {
  let d = 0;
  for (const s of el.strokes) d += weight(s) / THEME.pace.px;
  return Math.max(THEME.pace.min, d);
}
/** 一笔占多少“时间份额”：上色的排线是快速涂抹，只算三分之一 */
// 很细的线（导入的墨块人物的描边）一带而过，不按正常落笔算
const weight = (s: any) => ((s.under ? 0.2 : s.kind === 'line' && s.w < 3 ? 0.3 : 1) * s.len + penUp(s) * (s.under ? 0.4 : 1));
const penUp = (s: { kind: string; len: number }) => ((s as any).deco ? 0 : s.kind === 'line' && (s as any).w < 3 ? 1.5 : s.kind === 'fglyph' ? 40 : s.kind === 'wipe' ? 10 : (s as any).flat ? 10 : Math.min(75, 18 + s.len * 0.3));

export interface CastUse { /** 元素名 → 它是哪个角色 */ els: Map<string, string>; /** 手法的参数里用到的角色 */ pattern: Set<string>; /** 场景文件里直接写出来的元素名 */ declared: Set<string> }
export function loadProject(dir: string): { meta: any; scenes: { file: string; src: any }[]; plan: Plan | null; planIssues: Issue[]; castUse: Map<string, CastUse> } {
  const pf = join(dir, 'project.yaml');
  if (!existsSync(pf)) throw new Error(`${dir} 里没有 project.yaml，这不是一个画讲项目（用 hj init 创建）`);
  const meta = YAML.parse(readFileSync(pf, 'utf8')) ?? {};
  setStyle(meta.style === 'ink' ? 'ink' : 'color');
  const sd = join(dir, 'scenes');
  const files = existsSync(sd) ? readdirSync(sd).filter(f => /\.ya?ml$/.test(f)).sort() : [];
  let scenes = files.map(f => {
    try { return { file: 'scenes/' + f, src: YAML.parse(readFileSync(join(sd, f), 'utf8'), { prettyErrors: true }) ?? {} }; }
    catch (e: any) { throw new Error(`scenes/${f} 的 YAML 写错了：${e.message}`); }
  });
  // 计划：有 plan.yaml 时，板的划分、开口位置、全景、分区、板的大小、角色表都由它决定，场景文件只管“怎么画”
  const plan = loadPlan(dir), planIssues: Issue[] = [];
  const sceneId = (s: { file: string; src: any }) => String(s.src.id ?? basename(s.file).replace(/\.ya?ml$/, '').replace(/^\d+[-_]?/, ''));
  // 角色表：全片反复出现的人和东西，长相只定义一次
  const cf = join(dir, 'cast.yaml');
  let cast: Record<string, any> = {};
  if (existsSync(cf)) { try { cast = YAML.parse(readFileSync(cf, 'utf8')) ?? {}; } catch (e: any) { throw new Error(`cast.yaml 的 YAML 写错了：${e.message}`); } }
  if (typeof cast !== 'object' || Array.isArray(cast)) throw new Error('cast.yaml 应该是 "角色名: 元素定义" 的映射');
  if (plan) {
    cast = { ...cast, ...Object.fromEntries(Object.entries(plan.cast).filter(([, v]) => v.look && typeof v.look === 'object').map(([k, v]) => [k, v.look])) };
    const fmt = FORMATS[meta.format ?? 'portrait'] ?? FORMATS.portrait;
    for (const s of scenes) if (!plan.boards.some(b => b.id === sceneId(s))) planIssues.push({ level: 'error', where: s.file, msg: `计划里没有叫 "${sceneId(s)}" 的板。场景文件和计划的板一一对应（文件名去掉序号就是板的 id）；计划的板有：${plan.boards.map(b => b.id).join(' ')}。要加一块板，请规划者改 plan.yaml` });
    const ordered: typeof scenes = [];
    plan.boards.forEach((b, bi) => {
      const s = scenes.find(x => sceneId(x) === b.id);
      if (!s) { planIssues.push({ level: 'error', where: `plan.yaml / ${b.id}`, msg: `这块板还没有场景文件。运行 hj scaffold ${dir} 生成骨架（scenes/${String(bi + 1).padStart(2, '0')}-${b.id}.yaml），再把它画完` }); return; }
      for (const k of ['regions', 'board', 'recall']) if (s.src[k] != null) planIssues.push({ level: 'error', where: s.file, msg: `场景里不要写 ${k}：它由计划决定（plan.yaml 里这块板的 ${k === 'regions' ? 'grid' : k === 'board' ? 'size' : 'recall'}）。删掉这一行；要改请规划者改计划` });
      const from = b.segments[0]?.at;
      if (s.src.from != null && String(s.src.from).trim() !== String(from).trim()) planIssues.push({ level: 'error', where: s.file, msg: `from 由计划决定（这块板第一段的 at："${from}"），场景里写的不一样。删掉这一行` });
      const { regions } = planRegions(b, fmt);
      s.src = { ...s.src, from, intent: s.src.intent ?? b.picture, regions, ...(b.size != null ? { board: b.size } : {}), ...(b.recall ? { recall: b.recall } : {}) };
      if (bi === 0) delete s.src.from;
      ordered.push(s);
    });
    scenes = ordered;
  }
  const bad: string[] = [];
  const castUse = new Map<string, CastUse>();
  const useCast = (v: any, seen?: Set<string>): any => {
    if (Array.isArray(v)) return v.map(x => useCast(x, seen));
    if (!v || typeof v !== 'object') return v;
    const o: any = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, useCast(x, seen)]));
    if (typeof o.cast === 'string') { const base = cast[o.cast]; if (!base) { bad.push(o.cast); return o; } seen?.add(o.cast); const { cast: _c, ...rest } = o; void _c;
      // 角色是一群时，写在外面的 size 是每一个的大小：骨架给每个角色都写 size，一群也要能用
      if (base && typeof base === 'object' && 'crowd' in base && rest.size != null) { const { size, ...r2 } = rest; return { ...base, ...r2, of: { ...base.of, size } }; }
      return { ...base, ...rest }; }
    return o;
  };
  for (const sc of scenes) {
    const use: CastUse = { els: new Map(), pattern: new Set(), declared: new Set(Object.keys(sc.src.elements && typeof sc.src.elements === 'object' ? sc.src.elements : {})) };
    for (const [eid, e] of Object.entries(sc.src.elements && typeof sc.src.elements === 'object' ? sc.src.elements : {}) as [string, any][]) { const cn = e?.cast ?? e?.of?.cast; if (typeof cn === 'string') use.els.set(eid, cn); }
    castUse.set(sc.file, use);
    for (const k of ['pattern', 'elements', 'beats']) if (sc.src[k] != null) sc.src[k] = useCast(sc.src[k], k === 'pattern' ? use.pattern : undefined);
  }
  if (bad.length) throw new Error(`${plan ? 'plan.yaml 的 cast' : 'cast.yaml'} 里没有这些角色：${[...new Set(bad)].join('、')}。已有：${Object.keys(cast).join('、') || '（空）'}`);
  return { meta, scenes, plan, planIssues, castUse };
}

export function compile(dir: string): Compiled {
  const { meta, scenes: srcScenes, plan, planIssues, castUse } = loadProject(dir);
  const issues: Issue[] = [...planIssues];
  const err = (where: string, msg: string) => issues.push({ level: 'error', where, msg });
  const warn = (where: string, msg: string) => issues.push({ level: 'warn', where, msg });
  const fmt = FORMATS[meta.format ?? 'portrait'];
  if (!fmt) throw new Error(`project.yaml: format 只能是 portrait（竖屏）或 landscape（横屏）`);
  const alFile = join(dir, meta.voice ?? 'voice/alignment.json');
  if (!existsSync(alFile)) throw new Error(`找不到时间表 ${alFile}。把配音材料里的 alignment.json 放到项目的 voice/ 目录`);
  const al = loadAlignment(alFile);
  const fps = meta.fps ?? 30;
  const duration = al.duration + (meta.tail ?? 0.6);
  if (al.precision === 'sentence') warn('时间表', '当前是 SRT 降级输入，只有句级时间，句内卡点是均分估算的，同步精度有限');

  // ── 场景起点 ──
  const N = srcScenes.length;
  const starts: number[] = [];
  srcScenes.forEach((s, i) => {
    const where = s.file;
    let t = i === 0 ? 0 : NaN;
    if (s.src.from == null) { if (i > 0) err(where, '缺少 from：写上这个场景开口的头几个字，作为场景的起点'); }
    else { try { const r = resolveAnchor(al, s.src.from, [i ? starts[i - 1] ?? 0 : 0, Infinity]); if (i > 0) t = r.time; } catch (e: any) { err(where, `from ${e.message}`); } }
    if (i > 0 && !(t > starts[i - 1])) { if (!Number.isNaN(t)) err(where, `场景起点（${t.toFixed(2)}s）没有排在上一个场景之后，检查 from 或文件名顺序`); t = (starts[i - 1] ?? 0) + 0.01; }
    starts.push(t);
  });

  const scenes: CScene[] = [], tls: TL[] = [], erases: EraseGroup[] = [], camEvents: CamSeg[] = [], flows: FlowFx[] = [], traces: TraceFx[] = [], ghosts: TL[] = [];
  const framed = new Map<string, Box>();
  let nextX = 0;
  const screenC: Pt = [fmt.W / 2, fmt.H / 2], boardC: Pt = [fmt.board.x + fmt.board.w / 2, fmt.board.y + fmt.board.h / 2];
  let order = 0;
  const seenIds = new Set<string>();
  /** 每个场景结束时板上还留着什么，供后面的场景 recall */
  const boards = new Map<string, { srcs: [string, any][]; left: string[]; groups: Map<string, string[]> }>();

  srcScenes.forEach((s, si) => {
    const src = s.src, file = s.file;
    const id = String(src.id ?? basename(file).replace(/\.ya?ml$/, '').replace(/^\d+[-_]?/, '') ?? `s${si + 1}`);
    if (seenIds.has(id)) err(file, `场景 id "${id}" 重复了`);
    seenIds.add(id);
    for (const k of Object.keys(src)) if (!['id', 'from', 'intent', 'enter', 'recall', 'pattern', 'elements', 'beats', 'note', 'frame', 'regions', 'board', 'camera'].includes(k)) err(file, `场景不认识字段 "${k}"。可用：from intent enter recall pattern board camera regions elements beats note frame`);
    const t0 = starts[si], t1 = si + 1 < N ? starts[si + 1] : duration;
    // 比屏幕大的板：board: 1.6 表示这块板的宽高都是屏幕画板的 1.6 倍。全景（home）把整块板缩进画面，推近时才是原大
    // 也可以写 [横向几屏, 纵向几屏]：board: [3, 2] 是一块三屏宽、两屏高的板。全景按较大的那个方向缩
    const braw = src.board ?? meta.board ?? 1, bxy: number[] = Array.isArray(braw) ? braw.map(Number) : [+braw, +braw];
    let [bkx, bky] = bxy;
    if (bxy.length !== 2 || !(bkx >= 1 && bkx <= 5 && bky >= 1 && bky <= 5)) { err(file, 'board 写画板相对屏幕的倍数，1 到 5 之间（如 1.5）；或 [横向几屏, 纵向几屏]（如 [3, 2]）'); bkx = bky = 1; }
    const bk = Math.max(bkx, bky);
    const sfmt: Format = bk === 1 ? fmt : { ...fmt, board: { ...fmt.board, w: Math.round(fmt.board.w * bkx), h: Math.round(fmt.board.h * bky) } };
    const origin: Pt = [nextX, 0];
    nextX += Math.round(fmt.W * bk) + SCENE_GAP;
    const home: Cam = { cx: origin[0] + fmt.board.x + sfmt.board.w / 2 + (screenC[0] - boardC[0]) * bk, cy: fmt.board.y + sfmt.board.h / 2 + (screenC[1] - boardC[1]) * bk, zoom: 1 / bk };
    const enter = src.enter ?? (si === 0 ? 'cut' : 'pan');
    if (!['pan', 'wipe', 'cut'].includes(enter)) err(file, `enter 只能是 pan（镜头平移到新板面）/ wipe（擦掉重来）/ cut（直接切）`);
    const sayUnits = al.units.filter(u => u.start >= t0 - 1e-6 && u.start < t1 - 1e-6);
    const pendingCams: { ev: CamSeg; pad: number; maxZoom: number; items: { id: string; region: boolean; box: Box }[] }[] = [];
    const scene: CScene = { id, file, index: si, t0, t1, origin, intent: String(src.intent ?? ''), enter, beats: [], els: [], say: sayUnits.map(u => u.display).join(''), home, board: sfmt.board, span: Math.round(fmt.W * bk) };
    scenes.push(scene);
    if (!scene.intent) err(file, '缺少 intent：用一两句人话说明这个场景要让观众看到什么（给用户确认分镜用）');

    // 进场镜头
    if (si > 0) {
      if (enter === 'pan') camEvents.push({ t0: t0 - 0.45, t1: t0 + 0.1, to: home });
      else camEvents.push({ t0: t0 - 0.08, t1: t0 - 0.08, to: home, cut: true });
    } else camEvents.push({ t0: -1, t1: -1, to: home, cut: true });

    // ── 元素 ──
    const els = new Map<string, El>();
    const local = new Map<string, TL>();
    const life = new Map<string, [number, number]>();
    const pending: [string, any][] = [];
    const ctx: BuildCtx = { scene: id, fmt: sfmt, els, projectDir: dir, life, shade: meta.shade ?? !isInk(), note: (w, m, level = 'info') => issues.push({ level, where: w.replace(`场景 ${id}`, file), msg: m }) };
    const addEl = (eid: string, esrc: any): TL | null => {
      if (els.has(eid)) { err(`${file} / 元素 ${eid}`, 'id 重复了'); return local.get(eid)!; }
      try {
        const el = buildElement(ctx, eid, esrc);
        els.set(eid, el);
        const tl: TL = { el, order: 0, scene: si, moves: [], alpha: [], scale: [], shakes: [], poses: [], morphs: [] };
        if (!['figure', 'image', 'video'].includes(el.kind)) tl.remake = (patch, cur) => buildElement({ ...ctx, els: cur, life: undefined, note: undefined }, eid, { ...el.src, ...patch, __frozen: el.frozen });
        local.set(eid, tl); scene.els.push(eid);
        if (el.missing?.length) warn(`${file} / 元素 ${eid}`, `这些字符没有字形数据，画不出来：${[...new Set(el.missing)].join(' ')}`);
        return tl;
      } catch (e: any) { if (e instanceof SrcError) { err(file, e.message); return null; } throw e; }
    };
    // 成组的元素（crowd）：组名可以当作全体成员用，"p6..p10" 取其中一段
    const groups = new Map<string, string[]>();
    ctx.groups = groups;
    const ids1 = (v: string): string[] => {
      if (groups.has(v)) return groups.get(v)!;
      const m = /^([A-Za-z_][\w-]*?)(\d+)\.\.(?:\1)?(\d+)$/.exec(v);
      if (m && +m[3] >= +m[2] && +m[3] - +m[2] < 200) return Array.from({ length: +m[3] - +m[2] + 1 }, (_, i) => `${m[1]}${+m[2] + i}`);
      return [v];
    };
    const idsOf = (v: any): any => (typeof v === 'string' ? (ids1(v).length === 1 && ids1(v)[0] === v ? v : ids1(v)) : Array.isArray(v) ? v.flatMap(x => (typeof x === 'string' ? ids1(x) : [x])) : v);
    const GROUP_KEYS = ['draw', 'erase', 'hide', 'pop', 'fade', 'move', 'walk', 'shake', 'pulse', 'nod', 'pose', 'face', 'scale', 'change', 'grow', 'count', 'flow', 'trace', 'become', 'expand', 'collapse'];
    const withGroups = (a: any): any => {
      if (!a || typeof a !== 'object') return a;
      const o = { ...a };
      for (const k of GROUP_KEYS) if (k in o) { o[k] = idsOf(o[k]); const fix = (x: any) => (x && typeof x === 'object' && !Array.isArray(x) && x.target != null ? { ...x, target: idsOf(x.target) } : x); o[k] = Array.isArray(o[k]) ? o[k].map(fix) : fix(o[k]); }
      if (o.camera && typeof o.camera === 'object' && o.camera.focus != null) o.camera = { ...o.camera, focus: [].concat(idsOf(o.camera.focus)) };
      return o;
    };
    // 分区：先把板面划成几块有名字的地盘（全景的骨架）。元素写 in: 区名 后，at 的数字和百分比都相对这一块
    const regions = new Map<string, Box>();
    {
      const pcr = (v: any, total: number) => (typeof v === 'string' && v.endsWith('%') ? (parseFloat(v) / 100) * total : +v), Bd = sfmt.board;
      if (src.regions != null && (typeof src.regions !== 'object' || Array.isArray(src.regions))) err(file, 'regions 应该是 "区名: [x, y, w, h]" 的映射（数字或百分比）');
      else for (const [rn, rv] of Object.entries(src.regions ?? {}) as [string, any][]) {
        if (!Array.isArray(rv) || rv.length !== 4) { err(file, `分区 "${rn}" 要写成 [x, y, w, h]`); continue; }
        const b = { x: pcr(rv[0], Bd.w), y: pcr(rv[1], Bd.h), w: pcr(rv[2], Bd.w), h: pcr(rv[3], Bd.h) };
        if ([b.x, b.y, b.w, b.h].some(v => !Number.isFinite(v)) || b.w <= 0 || b.h <= 0) { err(file, `分区 "${rn}" 的 [x, y, w, h] 要是数字或百分比`); continue; }
        if (b.x < -1 || b.y < -1 || b.x + b.w > Bd.w + 1 || b.y + b.h > Bd.h + 1) warn(file, `分区 "${rn}" 超出了画板（画板 ${Bd.w}×${Bd.h}）`);
        regions.set(rn, b);
      }
      scene.regions = [...regions].map(([name, box]) => ({ name, box }));
    }
    // 沿用前面某个场景的画面：定义和位置原样带过来，进场时已经在板上，不占口播时间重画
    const recalled = new Set<string>();
    if (src.recall != null) {
      const rc = typeof src.recall === 'string' ? { scene: src.recall } : src.recall ?? {};
      const from = boards.get(String(rc.scene));
      for (const k of Object.keys(rc)) if (!['scene', 'show', 'except'].includes(k)) err(file, `recall 不认识字段 "${k}"。可用：scene show except`);
      if (!from) err(file, `recall 要写前面某个场景的名字（文件名去掉序号），没有找到 "${rc.scene}"。前面的场景有：${[...boards.keys()].join(' ') || '（无）'}`);
      else {
        scene.recall = String(rc.scene);
        for (const [g, ms] of from.groups) groups.set(g, ms);
        const want: string[] = rc.show != null ? [].concat(idsOf(rc.show)) : from.left, drop = new Set<string>(rc.except != null ? [].concat(idsOf(rc.except)) : []);
        for (const w of want) if (!from.srcs.some(([eid]) => eid === w)) err(file, `recall.show 里的 "${w}" 在场景 ${rc.scene} 里没有`);
        for (const [eid, esrc] of from.srcs) if (want.includes(eid) && !drop.has(eid)) { pending.push([eid, esrc]); recalled.add(eid); }
        for (const [g, ms] of [...groups]) if (!ms.every(m => recalled.has(m))) groups.set(g, ms.filter(m => recalled.has(m)));
      }
    }
    // 表现手法：展开成元素和具名步骤
    let steps: Record<string, any[]> = {};
    const fromPattern = new Set<string>();
    if (src.pattern != null) {
      // 一块板上可以放多种手法（写成列表，各占一块 area）。多于一种时，步骤名要带前缀：<name>.<步骤>
      const specs: any[] = (Array.isArray(src.pattern) ? src.pattern : [src.pattern]).map((x: any) => (typeof x === 'string' ? { kind: x } : x));
      const multi = specs.length > 1, B = sfmt.board;
      const pc = (v: any, total: number) => (typeof v === 'string' && v.endsWith('%') ? (parseFloat(v) / 100) * total : +v);
      const REF_KEYS = new Set(['draw', 'erase', 'move', 'hide', 'shake', 'pulse', 'nod', 'pop', 'fade', 'target', 'along', 'at', 'arrow', 'line', 'above', 'below', 'rightOf', 'leftOf', 'to']);
      specs.forEach(ps => {
        const pat = PATTERNS[ps?.kind];
        if (!pat) { err(file, `pattern.kind 写一种表现手法：${Object.keys(PATTERNS).join(' ')}（hj patterns 查看说明）`); return; }
        const name = String(ps.name ?? ps.kind);
        if (typeof ps.area === 'string' && !regions.has(ps.area)) { err(file, `手法 ${name} 的 area 写了 "${ps.area}"，但没有这个分区。本场景的分区：${[...regions.keys()].join(' ') || '（还没有定义 regions）'}`); return; }
        const rgA = typeof ps.area === 'string' ? regions.get(ps.area)! : null;
        if (multi && !rgA && !(Array.isArray(ps.area) && ps.area.length === 4)) { err(file, `一块板上放多种手法时，每种都要写 area: 分区名 或 [x, y, w, h] 划出自己的地盘（手法 ${name}）`); return; }
        const a = rgA ? { ...rgA } : Array.isArray(ps.area) && ps.area.length === 4 ? { x: pc(ps.area[0], B.w), y: pc(ps.area[1], B.h), w: pc(ps.area[2], B.w), h: pc(ps.area[3], B.h) } : { x: 20, y: 20, w: B.w - 40, h: B.h - 40 };
        try {
          const out = pat.build(ps, { fmt: sfmt, A: a, portrait: a.h > a.w, fail: (m: string) => { throw new SrcError(`${file} / 手法 ${name}`, m); } });
          // 手法自己算出来的字号不能小到手机上看不清（柱子多、地盘小时会算得很小）
          for (const [, e] of out.elements) if (e && typeof e === 'object' && 'text' in e && typeof e.size === 'number' && e.size < 36) e.size = 36;
          // 多种手法并存时，给自动起名的元素加前缀，避免撞名
          const userIds = new Set<string>(); JSON.stringify(ps, (k, v) => { if (k === 'id' && typeof v === 'string') userIds.add(v); return v; });
          const ren = new Map<string, string>();
          if (multi) for (const [eid] of out.elements) if (!userIds.has(eid)) ren.set(eid, `${name}_${eid}`);
          const fix = (v: any, key?: string): any => {
            if (typeof v === 'string') { if (key && !REF_KEYS.has(key)) return v; const [h, ...rest] = v.split('.'); return ren.has(h) ? [ren.get(h), ...rest].join('.') : v; }
            if (Array.isArray(v)) return v.map(x => fix(x, key));
            if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x, k)]));
            return v;
          };
          for (const [eid, esrc] of out.elements) { const nid = ren.get(eid) ?? eid; pending.push([nid, fix(esrc)]); fromPattern.add(nid); }
          for (const [sn, acts] of Object.entries(out.steps)) { const fixed = fix(acts); steps[`${name}.${sn}`] = fixed; if (!multi) steps[sn] = fixed; }
        } catch (e: any) { if (e instanceof SrcError) err(file, e.message); else throw e; }
      });
    }
    /** 细节框（detail）：框里的东西写 in: 框的名字，坐标相对框的左上角 */
    const frames = new Map<string, Box>();
    const inRegion = (eid: string, esrc: any): any => {
      if (!esrc || typeof esrc !== 'object' || esrc.in == null) return esrc;
      const fr = frames.get(String(esrc.in)), rg = regions.get(String(esrc.in)) ?? fr, { in: _in, ...rest } = esrc;
      if (fr) rest.__in = String(esrc.in);
      if (!rg) { err(`${file} / 元素 ${eid}`, `没有叫 "${esrc.in}" 的分区或细节框。本场景的分区：${[...regions.keys()].join(' ') || '（还没有定义 regions）'}${frames.size ? '；细节框：' + [...frames.keys()].join(' ') : ''}`); return rest; }
      if (Array.isArray(rest.at) && rest.at.length === 2) rest.at = rest.at.map((v: any, i: number) => (typeof v === 'number' ? (i ? rg.y : rg.x) + v : typeof v === 'string' && /^-?[\d.]+%$/.test(v) ? (i ? rg.y : rg.x) + (parseFloat(v) / 100) * (i ? rg.h : rg.w) : v));
      else if (rest.at == null && !['rightOf', 'leftOf', 'above', 'below'].some(k => k in rest) && !('arrow' in rest || 'line' in rest || 'mark' in rest || 'note' in rest)) rest.at = [rg.x + rg.w / 2, rg.y + rg.h / 2];
      // 箭头、连线里直接写的坐标点也相对分区（引用元素的端点不受影响）
      for (const k of ['arrow', 'line']) if (Array.isArray(rest[k])) rest[k] = rest[k].map((q: any) => (Array.isArray(q) && q.length === 2 && q.every((v: any) => typeof v === 'number') ? [rg.x + q[0], rg.y + q[1]] : q));
      return rest;
    };
    if (src.elements && typeof src.elements !== 'object') err(file, 'elements 应该是 "id: 定义" 的映射');
    for (const [eid, esrc] of Object.entries(src.elements ?? {}) as [string, any][]) {
      if (!esrc || typeof esrc !== 'object' || !('detail' in esrc)) continue;
      const r = inRegion(eid, esrc), w = +(r.w ?? 480), h = r.shape === 'circle' ? w : +(r.h ?? 360);
      if (Array.isArray(r.at) && r.at.every((v: any) => typeof v === 'number')) frames.set(eid, { x: r.at[0] - w / 2, y: r.at[1] - h / 2, w, h });
      else err(`${file} / 元素 ${eid}`, 'detail 的 at 写框中心的坐标 [x, y]（数字，可以配 in: 分区）');
    }
    for (const [eid, esrc0] of Object.entries(src.elements ?? {}) as [string, any][]) {
      const esrc = esrc0 && typeof esrc0 === 'object' && 'crowd' in esrc0 ? inRegion(eid, esrc0) : esrc0; // 人群也可以写 in: 分区
      if (esrc && typeof esrc === 'object' && 'crowd' in esrc) {
        // 一群一样的东西：整体定位、整体对齐，成员叫 <id>1…<id>N
        // 档位写在一群上，说的是“这一群”有多大：每一个取这一档的一半，免得十几个人把分区撑满
        const w = `${file} / 元素 ${eid}`, n = +esrc.crowd, of0 = esrc.of, tier = of0 && typeof of0 === 'object' && typeof of0.size === 'string' ? THING_TIERS[of0.size] : undefined;
        if (of0 && typeof of0 === 'object' && typeof of0.size === 'string' && tier == null) { err(w, `size 没有 "${of0.size}" 这一档。可用：${Object.keys(THING_TIERS).join(' ')}，或直接写数字（每一个的大小）`); continue; }
        const of = tier != null ? { ...of0, size: Math.round(tier / 2) } : of0;
        for (const k of Object.keys(esrc)) if (!['crowd', 'of', 'cols', 'at', 'gap', 'anchor', 'label', 'labelSize'].includes(k)) err(w, `crowd 不认识字段 "${k}"。可用：crowd（个数）of（每一个长什么样）cols（每排几个）at（整群的中心）gap label（整群下面的一行小字）labelSize`);
        if (!(n >= 2 && n <= 60) || !of || typeof of !== 'object' || !Array.isArray(esrc.at)) { err(w, 'crowd 要写成 { crowd: 10, cols: 5, of: { figure: stand, size: 140 }, at: [x, y] }：个数 2–60，of 是每一个的元素定义，at 是整群中心的坐标'); continue; }
        const pcv = (v: any, total: number) => (typeof v === 'string' && v.endsWith('%') ? (parseFloat(v) / 100) * total : +v);
        const cols = Math.max(1, Math.min(n, +(esrc.cols ?? (n <= 6 ? n : Math.ceil(n / 2))))), rows = Math.ceil(n / cols), size = +(of.size ?? ('figure' in of ? 150 : 140));
        const g = Array.isArray(esrc.gap) ? esrc.gap : [esrc.gap, esrc.gap];
        const gx = +(g[0] ?? ('figure' in of ? size * 0.72 : size * 1.18)), gy = +(g[1] ?? size * 1.14);
        const cx = pcv(esrc.at[0], sfmt.board.w), cy = pcv(esrc.at[1], sfmt.board.h), members: string[] = [];
        for (let i = 0; i < n; i++) {
          const r0 = Math.floor(i / cols), c0 = i % cols, mid = `${eid}${i + 1}`;
          pending.push([mid, { ...of, size, at: [Math.round(cx + (c0 - (cols - 1) / 2) * gx), Math.round(cy + (r0 - (rows - 1) / 2) * gy)], __rigid: true }]);
          members.push(mid);
        }
        // 整群的名字：写在整群正下方居中，随整群一起画（draw 这一群时一起写出来）
        if (esrc.label != null && String(esrc.label).trim()) {
          const lid = `${eid}_label`, ls = esrc.labelSize ?? 40;
          pending.push([lid, { text: String(esrc.label), size: ls, color: 'gray', at: [Math.round(cx), Math.round(cy + ((rows - 1) / 2) * gy + size * 0.5 + 18 + (typeof ls === 'number' ? ls : 40) * 0.6)], __rigid: true }]);
          members.push(lid);
        }
        groups.set(eid, members);
      } else pending.push([eid, esrc && typeof esrc === 'object' && esrc.target != null ? { ...esrc, target: idsOf(esrc.target) } : esrc]);
    }

    // ── 节拍 ──
    const beats: any[] = Array.isArray(src.beats) ? src.beats : [];
    if (!beats.length) warn(file, '这个场景没有任何节拍（beats），画面会是空的');
    const beatTimes: { t: number; shaky: boolean; anchor: number }[] = beats.map((b, bi) => {
      const where = `${file} / 节拍 ${bi + 1}`;
      if (b?.at == null) { err(where, '缺少 at：写上触发这个节拍的口播原文片段'); return { t: NaN, shaky: false, anchor: NaN }; }
      try {
        const r = resolveAnchor(al, b.at, [t0, t1]);
        if (typeof b.at === 'number') warn(where, `at 用了写死的秒数 ${b.at}，换配音后不会跟着变；尽量改成口播原文`);
        if (r.ambiguous) warn(where, `"${b.at}" 在本场景口播里出现了 ${r.ambiguous + 1} 次，现在取的是第 1 次；用 "…#2" 指明，或把片段写长一点`);
        if (r.shaky) warn(where, `"${b.at}" 落在时间不可靠的字上（低置信度/待复核），卡点可能偏；可以换成相邻的字，或渲染后听审微调`);
        return { t: r.time - (b.lead ?? 0), shaky: r.shaky, anchor: r.time };
      } catch (e: any) { err(where, e.message); return { t: NaN, shaky: false, anchor: NaN }; }
    });
    // 把 {step: 名字} 换成手法给出的那组动作；写在 step 上的 at/with/delay 作用于这组动作的第一个
    const expand = (list: any, where?: string): any[] => {
      const acts: any[] = [];
      for (const a of Array.isArray(list) ? list : []) {
        if (a && typeof a === 'object' && 'step' in a) {
          const st = steps[String(a.step)];
          if (!st) { if (where) err(where, `没有叫 "${a.step}" 的步骤。${Object.keys(steps).length ? '本场景可用：' + Object.keys(steps).join(' ') : '本场景没有使用表现手法（pattern）'}`); continue; }
          st.forEach((x, i) => { const { step: _s, ...rest } = a; void _s; acts.push(i === 0 ? { ...x, ...rest } : { ...x }); });
        } else acts.push(a);
      }
      return acts.map(withGroups);
    };
    // 细节框里有哪些东西、两条引线叫什么
    const membersOf = new Map<string, string[]>(), leadersOf = new Map<string, string[]>();
    for (const f of frames.keys()) {
      // 写了 in: 框的，加上相对它们定位的（below: rev 的标签），一层层找下去
      const mem = new Set(pending.filter(([, e]) => e && typeof e === 'object' && e.in === f).map(([i]) => i));
      for (let grew = true; grew;) { grew = false; for (const [i, e] of pending) if (!mem.has(i) && e && typeof e === 'object' && e.in == null && !('detail' in e) && ['below', 'above', 'rightOf', 'leftOf'].some(k => mem.has(String(e[k] ?? '').split('.')[0]))) { mem.add(i); grew = true; } }
      membersOf.set(f, [...mem]); leadersOf.set(f, [`${f}_a`, `${f}_b`]);
    }
    for (const eid of recalled) life.set(eid, [t0 - 1, Infinity]);
    // 预扫一遍节拍：每个元素什么时候出现、什么时候被擦掉。只有同时在板上的元素才需要互相避让
    beats.forEach((b, bi) => {
      const bt = beatTimes[bi].t;
      if (Number.isNaN(bt)) return;
      expand(b?.do).forEach((a, ai) => {
        if (!a || typeof a !== 'object') return;
        if (typeof a.expand === 'string' && frames.has(a.expand)) for (const i of [a.expand, ...leadersOf.get(a.expand)!]) if (!life.has(i)) life.set(i, [bt, Infinity]);
        if (typeof a.collapse === 'string' && frames.has(a.collapse)) for (const i of [a.collapse, ...leadersOf.get(a.collapse)!, ...membersOf.get(a.collapse)!]) if (life.has(i) && life.get(i)![1] === Infinity) life.get(i)![1] = bt;
        if (Array.isArray(a.become) && a.become.length === 2 && typeof a.become[1] === 'string' && !life.has(a.become[1])) life.set(a.become[1], [bt, Infinity]);
        const verb = [...APPEAR, 'erase', 'hide'].find(v => v in a);
        if (!verb) return;
        const tgs: any[] = Array.isArray(a[verb]) ? a[verb] : [a[verb]];
        tgs.forEach((tg, ti) => {
          if (verb === 'erase' || verb === 'hide') {
            if (tg === 'all') { for (const lf of life.values()) if (lf[1] === Infinity && lf[0] < bt) lf[1] = bt; }
            else if (typeof tg === 'string' && life.has(tg)) life.get(tg)![1] = bt;
          } else {
            const eid = tg && typeof tg === 'object' ? String(tg.id ?? `_${bi + 1}_${ai + 1}${ti ? '_' + ti : ''}`) : String(tg);
            if (!life.has(eid)) life.set(eid, [bt, Infinity]);
          }
        });
      });
    });
    for (const [eid, esrc] of pending) {
      const tl = addEl(eid, inRegion(eid, esrc));
      // 细节框的两条引线：从那样东西连到框，expand 时框到位之后画出来
      tl?.el.leaders?.forEach((pq, i) => addEl(leadersOf.get(eid)?.[i] ?? `${eid}_${i}`, { line: pq, color: tl.el.src.color ?? 'gray', pen: 3.5, rough: 0.6, pad: 0 }));
    }
    // 写了 in: 的元素被引擎挪出了自己的分区：多半是这个分区太挤
    for (const [eid, esrc] of pending) {
      const rn = esrc && typeof esrc === 'object' ? esrc.in : null, rg = rn != null ? regions.get(String(rn)) : null, el = els.get(eid);
      if (!rg || !el?.nudged) continue;
      const b = el.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      if (cx < rg.x || cx > rg.x + rg.w || cy < rg.y || cy > rg.y + rg.h) warn(`${file} / 元素 ${eid}`, `它写了 in: ${rn}，但压到别的东西后被引擎挪出了这个分区（挪了 ${el.nudged[0].toFixed(0)}, ${el.nudged[1].toFixed(0)}）。分区 ${rn} 放不下了：缩小这一区里的东西、把分区划大，或者用 board 把整块板放大`);
    }
    for (const rn of regions.keys()) if (els.has(rn)) err(file, `分区和元素都叫 "${rn}"，镜头不知道该推近哪个。给其中一个换个名字`);
    for (const eid of recalled) { const tl = local.get(eid); if (tl) { tl.appear = { t: t0 - 0.02, kind: 'fade', dur: 0.3 }; tl.order = order++; tl.recalled = true; } }
    /** 一笔一笔画出来：按笔画的分量分配 [t0, t1] */
    const schedDraw = (tl: TL, a0: number, a1: number) => {
      tl.drawT0 = a0; tl.drawT1 = a1; tl.compress = 1;
      const ws = tl.el.strokes.map(weight), sum = ws.reduce((x, y) => x + y, 0), sched = new Float64Array(ws.length * 2);
      let acc = a0;
      tl.el.strokes.forEach((s, i) => { const slot = ((a1 - a0) * ws[i]) / sum; sched[2 * i] = acc + slot * Math.min(0.6, penUp(s) / ws[i]) * 0.9; sched[2 * i + 1] = acc + slot; acc += slot; });
      tl.sched = sched;
    };
    let pos = new Map<string, Pt>(); // 元素当前位移
    const poseNow = new Map<string, { pose: Pose; face: string }>();
    /** 元素现在的参数和定义时差在哪儿（change / count 之后） */
    const morphNow = new Map<string, Record<string, any>>();
    let lastEnd = t0;
    beats.forEach((b, bi) => {
      const where = `${file} / 节拍 ${bi + 1}`;
      const bt = beatTimes[bi].t;
      if (Number.isNaN(bt)) return;
      for (const k of Object.keys(b)) if (!['at', 'lead', 'intent', 'do'].includes(k)) err(where, `节拍不认识字段 "${k}"。可用：at lead intent do`);
      let next = t1;
      for (let j = bi + 1; j < beats.length; j++) if (!Number.isNaN(beatTimes[j].t)) { next = beatTimes[j].t; break; }
      if (bi > 0 && !Number.isNaN(beatTimes[bi - 1].t) && bt < beatTimes[bi - 1].t) err(where, `节拍时间（${bt.toFixed(2)}s）比上一个节拍还早，节拍要按口播顺序写`);
      const nextAnchor = Math.min(next, t1);
      const endUnit = al.units.filter(u => u.start >= bt + (b.lead ?? 0) - 1e-6 && u.start < nextAnchor - 1e-6);
      const beat: CBeat = { at: b.at, t: bt, anchor: beatTimes[bi].anchor, tEnd: next, intent: String(b.intent ?? ''), actions: [], say: endUnit.map(u => u.display).join(''), shaky: beatTimes[bi].shaky, compress: 1 };
      scene.beats.push(beat);
      if (!beat.intent) err(where, '缺少 intent：用一句人话说明这一拍画面上发生什么');
      const acts = expand(b.do, where);
      if (!acts.length) warn(where, '这一拍没有动作（do 为空）');

      // 展开动作
      interface A { verb: string; ids: string[]; opt: any; natural: number; fixed: boolean; t0: number; t1: number; chain: number; withPrev: boolean; atTime?: number }
      const list: A[] = [];
      acts.forEach((a, ai) => {
        const aw = `${where} / 动作 ${ai + 1}`;
        if (!a || typeof a !== 'object') { err(aw, '动作应该是一个对象，例如 {draw: boss}'); return; }
        const verb = VERBS.find(v => v in a);
        if (!verb) { err(aw, `看不出这是什么动作。可用：${VERBS.join(' ')}`); return; }
        for (const k of Object.keys(a)) if (k !== verb && !ACTION_OPTS.includes(k)) err(aw, `动作不认识字段 "${k}"。可用：${ACTION_OPTS.join(' ')}`);
        let targets: any[] = verb === 'camera' || verb === 'wait' ? [] : Array.isArray(a[verb]) ? a[verb] : [a[verb]];
        const ids: string[] = [];
        targets.forEach((tg, ti) => {
          if (tg && typeof tg === 'object') { // 内联元素
            if (verb !== 'draw' && verb !== 'pop' && verb !== 'fade') { err(aw, '只有 draw / pop / fade 可以内联定义元素'); return; }
            const eid = String(tg.id ?? `_${bi + 1}_${ai + 1}${ti ? '_' + ti : ''}`);
            const { id: _drop, ...rest } = tg; void _drop;
            if (!KINDS.some(k => k in rest)) { err(aw, `内联元素看不出类型，需要包含：${KINDS.join(' ')}`); return; }
            if (addEl(eid, rest)) ids.push(eid);
          } else if (tg === 'all' && (verb === 'erase' || verb === 'hide')) ids.push('*');
          else if (typeof tg === 'string') { if (!local.has(tg)) err(aw, `没有叫 "${tg}" 的元素（在本场景的 elements 里定义，id 不跨场景）`); else ids.push(tg); }
          else err(aw, `${verb} 的对象应该是元素 id`);
        });
        let atTime: number | undefined;
        if (a.at != null) { try { atTime = resolveAnchor(al, a.at, [t0, t1]).time; } catch (e: any) { err(aw, e.message); } }
        const mk = (ids: string[], natural: number, withPrev = !!a.with): A => ({ verb, ids, opt: a, natural, fixed: a.dur != null, t0: 0, t1: 0, chain: 0, withPrev, atTime });
        if (verb === 'draw') {
          ids.forEach((eid, k) => { const x = mk([eid], a.dur != null ? a.dur / ids.length : naturalDraw(local.get(eid)!.el), k === 0 ? !!a.with : false); if (k > 0) x.atTime = undefined; list.push(x); });
        } else if (verb === 'wait') list.push(mk([], +a.wait || 0));
        else if (verb === 'flow') { const L = ids.reduce((n, i) => n + pathLen(local.get(i)?.el.path), 0), nn = +(a.n ?? 1); list.push(mk(ids, a.dur ?? Math.min(2.6, Math.max(0.8, L / 480)) * (+(a.loop ?? 1) + (nn - 1) / nn))); }
        else if (verb === 'trace') list.push(mk(ids, a.dur ?? ids.reduce((n, i) => n + (local.get(i)?.el.path ? Math.max(0.35, pathLen(local.get(i)!.el.path) / 800) : 0.25), 0)));
        else if (verb === 'camera' || ids.length) list.push(mk(ids, a.dur ?? NATURAL[verb] ?? 0.4));
      });

      // 排时间：默认顺序执行；with: prev 与上一个同时开始；动作自带 at 则从那一刻另起一串
      const chains: A[][] = [];
      for (const a of list) {
        if (a.withPrev && chains.length && chains[chains.length - 1].length) { a.chain = -1; chains[chains.length - 1].push(a); continue; }
        if (a.atTime != null || !chains.length) chains.push([]);
        chains[chains.length - 1].push(a);
      }
      chains.forEach((ch, ci) => {
        const start = ch[0].atTime ?? bt;
        const nextStart = chains[ci + 1]?.[0].atTime ?? next;
        const seq = ch.filter(a => a.chain !== -1);
        // 镜头移动不占画画的时间：后面还有动作时，镜头和它同时开始（真人一边走过去一边已经抬手了）
        const glide = new Set(seq.filter((a, i) => a.verb === 'camera' && i < seq.length - 1));
        const avail = Math.max(0.1, nextStart - start - 0.04);
        const fixedSum = seq.filter(a => !glide.has(a) && (a.fixed || a.verb !== 'draw')).reduce((n, a) => n + a.natural + (a.opt.delay ?? 0), 0);
        const flex = seq.filter(a => !a.fixed && a.verb === 'draw');
        const flexSum = flex.reduce((n, a) => n + a.natural, 0);
        let f = 1;
        if (flexSum > 0) {
          f = (avail - fixedSum) / flexSum;
          f = Math.max(0.12, Math.min(1.25, f));
        }
        if (flexSum > 0) beat.compress = Math.min(beat.compress, f);
        let t = start, prevStart = start;
        for (const a of ch) {
          if (a.chain === -1) { a.t0 = prevStart + (a.opt.delay ?? 0); }
          else { a.t0 = t + (a.opt.delay ?? 0); prevStart = a.t0; }
          const d = a.verb === 'draw' && !a.fixed ? a.natural * f : a.natural;
          a.t1 = a.t0 + d;
          if (a.chain !== -1 && !glide.has(a)) t = a.t1;
        }
        const over = t - nextStart;
        if (over > 0.25) warn(where, `这一拍的动作要到 ${t.toFixed(2)}s 才做完，比下一拍开始晚了 ${over.toFixed(1)} 秒，会和后面的画面抢。减少这一拍的内容、把一部分提前（lead）或挪到上一拍`);
      });

      // 落实动作
      for (const a of list) {
        const aw = where;
        const o = a.opt;
        if (o.ease != null && !EASES[o.ease]) err(aw, `ease 写动作的手感：${Object.keys(EASES).join(' ')}（soft 慢起慢收，默认；spring 冲过头一点再弹回；snap 干脆；linear 匀速）`);
        let ids = a.ids;
        if (ids.includes('*')) ids = [...local.values()].filter(tl => (tl.drawT0 ?? tl.appear?.t ?? Infinity) < a.t0 && tl.gone == null).map(tl => tl.el.id);
        const tlsOf = ids.map(i => local.get(i)!).filter(Boolean);
        const need = (tl: TL) => { if (tl.drawT0 == null && !tl.appear) { err(aw, `${a.verb} 的对象 "${tl.el.id}" 还没出现在画面上（先 draw / pop / fade）`); return false; } return true; };
        let desc = '';
        if (a.verb === 'draw' || a.verb === 'pop' || a.verb === 'fade') {
          for (const tl of tlsOf) {
            if (tl.drawT0 != null || tl.appear) { err(aw, `元素 "${tl.el.id}" 已经出现过了，不能重复 ${a.verb}（要再出现一次请定义一个新元素）`); continue; }
            tl.order = order++;
            if (a.verb === 'draw') {
              if (tl.el.kind === 'detail') err(aw, `细节框 "${tl.el.id}" 用 { expand: ${tl.el.id} } 打开（框从 "${tl.el.src.detail}" 里长出来，再画引线），不要 draw`);
              schedDraw(tl, a.t0, a.t1); tl.compress = a.fixed ? a.natural / naturalDraw(tl.el) : Math.min(1, (a.t1 - a.t0) / a.natural);
            } else tl.appear = { t: a.t0, kind: a.verb, dur: a.t1 - a.t0 };
          }
          desc = (a.verb === 'draw' ? '画 ' : a.verb === 'pop' ? '弹出 ' : '淡入 ') + tlsOf.map(tl => describe(tl.el)).join('、');
        } else if (a.verb === 'erase') {
          const ok = tlsOf.filter(need);
          if (ok.length) {
            const style = o.style ?? 'wipe';
            if (!['wipe', 'fade'].includes(style)) err(aw, 'erase 的 style 只能是 wipe（板擦擦掉）或 fade（淡出）');
            const b = unionBox(ok.map(tl => shifted(tl.el.box, pos.get(tl.el.id))));
            erases.push({ t0: a.t0, t1: a.t1, style, ...wipePath(b), scene: si });
            for (const tl of ok) { tl.erase = erases.length - 1; tl.gone = a.t1; }
            desc = '擦掉 ' + ok.map(tl => describe(tl.el)).join('、');
          }
        } else if (a.verb === 'hide') { for (const tl of tlsOf.filter(need)) { tl.alpha.push({ t0: a.t0, t1: a.t1, from: 1, to: 0 }); tl.gone = a.t1; } desc = '隐去 ' + ids.join('、'); }
        else if (a.verb === 'move' || a.verb === 'walk') {
          const walking = a.verb === 'walk';
          // 几个人一起走：队形的中心（出发前算好）
          const movers = tlsOf.filter(x => x.drawT0 != null || x.appear).map(x => { const q = pos.get(x.el.id) ?? [0, 0]; return [x.el.anchors.center[0] + q[0], x.el.anchors.center[1] + q[1]]; });
          const gmx = movers.reduce((n, q) => n + q[0], 0) / (movers.length || 1), gmy = movers.reduce((n, q) => n + q[1], 0) / (movers.length || 1);
          for (const tl of tlsOf.filter(need)) {
            const cur = pos.get(tl.el.id) ?? [0, 0];
            let to: Pt = cur, path: number[] | undefined, base: Pt | undefined;
            const c = tl.el.anchors.center;
            try {
              if (o.along) { const ar = els.get(String(o.along)); if (!ar?.path) throw new SrcError(aw, `along 要写一个 arrow、line 或折线图元素的 id，"${o.along}" 不是`); path = ar.path; base = c; to = [path[path.length - 2] - c[0], path[path.length - 1] - c[1]]; }
              else if (o.to != null) {
                const r = refPoint(els, pos, o.to, sfmt, aw);
                // 小人走到某处，是脚落在那儿；几个人一起走，保持队形（收紧一半）而不是叠成一个
                const foot: Pt = walking && tl.el.anchors.feet ? tl.el.anchors.feet : c;
                to = [r[0] - foot[0], r[1] - foot[1]];
                if (movers.length > 1) to = [to[0] + (c[0] + cur[0] - gmx) * 0.5, to[1] + (c[1] + cur[1] - gmy) * 0.5];
              }
              else if (Array.isArray(o.by)) to = [cur[0] + o.by[0], cur[1] + o.by[1]];
              else throw new SrcError(aw, 'move 需要 to（目标：元素 id、"id.锚点" 或 [x,y]）、by（相对位移 [dx,dy]）或 along（沿某条箭头走）');
            } catch (e: any) { if (e instanceof SrcError) { err(aw, e.message.replace(aw + ': ', '')); continue; } throw e; }
            tl.moves.push({ t0: a.t0, t1: a.t1, from: cur, to, path, base, linear: walking && o.ease == null, ease: o.ease });
            pos.set(tl.el.id, to);
            if (walking) { // 走过去：边移动边交替迈步，到了恢复原来的姿势
              if (!tl.el.figure) { err(aw, `"${tl.el.id}" 不是火柴人，不能 walk（用 move）`); continue; }
              const now = poseNow.get(tl.el.id) ?? { pose: tl.el.figure.spec.pose, face: tl.el.figure.spec.face };
              const right = to[0] >= cur[0], n = Math.max(2, Math.round((a.t1 - a.t0) / 0.22)), dt = (a.t1 - a.t0) / n;
              let prev = now.pose;
              for (let i = 0; i < n; i++) { const nx = i === n - 1 ? now.pose : POSES[(i % 2 === 0) === right ? 'walk-right' : 'walk-left']; tl.poses.push({ t0: a.t0 + i * dt, t1: a.t0 + (i + 1) * dt, from: prev, to: nx, faceFrom: now.face, faceTo: now.face }); prev = nx; }
            }
          }
          desc = `${walking ? '走动' : '移动'} ${ids.join('、')}` + (o.along ? ` 沿 ${o.along}` : o.to ? ` 到 ${JSON.stringify(o.to)}` : '');
        } else if (a.verb === 'scale') {
          if (typeof o.to !== 'number' || o.to <= 0) err(aw, 'scale 需要 to: 倍数（如 1.6 放大、0.5 缩小，相对元素原始大小）');
          else for (const tl of tlsOf.filter(need)) { const from = tl.scale.length ? tl.scale[tl.scale.length - 1].to : 1; tl.scale.push({ t0: a.t0, t1: a.t1, from, to: o.to, ease: o.ease }); }
          desc = `${ids.join('、')} 缩放到 ${o.to} 倍`;
        } else if (a.verb === 'change') {
          // 改一个量：横条变长变短、柱子变高、框变大、换颜色。连着它的箭头、标签跟着重新生成
          const to = o.to;
          if (!to || typeof to !== 'object' || Array.isArray(to) || !Object.keys(to).length) err(aw, 'change 要写 to: { 参数: 新值 }，例如 { change: bar, to: { span: [0, 81] } }');
          else for (const tl of tlsOf.filter(need)) {
            const el = tl.el, allow = CHANGE_KEYS[el.kind] ?? [], bad = Object.keys(to).filter(k => !allow.includes(k));
            if (bad.length) { err(aw, `"${el.id}"（${el.kind}）不能 change ${bad.join('、')}。${allow.length ? '它能改的：' + allow.join(' ') : '这种元素没有能改的参数：换样子用 pose / face，换位置用 move'}`); continue; }
            const v = (k: string): string | null => {
              const x = to[k];
              if (k === 'span') return Array.isArray(x) && x.length === 2 && x.every((n: any) => Number.isFinite(+n)) ? null : 'span 写起止数值，如 [0, 81]';
              if (k === 'data') return Array.isArray(x) && x.length === el.src.data.length && x.every((n: any) => typeof n === 'number') ? null : `data 写 ${el.src.data.length} 个数字（和原来的个数一样）`;
              if (k === 'color') return typeof x === 'string' ? null : 'color 写颜色名，如 red';
              return typeof x === 'number' && x > 0 ? null : `${k} 写一个正数`;
            };
            const bads = Object.keys(to).map(v).filter(Boolean);
            if (bads.length) { err(aw, bads.join('；')); continue; }
            const now = morphNow.get(el.id) ?? {}, toFull: Record<string, any> = { ...now };
            for (const k of Object.keys(to)) toFull[k] = k === 'color' ? color(to[k]) : k === 'span' ? to[k].map(Number) : to[k];
            const baseOf = (k: string) => (k === 'color' ? color(el.src.color) : k === 'h' && el.kind === 'span' ? el.src.h ?? 50 : k === 'w' || k === 'h' ? el.src[k] ?? el.src.size ?? (k === 'w' ? 240 : 160) : el.src[k]);
            const from = Object.fromEntries(Object.keys(toFull).map(k => [k, k in now ? now[k] : baseOf(k)]));
            tl.morphs.push({ t0: a.t0, t1: a.t1, from, to: toFull, ease: o.ease });
            morphNow.set(el.id, toFull);
          }
          desc = `${ids.join('、')} 变成 ${JSON.stringify(to).replace(/"/g, '')}`;
        } else if (a.verb === 'grow') {
          // 长出来：区间条从一头伸到定义的长度，柱状图的柱子从零长高。和 draw 一样让它第一次出现
          for (const tl of tlsOf) {
            const el = tl.el;
            if (tl.drawT0 != null || tl.appear) { err(aw, `"${el.id}" 已经在板上了，grow 是让它第一次出现时长出来。已经在板上的要变长变短用 change`); continue; }
            let from: Record<string, any>, to: Record<string, any>;
            if (el.kind === 'span') { const [p, q] = el.src.span.map(Number); if (o.from != null && !['start', 'end'].includes(o.from)) { err(aw, 'grow 的 from 写 start（从起点那头长出来，默认）或 end（从终点那头）'); continue; } from = { span: o.from === 'end' ? [q, q] : [p, p] }; to = { span: [p, q] }; }
            else if (el.kind === 'chart' && el.src.chart === 'bar') { from = { data: el.src.data.map(() => 0) }; to = { data: el.src.data }; }
            else { err(aw, `grow 只能用在区间条（span）和柱状图（chart: bar）上，"${el.id}" 是 ${el.kind}。别的东西用 draw 画出来`); continue; }
            tl.order = order++;
            tl.appear = { t: a.t0, kind: 'fade', dur: Math.min(0.12, (a.t1 - a.t0) / 3) };
            tl.morphs.push({ t0: a.t0, t1: a.t1, from, to, ease: o.ease, base: true });
          }
          desc = '长出 ' + tlsOf.map(tl => describe(tl.el)).join('、');
        } else if (a.verb === 'count') {
          // 数字滚动：还没出现的数从 from（默认 0）滚到写的值；已经在板上的数滚到 to
          for (const tl of tlsOf) {
            const el = tl.el, n = el.kind === 'text' ? numberIn(String(el.src.text)) : null;
            if (!n) { err(aw, `count 只能用在带数字的文字上（如 text: "= 1000"），"${el.id}" ${el.kind === 'text' ? '里没有数字' : `是 ${el.kind}`}`); continue; }
            const shown = tl.drawT0 != null || !!tl.appear;
            if (o.from != null && typeof o.from !== 'number') { err(aw, 'count 的 from 写一个数（从几开始滚），默认 0'); continue; }
            if (shown && typeof o.to !== 'number') { err(aw, `"${el.id}" 已经在板上了：写 to: 数字，滚到几`); continue; }
            if (!shown && o.to != null) { err(aw, `"${el.id}" 还没出现：count 会从 from 滚到它写的数（${n.value}），不用写 to。要滚到别的数，改它的 text`); continue; }
            const now = morphNow.get(el.id) ?? {}, start = shown ? now.__num ?? n.value : o.from ?? 0, end = shown ? o.to : n.value;
            const dec = Math.max(n.dec, decimalsOf(start), decimalsOf(end));
            if (!shown) { tl.order = order++; tl.appear = { t: a.t0, kind: 'fade', dur: 0.1 }; }
            const toFull = { ...now, __num: end, __numDec: dec };
            tl.morphs.push({ t0: a.t0, t1: a.t1, from: { ...now, __num: start, __numDec: dec }, to: toFull, ease: o.ease, base: !shown });
            if (shown) morphNow.set(el.id, toFull);
          }
          desc = `数字滚动 ${ids.join('、')}${o.to != null ? ` 到 ${o.to}` : ''}`;
        } else if (a.verb === 'flow') {
          // 流动：小记号沿着线走。几条线首尾相接就是一圈（钱借出去、付出去、存回来）
          const ok = tlsOf.filter(need), bad = ok.find(tl => !tl.el.path);
          const n = +(o.n ?? 1), loop = +(o.loop ?? 1);
          if (bad) err(aw, `flow 沿着箭头或连线流动，"${bad.el.id}" 是 ${bad.el.kind}。写一条线，或几条首尾相接的线：{ flow: [lend, pay, back] }`);
          else if (!(Number.isInteger(n) && n >= 1 && n <= 8)) err(aw, 'flow 的 n 写同时有几个记号在走，1 到 8');
          else if (!(Number.isInteger(loop) && loop >= 1 && loop <= 10)) err(aw, 'flow 的 loop 写走几趟，1 到 10');
          else if (ok.length) {
            for (let i = 1; i < ok.length; i++) {
              const p = ok[i - 1].el.path!, q = ok[i].el.path!, gap = Math.hypot(q[0] - p[p.length - 2], q[1] - p[p.length - 1]);
              if (gap > 260) warn(aw, `flow 的 "${ok[i - 1].el.id}" 和 "${ok[i].el.id}" 首尾没接上（隔了 ${gap.toFixed(0)} 像素），记号会从一头跳到另一头。按顺序写首尾相接的线：前一条指向谁，后一条就从谁出发`);
            }
            const col = o.color ?? 'blue', tk = o.token ?? 'dot';
            let tsrc: any = null;
            if (tk === 'dot') tsrc = { shape: 'circle', size: o.size ?? 24, color: col, fill: col, fillStyle: 'solid', fillAlpha: 1, shade: false };
            else if (typeof tk === 'string' && /^[\w-]+$/.test(tk) && loadDoodle(tk, dir)) tsrc = { doodle: tk, size: o.size ?? 60, shade: false };
            else if ((typeof tk === 'string' || typeof tk === 'number') && String(tk).length <= 6) tsrc = { text: String(tk), size: o.size ?? 42, color: col, weight: 'bold' };
            if (!tsrc) err(aw, 'flow 的 token 写在线上走的是什么：dot（圆点，默认）、一个手绘件的名字（coin、banknote、document…）、或不超过 6 个字的字（"¥"、"90"）');
            else {
              try {
                const te = buildElement({ ...ctx, els: new Map(), life: undefined, note: undefined }, '_token', { ...tsrc, at: [0, 0] }), tc = te.anchors.center;
                flows.push({ scene: si, t0: a.t0, t1: a.t1, ids: ok.map(tl => tl.el.id), token: cloneStrokes(te.strokes, -tc[0], -tc[1]), n, loop });
              } catch (e: any) { if (e instanceof SrcError) err(aw, e.message.replace(/^.*?: /, '')); else throw e; }
            }
          }
          desc = `沿 ${ids.join(' → ')} 流动`;
        } else if (a.verb === 'trace') {
          // 点亮：顺着一条路，线用荧光笔描一遍，经过的东西跳一下。讲“结论是从哪儿连过来的”
          const ok = tlsOf.filter(need);
          const w8 = ok.map(tl => (tl.el.path ? Math.max(0.35, pathLen(tl.el.path) / 800) : 0.25)), sum = w8.reduce((x, y) => x + y, 0) || 1;
          const until = o.keep === true ? Infinity : Math.max(a.t1 + 1.5, next + 1.2);
          let tt = a.t0;
          ok.forEach((tl, i) => {
            const d = ((a.t1 - a.t0) * w8[i]) / sum;
            if (tl.el.path) traces.push({ scene: si, id: tl.el.id, t0: tt, t1: tt + d, color: color(o.color ?? 'yellow'), w: +(o.size ?? 28), until });
            else tl.shakes.push({ t0: tt, t1: tt + Math.max(0.35, d), kind: 'pulse' });
            tt += d;
          });
          if (!ok.some(tl => tl.el.path)) warn(aw, 'trace 里没有一条线：点亮是顺着箭头、连线描一遍。把这条路上的箭头按顺序写进去，如 [me, dep, bank, lend, shop]');
          desc = `点亮 ${ids.join(' → ')}`;
        } else if (a.verb === 'become') {
          // 变成：一样东西（或它的替身）走过去，到了变成另一样。“存回的 90 变成第二条”
          const [A, B] = ids.map(i => local.get(i));
          if (ids.length !== 2 || !A || !B) err(aw, 'become 写成 [从哪样, 变成哪样]，例如 { become: [backT, n2], along: back }');
          else if (!need(A)) { /* need 已经报错 */ }
          else if (B.drawT0 != null || B.appear) err(aw, `"${B.el.id}" 已经在板上了。become 是让它第一次出现：从 "${A.el.id}" 变过来`);
          else {
            const d = a.t1 - a.t0, tTravel = a.t0 + d * 0.75, ta = a.t0 + d * 0.55;
            const ca = A.el.anchors.center, cb = B.el.anchors.center, from = pos.get(A.el.id) ?? [0, 0];
            const sa = Math.max(A.el.box.w, A.el.box.h, 1), sb = Math.max(B.el.box.w, B.el.box.h, 1), r = Math.min(3, Math.max(0.3, sb / sa));
            const ghost: TL = { el: A.el, order: order++, scene: si, moves: [], alpha: [{ t0: ta, t1: a.t1, from: 1, to: 0 }], scale: [{ t0: a.t0, t1: tTravel, from: 1, to: r }], shakes: [], poses: [], morphs: [], appear: { t: a.t0, kind: 'fade', dur: 0.01 }, gone: a.t1, ghost: true };
            if (o.along != null) {
              const ar = els.get(String(o.along));
              if (!ar?.path) { err(aw, `along 要写一条箭头或连线的 id，"${o.along}" 不是`); }
              else ghost.moves.push({ t0: a.t0, t1: tTravel, from, to: [cb[0] - ca[0], cb[1] - ca[1]], path: [...ar.path, cb[0], cb[1]], base: ca, ease: o.ease });
            } else ghost.moves.push({ t0: a.t0, t1: tTravel, from, to: [cb[0] - ca[0], cb[1] - ca[1]], ease: o.ease });
            local.set(`${A.el.id}~${B.el.id}`, ghost);
            if (o.keep !== true) { A.alpha.push({ t0: a.t0, t1: a.t0 + 0.05, from: 1, to: 0 }); A.gone = a.t0 + 0.05; }
            B.order = order++;
            B.appear = { t: ta, kind: 'fade', dur: Math.max(0.1, a.t1 - ta) };
            B.scale.push({ t0: ta, t1: a.t1 + 0.15, from: 1 / r, to: 1, ease: o.ease ?? 'spring' });
          }
          desc = ids.length === 2 ? `${ids[0]} ${o.keep === true ? '的替身' : ''}走过去变成 ${ids[1]}` : '';
        } else if (a.verb === 'expand' || a.verb === 'collapse') {
          // 展开：细节框从那样东西里长出来，引线随后画出；收起：引线先消失，框和框里的东西一起缩回那样东西，它跳一下
          for (const tl of tlsOf) {
            const el = tl.el;
            if (el.kind !== 'detail') { err(aw, `${a.verb} 的对象是细节框（detail），"${el.id}" 是 ${el.kind}。先定义 ${el.id}In: { detail: ${el.id}, at: [x, y], w: 480, h: 360 }，框里的东西写 in: ${el.id}In，再 ${a.verb} 框`); continue; }
            const node = local.get(String(el.src.detail))!, shown = (x: TL) => x.drawT0 != null || !!x.appear;
            const nb = shifted(node.el.box, pos.get(node.el.id)), nc: Pt = [nb.x + nb.w / 2, nb.y + nb.h / 2];
            const ratio = Math.min(1, Math.max(0.05, Math.max(nb.w, nb.h) / Math.max(el.box.w, el.box.h)));
            const fc0 = el.anchors.center, leads = (leadersOf.get(el.id) ?? []).map(i => local.get(i)).filter((x): x is TL => !!x);
            if (a.verb === 'expand') {
              if (shown(tl)) { err(aw, `细节框 "${el.id}" 已经打开过了。要再看一次，定义一个新的框`); continue; }
              if (!shown(node)) { err(aw, `要先把 "${node.el.id}" 画出来，才能展开它的里面`); continue; }
              const tp = a.t0 + (a.t1 - a.t0) * 0.65, ez = o.ease ?? 'spring';
              tl.order = order++; tl.appear = { t: a.t0, kind: 'fade', dur: 0.12 };
              tl.moves.push({ t0: a.t0, t1: tp, from: [nc[0] - fc0[0], nc[1] - fc0[1]], to: [0, 0], ease: ez }); pos.set(el.id, [0, 0]);
              tl.scale.push({ t0: a.t0, t1: tp, from: ratio, to: 1, ease: ez });
              for (const lt of leads) { lt.order = order++; schedDraw(lt, tp, a.t1); }
            } else {
              if (!need(tl)) continue;
              if (tl.gone != null) { err(aw, `细节框 "${el.id}" 已经收起了`); continue; }
              const s1 = ratio * 0.8, fp = pos.get(el.id) ?? [0, 0], fc: Pt = [fc0[0] + fp[0], fc0[1] + fp[1]], tf = a.t0 + (a.t1 - a.t0) * 0.45;
              for (const lt of leads) if (shown(lt) && lt.gone == null) { lt.alpha.push({ t0: a.t0, t1: a.t0 + 0.2, from: 1, to: 0 }); lt.gone = a.t0 + 0.2; }
              const inside = [tl, ...[...local.values()].filter(x => x !== tl && !x.ghost && (x.el.over.has(el.id) || membersOf.get(el.id)?.includes(x.el.id)) && shown(x) && x.gone == null)];
              for (const m of inside) {
                const cur = pos.get(m.el.id) ?? [0, 0], pc: Pt = [m.el.anchors.center[0] + cur[0], m.el.anchors.center[1] + cur[1]];
                const to: Pt = [cur[0] + nc[0] + (pc[0] - fc[0]) * s1 - pc[0], cur[1] + nc[1] + (pc[1] - fc[1]) * s1 - pc[1]];
                m.moves.push({ t0: a.t0, t1: a.t1, from: cur, to, ease: o.ease }); pos.set(m.el.id, to);
                const from = m.scale.length ? m.scale[m.scale.length - 1].to : 1;
                m.scale.push({ t0: a.t0, t1: a.t1, from, to: from * s1, ease: o.ease });
                m.alpha.push({ t0: tf, t1: a.t1, from: 1, to: 0 }); m.gone = a.t1;
              }
              node.shakes.push({ t0: a.t1 - 0.05, t1: a.t1 + 0.4, kind: 'pulse' });
            }
          }
          desc = `${a.verb === 'expand' ? '展开' : '收起'} ${ids.join('、')}`;
        } else if (a.verb === 'pose' || a.verb === 'face') {
          for (const tl of tlsOf.filter(need)) {
            if (!tl.el.figure) { err(aw, `"${tl.el.id}" 不是火柴人，不能 ${a.verb}`); continue; }
            const cur = poseNow.get(tl.el.id) ?? { pose: tl.el.figure.spec.pose, face: tl.el.figure.spec.face };
            const pn = a.verb === 'pose' ? o.to : undefined, fn = a.verb === 'face' ? o.to : o.face;
            if (pn != null && !POSES[pn]) { err(aw, `没有姿势 "${pn}"。可用：${Object.keys(POSES).join(' ')}`); continue; }
            if (fn != null && !FACES[fn]) { err(aw, `没有表情 "${fn}"。可用：${Object.keys(FACES).join(' ')}`); continue; }
            if (pn == null && fn == null) { err(aw, `${a.verb} 需要 to`); continue; }
            if (a.t0 < (tl.drawT1 ?? 0) - 1e-6) warn(aw, `"${tl.el.id}" 还没画完就开始换姿势，会跳一下`);
            const nx = { pose: pn ? POSES[pn] : cur.pose, face: fn ?? cur.face };
            tl.poses.push({ t0: a.t0, t1: a.t1, from: cur.pose, to: nx.pose, faceFrom: cur.face, faceTo: nx.face });
            poseNow.set(tl.el.id, nx);
          }
          desc = `${ids.join('、')} ${a.verb === 'pose' ? '摆出 ' + o.to : ''}${a.verb === 'face' || o.face ? ' 表情变 ' + (a.verb === 'face' ? o.to : o.face) : ''}`;
        } else if (a.verb === 'shake' || a.verb === 'pulse' || a.verb === 'nod') { for (const tl of tlsOf.filter(need)) tl.shakes.push({ t0: a.t0, t1: a.t1, kind: a.verb }); desc = `${a.verb === 'shake' ? '晃动' : a.verb === 'pulse' ? '放大强调' : '点头'} ${ids.join('、')}`; }
        else if (a.verb === 'camera') {
          const c = o.camera;
          if (c === 'home') { camEvents.push({ t0: a.t0, t1: a.t1, to: home }); desc = '镜头回到全景'; }
          else if (c && typeof c === 'object' && c.focus != null) {
            const fids: string[] = Array.isArray(c.focus) ? c.focus : [c.focus];
            const bad = fids.find(i => !local.has(i) && !regions.has(i));
            if (bad) err(aw, `camera.focus 里没有叫 "${bad}" 的元素或分区`);
            else {
              // 先记下对准谁，等这块板排完（知道每样东西什么时候画）再定景：只框已经画出来和马上要画的，后画的到时候再带进来
              const ev: CamSeg = { t0: a.t0, t1: a.t1, to: { cx: 0, cy: 0, zoom: 1 }, region: fids.every(i => regions.has(i)) };
              camEvents.push(ev);
              pendingCams.push({ ev, pad: c.pad ?? (fids.every(i => regions.has(i)) ? 20 : 90), maxZoom: c.maxZoom ?? (bk > 1.2 ? 1.5 : 2.4) /* 大板上的东西是按一屏原大画的，近景不用放那么大 */, items: fids.map(i => ({ id: i, region: regions.has(i), box: regions.has(i) ? regions.get(i)! : shifted(local.get(i)!.el.box, pos.get(i)) })) });
              desc = `镜头推近 ${fids.join('、')}`;
            }
          } else err(aw, 'camera 写 home（回全景）或 {focus: [元素id…], pad: 90}（推近）');
        }
        if (desc) beat.actions.push({ verb: a.verb, ids, t0: a.t0, t1: a.t1, natural: a.natural, desc });
        lastEnd = Math.max(lastEnd, a.t1);
      }
    });
    // 跟着变：引用了会挪动、会变化的元素的东西（箭头的两头、标记和批注的对象、相对定位的参照），跟着重新生成
    const extents = new Map<string, Box[]>();
    {
      const moving = new Set<string>();
      for (const eid of scene.els) {
        const tl = local.get(eid); if (!tl) continue;
        if (tl.moves.length || !tl.remake) { if (tl.moves.length || tl.morphs.length) moving.add(eid); continue; }
        const ds = depsOf(tl.el.src, i => local.has(i) || groups.has(i)).flatMap(i => groups.get(i) ?? [i]).filter(d => moving.has(d));
        if (ds.length) tl.live = ds;
        if (ds.length || tl.morphs.length) moving.add(eid);
      }
      // 变化之后它占的地方：镜头要装得下，也不能压到别人
      const after = new Map<string, { t1: number; box: Box }[]>();
      for (const eid of scene.els) {
        const tl = local.get(eid);
        if (!tl?.remake) continue;
        for (const m of tl.morphs) {
          if (m.base) continue;
          try { const b = remade(tl, m.to, els, els).box; after.set(eid, [...(after.get(eid) ?? []), { t1: m.t1, box: b }]); extents.set(eid, [...(extents.get(eid) ?? []), b]); }
          catch (e: any) { if (e instanceof SrcError) err(`${file} / 元素 ${eid}`, `变化之后排不出来：${e.message.replace(/^.*?: /, '')}`); else throw e; }
        }
      }
      /** t 时刻它占的地方：最近一次变化之后的样子（同时在变的，按变完算） */
      const boxAt = (tl: TL, t: number): Box => { let b = tl.el.kind === 'note' ? tl.el.solid : tl.el.box; for (const x of after.get(tl.el.id) ?? []) if (x.t1 <= t + 0.3) b = x.box; return b; };
      const ov = (a: Box, q: Box) => Math.min(a.x + a.w, q.x + q.w) - Math.max(a.x, q.x) > 8 && Math.min(a.y + a.h, q.y + q.h) - Math.max(a.y, q.y) > 8;
      for (const [eid, list] of after) {
        const tl = local.get(eid)!;
        if (['arrow', 'line', 'mark'].includes(tl.el.kind)) continue;
        for (const { t1: mt, box: b } of list) {
          const hit = [...local.values()].find(o => {
            if (o === tl || ['mark', 'arrow', 'line', 'axis'].includes(o.el.kind) || o.el.src?.overlap === true || tl.el.src?.overlap === true || o.live?.includes(eid) || tl.el.over.has(o.el.id) || o.el.over.has(eid)) return false;
            const born = o.drawT0 ?? o.appear?.t ?? Infinity;
            if (born > (tl.gone ?? Infinity) || (o.gone ?? Infinity) <= mt) return false;
            return ov(b, boxAt(o, Math.max(mt, born))) && !ov(tl.el.box, o.el.solid);
          });
          if (hit) warn(`${file} / 元素 ${eid}`, `change 之后（${fmtTime(mt)}）它会压到 "${hit.el.id}"。定义时引擎只按变化前的样子避让：给它变大之后的样子留出地方（挪开 "${hit.el.id}"，或者把 "${eid}" 定义成变化后的样子、用 change 从小变回来）`);
        }
      }
    }
    // 细节框：框里的东西在框打开之后、收起之前画；框不能压到外面的东西
    for (const [f, mem0] of membersOf) {
      const ft = local.get(f); if (!ft) continue;
      const mem = [...new Set([...mem0, ...[...local.values()].filter(x => x !== ft && !x.ghost && x.el.over.has(f)).map(x => x.el.id)])]; // 叠放在框上的（相对框里的东西定位的标签）也算框里的
      const open = ft.appear?.t, close = ft.gone ?? Infinity;
      if (open == null) { if (mem.some(i => local.get(i)?.drawT0 != null || local.get(i)?.appear)) err(`${file} / 元素 ${f}`, `细节框 "${f}" 从没打开，框里的东西却画了。在画它们之前加一拍 { expand: ${f} }`); continue; }
      for (const i of mem) {
        const m = local.get(i), born = m?.drawT0 ?? m?.appear?.t;
        if (born == null) continue;
        if (born < open - 0.01) err(`${file} / 元素 ${i}`, `它在细节框 "${f}" 里，却在框打开（${fmtTime(open)}）之前就画了。先 { expand: ${f} }，再画框里的东西`);
        else if (born >= close - 0.01) err(`${file} / 元素 ${i}`, `它在细节框 "${f}" 里，但框在 ${fmtTime(close)} 已经收起了，再画就画在空地上`);
      }
      const fb = ft.el.box, own = new Set([f, ...mem, ...(leadersOf.get(f) ?? []), String(ft.el.src.detail)]);
      const hit = [...local.values()].find(o => {
        if (own.has(o.el.id) || o.ghost || ['arrow', 'line', 'mark', 'axis'].includes(o.el.kind)) return false;
        const born = o.drawT0 ?? o.appear?.t; if (born == null || born >= close || (o.gone ?? Infinity) <= open) return false;
        const q = o.el.solid; return Math.min(fb.x + fb.w, q.x + q.w) - Math.max(fb.x, q.x) > 8 && Math.min(fb.y + fb.h, q.y + q.h) - Math.max(fb.y, q.y) > 8;
      });
      if (hit) warn(`${file} / 元素 ${f}`, `细节框打开的时候会盖住 "${hit.el.id}"。把框挪到板上空着的地方（改 at），或者把框画小（w、h）；外面的东西要在框收起之后才画，就把它放到 collapse 之后`);
    }
    // 进场方式为 wipe 的下一场景：把本场景整板擦掉
    const nextSrc = srcScenes[si + 1]?.src;
    if (nextSrc && nextSrc.enter === 'wipe') {
      const live = [...local.values()].filter(tl => (tl.drawT0 != null || tl.appear) && tl.gone == null);
      if (live.length) {
        const g = { t0: t1 - 0.62, t1: t1 - 0.1, style: 'wipe' as const, ...wipePath({ x: -fmt.board.x, y: -fmt.board.y, w: fmt.W * bk, h: fmt.H * bk }, 260 * bk), scene: si };
        erases.push(g);
        for (const tl of live) { tl.erase = erases.length - 1; tl.gone = g.t1; }
      }
    }
    boards.set(id, { srcs: [...local.values()].filter(tl => !tl.ghost).map(tl => [tl.el.id, { ...tl.el.src, __seed: tl.el.src.__seed ?? id }] as [string, any]), left: [...local.values()].filter(tl => (tl.drawT0 != null || tl.appear) && (tl.gone == null || tl.gone >= t1 - 0.7) && !tl.moves.length).map(tl => tl.el.id), groups: new Map(groups) });
    // 自动取景：这块板上所有东西（含它们移动到过的位置）没铺满画板时，镜头推近到刚好装满。
    // 位置关系一点不变，只是整体放大；东西和字在手机上都更大，板面不再空一截。home 是同一个对象，前面排好的镜头跟着变
    let contentBox: Box | null = null;
    if (meta.autoframe !== false && src.frame !== false) {
      const bs: Box[] = [];
      for (const tl of local.values()) {
        if (tl.drawT0 == null && !tl.appear) continue;
        bs.push(tl.el.box);
        for (const m of tl.moves) bs.push(shifted(tl.el.box, m.to as Pt));
        bs.push(...(extents.get(tl.el.id) ?? []));
      }
      // 沿用（recall）的场景和原场景取同一个景，母图再出现时不跳
      const rcId = src.recall != null ? String(typeof src.recall === 'string' ? src.recall : src.recall?.scene ?? '') : '';
      if (rcId && framed.has(rcId)) bs.push(framed.get(rcId)!);
      if (bs.length) {
        const b = unionBox(bs), B = fmt.board, pad = 36;
        framed.set(id, b); contentBox = b;
        const zoom = Math.min(FRAME_MAX, B.w / (b.w + pad * 2), B.h / (b.h + pad * 2));
        if (zoom >= 1.05 / bk) {
          // 内容中心对到画板中心。zoom 不超过“装得下”的倍数，所以内容仍然全在画板（安全区）里
          const ccx = b.x + b.w / 2, ccy = b.y + b.h / 2;
          home.zoom = zoom;
          home.cx = origin[0] + fmt.board.x + ccx + (screenC[0] - boardC[0]) / zoom;
          home.cy = fmt.board.y + ccy + (screenC[1] - boardC[1]) / zoom;
        }
      }
    }
    // 自己写的近景在这里定景。三件事：
    // 1. 只框“镜头到位时已经画出来、或一秒多之内就要画”的东西；focus 里更晚才画的，等它快画时镜头再带过去——不对着半屏空白等
    // 2. 这一拍正在画的东西（箭头连线除外）顺手框进来，前提是不会把近景拉得太远
    // 3. 画面不越过板上内容的边：对准板边的东西时往里收
    // 近景不从已经画好的东西中间切过去：画面边压到谁，就把谁整个框进来（箭头、线、标记除外：它们本来就通向别处）。
    // 框进来之后放大倍数会变小；小到不值得推近时，由调用的地方决定回全景
    const viewBox = (cm: Cam): Box => { const FB = fmt.board, w = FB.w / cm.zoom, h = FB.h / cm.zoom, cx = cm.cx - origin[0] - FB.x - (screenC[0] - boardC[0]) / cm.zoom, cy = cm.cy - FB.y - (screenC[1] - boardC[1]) / cm.zoom; return { x: cx - w / 2, y: cy - h / 2, w, h }; };
    // 刚画的东西（正在讲的）必须完整：重 10。早先画的字和小人被切一刀也难看，但可以权衡：重 1。早先画的长横条、大图可以伸出画面：不算
    const aliveAt = (t: number): (Box & { wt: number })[] => [...local.values()].flatMap(tl => {
      const born = tl.drawT0 ?? tl.appear?.t ?? Infinity;
      if (['axis', 'arrow', 'line', 'mark'].includes(tl.el.kind) || born > t || (tl.gone != null && tl.gone <= t)) return [];
      const wt = born > t - 4 ? 10 : ['text', 'note', 'figure'].includes(tl.el.kind) ? 1 : 0;
      if (!wt) return [];
      const b = tl.el.kind === 'note' ? tl.el.solid : tl.el.box, mv = tl.moves.length ? tl.moves[tl.moves.length - 1].to as Pt : [0, 0];
      return [{ x: b.x + mv[0], y: b.y + mv[1], w: b.w, h: b.h, wt }];
    });
    const whole = (b: Box, mk: (b: Box) => Cam, t: number): Cam => {
      const alive = aliveAt(t), raw = mk(b), hz = home.zoom || 1, FB = fmt.board;
      const cutBy = (v: Box) => alive.reduce((n, o) => { const a = o.w * o.h, i = Math.max(0, Math.min(o.x + o.w, v.x + v.w) - Math.max(o.x, v.x)) * Math.max(0, Math.min(o.y + o.h, v.y + v.h) - Math.max(o.y, v.y)); return n + (a > 0 && i / a > 0.04 && i / a < 0.97 ? o.wt : 0); }, 0);
      const v0 = viewBox(raw);
      if (!cutBy(v0)) return raw;
      // 在原来的取景附近找一个不切东西的：稍微推近或拉开一点、往旁边让一点，对准的东西始终完整留在画面里
      let best: Cam | null = null, bestCost = Infinity;
      const c0x = v0.x + v0.w / 2, c0y = v0.y + v0.h / 2;
      for (const f of [1, 1.12, 0.9, 1.25, 0.8, 1.4, 0.7, 0.6]) {
        const z = raw.zoom * f, w = FB.w / z, h = FB.h / z;
        if (z < hz * 1.2 || w < b.w + 24 || h < b.h + 24) continue;
        for (const dx of [0, -0.08, 0.08, -0.16, 0.16, -0.24, 0.24]) for (const dy of [0, -0.08, 0.08, -0.16, 0.16, -0.24, 0.24]) {
          const cx = c0x + dx * w, cy = c0y + dy * h, v = { x: cx - w / 2, y: cy - h / 2, w, h };
          if (b.x < v.x + 12 || b.y < v.y + 12 || b.x + b.w > v.x + w - 12 || b.y + b.h > v.y + h - 12) continue;
          const cost = cutBy(v) + 0.2 * Math.abs(Math.log(f)) + 0.3 * (Math.abs(dx) + Math.abs(dy));
          if (cost < bestCost) { bestCost = cost; best = { cx: origin[0] + FB.x + cx + (screenC[0] - boardC[0]) / z, cy: FB.y + cy + (screenC[1] - boardC[1]) / z, zoom: z }; }
        }
      }
      // 尽量少切；怎么挪都要切到正在讲的东西，这一拍就看全景
      return best && bestCost < 10 ? best : home;
    };
    if (pendingCams.length) {
      const FB = fmt.board;
      let CB: Box | null = null;
      const camFor = (b: Box, pad: number, maxZoom: number): Cam => {
        const z = Math.min(maxZoom, FB.w / (b.w + pad * 2), FB.h / (b.h + pad * 2));
        let cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (CB) CB = unionBox([CB, b]); // 对准的地方本身算“有内容”：走到一块还空着的分区时，不被已经画过的那一头拽回去
        if (CB) { const hw = FB.w / z / 2, hh = FB.h / z / 2, m = 30; if (CB.w + 2 * m > 2 * hw) cx = Math.min(Math.max(cx, CB.x - m + hw), CB.x + CB.w + m - hw); if (CB.h + 2 * m > 2 * hh) cy = Math.min(Math.max(cy, CB.y - m + hh), CB.y + CB.h + m - hh); }
        return { cx: origin[0] + FB.x + cx + (screenC[0] - boardC[0]) / z, cy: FB.y + cy + (screenC[1] - boardC[1]) / z, zoom: z };
      };
      const bornOf = (i: string) => { const tl = local.get(i); return tl ? tl.drawT0 ?? tl.appear?.t ?? -Infinity : -Infinity; };
      const explicit = pendingCams.map(p => p.ev), homeEvs = camEvents.filter(k => k.to === home && k.t0 >= t0 - 1e-6);
      for (const p of pendingCams) {
        const until = Math.min(t1, ...[...explicit, ...homeEvs].filter(k => k.t0 > p.ev.t0 + 1e-6).map(k => k.t0));
        const its = p.items.map(it => ({ ...it, born: it.region ? -Infinity : bornOf(it.id) }));
        let now = its.filter(it => it.born <= p.ev.t1 + 1.2);
        const later = its.filter(it => it.born > p.ev.t1 + 1.2 && it.born < until).sort((x, y) => x.born - y.born);
        if (!now.length) now = later.length ? later.splice(0, 1) : its;
        let boxes = now.map(it => it.box);
        // 往里收只看“这时候板上已经有的东西”：板还空着时，对准谁谁就在画面正中
        const sofar = (t: number) => { const bs = [...local.values()].filter(tl => tl.el.kind !== 'axis' && bornOf(tl.el.id) !== -Infinity && bornOf(tl.el.id) <= t && (tl.gone == null || tl.gone > t)).map(tl => tl.el.box); return bs.length ? unionBox(bs) : null; };
        CB = sofar(p.ev.t1 + 1.2);
        const z0 = camFor(unionBox(boxes), p.pad, p.maxZoom).zoom;
        const fset = new Set(p.items.map(it => it.id));
        const beat = [...local.values()].filter(tl => !fset.has(tl.el.id) && !['axis', 'arrow', 'line', 'mark'].includes(tl.el.kind) && bornOf(tl.el.id) >= p.ev.t0 - 0.1 && bornOf(tl.el.id) <= p.ev.t1 + 1.2).map(tl => (tl.el.kind === 'note' ? tl.el.solid : tl.el.box));
        if (beat.length && camFor(unionBox([...boxes, ...beat]), p.pad, p.maxZoom).zoom >= z0 * 0.75) boxes = [...boxes, ...beat];
        { const first = unionBox(boxes), zf = camFor(first, p.pad, p.maxZoom).zoom, cam = whole(first, b => camFor(b, p.pad, p.maxZoom), p.ev.t1 + 1.2); p.ev.to = cam;
          // 自己写的近景被引擎拉远了：说出来，不然作者只看到“推近变成了全景”却不知道为什么
          if (cam === home || cam.zoom < zf * 0.7) issues.push({ level: 'info', where: `${file} / ${fmtTime(p.ev.t0)} 的 camera`, msg: `这个近景${cam === home ? '被换成了全景' : `只推到了 ${(cam.zoom / (home.zoom || 1)).toFixed(2)} 倍（想要的是 ${(zf / (home.zoom || 1)).toFixed(2)} 倍）`}：画面边会从板上已经画好的东西中间切过去，引擎就拉开了。focus 里少放几样，或者把挨着的东西挪开一点` }); }
        let lastT = p.ev.t1, lastCam = p.ev.to;
        for (const it of later) {
          boxes = [...boxes, it.box]; CB = sofar(it.born + 0.5);
          const to = whole(unionBox(boxes), b => camFor(b, p.pad, p.maxZoom), it.born + 0.5), st = Math.max(lastT + 0.2, it.born - 0.5);
          if (st + 0.9 > until || (Math.abs(to.zoom / lastCam.zoom - 1) < 0.04 && Math.hypot(to.cx - lastCam.cx, to.cy - lastCam.cy) * to.zoom < 30)) continue;
          camEvents.push({ t0: st, t1: st + 0.9, to }); lastT = st + 0.9; lastCam = to;
        }
      }
    }
    // 跟拍：引擎像摄像师一样跟着笔走。正在画的东西小就推近；要画的东西跑出画面就跟过去；切换太密就拉回全景；结尾回到全景。
    // 自己写的 camera 动作优先：写了的那一拍按写的来，之后接着跟
    const camMode = src.camera ?? meta.camera ?? (meta.layout === 'pages' ? 'still' : 'follow');
    if (!['follow', 'still'].includes(camMode)) err(file, 'camera 写 follow（跟着笔走，默认）或 still（镜头不动，除非自己写 camera 动作）');
    if (camMode === 'follow' && t1 - t0 >= 12) {
      const mine = camEvents.filter(k => k.t0 >= t0 - 1e-6 && k.t0 < t1); // 这块板里自己写的镜头（进场的平移在 t0 之前，不算）
      const FB = fmt.board, FMAX = bk > 1.2 ? 1.25 : 1.9, PAD = 70, GAP = 3.5, BIG = bk >= 1.8;
      let CB: Box | null = contentBox;
      const drawnBy = (t: number): Box | null => { const bs = [...local.values()].filter(tl => tl.el.kind !== 'axis' && (tl.drawT0 ?? tl.appear?.t ?? Infinity) <= t && (tl.gone == null || tl.gone > t)).map(tl => tl.el.box); return bs.length ? unionBox(bs) : null; };
      const camOf = (b: Box, pad = PAD): Cam => {
        const z = Math.min(FMAX, FB.w / (b.w + pad * 2), FB.h / (b.h + pad * 2));
        // 近景别越过板上内容的边：对准板边上的东西时，画面往里收，不留半屏空白
        let cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        if (CB) CB = unionBox([CB, b]);
        if (CB) { const hw = FB.w / z / 2, hh = FB.h / z / 2, m = 30; if (CB.w + 2 * m > 2 * hw) cx = Math.min(Math.max(cx, CB.x - m + hw), CB.x + CB.w + m - hw); if (CB.h + 2 * m > 2 * hh) cy = Math.min(Math.max(cy, CB.y - m + hh), CB.y + CB.h + m - hh); }
        return { cx: origin[0] + FB.x + cx + (screenC[0] - boardC[0]) / z, cy: FB.y + cy + (screenC[1] - boardC[1]) / z, zoom: z };
      };
      const viewOf = (cm: Cam): Box => { const w = FB.w / cm.zoom, h = FB.h / cm.zoom, cx = cm.cx - origin[0] - FB.x - (screenC[0] - boardC[0]) / cm.zoom, cy = cm.cy - FB.y - (screenC[1] - boardC[1]) / cm.zoom; return { x: cx - w / 2, y: cy - h / 2, w, h }; };
      const inside = (a: Box, v: Box, m = 24) => a.x >= v.x + m && a.y >= v.y + m && a.x + a.w <= v.x + v.w - m && a.y + a.h <= v.y + v.h - m;
      let cur: Cam = home, lastMove = -Infinity, lastHome = t0, held = false; // held：现在的景别是分镜自己写的
      // 大板上从一头走到另一头，镜头走得慢一点
      const go = (t: number, to: Cam, region = false) => { if (to === cur || (Math.abs(to.zoom / cur.zoom - 1) < 0.02 && Math.hypot(to.cx - cur.cx, to.cy - cur.cy) * to.zoom < 12)) return; const far = Math.hypot(to.cx - cur.cx, to.cy - cur.cy) / Math.hypot(fmt.W, fmt.H); camEvents.push({ t0: t, t1: t + Math.min(1.9, 1.1 + 0.35 * Math.max(0, far - 1)), to, region }); cur = to; lastMove = t; held = false; if (to === home) lastHome = t; };
      for (const b of scene.beats) {
        const own = mine.filter(k => k.t0 >= b.t - 1e-6 && k.t0 < b.tEnd);
        if (own.length) { cur = own[own.length - 1].to; lastMove = own[own.length - 1].t0; held = true; if (cur === home) lastHome = lastMove; continue; } // 自己写的镜头：照写的走
        const boxOfBeat = (bb: CBeat): Box | null => { const ids = bb.actions.filter(a => [...APPEAR, 'change', 'become', 'expand'].includes(a.verb)).flatMap(a => a.ids).filter(i => local.has(i) && local.get(i)!.el.kind !== 'axis'); return ids.length ? unionBox(ids.map(i => local.get(i)!.el.kind === 'note' ? local.get(i)!.el.solid : local.get(i)!.el.box)) : null; };
        const tgt = boxOfBeat(b);
        if (!tgt) continue;
        // 往后看一小段：接下来几秒要画的东西一起框进去，免得刚推近就得拉开
        const ahead = scene.beats.filter(x => x.t > b.t && x.t < b.t + GAP && !mine.some(k => k.t0 >= x.t - 1e-6 && k.t0 < x.tEnd)).map(boxOfBeat).filter((x): x is Box => !!x);
        CB = drawnBy(b.t + GAP);
        // 大板按分区走：要画的东西整个落在某个分区里、而这个分区一屏装得下，就对准整个分区——
        // 观众看到的是“走到了这一块”，在这一块里画的时候镜头不再跟着每一笔晃
        // 打开的细节框里画东西：镜头对准整个框，框里画的时候不再跟着每一笔走
        const frIn = [...frames.entries()].find(([f, fb]) => { const ft = local.get(f), op = ft?.appear?.t; return op != null && b.t >= op - 0.05 && b.t < (ft!.gone ?? Infinity) && tgt.x >= fb.x - 8 && tgt.y >= fb.y - 8 && tgt.x + tgt.w <= fb.x + fb.w + 8 && tgt.y + tgt.h <= fb.y + fb.h + 60; });
        const want = frIn ? { ...frIn[1], h: frIn[1].h + 60 } : unionBox([tgt, ...ahead]);
        const home0 = BIG ? [...regions.values()].filter(r => want.x >= r.x - 8 && want.y >= r.y - 8 && want.x + want.w <= r.x + r.w + 8 && want.y + want.h <= r.y + r.h + 8 && Math.min(FB.w / r.w, FB.h / r.h) >= 0.72).sort((p, q) => p.w * p.h - q.w * q.h)[0] : undefined;
        const near = whole(home0 ?? want, x => camOf(x, home0 && x === home0 ? 0 : PAD), b.t + GAP), worth = near.zoom / (home.zoom || 1) >= 1.35 && b.t < t1 - 5, calm = b.t - lastMove >= GAP; // 最后几秒不再推近
        // 分镜自己定的景别（含自己写的全景）：要画的东西在画面里、而且在这个景别下看得清，就不动——那是为这个景别画的
        if (held && inside(tgt, viewOf(cur), 4) && Math.min(tgt.w, tgt.h) * cur.zoom >= 40) continue;
        if (cur === home) { if (worth && calm) go(b.t, near, !!home0); continue; }        // 全景里：要画的东西小，就推近去画
        if (inside(tgt, viewOf(cur))) {                                          // 近景里：还在画面里，不动
          // 大板例外：现在是一个为了看连线拉开的宽景，接下来要画的东西小得多，就走近去画
          if (BIG && !held && calm && near.zoom / cur.zoom >= 1.35) go(b.t, near, !!home0);
          continue;
        }
        // 跑出画面了：能推近就跟过去；东西本来就宽（一条连起两处的线）或者刚动过镜头，就拉回全景看关系
        // 在近景里待太久（15 秒以上）就先回一次全景，让观众知道现在在整张图的哪儿
        // 大板的全景是一张缩得很小的地图，讲到一半回去看不清东西：只要推得近就直接走到下一处
        { const push = worth && (BIG || (calm && b.t - lastHome < 15)); go(b.t, push ? near : home, push && !!home0); }
      }
      // 结尾：最后几秒回到全景，看整张图
      if (cur !== home) go(Math.max(lastMove + GAP, t1 - 3.5), home);
    }
    // 看全：观众看得见的变化，都要看完整。
    // 近景里正在画（或擦、挪、强调）的东西伸出了画面——典型的是一条连到远处的箭头——观众只看到线头，不知道镜头外发生了什么。
    // 这里把每一段近景过一遍：这样的变化发生时，镜头先拉开到装得下它（箭头连同它的两头），画完再推回去。
    // 这是引擎保证的，不靠分镜自觉；meta.seeWhole: false 关掉
    if (meta.seeWhole !== false) {
      const FB = fmt.board, hz = home.zoom || 1, explicitEvs = new Set(pendingCams.map(p => p.ev));
      const sceneEnd = (tl: TL) => tl.erase != null && erases[tl.erase].t0 >= t1 - 0.7;
      const endsOf = (el: El): Box[] => (el.kind !== 'arrow' && el.kind !== 'line' ? [] : [].concat(el.src.arrow ?? el.src.line ?? []).flatMap((r: any) => { const tl = typeof r === 'string' ? local.get(r.split('.')[0].split('@')[0]) : undefined; return tl && tl.el.kind !== 'axis' && (tl.drawT0 != null || tl.appear) ? [tl.el.box] : []; }));
      const needs: { t0: number; t1: number; box: Box; id: string }[] = [];
      for (const tl of local.values()) {
        if (tl.el.kind === 'axis' || tl.recalled || isDivider(tl.el)) continue; // 不连着任何东西、没有小字的线（分隔线）只是装饰：画它不拉远镜头
        const box = unionBox([tl.el.box, ...endsOf(tl.el)]);
        if (box.w <= 0 && box.h <= 0) continue;
        const id = tl.el.id;
        if (tl.drawT0 != null) needs.push({ t0: tl.drawT0, t1: tl.drawT1 ?? tl.drawT0, box, id });
        if (tl.appear) needs.push({ t0: tl.appear.t, t1: tl.appear.t + tl.appear.dur, box, id });
        for (const k of tl.shakes) needs.push({ t0: k.t0, t1: k.t1, box, id });
        for (const k of tl.poses) needs.push({ t0: k.t0, t1: k.t1, box, id });
        for (const m of tl.moves) needs.push({ t0: m.t0, t1: m.t1, box: unionBox([shifted(tl.el.box, m.from), shifted(tl.el.box, m.to)]), id });
        for (const m of tl.morphs) needs.push({ t0: m.t0, t1: m.t1, box: unionBox([box, ...(extents.get(id) ?? [])]), id });
        if (tl.erase != null && !sceneEnd(tl)) needs.push({ t0: erases[tl.erase].t0, t1: erases[tl.erase].t1, box, id });
      }
      // 流动、点亮、变成：整条路都要在画面里
      for (const bb of scene.beats) for (const ac of bb.actions) {
        if (!['flow', 'trace', 'become', 'expand', 'collapse'].includes(ac.verb)) continue;
        const bs = ac.ids.flatMap(i => [local.get(i)?.el.box, ...(ac.verb === 'expand' || ac.verb === 'collapse' ? [local.get(String(local.get(i)?.el.src.detail))?.el.box] : [])]).filter((x): x is Box => !!x);
        if (bs.length) needs.push({ t0: ac.t0, t1: ac.t1, box: unionBox(bs), id: ac.ids[0] });
      }
      needs.sort((a, b) => a.t0 - b.t0);
      const fits = (b: Box, v: Box, m = 6) => b.x >= v.x + m && b.y >= v.y + m && b.x + b.w <= v.x + v.w - m && b.y + b.h <= v.y + v.h - m;
      const fit = (b: Box, maxZoom: number, t: number): Cam => {
        const mk = (x: Box): Cam => { const z = Math.min(maxZoom, FB.w / (x.w + 120), FB.h / (x.h + 120)); return { cx: origin[0] + FB.x + x.x + x.w / 2 + (screenC[0] - boardC[0]) / z, cy: FB.y + x.y + x.h / 2 + (screenC[1] - boardC[1]) / z, zoom: z }; };
        const cm = whole(b, mk, t);
        return cm.zoom < hz * 1.12 || !fits(b, viewBox(cm), 0) ? home : cm;
      };
      const evs = camEvents.filter(k => k.t0 >= t0 - 1e-6 && k.t0 < t1).sort((a, b) => a.t0 - b.t0);
      const added: CamSeg[] = [];
      evs.forEach((ev, i) => {
        const C = ev.to, end = evs[i + 1]?.t0 ?? t1;
        if (C === home) return;
        const mine = needs.filter(n => n.t0 >= ev.t0 - 0.05 && n.t0 < end);
        const out = mine.filter(n => !fits(n.box, viewBox(C)));
        if (!out.length) return;
        const uStart = out[0].t0, uEnd = Math.max(...out.map(n => n.t1));
        const early = uStart <= ev.t1 + 1.5;
        // 拉开的那一段里要变的东西全框进来；不是一开头就拉开时，原来看着的那一块也留在画面里
        const W = fit(unionBox([...mine.filter(n => n.t0 <= uEnd && (early || n.t0 >= uStart - 0.05)).map(n => n.box), ...(early ? [] : [viewBox(C)])]), C.zoom, uStart);
        const wT0 = early ? ev.t0 : Math.max(ev.t1 + 0.1, uStart - 1);
        // 自己写的近景被拉远了三成以上：指名是哪样东西伸出了画面
        if (explicitEvs.has(ev) && (W === home || W.zoom < C.zoom * 0.7)) issues.push({ level: 'info', where: `${file} / ${fmtTime(ev.t0)} 的 camera`, msg: `这个近景${early ? '' : `在 ${fmtTime(wT0)} `}被拉${W === home ? '回全景' : `远到 ${(W.zoom / hz).toFixed(2)} 倍（原来 ${(C.zoom / hz).toFixed(2)} 倍）`}：${[...new Set(out.map(n => `"${n.id}"`))].slice(0, 4).join('、')} 在这期间画出来（或变化）时伸出了画面，观众得看到它整个。想保住这个近景，就把它挪到全景的那一拍去画，或者画短一点` });
        if (early) ev.to = W;
        else added.push({ t0: wT0, t1: uStart, to: W });
        // 画完之后推回原来的近景：和拉开那一下至少隔三秒半（镜头不来回晃），推回去之后还得有三秒可看
        const back = Math.max(uEnd + 0.35, wT0 + 3.5);
        if (end - back >= 3 && W !== C) added.push({ t0: back, t1: back + 1, to: C });
      });
      camEvents.push(...added);
      // 镜头正在路上、要画的东西在出发的那个景别里看不见：镜头提前半秒多动身（放进句子之间的停顿里），落笔时已经到位
      const all = camEvents.filter(k => k.t0 >= t0 - 1e-6 && k.t0 < t1).sort((a, b) => a.t0 - b.t0);
      all.forEach((ev, i) => {
        const prev = all[i - 1], from = prev ? prev.to : home;
        if (from === ev.to || ev.cut) return;
        const during = needs.filter(n => n.t0 >= ev.t0 - 0.05 && n.t0 < ev.t1);
        if (!during.some(n => !fits(n.box, viewBox(from)))) return;
        const busy = Math.max(t0, prev ? prev.t1 + 0.15 : t0, ...needs.filter(n => n.t0 < ev.t0 - 0.05 && !fits(n.box, viewBox(ev.to))).map(n => n.t1 + 0.1));
        const lead = Math.min(0.8, Math.max(0, ev.t0 - busy), Math.max(0, ev.t1 - Math.min(...during.map(n => n.t0))));
        ev.t0 -= lead; ev.t1 -= lead;
      });
    }
    for (const tl of local.values()) {
      if (tl.ghost) { ghosts.push(tl); continue; } // 替身只出现在画面上，不进元素清单，不参与检查
      if (tl.drawT0 == null && !tl.appear && !fromPattern.has(tl.el.id) && tl.el.kind !== 'axis') warn(`${file} / 元素 ${tl.el.id}`, '定义了但从没画出来（没有任何 draw / pop / fade 用到它）');
      tls.push(tl);
    }
  });

  // 镜头：按时间排好
  camEvents.sort((a, b) => a.t0 - b.t0);
  const subs = meta.subtitles === false ? [] : buildSubtitles(al, meta.subtitleMaxChars ?? fmt.subMax);
  const sceneHash = createHash('sha256').update(JSON.stringify({ format: fmt.name, scenes: srcScenes.map(s => [s.src.from, s.src.intent, s.src.enter, ...(s.src.recall != null ? [s.src.recall] : []), [].concat(s.src.pattern ?? []).map((x: any) => (typeof x === 'string' ? x : x?.kind)), (s.src.beats ?? []).map((b: any) => [b?.at, b?.intent])]) })).digest('hex').slice(0, 16);
  tls.sort((a, b) => a.order - b.order);
  // 有计划时，第一道确认认的是计划本身：执行者怎么画不会让它失效
  const planHash = plan ? plan.hash : sceneHash, keyHash = plan ? createHash('sha256').update(plan.hash + JSON.stringify(boardSizes(plan)) + sceneHash).digest('hex').slice(0, 16) : sceneHash;
  if (plan) issues.push(...checkPlan(plan, al, fmt, duration, dir));
  // 附录：镜头停在最后一块板的全景上，全景虚化成底色；附录按一屏的字号排，从画板底边滚上来，滚到最后一条停在画面中间偏上
  const apx = loadAppendix(dir);
  for (const i of apx.issues) issues.push(i);
  let appendix: Compiled['appendix'], total = duration;
  if (apx.appendix && scenes.length && !apx.issues.some(i => i.level === 'error')) {
    const layout = layoutAppendix(apx.appendix, fmt), last = scenes[scenes.length - 1], from = last.home;
    // 从画板底边下面开始（字幕区有纸面遮罩，字是从遮罩里浮上来的）；滚到底时，最后一行落在画面高度的 58% 处
    const start = fmt.board.y + fmt.board.h, dist = start - (fmt.H * 0.58 - layout.height);
    const speed = apx.seconds != null ? Math.min(600, Math.max(60, dist / Math.max(1, apx.seconds - apx.appendix.hold - 0.9 - APPENDIX_DELAY))) : apx.appendix.speed;
    const tm = appendixTiming(dist, speed, apx.appendix.hold);
    appendix = { layout, t0: duration, t1: duration + APPENDIX_DELAY + tm.total, from, start, dist, speed };
    total = appendix.t1;
    if (layout.missing.length) warn('appendix.yaml', `这些字符手写字体里没有，会缺字：${layout.missing.slice(0, 12).join(' ')}。换个写法`);
    if (tm.total > 45) warn('appendix.yaml', `附录要滚 ${Math.round(tm.total)} 秒（${apx.appendix.sections.reduce((n, s) => n + s.items.length, 0)} 条）。片尾太长观众会划走：删掉次要的几条，或者写 seconds: 30 滚快一点（太快就读不清了）`);
    if (speed > 330) warn('appendix.yaml', `附录滚得太快（每秒 ${Math.round(speed)} 像素），字读不清。把 seconds 调大，或者删几条`);
  }
  return { dir, meta, fmt, fps, al, duration, total, ...(appendix ? { appendix } : {}), scenes, tls, erases, cams: camEvents, subs, issues, fx: { flows, traces, ghosts }, planHash: apx.appendix && !plan ? createHash('sha256').update(planHash + JSON.stringify(apx.appendix)).digest('hex').slice(0, 16) : planHash, keyHash: apx.appendix && !plan ? createHash('sha256').update(keyHash + JSON.stringify(apx.appendix)).digest('hex').slice(0, 16) : keyHash, ...(plan ? { plan } : {}), castUse };
}

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
/** 分隔线：两头都是坐标（不连着任何东西）、也没有小字的线。它只是装饰，画它时镜头不必拉开看全 */
export const isDivider = (el: El) => el.kind === 'line' && !el.src?.label && [].concat(el.src?.line ?? []).every((q: any) => Array.isArray(q));

function describe(el: El): string {
  const s = el.src;
  if (el.kind === 'text') return `文字“${String(s.text).replace(/\n/g, '/')}”`;
  const lab = s.label ? `（标“${s.label}”）` : '';
  if (el.kind === 'figure') { const f = typeof s.figure === 'string' ? { pose: s.figure } : s.figure ?? {}; return `小人 ${el.id}${lab}[${s.pose ?? f.pose ?? 'stand'}/${s.face ?? f.face ?? 'happy'}]`; }
  if (el.kind === 'icon') return `图标 ${s.icon}${lab}`;
  if (el.kind === 'doodle') return `手绘件 ${s.doodle}${el.text ? `“${el.text}”` : ''}`;
  if (el.kind === 'arrow') return `箭头 ${JSON.stringify(s.arrow).replace(/"/g, '')}${s.label ? `“${s.label}”` : ''}`;
  if (el.kind === 'line') return `连线 ${JSON.stringify(s.line).replace(/"/g, '')}`;
  if (el.kind === 'mark') return `标记 ${s.mark}→${[].concat(s.target).join(',')}`;
  if (el.kind === 'note') return `批注“${s.note}”→${s.target}`;
  if (el.kind === 'chart') return `${s.chart === 'bar' ? '柱状图' : '折线图'} ${el.id}`;
  if (el.kind === 'shape') return `形状 ${s.shape} ${el.id}${lab}`;
  return `图形 ${el.id}${lab}`;
}

const shifted = (b: Box, p?: Pt): Box => (p ? { x: b.x + p[0], y: b.y + p[1], w: b.w, h: b.h } : b);

function refPoint(els: Map<string, El>, pos: Map<string, Pt>, ref: any, fmt: Format, where: string): Pt {
  if (Array.isArray(ref)) {
    const n = (v: any, total: number) => (typeof v === 'string' && v.endsWith('%') ? (parseFloat(v) / 100) * total : +v);
    return [n(ref[0], fmt.board.w), n(ref[1], fmt.board.h)];
  }
  const [id, a] = String(ref).split('.');
  const el = els.get(id);
  if (!el) throw new SrcError(where, `to 引用了不存在的元素 "${id}"`);
  const p = el.anchors[a ?? 'center'];
  if (!p) throw new SrcError(where, `元素 "${id}" 没有锚点 "${a}"，可用：${Object.keys(el.anchors).join(' ')}`);
  const off = pos.get(id) ?? [0, 0];
  return [p[0] + off[0], p[1] + off[1]];
}

/** 板擦的走位：在 box 上来回横扫 */
function wipePath(b: Box, width?: number): { path: number[]; width: number } {
  const w = width ?? Math.max(70, Math.min(150, b.h * 0.5));
  const rows = Math.max(1, Math.ceil((b.h + 30) / (w * 0.8)));
  const path: number[] = [];
  for (let r = 0; r < rows; r++) {
    const y = b.y - 15 + ((r + 0.5) * (b.h + 30)) / rows, l = b.x - 30, rr = b.x + b.w + 30;
    if (r % 2 === 0) path.push(l, y - 12, rr, y + 12); else path.push(rr, y - 12, l, y + 12);
  }
  if (path.length === 4) { path.push(path[0] + 20, path[1] + 24); }
  return { path, width: w };
}
