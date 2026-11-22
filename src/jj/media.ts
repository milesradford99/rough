// 让 agent 看得起素材：探测时长尺寸、抽帧、胶片条、视频转文字。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

let fontsReady = false;
/** 画字用的字体：仓库自带的霞鹜马克手写体，系统有文泉驿就作后备 */
export function fonts(): string {
  if (!fontsReady) {
    GlobalFonts.registerFromPath(fileURLToPath(new URL('../../assets/fonts/LXGWMarkerGothic-Regular.ttf', import.meta.url)), 'JJ');
    for (const f of ['/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/System/Library/Fonts/PingFang.ttc']) if (existsSync(f)) { GlobalFonts.registerFromPath(f, 'JJSans'); break; }
    fontsReady = true;
  }
  return 'JJ, JJSans, sans-serif';
}

export interface Probe { w: number; h: number; duration: number; video: boolean; audio: boolean; fps: number }
export function probe(file: string): Probe {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,duration:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.error) throw new Error('没有找到 ffprobe（ffmpeg 的一部分），请先安装 ffmpeg');
  if (r.status !== 0) throw new Error(`读不了这个文件：${file}\n${r.stderr}`);
  const j = JSON.parse(r.stdout), v = (j.streams ?? []).find((s: any) => s.codec_type === 'video'), a = (j.streams ?? []).find((s: any) => s.codec_type === 'audio');
  const [fn, fd] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number);
  const duration = +(j.format?.duration ?? v?.duration ?? 0) || 0;
  return { w: +(v?.width ?? 0), h: +(v?.height ?? 0), duration, video: !!v, audio: !!a, fps: fd ? fn / fd : 0 };
}

/** 视频的第 t 秒，缩到 width 宽，PNG */
export function frameAt(file: string, t: number, width = 480): Buffer {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 64 << 20 });
  if (r.status !== 0 || !r.stdout?.length) throw new Error(`取不到 ${basename(file)} 第 ${t.toFixed(1)} 秒的画面`);
  return r.stdout;
}

/** 镜头切换的时间点（ffmpeg 的场景检测，在小图上做，很快） */
export function sceneCuts(file: string, from = 0, to?: number, threshold = 0.3): number[] {
  const a = ['-v', 'info', '-ss', String(from), ...(to != null ? ['-to', String(to)] : []), '-i', file, '-vf', `scale=160:-2,select='gt(scene\\,${threshold})',showinfo`, '-an', '-f', 'null', '-'];
  const r = spawnSync('ffmpeg', ['-hide_banner', ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const out: number[] = [];
  for (const m of (r.stderr ?? '').matchAll(/pts_time:([\d.]+)/g)) out.push(from + +m[1]);
  return out;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/** 胶片条：按镜头切换和均匀间隔抽帧，一张图看完一段视频。返回帧的时间 */
export async function filmstrip(file: string, out: string, o: { from?: number; to?: number; n?: number; title?: string }): Promise<number[]> {
  const p = probe(file);
  const from = Math.max(0, o.from ?? 0), to = Math.min(p.duration, o.to ?? p.duration), span = to - from;
  if (!(span > 0)) throw new Error(`时间范围不对：${from}–${to}（素材长 ${p.duration.toFixed(1)} 秒）`);
  const n = o.n ?? (span <= 8 ? Math.max(4, Math.round(span * 2)) : 24);
  const cuts = span > 8 ? sceneCuts(file, from, to) : [];
  // 均匀的点 + 镜头切换后 0.3 秒（切换那一帧常常是糊的），去掉挨得太近的
  let ts = [...Array.from({ length: n }, (_, i) => from + (span * (i + 0.5)) / n), ...cuts.map(c => c + 0.3)].filter(t => t < to).sort((a, b) => a - b);
  const minGap = span / (n * 1.6);
  ts = ts.filter((t, i) => i === 0 || t - ts[i - 1] >= minGap);
  if (ts.length > n + 8) ts = Array.from({ length: n + 8 }, (_, i) => ts[Math.floor((i * ts.length) / (n + 8))]);
  const cols = p.w >= p.h ? 4 : 6, tw = p.w >= p.h ? 400 : 260, th = Math.round(tw * (p.h / p.w || 0.5625));
  const rows = Math.ceil(ts.length / cols), pad = 8, head = 64, lab = 30;
  const cv = createCanvas(cols * (tw + pad) + pad, head + rows * (th + lab + pad) + pad), ctx = cv.getContext('2d');
  const F = fonts();
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#fff'; ctx.font = `30px ${F}`; ctx.fillText(o.title ?? basename(file), pad, 40);
  ctx.fillStyle = '#aaa'; ctx.font = `20px ${F}`; ctx.fillText(`${fmt(from)}–${fmt(to)} · ${p.w}×${p.h} · ${ts.length} 帧${cuts.length ? ` · 检测到 ${cuts.length} 处镜头切换` : ''}`, pad, 58);
  for (let i = 0; i < ts.length; i++) {
    const x = pad + (i % cols) * (tw + pad), y = head + Math.floor(i / cols) * (th + lab + pad);
    try { const img = await loadImage(frameAt(file, ts[i], tw)); ctx.drawImage(img, x, y, tw, th); } catch { ctx.fillStyle = '#333'; ctx.fillRect(x, y, tw, th); }
    ctx.fillStyle = '#ffd34d'; ctx.font = `22px ${F}`; ctx.fillText(fmt(ts[i]) + `  (${ts[i].toFixed(1)}s)`, x + 4, y + th + 23);
  }
  writeFileSync(out, await cv.encode('png'));
  return ts;
}

/** 字幕文件（yt-dlp 下的 vtt / srt）→ 带时间的文字 */
export function parseSubs(raw: string): Seg[] {
  const ts = (s: string) => { const p = s.trim().replace(',', '.').split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const out: Seg[] = [];
  for (const block of raw.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n'), i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map(x => ts(x.split(' ').filter(Boolean)[0]));
    const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (text && !(out.length && out[out.length - 1].text === text)) out.push({ start: a, end: b, text });
  }
  return out;
}
export interface Seg { start: number; end: number; text: string }

/** 视频里的人声 → 带时间的文字。有平台字幕先用字幕（免费又准），没有再用 faster-whisper */
export function hear(file: string, cache: string, o: { model?: string; lang?: string } = {}): { segs: Seg[]; via: string } {
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const dir = dirname(file), stem = basename(file).replace(/\.[^.]+$/, '');
  const subs = existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith(stem + '.') && /\.(vtt|srt)$/.test(f)).sort((a, b) => Number(/zh/.test(b)) - Number(/zh/.test(a))) : [];
  let res: { segs: Seg[]; via: string };
  if (subs.length) res = { segs: parseSubs(readFileSync(join(dir, subs[0]), 'utf8')), via: `平台字幕 ${subs[0]}` };
  else {
    const py = fileURLToPath(new URL('../../scripts/jj_hear.py', import.meta.url));
    const r = spawnSync(process.env.PYTHON || 'python3', [py, file, o.model ?? 'small', o.lang ?? ''], { encoding: 'utf8', maxBuffer: 256 << 20 });
    if (r.status !== 0) throw new Error(`转文字失败：${(r.stderr || '').trim().split('\n').slice(-3).join('\n')}\n需要 faster-whisper：pip install faster-whisper（第一次运行会下载模型）`);
    res = { segs: JSON.parse(r.stdout), via: `faster-whisper ${o.model ?? 'small'}` };
  }
  writeFileSync(cache, JSON.stringify(res));
  return res;
}
export const fmtTime = fmt;
