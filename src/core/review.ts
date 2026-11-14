// 审片页：每道确认闸交给用户看的那一页。由引擎生成，图都嵌在里面，一个文件就能发给用户。
// 确认码印在图上和页面上：用户看了图才报得出来。`hj approve` 要求用户的原话里带着它。
import { createHash } from 'node:crypto';

export type Stage = 'plan' | 'look' | 'keyframes';
export const STAGE_NAME: Record<Stage, string> = { plan: '分镜计划', look: '全景定稿', keyframes: '关键帧' };

/** 四位确认码：由“哪一道闸 + 内容的版本号”算出来，内容一变码就变 */
export function confirmCode(stage: Stage, hash: string): string {
  return String(1000 + (parseInt(createHash('sha256').update(`hj-review:${stage}:${hash}`).digest('hex').slice(0, 8), 16) % 9000));
}
/** 用户的原话里有没有这个确认码（全角数字也认） */
export function hasCode(by: string, code: string): boolean {
  const half = by.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  return new RegExp(`(^|\\D)${code}(\\D|$)`).test(half);
}

export interface ReviewImage { src: string; caption?: string; sub?: string; wide?: boolean }
export interface ReviewBlock { heading: string; note?: string; images?: ReviewImage[]; html?: string; grid?: boolean }
export interface ReviewPage {
  title: string; stage: Stage; code: string; hash: string;
  /** 这一步在整个流程里的位置：前面确认过什么，这一步确认什么，后面还有什么 */
  step: number; steps: string[];
  lead: string;
  /** 请用户回答的问题，最多三个，每个带一个“没意见就这样”的默认 */
  questions: { q: string; fallback: string }[];
  blocks: ReviewBlock[];
  /** 自动检查发现、还没处理的问题，原样列给用户 */
  warnings: string[];
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function reviewHtml(p: ReviewPage): string {
  const name = STAGE_NAME[p.stage];
  const img = (i: ReviewImage) => `<figure${i.wide ? ' class="wide"' : ''}><img loading="lazy" src="${i.src}" alt="${esc(i.caption ?? '')}">${i.caption || i.sub ? `<figcaption>${i.caption ? `<b>${esc(i.caption)}</b>` : ''}${i.sub ? `<span>${esc(i.sub)}</span>` : ''}</figcaption>` : ''}</figure>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · ${esc(p.title)}</title>
<style>
:root{--bg:#f8f5ed;--card:#fffdf7;--ink:#24211e;--dim:#77726c;--line:#e2dccd;--red:#d9433a;--blue:#2f6fb7;--yellow:#fbeab8}
@media (prefers-color-scheme:dark){:root{--bg:#1c1a17;--card:#26231f;--ink:#efe9dc;--dim:#a39c90;--line:#3a362f;--red:#f0685f;--blue:#7fb0ea;--yellow:#4a3f1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,"PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:26px;margin:6px 0 2px}h2{font-size:19px;margin:36px 0 8px;padding-top:18px;border-top:1px solid var(--line)}
.steps{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none;font-size:13px;color:var(--dim)}
.steps li{padding:2px 10px;border:1px solid var(--line);border-radius:99px}.steps li.now{background:var(--ink);color:var(--bg);border-color:var(--ink)}.steps li.done::before{content:"✓ "}
.lead{color:var(--dim);margin:6px 0 18px}
.ask{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin:14px 0}
.ask ol{margin:6px 0 0;padding-left:22px}.ask li{margin:8px 0}.ask small{display:block;color:var(--dim)}
.code{display:inline-block;font:700 30px/1 ui-monospace,Menlo,monospace;letter-spacing:4px;color:var(--red);background:var(--yellow);padding:8px 14px;border-radius:8px;vertical-align:middle}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}figure.wide{max-width:560px;margin:0 auto 14px}
img{display:block;width:100%;height:auto}figcaption{padding:8px 10px;font-size:13.5px}figcaption b{display:block}figcaption span{display:block;color:var(--dim)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}th{color:var(--dim);font-weight:500;white-space:nowrap}
.scroll{overflow-x:auto}.note{color:var(--dim);font-size:14px;margin:4px 0 12px}.warn li{margin:6px 0}
.pair{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1fr);gap:14px;align-items:start}@media (max-width:640px){.pair{grid-template-columns:1fr}}
</style></head><body><main>
<ol class="steps">${p.steps.map((s, i) => `<li class="${i + 1 === p.step ? 'now' : i + 1 < p.step ? 'done' : ''}">${esc(s)}</li>`).join('')}</ol>
<h1>${esc(name)}：${esc(p.title)}</h1>
<p class="lead">${esc(p.lead)}</p>
<div class="ask"><b>请看完下面的图，回答这 ${p.questions.length} 件事</b>
<ol>${p.questions.map(q => `<li>${esc(q.q)}<small>没意见：${esc(q.fallback)}</small></li>`).join('')}</ol>
<p>都没问题，回复 <span class="code">确认 ${esc(p.code)}</span>　要改，直接说改哪儿（图下面有编号）。</p>
<p class="note">确认码只对这一版有效（版本 ${esc(p.hash)}）。内容改了，码会变，要重新看。</p></div>
${p.blocks.map(b => `<h2>${esc(b.heading)}</h2>${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}${b.html ?? ''}${b.images?.length ? (b.grid ? `<div class="grid">${b.images.map(img).join('')}</div>` : b.images.map(img).join('')) : ''}`).join('\n')}
${p.warnings.length ? `<h2>自动检查发现、还没处理的问题（${p.warnings.length}）</h2><ul class="warn">${p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
</main></body></html>
`;
}
