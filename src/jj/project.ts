// 剪讲的项目：project.yaml、口播时间表、镜头单（shots.yaml）、素材台账（assets.yaml）。
// 项目的目录结构和画讲一样（script.txt、voice/），所以 hj voice 可以直接给剪讲项目配音。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import YAML from 'yaml';
import { loadAlignment, type Alignment } from '../core/alignment';

export const W = 1080, H = 1920;

export interface Meta { title?: string; fps?: number; voice?: string; audio?: string; subtitles?: boolean; [k: string]: any }

/** 镜头：骨架字段由 jj scaffold / jj sync 写（at 由 agent 可改），其余是 agent 的决定 */
export interface Shot {
  id: string;
  at: string;               // 口播原文锚点：这个镜头从这几个字开口时开始，到下一个镜头的 at 为止
  say?: string;             // 只读：这个镜头里说的话
  dur?: number;             // 只读：镜头时长（秒）
  want?: string;            // agent：想要什么画面
  use?: string;             // agent：素材 id（a001…），或 title（金句卡）
  from?: number;            // agent：用视频素材的第几秒开始
  fit?: 'fill' | 'frame';   // fill 裁满竖屏；frame 整幅放在中间、上下用模糊的同一画面垫底
  focus?: string | number;  // fill 时保哪边：left | center | right | top | bottom，或 0..1
  crop?: [number, number, number, number]; // 只用素材的这一块：[左, 上, 宽, 高]，都是 0..1 的比例（切掉烧进画面的字幕、水印，或者只要图表那一块）
  text?: string;            // 金句卡上的字（不写就用 say）
  pop?: string;             // 说到这几个字时弹出大字（必须是这一镜里说的原文）
  meme?: { use: string; at?: string; dur?: number; place?: 'corner' | 'center' };
  cut?: 'cut' | 'flash' | 'zoom' | 'whip';
  layout?: 'card' | 'full'; // card：顶部标题条 + 中间一张卡片放画面（默认，见 project.yaml 的 layout）；full：画面铺满全屏
  head?: string;            // 这一镜顶部标题条的字（不写就沿用上一镜的，第一镜用 project.yaml 的 headline）
  chart?: Chart;            // use: chart 时的数据图
  note?: string;
}
export const SHOT_KEYS = ['id', 'at', 'say', 'dur', 'want', 'use', 'from', 'fit', 'focus', 'crop', 'text', 'pop', 'meme', 'cut', 'layout', 'head', 'chart', 'note'];
export const CUTS = ['cut', 'flash', 'zoom', 'whip'];

/** 原生数据图：数据写在镜头单里，引擎画、引擎做动画 */
export interface Chart {
  type?: 'bar' | 'line';                 // bar 横条（默认）；line 折线
  title?: string;                        // 图上方的一行字
  unit?: string;                         // 数值后面的单位，如 %、美元、年
  data: [string, number][];              // [[标签, 数值], …]
  highlight?: string | string[];         // 要标红的那一条（标签）
  note?: string;                         // 图下方的出处或注释
}

/** 素材的来源：jj grab / jj snap 自动记，封了签（seal），手改了 jj check 会报错 */
export interface Source {
  url: string;              // 抓取的网址（本地文件是 file://…）
  page?: string;            // 所在页面
  title?: string;
  author?: string;          // 作者、频道、机构
  site?: string;            // 网站
  published?: string;       // 发布日期
  grabbed: string;          // 抓取时间
  sha256: string;
  license: string;          // 见 LICENSES
  licenseUrl?: string;
  find?: string;            // jj snap：截的是页面上哪句原文
  box?: [number, number, number, number]; // 这句原文在截图里的位置（像素）
  via?: 'upload';           // 用户或别的机器下好、放进来的文件：出处是声明的，框架没有亲自抓
}
export interface Asset {
  file: string;             // 相对项目目录
  kind: 'image' | 'video' | 'page';
  w?: number; h?: number; duration?: number;
  source: Source;
  seal: string;
  hd?: { file: string; from: number; to: number }[]; // 选定片段的高清版（jj grab --hd）
  transcript?: string;      // jj hear 的结果
  // agent 写的
  note?: string;
  for?: string[];           // 是哪些镜头的候选
  purpose?: 'quote' | 'licensed';
  why?: string;
  rejected?: string;        // 为什么不用（写了就不再当候选）
}

/** 许可证：绿（可以直接用）、黄（官方公开信息，要写用途）、红（授权不明或有版权，要写评论引用的理由）、禁（不能用） */
export const LICENSES: Record<string, { name: string; tier: 'green' | 'yellow' | 'red' | 'banned'; credit?: boolean }> = {
  cc0: { name: 'CC0', tier: 'green' },
  pd: { name: '公有领域', tier: 'green' },
  'pd-usgov': { name: '美国联邦政府作品（公有领域）', tier: 'green' },
  pexels: { name: 'Pexels 许可', tier: 'green' },
  pixabay: { name: 'Pixabay 许可', tier: 'green' },
  unsplash: { name: 'Unsplash 许可', tier: 'green' },
  'cc-by': { name: 'CC BY', tier: 'green', credit: true },
  'cc-by-sa': { name: 'CC BY-SA', tier: 'green', credit: true },
  own: { name: '自有素材', tier: 'green' },
  ai: { name: 'AI 生成', tier: 'green' },
  official: { name: '官方公开信息', tier: 'yellow', credit: true },
  platform: { name: '视频平台内容', tier: 'red', credit: true },
  unknown: { name: '授权未知', tier: 'red', credit: true },
  'cc-nc': { name: 'CC 禁止商用', tier: 'banned' },
  'cc-nd': { name: 'CC 禁止演绎', tier: 'banned' },
};
export const tierOf = (a: Asset) => LICENSES[a.source.license]?.tier ?? 'red';

export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const sealOf = (s: Source) => sha(JSON.stringify(s, Object.keys(s).sort())).slice(0, 16);

export interface Project {
  dir: string; meta: Meta; fps: number;
  al: Alignment | null; audio: string | null; duration: number;
}
export function loadProject(dir: string): Project {
  const pf = join(dir, 'project.yaml');
  if (!existsSync(pf)) throw new Error(`${dir} 还不是剪讲项目。先运行 jj init ${dir} --script <口播稿.txt>（或 --from <画讲项目>）`);
  const meta: Meta = YAML.parse(readFileSync(pf, 'utf8')) ?? {};
  const alf = join(dir, meta.voice ?? 'voice/alignment.json');
  const al = existsSync(alf) ? loadAlignment(alf) : null;
  const au = join(dir, meta.audio ?? 'voice/narration.wav');
  return { dir, meta, fps: +(meta.fps ?? 30), al, audio: existsSync(au) ? au : null, duration: al?.duration ?? 0 };
}

export const shotsFile = (dir: string) => join(dir, 'shots.yaml');
export function loadShots(dir: string): Shot[] {
  const f = shotsFile(dir);
  if (!existsSync(f)) return [];
  const raw = YAML.parse(readFileSync(f, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${f} 要写成一个列表：- id: s01 …`);
  return raw.map((s: any) => ({ ...s, id: String(s?.id ?? ''), at: s?.at == null ? '' : String(s.at) }));
}
export function saveShots(dir: string, shots: Shot[]) {
  const head = '# 镜头单。骨架（id、at、say、dur）由 jj scaffold 生成；say、dur 只读，改了 at 之后运行 jj sync 重算。\n# 其余字段是 agent 的决定：want 想要什么画面，use 用哪个素材（或 title 金句卡），from 从第几秒开始……jj help shots 看全部字段。\n';
  const clean = shots.map(s => Object.fromEntries(SHOT_KEYS.filter(k => (s as any)[k] !== undefined && (s as any)[k] !== '').map(k => [k, (s as any)[k]])));
  writeFileSync(shotsFile(dir), head + YAML.stringify(clean, { lineWidth: 0 }));
}

export const assetsFile = (dir: string) => join(dir, 'assets.yaml');
export function loadAssets(dir: string): Record<string, Asset> {
  const f = assetsFile(dir);
  if (!existsSync(f)) return {};
  return YAML.parse(readFileSync(f, 'utf8')) ?? {};
}
export function saveAssets(dir: string, assets: Record<string, Asset>) {
  writeFileSync(assetsFile(dir), '# 素材台账。source 和 seal 是 jj grab / jj snap 自动记的，不能手改（jj check 会对签）。\n# note、for、purpose、why、rejected 是 agent 写的：用 jj note / jj reject，或者直接改。\n' + YAML.stringify(assets, { lineWidth: 0 }));
}
export function nextAssetId(assets: Record<string, Asset>): string {
  let n = 1; while (assets[`a${String(n).padStart(3, '0')}`]) n++;
  return `a${String(n).padStart(3, '0')}`;
}

/** 素材文件：选定片段有高清版就用高清版 */
export function mediaFor(dir: string, a: Asset, from = 0, dur = 0): { file: string; offset: number; hd: boolean } {
  for (const h of a.hd ?? []) if (from >= h.from - 1e-3 && from + dur <= h.to + 1e-3 && existsSync(join(dir, h.file))) return { file: join(dir, h.file), offset: h.from, hd: true };
  return { file: join(dir, a.file), offset: 0, hd: false };
}

/** 跨项目的素材库：抓过什么、否过什么，下条片子还记得。JJ_HOME 可以指到一个长期保存的地方 */
export const jjHome = () => process.env.JJ_HOME || join(homedir(), '.jianjiang');
export interface LibEntry { url: string; sha256: string; file: string; kind: Asset['kind']; title?: string; site?: string; license: string; notes: string[]; rejected: string[]; transcript?: string; project: string; id: string; at: string }
export function loadLibrary(): LibEntry[] {
  const f = join(jjHome(), 'library.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}
export function saveLibrary(lib: LibEntry[]) {
  mkdirSync(jjHome(), { recursive: true });
  writeFileSync(join(jjHome(), 'library.json'), JSON.stringify(lib, null, 1));
}

/** 搜索记录：agent 搜过什么词、哪个网站，什么结果 */
export const triedFile = (dir: string) => join(dir, 'tried.yaml');
export interface Tried { shot: string; q: string; where?: string; result?: string; at: string }
export function loadTried(dir: string): Tried[] { const f = triedFile(dir); return existsSync(f) ? YAML.parse(readFileSync(f, 'utf8')) ?? [] : []; }
export function saveTried(dir: string, t: Tried[]) { writeFileSync(triedFile(dir), YAML.stringify(t, { lineWidth: 0 })); }

export const approvalsFile = (dir: string) => join(dir, 'approvals.json');
export const approvals = (dir: string): any => (existsSync(approvalsFile(dir)) ? JSON.parse(readFileSync(approvalsFile(dir), 'utf8')) : {});
