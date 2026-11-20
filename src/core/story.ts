// 导演的产物：创意简报（story.yaml）。在配音之前回答“观众会因为哪一刻恍然大悟”。
// 简报里的四句话（开头、让观众猜、惊叹、落点）都是稿子的原文：引擎据此查顺序，再往下游查计划和画面有没有照做。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import type { Issue } from './compile';
import { resolveAnchor, type Alignment } from './alignment';

/** 能把惊叹做出来的动作：画面上的东西在观众眼前变了，而不是又画了一样新东西 */
export const MOVES = ['become', 'change', 'count', 'grow', 'expand', 'collapse', 'trace', 'flow'] as const;
const MOVE_NAME: Record<string, string> = { become: '变成', change: '改一个量', count: '数字滚动', grow: '长出来', expand: '展开看里面', collapse: '收起', trace: '点亮来路', flow: '流动' };

export interface StoryLine { say: string }
export interface Story {
  audience: string; myth: string; truth: string; motif: string;
  hook: StoryLine & { why?: string };
  predict: StoryLine;
  aha: StoryLine & { see: string; move: string };
  land: StoryLine & { callback: string };
  hash: string;
}

export const STORY_TEMPLATE = `# 创意简报：导演的产物。写完后 hj story → 交用户确认 → 再配音、再交给规划者。
# 它回答一个问题：观众会因为哪一刻恍然大悟。写法见技能里的 director.md。
# say 都写稿子（script.txt）里的原文片段，引擎会去稿子里找。把注释去掉、填上内容。
#
# audience: 谁在看，他们原本知道什么、不知道什么
# myth: 观众原本相信的那个说法（这条片子要推翻或补全它）
# truth: 看完之后他们会换成的那个说法
# motif: 母题：贯穿全片的那一个画面比喻，开头出现，结尾回来
# hook:                      # 开头：头几秒让人停下来的那一句
#   say: "稿子开头的原文"
#   why: 为什么会停下来（反常、悬念、和他有关）
# predict:                   # 揭晓之前，让观众自己先猜一下
#   say: "稿子里那个问题的原文"
# aha:                       # 惊叹点：一个画面变化，不是一句话
#   say: "揭晓那一刻口播的原文"
#   see: 那一刻画面上发生了什么变化
#   move: become             # 用什么做出来：${MOVES.join(' ')}
# land:                      # 落点：回到母题收尾
#   say: "稿子结尾的原文"
#   callback: 回到哪个画面
`;

const FIELDS = ['audience', 'myth', 'truth', 'motif', 'hook', 'predict', 'aha', 'land'];
const strip = (t: string) => t.replace(/[\s，。、；：？！,.;:?!“”"'‘’…—\-（）()《》]/g, '');

export function loadStory(dir: string): { story: Story | null; issues: Issue[] } {
  const f = join(dir, 'story.yaml'), issues: Issue[] = [], err = (msg: string) => issues.push({ level: 'error', where: 'story.yaml', msg });
  if (!existsSync(f)) return { story: null, issues };
  const raw = readFileSync(f, 'utf8');
  let y: any;
  try { y = YAML.parse(raw) ?? {}; } catch (e: any) { err(`YAML 写错了：${e.message}`); return { story: null, issues }; }
  if (!y || typeof y !== 'object' || !Object.keys(y).length) { err('简报还是空的：照注释把每一项填上（director.md 讲怎么想）'); return { story: null, issues }; }
  for (const k of Object.keys(y)) if (!FIELDS.includes(k)) err(`不认识字段 "${k}"。简报只有这几项：${FIELDS.join(' ')}`);
  const str = (v: any) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const line = (k: string, extra: string[] = []): any => {
    const v = y[k];
    if (!v || typeof v !== 'object') { err(`缺 ${k}：要写成 { say: "稿子里的原文"${extra.map(e => `, ${e}: …`).join('')} }`); return { say: '' }; }
    for (const kk of Object.keys(v)) if (![...['say', 'why', 'see', 'move', 'callback']].includes(kk)) err(`${k} 不认识字段 "${kk}"`);
    const o: any = { say: str(v.say) };
    if (!o.say) err(`${k}.say 要写稿子里的原文片段`);
    for (const e of extra) { o[e] = str(v[e]); if (!o[e]) err(`缺 ${k}.${e}`); }
    if (v.why != null) o.why = str(v.why);
    return o;
  };
  const story: Story = {
    audience: str(y.audience), myth: str(y.myth), truth: str(y.truth), motif: str(y.motif),
    hook: line('hook'), predict: line('predict'), aha: line('aha', ['see', 'move']), land: line('land', ['callback']),
    hash: createHash('sha256').update(JSON.stringify(y)).digest('hex').slice(0, 16),
  };
  const need: [keyof Story, string, number][] = [['audience', '谁在看', 60], ['myth', '观众原本相信的说法', 50], ['truth', '看完换成的说法', 50], ['motif', '母题', 40]];
  for (const [k, what, max] of need) { const v = story[k] as string; if (!v) err(`缺 ${k}（${what}）`); else if (v.length > max) err(`${k} 写了 ${v.length} 个字，压到 ${max} 个字以内：说不短，就是还没想清楚`); }
  if (story.myth && story.truth && strip(story.myth) === strip(story.truth)) err('myth 和 truth 一样：没有被推翻或补全的东西，就不会有“原来如此”');
  if (story.aha.move && !(MOVES as readonly string[]).includes(story.aha.move)) err(`aha.move 写 ${MOVES.map(m => `${m}（${MOVE_NAME[m]}）`).join('、')} 之一。惊叹要靠画面上的东西在观众眼前变，不靠再画一样新东西、也不靠写一句话`);
  if (story.aha.see && story.aha.see.length > 80) err(`aha.see 写了 ${story.aha.see.length} 个字：用一句话说清那一刻画面怎么变（80 字以内）`);
  return { story, issues };
}

/** 简报和稿子对得上吗：四句话都在稿子里、顺序对、位置对。有了时间表再查揭晓前有没有停顿 */
export function checkStory(story: Story, script: string, al?: Alignment): Issue[] {
  const out: Issue[] = [], err = (msg: string) => out.push({ level: 'error', where: 'story.yaml', msg }), warn = (msg: string) => out.push({ level: 'warn', where: 'story.yaml', msg });
  const plain = strip(script), N = plain.length || 1;
  const at = (k: 'hook' | 'predict' | 'aha' | 'land'): number => {
    const s = strip(story[k].say);
    if (!s) return NaN;
    const i = plain.indexOf(s);
    if (i < 0) { err(`${k}.say "${story[k].say}" 在稿子里找不到。写稿子（script.txt）里的原文片段；要改说法，先改稿子`); return NaN; }
    if (plain.indexOf(s, i + 1) >= 0) warn(`${k}.say "${story[k].say}" 在稿子里不止一次，取的是第一次：写长一点`);
    return i;
  };
  const h = at('hook'), p = at('predict'), a = at('aha'), l = at('land');
  if (h / N > 0.15) err(`钩子在稿子的 ${Math.round((h / N) * 100)}% 处。开头几秒就要让人停下来：把这句挪到最前面，或者换开头的那句当钩子`);
  if (l / N < 0.7) err(`落点在稿子的 ${Math.round((l / N) * 100)}% 处，后面还有很长。落点是收尾的那一句`);
  if (p >= a) err('predict（让观众猜）要在 aha（揭晓）之前：先猜，再揭晓，惊讶才落得下来');
  else if ((a - p) / N > 0.35) warn(`猜完要隔 ${Math.round(((a - p) / N) * 100)}% 的稿子才揭晓，观众早忘了自己猜的是什么。把问题挪到揭晓前不远处`);
  if (a <= h) err('aha（揭晓）要在开头之后');
  if (l <= a) err('land（落点）要在揭晓之后');
  // “猜”的那一句要真的是一个问题
  if (Number.isFinite(p)) {
    const raw = script.replace(/\s/g, ''), j = raw.indexOf(story.predict.say.replace(/\s/g, ''));
    const tail = j >= 0 ? raw.slice(j, j + story.predict.say.length + 40) : '';
    if (j >= 0 && !/[？?]/.test(tail.split(/[。！!]/)[0])) warn(`predict 那一句“${story.predict.say}”不是一个问句。让观众猜，要把问题抛出来：“你觉得会是多少？”`);
  }
  // 揭晓前停一下：静默是惊叹之前最便宜的铺垫
  if (al && Number.isFinite(a)) {
    try {
      const t = resolveAnchor(al, story.aha.say).time, prev = al.units.filter(u => u.end <= t + 1e-6).pop();
      const gap = prev ? t - prev.end : Infinity;
      if (gap < 0.35) warn(`揭晓那一句（“${story.aha.say}”）前面几乎没有停顿（${gap.toFixed(2)} 秒）。在稿子里它前面断一句（句号、或单独成段），配音会停一下，惊叹才有铺垫`);
    } catch { /* 时间表里找不到的情况已经由稿子检查报过 */ }
  }
  return out;
}

export function storyMarkdown(s: Story): string {
  return [
    '# 创意简报', '',
    `**给谁看**：${s.audience}`, '',
    `**他们原本以为**：${s.myth}`, '',
    `**看完会换成**：${s.truth}`, '',
    `**母题**（贯穿全片的那一个画面）：${s.motif}`, '',
    '| | 稿子里的那一句 | 画面 |', '|---|---|---|',
    `| 开头 | ${s.hook.say} | ${s.hook.why ?? ''} |`,
    `| 让观众猜 | ${s.predict.say} | |`,
    `| **惊叹** | **${s.aha.say}** | ${s.aha.see}（${MOVE_NAME[s.aha.move] ?? s.aha.move}） |`,
    `| 落点 | ${s.land.say} | 回到：${s.land.callback} |`, '',
  ].join('\n');
}
