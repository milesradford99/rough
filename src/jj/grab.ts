// 抓素材：任何网址一个命令抓下来，同时自动记台账（来源、作者、日期、许可证、哈希）。
// 抓什么、为什么抓，是 agent 的判断；这里只负责抓准、记全、不重复。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, renameSync } from 'node:fs';
import { join, extname, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';
import { type Asset, type Source, sealOf, sha, loadAssets, saveAssets, nextAssetId, loadLibrary, saveLibrary, jjHome } from './project';
import { probe } from './media';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
/** 交给 yt-dlp 的网站（视频平台、带视频的社交网站） */
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|b23\.tv|douyin\.com|ixigua\.com|weibo\.com|weibo\.cn|twitter\.com|x\.com|vimeo\.com|dailymotion\.com|tiktok\.com|kuaishou\.com|v\.qq\.com|youku\.com|cctv\.com|cntv\.cn|cnbc\.com|bloomberg\.com|c-span\.org|rumble\.com|facebook\.com|instagram\.com|streamable\.com)$/i;
/** 官方机构的网站：公开信息，引用时写用途（黄档） */
const OFFICIAL = /(^|\.)(gov\.cn|federalreserve\.gov|pbc\.gov\.cn|safe\.gov\.cn|stats\.gov\.cn|csrc\.gov\.cn|gold\.org|cmegroup\.com|ecb\.europa\.eu|imf\.org|worldbank\.org|bis\.org|sse\.com\.cn|szse\.cn|sge\.com\.cn|lbma\.org\.uk|bankofengland\.co\.uk|boj\.or\.jp|oecd\.org|un\.org|treasury\.gov|bls\.gov|bea\.gov|sec\.gov|cftc\.gov|europa\.eu)$/i;

export interface GrabResult { id: string; asset: Asset; reused?: 'project' | 'library'; extra: string[] }

/** Wikimedia 要求自动程序用能说明身份的 User-Agent，用浏览器的会被限流 */
const uaFor = (u: string) => (/wiki(media|pedia)\.org/.test(u) ? 'jianjiang-grab/1.0 (open-source video tool; curl)' : UA);
/** 额外传给 yt-dlp 的参数，比如 --cookies-from-browser chrome（平台要求登录、或者把机房 IP 当成机器人时） */
const ytExtra = () => (process.env.JJ_YTDLP_ARGS ?? '').split(/\s+/).filter(Boolean);
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const today = () => new Date().toISOString();
const ymd = (s?: string) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s);
const stripTags = (s?: string) => (s ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** 许可证：从网址的域名就能认出来的 */
function licenseByHost(host: string): Pick<Source, 'license' | 'licenseUrl'> | null {
  if (/(^|\.)pexels\.com$/.test(host)) return { license: 'pexels', licenseUrl: 'https://www.pexels.com/license/' };
  if (/(^|\.)pixabay\.com$/.test(host)) return { license: 'pixabay', licenseUrl: 'https://pixabay.com/service/license-summary/' };
  if (/(^|\.)unsplash\.com$/.test(host)) return { license: 'unsplash', licenseUrl: 'https://unsplash.com/license' };
  if (/\.gov$/.test(host) && !/\.gov\.[a-z]{2}$/.test(host)) return { license: 'pd-usgov', licenseUrl: 'https://www.usa.gov/government-copyright' };
  if (OFFICIAL.test(host)) return { license: 'official' };
  return null;
}
/** 许可证的文字（CC BY-SA 4.0、Public domain…）→ 台账里的代号 */
export function licenseFromText(t: string): string | null {
  const s = t.toLowerCase();
  if (/cc0|publicdomain\/zero|creative commons zero/.test(s)) return 'cc0';
  if (/public ?domain|publicdomain\/mark|pd-/.test(s)) return 'pd';
  if (/(cc|creative ?commons)[ -]?(by|attribution)|licenses\/by/.test(s)) return /\bnc\b|-nc|noncommercial|non-commercial/.test(s) ? 'cc-nc' : /\bnd\b|-nd|noderiv/.test(s) ? 'cc-nd' : /\bsa\b|-sa|sharealike/.test(s) ? 'cc-by-sa' : 'cc-by';
  return null;
}

function curl(url: string, out: string): { type: string; final: string } {
  const hdr = out + '.headers';
  const r = spawnSync('curl', ['-L', '-sS', '--fail', '--retry', '3', '--retry-delay', '4', '--retry-max-time', '40', '--max-time', '180', '-A', uaFor(url), '-D', hdr, '-o', out, '-w', '%{content_type}\n%{url_effective}', url], { encoding: 'utf8' });
  if (r.error) throw new Error('没有找到 curl');
  if (r.status !== 0) throw new Error(`下载失败（${url}）：${(r.stderr || '').trim()}。网站拒绝了自动下载的话，换一个来源，或者用 jj snap 截图`);
  const [type, final] = (r.stdout || '').trim().split('\n');
  return { type: (type || '').split(';')[0].trim().toLowerCase(), final: final || url };
}
function curlText(url: string): string {
  const r = spawnSync('curl', ['-L', '-sS', '--fail', '--retry', '3', '--retry-delay', '4', '--retry-max-time', '40', '--max-time', '60', '-A', uaFor(url), url], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`请求失败（${url}）：${(r.stderr || '').trim()}`);
  return r.stdout;
}

/** Wikimedia Commons：查文件的作者和许可证（接口返回的，不靠猜） */
function commonsInfo(fileTitle: string): { url: string; page: string; author?: string; license: string; licenseUrl?: string; title?: string; published?: string } {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=1920&titles=${encodeURIComponent(fileTitle)}`;
  const j = JSON.parse(curlText(api));
  const pg: any = Object.values(j.query?.pages ?? {})[0];
  const ii = pg?.imageinfo?.[0];
  if (!ii) throw new Error(`Commons 上找不到 ${fileTitle}`);
  const em = ii.extmetadata ?? {};
  const lic = licenseFromText(`${em.LicenseShortName?.value ?? ''} ${em.License?.value ?? ''} ${em.LicenseUrl?.value ?? ''}`) ?? 'unknown';
  return { url: ii.width > 1920 && ii.thumburl ? ii.thumburl : ii.url, page: ii.descriptionurl, author: stripTags(em.Artist?.value) || undefined, license: lic, licenseUrl: em.LicenseUrl?.value, title: stripTags(em.ObjectName?.value) || fileTitle.replace(/^File:/, ''), published: stripTags(em.DateTimeOriginal?.value) || undefined };
}

function ytdlpInfo(url: string): any {
  const r = spawnSync('yt-dlp', ['-J', '--no-playlist', '--no-warnings', ...ytExtra(), url], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.error) throw new Error('没有找到 yt-dlp：pip install -U yt-dlp（平台经常改版，yt-dlp 要常更新）');
  if (r.status !== 0) throw new Error(`yt-dlp 读不了这个网址：${(r.stderr || '').trim().split('\n').slice(-2).join(' ')}\n  平台改版了就先 pip install -U yt-dlp；要求登录或说你是机器人，设 JJ_YTDLP_ARGS="--cookies-from-browser chrome"；还不行换一个来源`);
  return JSON.parse(r.stdout);
}
function ytdlpDownload(url: string, outStem: string, format: string, extra: string[] = []) {
  const r = spawnSync('yt-dlp', ['--no-playlist', '--no-warnings', ...ytExtra(), '-f', format, '--merge-output-format', 'mp4', '-o', outStem + '.%(ext)s', ...extra, url], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`yt-dlp 下载失败：${(r.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
}

/** 无头浏览器（Playwright）。网页截图、jj snap 用 */
export async function browser(): Promise<any> {
  const req = createRequire(import.meta.url);
  let pw: any;
  for (const m of ['playwright', 'playwright-core']) { try { pw = req(m); break; } catch { /* 下一个 */ } }
  if (!pw) throw new Error('网页截图要用 Playwright：npm install playwright && npx playwright install chromium');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const opts: any = { args: ['--no-sandbox'], ...(proxy ? { proxy: { server: proxy } } : {}) };
  try { return await pw.chromium.launch(opts); } catch (e) { if (existsSync('/opt/pw-browsers/chromium')) return pw.chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium' }); throw e; }
}

/** 页面里找一句原文，返回它在整页里的位置（CSS 像素）。空白、换行不算 */
const FIND_JS = `(needle) => {
  const norm = s => s.replace(/\\s+/g, '');
  const want = norm(needle); if (!want) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let flat = '', map = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement; if (!el) continue;
    const st = getComputedStyle(el); if (st.display === 'none' || st.visibility === 'hidden') continue;
    const t = n.nodeValue;
    for (let i = 0; i < t.length; i++) if (!/\\s/.test(t[i])) { flat += t[i]; map.push([n, i]); }
  }
  for (let k = flat.indexOf(want); k >= 0; k = flat.indexOf(want, k + 1)) {
    const r = document.createRange(); const a = map[k], b = map[k + want.length - 1];
    r.setStart(a[0], a[1]); r.setEnd(b[0], b[1] + 1);
    const rects = [...r.getClientRects()].filter(x => x.width > 0 && x.height > 0);
    if (!rects.length || (a[0].parentElement.checkVisibility && !a[0].parentElement.checkVisibility())) continue;
    const x0 = Math.min(...rects.map(x => x.left)), y0 = Math.min(...rects.map(x => x.top)), x1 = Math.max(...rects.map(x => x.right)), y1 = Math.max(...rects.map(x => x.bottom));
    return { x: x0 + scrollX, y: y0 + scrollY, w: x1 - x0, h: y1 - y0 };
  }
  return null;
}`;
const META_JS = `() => {
  const m = n => document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]')?.content || '';
  const lic = [...document.querySelectorAll('a[rel~=license],link[rel~=license]')].map(a => a.href).join(' ') + ' ' + m('license') + ' ' + m('dc.rights');
  const imgs = [...document.images].filter(i => i.naturalWidth >= 500).sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight).slice(0, 8).map(i => i.currentSrc || i.src);
  const vids = [...document.querySelectorAll('video source,video')].map(v => v.currentSrc || v.src).filter(Boolean).slice(0, 4);
  return { title: m('og:title') || document.title, site: m('og:site_name'), author: m('author') || m('article:author') || m('dc.creator'), published: m('article:published_time') || m('pubdate') || m('date') || m('dc.date') || document.querySelector('time[datetime]')?.getAttribute('datetime') || '', ogImage: m('og:image'), lic, imgs, vids, text: document.body.innerText.slice(0, 30000) };
}`;

/** 网页：截图（手机宽度，竖着看正合适）+ 正文 + 元信息。find：截这句原文所在的那一屏，并记下位置 */
async function shootPage(url: string, outPng: string, o: { find?: string; full?: boolean }): Promise<{ meta: any; box?: [number, number, number, number]; final: string }> {
  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2, userAgent: UA.replace('Windows NT 10.0; Win64; x64', 'Linux; Android 14; Pixel 8') + ' Mobile', locale: 'zh-CN' });
    let resp: any;
    try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e: any) { throw new Error(`打不开这个网页：${e.message.split('\n')[0]}`); }
    if (resp && resp.status() >= 400) throw new Error(`网页返回 ${resp.status()}（网站拒绝了，或者页面不存在）。换一个来源`);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const meta = await page.evaluate(`(${META_JS})()`);
    if (String(meta.text ?? '').replace(/\s/g, '').length < 60) throw new Error(`页面几乎没有内容（只有“${String(meta.text ?? '').trim().slice(0, 40)}”），多半是没打开、要登录或被拦了。换一个来源`);
    // 浮在页面上的东西（“打开APP”按钮、cookie 提示、吸顶的导航）挡住正文：截图前藏起来
    await page.evaluate(`for (const el of document.querySelectorAll('body *')) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') el.style.setProperty('display', 'none', 'important'); }`).catch(() => {});
    let box: [number, number, number, number] | undefined;
    if (o.find) {
      const r: any = await page.evaluate(`(${FIND_JS})(${JSON.stringify(o.find)})`);
      if (!r) throw new Error(`页面上找不到这句原文："${o.find}"。逐字核对（截图引用必须是页面上真有的话），或者换一句更短的、确实在页面上的原文`);
      // 截原文所在的一屏：原文放在上三分之一处
      const H = 960, top = Math.max(0, r.y - H * 0.33);
      await page.evaluate(`window.scrollTo(0, ${top})`); await page.waitForTimeout(500);
      const sy: number = await page.evaluate('scrollY');
      await page.screenshot({ path: outPng });
      box = [Math.round(r.x * 2), Math.round((r.y - sy) * 2), Math.round(r.w * 2), Math.round(r.h * 2)];
    } else {
      const h: number = await page.evaluate('document.documentElement.scrollHeight');
      await page.screenshot({ path: outPng, fullPage: true, clip: { x: 0, y: 0, width: 540, height: Math.min(h, o.full ? 8000 : 2880) } });
    }
    return { meta, box, final: page.url() };
  } finally { await b.close(); }
}

const extFor = (type: string, url: string) => {
  const m: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'image/svg+xml': '.svg', 'image/avif': '.avif' };
  return m[type] ?? (extname(new URL(url).pathname).toLowerCase() || '.bin');
};

/** 本项目或素材库里已经有这个网址 / 这个文件了吗 */
function findExisting(assets: Record<string, Asset>, url: string, hash?: string): string | null {
  for (const [id, a] of Object.entries(assets)) if (a.source.url === url || (hash && a.source.sha256 === hash)) return id;
  return null;
}

export interface GrabOpts { as?: string; note?: string; video?: boolean; find?: string; license?: string; full?: boolean; page?: boolean }

export async function grab(dir: string, url: string, o: GrabOpts = {}): Promise<GrabResult> {
  const assets = loadAssets(dir), media = join(dir, 'media');
  mkdirSync(media, { recursive: true });
  const extra: string[] = [];
  const attach = (id: string, reused?: GrabResult['reused']): GrabResult => {
    const a = assets[id];
    if (o.as) a.for = [...new Set([...(a.for ?? []), ...o.as.split(',')])];
    if (o.note) a.note = a.note ? `${a.note}；${o.note}` : o.note;
    saveAssets(dir, assets); remember(dir, id, a);
    return { id, asset: a, reused, extra };
  };
  const local = !/^https?:\/\//i.test(url);
  // Pexels 的页面拒绝自动访问，但图片地址有固定写法：页面网址直接换成原图
  const px = url.match(/^https?:\/\/(?:www\.)?pexels\.com\/(?:[a-z-]+\/)?photo\/(?:[^/]*-)?(\d+)\/?$/i);
  if (px) url = `https://images.pexels.com/photos/${px[1]}/pexels-photo-${px[1]}.jpeg?auto=compress&w=2400`;
  if (o.license && !local) throw new Error('--license 只用于本地文件。网上的素材，许可证由框架从来源识别，不能自己填');
  if (local && o.license && !['own', 'ai', 'unknown'].includes(o.license)) throw new Error('本地文件的 --license 只能是 own（自己拍的、自己做的）、ai（AI 生成）或 unknown。网上下的东西请直接 jj grab 它的网址，许可证由框架识别');
  const key = local ? 'file://' + resolve(url) : url;
  // 抓过的网址不重复下载（jj snap 每句原文是一次新的截图）
  if (!o.find) { const hit = findExisting(assets, key); if (hit) return attach(hit, 'project'); }
  if (!o.find && !local) {
    const lib = loadLibrary().find(e => e.url === key && existsSync(e.file));
    if (lib) {
      const id = nextAssetId(assets), file = `media/${id}${extname(lib.file)}`;
      copyFileSync(lib.file, join(dir, file));
      for (const f of readdirSync(join(lib.file, '..')).filter(f => f.startsWith(basename(lib.file).replace(/\.[^.]+$/, '') + '.') && /\.(vtt|srt|txt)$/.test(f))) copyFileSync(join(lib.file, '..', f), join(media, f.replace(/^[^.]+/, id)));
      const p = probe(join(dir, file));
      const src = JSON.parse(readFileSync(join(jjHomeMeta(), lib.sha256 + '.json'), 'utf8')) as Source;
      assets[id] = { file, kind: lib.kind, ...(p.w ? { w: p.w, h: p.h } : {}), ...(lib.kind === 'video' ? { duration: +p.duration.toFixed(2) } : {}), source: src, seal: sealOf(src) };
      if (lib.rejected.length) extra.push(`! 素材库里记着它被否过：${lib.rejected.join('；')}`);
      return attach(id, 'library');
    }
  }
  const id = nextAssetId(assets);
  let source: Source, kind: Asset['kind'], file: string, hdPending = false;
  if (local) {
    const abs = resolve(url);
    if (!existsSync(abs)) throw new Error(`找不到文件：${url}`);
    const lic = o.license ?? 'unknown';
    if (!['own', 'ai', 'unknown'].includes(lic)) throw new Error('本地文件的 --license 只能是 own（自己拍的、自己做的）、ai（AI 生成）或 unknown。网上下的东西请直接 jj grab 它的网址，许可证由框架识别');
    file = `media/${id}${extname(abs).toLowerCase()}`;
    copyFileSync(abs, join(dir, file));
    kind = probe(join(dir, file)).duration > 0.5 && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(abs) ? 'video' : 'image';
    source = { url: key, title: basename(abs), grabbed: today(), sha256: '', license: lic };
  } else if (o.find || o.page) {
    // 网页截图：jj snap，或者 jj grab --page
    file = `media/${id}.png`;
    const r = await shootPage(url, join(dir, file), { find: o.find, full: o.full });
    const host = hostOf(r.final);
    writeFileSync(join(media, `${id}.txt`), `${r.meta.title}\n${url}\n\n${r.meta.text}`);
    kind = 'page';
    const lic = licenseByHost(host) ?? (licenseFromText(r.meta.lic) ? { license: licenseFromText(r.meta.lic)! } : { license: 'unknown' });
    source = { url, page: r.final, title: r.meta.title || undefined, author: r.meta.author || undefined, site: r.meta.site || host, published: r.meta.published || undefined, grabbed: today(), sha256: '', ...lic, ...(o.find ? { find: o.find, box: r.box } : {}) };
    if (r.meta.ogImage) extra.push(`页面主图：${r.meta.ogImage}`);
    for (const im of r.meta.imgs.slice(0, 5)) if (im !== r.meta.ogImage) extra.push(`页面里的大图：${im}`);
    for (const v of r.meta.vids) extra.push(`页面里的视频：${v}`);
  } else {
    const host = hostOf(url);
    const commonsPage = /commons\.wikimedia\.org$|wikipedia\.org$/.test(host) && /\/wiki\/(File|文件):/.test(decodeURIComponent(url));
    if (VIDEO_HOSTS.test(host) || o.video) {
      const info = ytdlpInfo(url);
      const long = (info.duration ?? 0) > 900;
      const stem = join(media, id);
      ytdlpDownload(url, stem, long ? 'b[height<=360]/bv*[height<=360]+ba/w' : 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/bv*+ba/b', ['--write-subs', '--write-auto-subs', '--sub-langs', 'zh-Hans,zh-CN,zh,zh-Hant,en', '--convert-subs', 'srt', '--ignore-errors']);
      const got = readdirSync(media).find(f => f.startsWith(id + '.') && /\.(mp4|webm|mkv|mov)$/.test(f));
      if (!got) throw new Error('yt-dlp 没有下到视频文件');
      file = `media/${got}`; kind = 'video'; hdPending = long;
      const yl = licenseFromText(String(info.license ?? ''));
      source = { url, page: info.webpage_url ?? url, title: info.title, author: info.channel ?? info.uploader, site: info.extractor_key ?? host, published: ymd(info.upload_date), grabbed: today(), sha256: '', license: yl ?? 'platform', ...(info.license ? { licenseUrl: String(info.license) } : {}) };
      if (long) extra.push(`视频有 ${Math.round(info.duration / 60)} 分钟，先下了 360p 的低清版来看。选定片段后：jj grab ${dir} --hd ${id}`);
      const subs = readdirSync(media).filter(f => f.startsWith(id + '.') && f.endsWith('.srt'));
      if (subs.length) extra.push(`带了平台字幕：${subs.join('、')}（jj hear 会直接用）`);
    } else if (commonsPage || host === 'upload.wikimedia.org') {
      const title = commonsPage ? 'File:' + decodeURIComponent(url).split(/\/wiki\/(?:File|文件):/)[1].split(/[?#]/)[0] : 'File:' + decodeURIComponent(url.split('/').pop()!.replace(/^\d+px-/, ''));
      const ci = commonsInfo(title);
      const tmp = join(media, id + '.dl');
      const r = curl(ci.url, tmp);
      file = `media/${id}${extFor(r.type, ci.url)}`; renameSync(tmp, join(dir, file));
      kind = r.type.startsWith('video') ? 'video' : 'image';
      source = { url, page: ci.page, title: ci.title, author: ci.author, site: 'Wikimedia Commons', published: ci.published, grabbed: today(), sha256: '', license: ci.license, ...(ci.licenseUrl ? { licenseUrl: ci.licenseUrl } : {}) };
    } else {
      const tmp = join(media, id + '.dl');
      let r: { type: string; final: string };
      // 网站拒绝 curl（常见于新闻站）：换无头浏览器打开，按网页截图
      try { r = curl(url, tmp); } catch (e: any) { spawnSync('rm', ['-f', tmp, tmp + '.headers']); if (/\.(jpe?g|png|webp|gif|mp4|webm)(\?|$)/i.test(url)) throw e; return grab(dir, url, { ...o, page: true }); }
      if (r.type.startsWith('image/') || r.type.startsWith('video/')) {
        file = `media/${id}${extFor(r.type, r.final)}`; renameSync(tmp, join(dir, file));
        kind = r.type.startsWith('video/') ? 'video' : 'image';
        source = { url, site: hostOf(r.final), grabbed: today(), sha256: '', ...(licenseByHost(hostOf(r.final)) ?? licenseByHost(host) ?? { license: 'unknown' }) };
        if (source.license === 'unknown') extra.push('直链认不出许可证。知道它出自哪个页面的话，改抓那个页面的网址（图库、Commons 的页面能认出作者和许可证）');
      } else {
        // 普通网页：图库和 Commons 的页面直接取主图，其他网页截图
        const html = readFileSync(tmp, 'utf8');
        const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image/i)?.[1];
        const stock = licenseByHost(host);
        if (stock && ['pexels', 'pixabay', 'unsplash'].includes(stock.license) && og) {
          const r2 = curl(og.replace(/&amp;/g, '&'), tmp);
          file = `media/${id}${extFor(r2.type, og)}`; renameSync(tmp, join(dir, file)); kind = 'image';
          const title = stripTags(html.match(/<title>([^<]*)/i)?.[1]);
          source = { url, page: url, title, site: host, grabbed: today(), sha256: '', ...stock };
        } else {
          spawnSync('rm', ['-f', tmp, tmp + '.headers']);
          return grab(dir, url, { ...o, page: true });
        }
      }
      spawnSync('rm', ['-f', tmp + '.headers']);
    }
  }
  spawnSync('rm', ['-f', join(media, id + '.dl.headers')]);
  const buf = readFileSync(join(dir, file));
  source.sha256 = sha(buf);
  const dup = findExisting(assets, '\0', source.sha256);
  if (dup) { spawnSync('rm', ['-f', join(dir, file)]); extra.push(`这个文件和 ${dup} 一模一样（从别的网址来的），用 ${dup}`); return attach(dup, 'project'); }
  const p = probe(join(dir, file));
  if (kind !== 'video' && p.duration > 1 && /\.(gif|webp)$/.test(file)) kind = 'video';
  const asset: Asset = { file, kind, ...(p.w ? { w: p.w, h: p.h } : {}), ...(kind === 'video' ? { duration: +p.duration.toFixed(2) } : {}), source, seal: sealOf(source), ...(hdPending ? { hd: [] } : {}) };
  assets[id] = asset;
  return attach(id);
}

/** 素材库：每次抓取都记一笔（跨项目），来源信息按文件哈希单独存 */
const jjHomeMeta = () => join(jjHome(), 'sources');
function remember(dir: string, id: string, a: Asset) {
  try {
    const lib = loadLibrary();
    mkdirSync(jjHomeMeta(), { recursive: true });
    writeFileSync(join(jjHomeMeta(), a.source.sha256 + '.json'), JSON.stringify(a.source));
    const abs = resolve(dir, a.file);
    let e = lib.find(x => x.sha256 === a.source.sha256);
    if (!e) { e = { url: a.source.url, sha256: a.source.sha256, file: abs, kind: a.kind, title: a.source.title, site: a.source.site, license: a.source.license, notes: [], rejected: [], project: resolve(dir), id, at: today() }; lib.push(e); }
    if (a.note && !e.notes.includes(a.note)) e.notes.push(a.note);
    if (a.rejected && !e.rejected.includes(a.rejected)) e.rejected.push(a.rejected);
    if (a.transcript) e.transcript = a.transcript;
    if (!existsSync(e.file)) e.file = abs;
    saveLibrary(lib);
  } catch { /* 素材库记不上不影响这次抓取 */ }
}
export { remember };

/** 选定片段的高清版：只下镜头用到的那几秒 */
export function grabHd(dir: string, id: string, ranges: [number, number][]): string[] {
  const assets = loadAssets(dir), a = assets[id];
  if (!a) throw new Error(`台账里没有 ${id}`);
  if (a.kind !== 'video' || !/^https?:/.test(a.source.url)) throw new Error(`${id} 不是从网上抓的视频，没有高清版可下`);
  const done: string[] = [];
  a.hd ??= [];
  for (const [f0, t0] of ranges) {
    const from = Math.max(0, Math.floor(f0 - 1)), to = Math.min(a.duration ?? t0 + 1, Math.ceil(t0 + 1));
    if (a.hd.some(h => h.from <= from && h.to >= to)) continue;
    const stem = join(dir, 'media', `${id}.hd-${from}-${to}`);
    ytdlpDownload(a.source.url, stem, 'bv*[height<=1080]+ba/b[height<=1080]/b', ['--download-sections', `*${from}-${to}`, '--force-keyframes-at-cuts']);
    const got = readdirSync(join(dir, 'media')).find(f => f.startsWith(`${id}.hd-${from}-${to}.`));
    if (!got) throw new Error('yt-dlp 没有下到高清片段');
    a.hd.push({ file: `media/${got}`, from, to }); done.push(`${from}–${to}s → media/${got}`);
  }
  saveAssets(dir, assets);
  return done;
}
