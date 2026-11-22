// 给 agent 和用户看的图：候选拼图（jj compare）、故事板审片页（jj board）、切点检查图（渲染后）。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { type Project, type Asset, LICENSES, tierOf, sha, W, H } from './project';
import { type Timed, type Issue, videoPlan } from './shots';
import { fonts, frameAt, fmtTime } from './media';
import { shotStill, creditLine } from './render';
import { reviewHtml, esc, type ReviewPage } from '../core/review';

const TIER_COLOR: Record<string, string> = { green: '#3c9a55', yellow: '#d9a520', red: '#d9433a', banned: '#7a1f1a' };
const TIER_NAME: Record<string, string> = { green: '授权清楚', yellow: '官方公开', red: '要写引用理由', banned: '不能用' };

/** 素材的一张代表图（视频取 at 秒） */
export async function thumbOf(dir: string, a: Asset, at?: number, width = 480): Promise<any> {
  if (a.kind === 'video') return loadImage(frameAt(join(dir, a.file), at ?? Math.min(1, (a.duration ?? 2) / 2), width));
  return loadImage(join(dir, a.file));
}

/** 感知哈希（差值哈希，64 位）：两张图几乎一样，汉明距离就很小 */
export function dhash(img: any): bigint {
  const c = createCanvas(9, 8), x = c.getContext('2d');
  x.drawImage(img, 0, 0, 9, 8);
  const d = x.getImageData(0, 0, 9, 8).data;
  let h = 0n;
  for (let r = 0; r < 8; r++) for (let q = 0; q < 8; q++) { const i = (r * 9 + q) * 4, j = i + 4; const a = d[i] * 3 + d[i + 1] * 6 + d[i + 2], b = d[j] * 3 + d[j + 1] * 6 + d[j + 2]; h = (h << 1n) | (a > b ? 1n : 0n); }
  return h;
}
export const hamming = (a: bigint, b: bigint) => { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

function fitDraw(ctx: any, img: any, x: number, y: number, w: number, h: number) {
  const s = Math.min(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
function lines(ctx: any, text: string, maxW: number): string[] {
  const out: string[] = []; let l = '';
  for (const c of [...text]) { if (ctx.measureText(l + c).width > maxW && l) { out.push(l); l = c; } else l += c; }
  if (l) out.push(l);
  return out;
}

/** 候选拼图：一个镜头的所有候选摆在一张图上，框架能机械判断的问题直接标出来 */
export async function compareSheet(p: Project, s: Timed, timed: Timed[], assets: Record<string, Asset>, out: string): Promise<{ ids: string[]; flags: Record<string, string[]> }> {
  const F = fonts(), dur = s.t1 - s.t0;
  const cands = Object.entries(assets).filter(([, a]) => a.for?.includes(s.id)).sort((x, y) => Number(!!x[1].rejected) - Number(!!y[1].rejected));
  // 其他镜头已经选定的画面：用来查“和别的镜头几乎一样”
  const others: { id: string; h: bigint }[] = [];
  for (const o of timed) if (o.id !== s.id && o.use && assets[o.use]) { try { others.push({ id: o.id, h: dhash(await thumbOf(p.dir, assets[o.use], o.from, 120)) }); } catch { /* 跳过 */ } }
  const cols = 3, cardW = 420, thumbH = 300, cardH = thumbH + 230, pad = 16, head = 190;
  const rows = Math.max(1, Math.ceil(cands.length / cols));
  const cv = createCanvas(cols * (cardW + pad) + pad, head + rows * (cardH + pad) + pad), ctx = cv.getContext('2d');
  ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#222'; ctx.font = `34px ${F}`; ctx.textBaseline = 'top';
  ctx.fillText(`${s.id}  ${fmtTime(s.t0)}–${fmtTime(s.t1)}（${dur.toFixed(1)} 秒）`, pad, 14);
  ctx.font = `28px ${F}`; lines(ctx, `口播：${s.sayNow}`, cv.width - pad * 2).slice(0, 2).forEach((l, i) => ctx.fillText(l, pad, 62 + i * 36));
  ctx.fillStyle = '#2f6fb7'; lines(ctx, `想要：${s.want ?? '（还没写 want）'}`, cv.width - pad * 2).slice(0, 2).forEach((l, i) => ctx.fillText(l, pad, 132 + i * 34));
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < cands.length; i++) {
    const [id, a] = cands[i], x = pad + (i % cols) * (cardW + pad), y = head + Math.floor(i / cols) * (cardH + pad);
    const f: string[] = (flags[id] = []);
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, cardW, cardH);
    const tier = tierOf(a);
    ctx.fillStyle = TIER_COLOR[tier]; ctx.fillRect(x, y, cardW, 8);
    try {
      if (a.kind === 'video') {
        const at = [0.15, 0.5, 0.85].map(r => (s.use === id && s.from != null ? s.from + dur * r : (a.duration ?? 1) * r));
        for (let j = 0; j < 3; j++) { const img = await thumbOf(p.dir, a, at[j], 280); fitDraw(ctx, img, x + 4 + j * ((cardW - 8) / 3), y + 14, (cardW - 8) / 3 - 4, thumbH - 20); }
      } else fitDraw(ctx, await thumbOf(p.dir, a), x + 6, y + 14, cardW - 12, thumbH - 20);
      const h = dhash(await thumbOf(p.dir, a, s.use === id ? s.from : undefined, 120));
      const near = others.filter(o => hamming(o.h, h) <= 6).map(o => o.id);
      if (near.length) f.push(`和 ${near.slice(0, 3).join('、')} 的画面几乎一样`);
    } catch { ctx.fillStyle = '#ccc'; ctx.fillRect(x + 6, y + 14, cardW - 12, thumbH - 20); }
    if (a.kind === 'video') { const vp = videoPlan(a, s.use === id ? s.from ?? 0 : 0, dur); if (vp.cover < 1) f.push(`素材只有 ${(a.duration ?? 0).toFixed(1)} 秒，比镜头短`); void vp; }
    if ((a.w ?? 1) / (a.h ?? 1) > 1.15) f.push(`横屏 ${a.w}×${a.h}：裁满竖屏只剩中间 ${Math.round(((a.h ?? 1) * (W / H)) / (a.w ?? 1) * 100)}%，或用 fit: frame`);
    if (tier !== 'green') f.push(`${LICENSES[a.source.license]?.name ?? '授权不明'}${a.purpose ? `（已写用途：${a.purpose}）` : '，要用得写 purpose 和 why'}`);
    if (/video|bilibili|youtube|douyin/i.test(a.source.site ?? '')) f.push('来自视频平台');
    const usedBy = timed.filter(o => o.use === id && o.id !== s.id).map(o => o.id);
    if (usedBy.length) f.push(`已经用在 ${usedBy.join('、')}`);
    if (a.rejected) f.push(`已否：${a.rejected}`);
    let ty = y + thumbH + 2;
    ctx.fillStyle = a.rejected ? '#999' : '#111'; ctx.font = `30px ${F}`; ctx.fillText(`${id}${s.use === id ? '  ✓ 选定' : ''}`, x + 10, ty); ty += 38;
    ctx.font = `21px ${F}`; ctx.fillStyle = '#444';
    const meta = [a.kind === 'video' ? `视频 ${(a.duration ?? 0).toFixed(1)}s` : a.kind === 'page' ? '网页截图' : '图片', a.w ? `${a.w}×${a.h}` : '', a.source.published?.slice(0, 10) ?? '', a.source.site ?? ''].filter(Boolean).join(' · ');
    for (const l of lines(ctx, meta, cardW - 20).slice(0, 2)) { ctx.fillText(l, x + 10, ty); ty += 26; }
    if (a.note) for (const l of lines(ctx, `备注：${a.note}`, cardW - 20).slice(0, 2)) { ctx.fillText(l, x + 10, ty); ty += 26; }
    ctx.fillStyle = TIER_COLOR[tier]; ctx.fillText(`● ${TIER_NAME[tier]}`, x + 10, ty); ty += 28;
    ctx.fillStyle = '#c0392b';
    for (const l of f.flatMap(t => lines(ctx, '! ' + t, cardW - 20)).slice(0, 3)) { ctx.fillText(l, x + 10, ty); ty += 25; }
  }
  if (!cands.length) { ctx.fillStyle = '#999'; ctx.font = `30px ${F}`; ctx.fillText(`还没有候选。抓素材时加 --as ${s.id}，就会出现在这里`, pad, head + 40); }
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, await cv.encode('png'));
  return { ids: cands.map(c => c[0]), flags };
}

/** 素材定稿的版本：镜头的决定 + 用到的素材的签 + 口播。换了素材、挪了起点，就要重新确认 */
export function footageHash(p: Project, timed: Timed[], assets: Record<string, Asset>): string {
  const keys = ['id', 'use', 'from', 'fit', 'focus', 'crop', 'text', 'pop', 'meme', 'cut'];
  return sha(JSON.stringify({ shots: timed.map(s => [...keys.map(k => (s as any)[k] ?? null), +s.t0.toFixed(2), +s.t1.toFixed(2)]), seals: timed.map(s => (s.use && assets[s.use] ? assets[s.use].seal : null)), text: p.al?.flat })).slice(0, 8);
}

/** 故事板：每个镜头一行：口播 | 选中的画面（和成片一样的裁切） | 来源和授权 */
export async function boardReview(p: Project, timed: Timed[], assets: Record<string, Asset>, issues: Issue[]): Promise<{ html: string; png: string; hash: string }> {
  const hash = footageHash(p, timed, assets), F = fonts();
  const thumbs: any[] = [];
  for (let k = 0; k < timed.length; k++) thumbs.push(await shotStill(p, timed[k], assets, 270, k));
  const rowsHtml: string[] = [];
  let quotes = 0, titles = 0;
  for (let k = 0; k < timed.length; k++) {
    const s = timed[k], a = s.use && s.use !== 'title' ? assets[s.use] : undefined;
    const tier = a ? tierOf(a) : s.use === 'title' ? 'green' : 'red';
    if (a?.purpose === 'quote') quotes++;
    if (s.use === 'title') titles++;
    const src = a ? `${esc(creditLine(a))}<br><a href="${esc(a.source.page ?? a.source.url)}">${esc((a.source.title ?? a.source.page ?? a.source.url).slice(0, 60))}</a>` : s.use === 'title' ? '金句卡（不用外部素材）' : '还没选';
    const flag = a?.purpose === 'quote' ? `<em class="alert">⚠ 评论性引用：${esc(a.why ?? '')}</em>` : '';
    rowsHtml.push(`<div class="seg"><img src="${'data:image/jpeg;base64,' + (await thumbs[k].encode('jpeg', 80)).toString('base64')}" alt="${s.id}"><div><div class="seg-h"><b>${s.id}</b><span class="tag">${fmtTime(s.t0)}–${fmtTime(s.t1)} · ${(s.t1 - s.t0).toFixed(1)}s</span><span class="tag" style="color:${TIER_COLOR[tier]};border-color:${TIER_COLOR[tier]}">${a ? LICENSES[a.source.license]?.name ?? a.source.license : s.use === 'title' ? '金句卡' : '缺画面'}</span>${s.cut && s.cut !== 'cut' ? `<span class="tag">转场 ${s.cut}</span>` : ''}${s.pop ? `<span class="tag in">弹字 ${esc(s.pop)}</span>` : ''}</div><p class="say">${esc(s.sayNow)}</p>${s.want ? `<p class="intent">${esc(s.want)}</p>` : ''}<p class="note">${src}</p>${flag ? `<p>${flag}</p>` : ''}</div></div>`);
  }
  // 长图：一屏 6 列缩略图，带镜头号和授权色标
  const cols = 6, tw = 270, th = Math.round((tw * H) / W), lab = 64, pad = 10, head = 110;
  const rows = Math.ceil(timed.length / cols);
  const cv = createCanvas(cols * (tw + pad) + pad, head + rows * (th + lab + pad) + pad), ctx = cv.getContext('2d');
  ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#222'; ctx.font = `40px ${F}`; ctx.textBaseline = 'top'; ctx.fillText(`素材定稿 · ${String(p.meta.title ?? '')}`, pad, 16);
  ctx.font = `24px ${F}`; ctx.fillStyle = '#666'; ctx.fillText(`版本 ${hash} · ${timed.length} 个镜头 · 金句卡 ${titles} · 评论性引用 ${quotes}`, pad, 70);
  for (let k = 0; k < timed.length; k++) {
    const s = timed[k], x = pad + (k % cols) * (tw + pad), y = head + Math.floor(k / cols) * (th + lab + pad);
    ctx.drawImage(thumbs[k], x, y, tw, th);
    const a = s.use && s.use !== 'title' ? assets[s.use] : undefined, tier = a ? tierOf(a) : s.use === 'title' ? 'green' : 'red';
    ctx.fillStyle = TIER_COLOR[tier]; ctx.fillRect(x, y + th, tw, 6);
    ctx.fillStyle = '#111'; ctx.font = `22px ${F}`; ctx.fillText(`${s.id} ${fmtTime(s.t0)}`, x + 2, y + th + 10);
    ctx.fillStyle = '#555'; ctx.font = `18px ${F}`; ctx.fillText(lines(ctx, s.sayNow, tw - 4)[0] ?? '', x + 2, y + th + 38);
  }
  const page: ReviewPage = {
    title: String(p.meta.title ?? '未命名'), stage: 'footage', hash, step: 2, steps: ['口播稿和配音', '素材定稿', '成片'],
    lead: '每个镜头用什么画面。左边是成片里这个镜头的样子（裁切和成片一样，不含字幕），右边是这句口播、想要的画面、素材出处和授权。红色标签的是评论性引用，请你拍板。',
    questions: [{ q: '有没有哪个镜头的画面和这句话对不上，或者不够有冲击力？', fallback: '没有，都可以' }, { q: `标红的 ${quotes} 处评论性引用（新闻、平台视频的片段），能接受吗？`, fallback: '可以，按现在的理由引用' }, { q: '金句卡、截图、视频的比例合适吗？', fallback: '合适' }],
    blocks: [{ heading: `逐个镜头（${timed.length}）`, html: `<div class="segs">${rowsHtml.join('\n')}</div>` }],
    warnings: issues.filter(i => i.level === 'warn').map(i => `${i.where}：${i.msg}`),
  };
  const out = join(p.dir, 'out', 'review'); mkdirSync(out, { recursive: true });
  const html = reviewHtml(page), png = await cv.encode('png');
  for (const f of [`footage-${hash}`, 'footage']) { writeFileSync(join(out, f + '.html'), html); writeFileSync(join(out, f + '.png'), png); }
  writeFileSync(join(out, 'footage.json'), JSON.stringify({ hash, at: new Date().toISOString() }));
  return { html: resolve(out, `footage-${hash}.html`), png: resolve(out, `footage-${hash}.png`), hash };
}

/** 切点检查图：每个切点前后各一帧，自动标出黑帧 */
export async function cutSheet(video: string, cuts: { id: string; t: number }[], out: string): Promise<string[]> {
  const F = fonts(), tw = 160, th = Math.round((tw * H) / W), pairW = tw * 2 + 6, cols = 5, pad = 12, lab = 34;
  const rows = Math.ceil(cuts.length / cols);
  const cv = createCanvas(cols * (pairW + pad) + pad, rows * (th + lab + pad) + pad + 50), ctx = cv.getContext('2d');
  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#fff'; ctx.font = `28px ${F}`; ctx.textBaseline = 'top'; ctx.fillText('切点检查：每对是切点前一帧 | 后一帧', pad, 12);
  const bad: string[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i], x = pad + (i % cols) * (pairW + pad), y = 50 + Math.floor(i / cols) * (th + lab + pad);
    let black = false;
    for (const [j, t] of [[0, c.t - 0.06], [1, c.t + 0.1]] as const) {
      try {
        const img = await loadImage(frameAt(video, t, tw));
        ctx.drawImage(img, x + j * (tw + 6), y, tw, th);
        const d = ctx.getImageData(x + j * (tw + 6), y, tw, th).data; let sum = 0; for (let q = 0; q < d.length; q += 16) sum += d[q] + d[q + 1] + d[q + 2];
        if (sum / (d.length / 16) / 3 < 10) black = true;
      } catch { black = true; }
    }
    if (black) { bad.push(c.id); ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 4; ctx.strokeRect(x - 2, y - 2, pairW + 4, th + 4); }
    ctx.fillStyle = black ? '#ff6b60' : '#ddd'; ctx.font = `22px ${F}`; ctx.fillText(`${c.id} ${fmtTime(c.t)}${black ? ' 黑帧' : ''}`, x, y + th + 6);
  }
  writeFileSync(out, await cv.encode('png'));
  return bad;
}
export { existsSync };
