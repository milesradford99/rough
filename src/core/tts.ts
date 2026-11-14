// 配音：火山引擎豆包语音合成（双向流式 WebSocket）。朗读稿进去，一条连续的 WAV 和逐字时间表出来。
// 这是付费接口：没有自动重试，每次调用都要用户先确认过朗读稿（闸门在命令行里）。
// 协议：https://www.volcengine.com/docs/6561/1329505 ；以实际响应为准。
import { gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import WebSocket from 'ws';

export const TTS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
export const DEFAULT_SPEAKER = 'zh_male_kuailexiaodong_uranus_bigtts';
export const KEY_ENV = 'VOLCENGINE_TTS_API_KEY';
/** 事件码：1/50 建连，100/150 开会话，200 发文本，102 结束发送，352 音频，364 字词时间，152 会话完成，51/153 失败，2/52 收尾 */
const EV = { StartConnection: 1, FinishConnection: 2, ConnectionStarted: 50, ConnectionFailed: 51, ConnectionFinished: 52, StartSession: 100, FinishSession: 102, SessionStarted: 150, SessionFinished: 152, SessionFailed: 153, TaskRequest: 200, TTSResponse: 352, TTSSubtitle: 364 };

/** 客户端帧：4 字节头 + 事件码 + [会话 id] + JSON 体 */
export function packet(event: number, payload: any = {}, session?: string): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8'), parts: Buffer[] = [Buffer.from([0x11, 0x14, 0x10, 0x00])];
  const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }, u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  parts.push(i32(event));
  if (session != null) { const sid = Buffer.from(session, 'utf8'); parts.push(u32(sid.length), sid); }
  parts.push(u32(body.length), body);
  return Buffer.concat(parts);
}

export interface Msg { type: number; event: number; errorCode?: number; audio?: Buffer; payload?: any }
/** 服务端帧 → 消息。音频帧（type 11）的体是 PCM，其余是 JSON */
export function unpack(data: Buffer): Msg {
  if (!Buffer.isBuffer(data) || data.length < 4) throw new Error('不是二进制协议帧');
  const version = data[0] >> 4, size = (data[0] & 15) * 4, type = data[1] >> 4, flags = data[1] & 15, serialization = data[2] >> 4, compression = data[2] & 15;
  if (version !== 1 || size < 4 || size > data.length) throw new Error('不支持的协议头');
  let off = size;
  const take = (n: number) => { if (n < 0 || off + n > data.length) throw new Error('协议帧被截断'); const p = data.subarray(off, off + n); off += n; return p; };
  const int = (signed = false) => (signed ? take(4).readInt32BE() : take(4).readUInt32BE()), blob = () => take(int());
  const msg: Msg = { type, event: 0 };
  if (type === 15) msg.errorCode = int();
  else if (flags & 1) int(true); // 序号，用不到
  if (flags & 4) { msg.event = int(true); if (![EV.StartConnection, EV.FinishConnection].includes(msg.event)) blob(); /* 连接 id 或会话 id */ }
  let body = blob();
  if (off !== data.length) throw new Error('协议帧后面有多余的字节');
  if (compression === 1) body = gunzipSync(body); else if (compression !== 0) throw new Error('不支持的压缩方式');
  if (type === 11) msg.audio = Buffer.from(body);
  else if (serialization === 1) msg.payload = body.length ? JSON.parse(body.toString('utf8')) : {};
  else msg.payload = { raw: body.toString('utf8') };
  return msg;
}

export interface TtsWord { word: string; startTime: number; endTime: number; confidence?: number }
/** 平台返回的字词时间 → 引擎的时间表（alignment.json）。只用平台给的时间，不拆字、不插值 */
export function buildAlignment(subtitles: { text?: string; words?: TtsWord[] }[], duration: number, speaker: string): any {
  const units: any[] = [], sentences: any[] = [], seen = new Set<string>();
  for (const sub of subtitles) {
    if (!sub.words?.length) continue;
    const sig = JSON.stringify(sub); if (seen.has(sig)) continue; seen.add(sig);
    const first = units.length;
    for (const w of sub.words) {
      const spoken = [...String(w.word)].filter(ch => !/[\s\p{P}]/u.test(ch)).join('');
      if (!spoken) continue; // 单独的标点没有自己的时间
      const flags: string[] = [];
      if (w.confidence != null && w.confidence < 0.6) flags.push('low_confidence');
      if (spoken.length > 1 && w.endTime - w.startTime < 0.05) flags.push('too_short_for_its_length');
      if (/\d/.test(spoken) || /^[A-Z]{2,}$/.test(spoken)) flags.push('number_or_acronym');
      units.push({ text: spoken, display_text: String(w.word), start: w.startTime, end: w.endTime, confidence: w.confidence ?? null, timing_warnings: flags, sentence_index: sentences.length });
    }
    if (units.length > first) sentences.push({ text: sub.text ?? '', start: units[first].start, end: units[units.length - 1].end, unit_range: [first, units.length] });
  }
  if (!units.length) throw new Error('平台没有返回任何字词时间');
  let prev = -1;
  units.forEach((u, i) => { if (!(u.start >= 0 && u.start <= u.end && u.end <= duration + 0.05) || u.start < prev) throw new Error(`第 ${i} 个字（${u.text}）的时间不对：${u.start}–${u.end}，音频长 ${duration.toFixed(2)} 秒`); prev = u.start; });
  return { provider: 'volcengine', speaker, duration_seconds: duration, units, sentences };
}

export function wavFile(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 朗读稿的版本号：确认的是哪一版稿子 */
export const scriptHash = (text: string) => createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 16);

/** 朗读稿里容易读错、时间不准的地方（不拦，只提醒） */
export function scriptWarnings(text: string): string[] {
  const out: string[] = [], digits = [...new Set(text.match(/\d[\d.,%]*/g) ?? [])], latin = [...new Set(text.match(/[A-Za-z]{2,}/g) ?? [])];
  if (digits.length) out.push(`稿子里有阿拉伯数字：${digits.slice(0, 8).join('、')}${digits.length > 8 ? '…' : ''}。平台会把一串数字当成一个词，时间不准，读法也可能不是你想的。按读法写成汉字（2026 年写“二零二六年”，53% 写“百分之五十三”）`);
  if (latin.length) out.push(`稿子里有英文：${latin.slice(0, 8).join('、')}${latin.length > 8 ? '…' : ''}。缩写会被当成一个整体，卡点不能落在它中间；想让它按中文读就写成中文`);
  if (!/[。？！?!]\s*$/.test(text.trim())) out.push('稿子最后没有句号：字幕断句靠标点');
  return out;
}

export interface TtsOptions { text: string; key: string; outDir: string; speaker?: string; resource?: string; sampleRate?: number; speechRate?: number; context?: string; endpoint?: string; idleTimeout?: number; totalTimeout?: number }
export interface TtsResult { wav: string; alignment: string; duration: number; units: number; shaky: number; logid: string | null }

/** 合成一次。成功时在 outDir 里写 narration.wav、alignment.json、metadata.json、events.jsonl；失败抛错，不留成品文件、不重试 */
export async function synthesize(o: TtsOptions): Promise<TtsResult> {
  const speaker = o.speaker ?? DEFAULT_SPEAKER, resource = o.resource ?? 'seed-tts-2.0', sampleRate = o.sampleRate ?? 48000, text = o.text.trim();
  if (!text) throw new Error('朗读稿是空的');
  mkdirSync(o.outDir, { recursive: true });
  const params: any = { speaker, audio_params: { format: 'pcm', sample_rate: sampleRate, speech_rate: o.speechRate ?? 0, enable_subtitle: true } };
  if (o.context) params.additions = JSON.stringify({ context_texts: [o.context] });
  const sid = randomUUID(), log = join(o.outDir, 'events.jsonl'), redact = (s: string) => s.split(o.key).join('[REDACTED]');
  writeFileSync(log, '');
  const audio: Buffer[] = [], subtitles: any[] = [];
  let logid: string | null = null;

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(o.endpoint ?? TTS_ENDPOINT, { headers: { 'X-Api-Key': o.key, 'X-Api-Resource-Id': resource, 'X-Api-Connect-Id': randomUUID(), 'X-Control-Require-Usage-Tokens-Return': '*' }, handshakeTimeout: 20000, maxPayload: 16 * 1024 * 1024 });
    let done = false, finished = false, idle: NodeJS.Timeout;
    const end = (e?: Error) => { if (done) return; done = true; clearTimeout(idle); clearTimeout(total); try { ws.terminate(); } catch { /* 已经断了 */ } if (e) reject(e); else resolve(); };
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => end(finished ? undefined : new Error(`${(o.idleTimeout ?? 90)} 秒没有收到任何数据，放弃这次合成`)), (o.idleTimeout ?? 90) * 1000); };
    const total = setTimeout(() => end(new Error(`超过了整次上限 ${(o.totalTimeout ?? 600)} 秒`)), (o.totalTimeout ?? 600) * 1000);
    ws.on('upgrade', res => { logid = String(res.headers['x-tt-logid'] ?? '') || null; });
    ws.on('open', () => { arm(); ws.send(packet(EV.StartConnection)); });
    ws.on('unexpected-response', (_req, res) => end(new Error(`服务端拒绝了连接（HTTP ${res.statusCode}）。${res.statusCode === 401 || res.statusCode === 403 ? `多半是密钥不对或没有开通这个音色的资源：检查环境变量 ${KEY_ENV}` : '检查网络和资源 id'}`)));
    ws.on('error', e => end(finished ? undefined : new Error(redact(`连接出错：${e.message}`))));
    ws.on('close', () => end(finished ? undefined : new Error('连接在合成完成之前断开了，音频不完整')));
    ws.on('message', (raw: Buffer) => {
      arm();
      let m: Msg;
      try { m = unpack(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any)); } catch (e: any) { return end(e); }
      appendFileSync(log, redact(JSON.stringify({ event: m.event, type: m.type, ...(m.errorCode != null ? { error_code: m.errorCode } : {}), ...(m.audio ? { audio_bytes: m.audio.length } : { payload: m.payload }) })) + '\n');
      if (m.type === 15 || m.event === EV.ConnectionFailed || m.event === EV.SessionFailed) return end(new Error(redact(`服务端报错（${m.errorCode ?? m.event}）：${JSON.stringify(m.payload ?? {})}${logid ? `，logid ${logid}` : ''}。先看 ${log} 判断是参数、额度还是音色问题，再决定要不要重来：每重来一次都是一次新的付费调用`)));
      if (m.audio) { audio.push(m.audio); return; }
      if (m.event === EV.ConnectionStarted) ws.send(packet(EV.StartSession, { event: EV.StartSession, req_params: params }, sid));
      else if (m.event === EV.SessionStarted) { ws.send(packet(EV.TaskRequest, { event: EV.TaskRequest, req_params: { ...params, text } }, sid)); ws.send(packet(EV.FinishSession, {}, sid)); }
      else if (m.event === EV.TTSSubtitle) subtitles.push(m.payload);
      // 必须等到会话完成才算数：字词时间可能晚于句末到达
      else if (m.event === EV.SessionFinished) { finished = true; ws.send(packet(EV.FinishConnection)); setTimeout(() => end(), 1500); }
      else if (m.event === EV.ConnectionFinished) end();
    });
  });

  const pcm = Buffer.concat(audio);
  if (!pcm.length || pcm.length % 2) throw new Error('没有收到完整的音频');
  const duration = pcm.length / 2 / sampleRate, alignment = buildAlignment(subtitles, duration, speaker), wav = wavFile(pcm, sampleRate);
  writeFileSync(join(o.outDir, 'narration.wav'), wav);
  writeFileSync(join(o.outDir, 'alignment.json'), JSON.stringify(alignment, null, 2) + '\n');
  writeFileSync(join(o.outDir, 'metadata.json'), JSON.stringify({ provider: 'volcengine', speaker, resource, sample_rate: sampleRate, speech_rate: o.speechRate ?? 0, duration_seconds: duration, script_hash: scriptHash(text), logid, audio_sha256: createHash('sha256').update(wav).digest('hex') }, null, 2) + '\n');
  return { wav: join(o.outDir, 'narration.wav'), alignment: join(o.outDir, 'alignment.json'), duration, units: alignment.units.length, shaky: alignment.units.filter((u: any) => u.timing_warnings.length).length, logid };
}

// ── 免费引擎：edge-tts（微软 Edge 浏览器“大声朗读”的在线接口）──
// 接口是逆向的，令牌算法会跟着 Edge 变，所以不自己实现，调用社区维护的 Python 包 edge-tts（scripts/edge_words.py）。
// 只能调语速、音高、音量三个全局参数，不支持停顿和情绪标签。下面的默认值是实测出来的（2026-11，见技能里的 voice.md）。

export interface EdgeVoice { name: string; rate: string; pitch: string; note: string }
/** 每个音色的默认语速：让成片落在每秒 4.1–4.3 个字（画得过来的速度）。原速实测：云希 4.25、晓伊 4.23、晓晓 4.10、云健 4.07、Brian 3.59、Andrew 3.20 字/秒 */
export const EDGE_VOICES: Record<string, EdgeVoice> = {
  'zh-CN-YunxiNeural': { name: '云希', rate: '+0%', pitch: '-4Hz', note: '男，年轻、口语感最好' },
  'zh-CN-YunjianNeural': { name: '云健', rate: '+4%', pitch: '-4Hz', note: '男，厚实、起伏大。默认' },
  'zh-CN-XiaoxiaoNeural': { name: '晓晓', rate: '+4%', pitch: '-2Hz', note: '女，清亮、吐字最稳。通用' },
  'zh-CN-XiaoyiNeural': { name: '晓伊', rate: '+0%', pitch: '-2Hz', note: '女，低一点、温和。慢节奏内容' },
  'en-US-BrianMultilingualNeural': { name: 'Brian（多语言，说中文）', rate: '+16%', pitch: '-3Hz', note: '男，松弛的播客腔，原速偏慢所以提速' },
  'en-US-AndrewMultilingualNeural': { name: 'Andrew（多语言，说中文）', rate: '+28%', pitch: '-3Hz', note: '男，胸腔共鸣重，原速很慢（3.2 字/秒）' },
};
export const DEFAULT_EDGE_VOICE = 'zh-CN-YunjianNeural';

const isCJK = (ch: string) => /[㐀-鿿]/.test(ch);
/** edge-tts 的逐词时间 → 时间表的单位。纯汉字的词按字均分（一个词只有两三个字、零点几秒，均分的误差在几十毫秒内）；数字和英文保持整体并标成不可靠。标点从原文里补回来 */
export function edgeUnits(text: string, words: { text: string; start: number; end: number }[], offset = 0): any[] {
  const units: any[] = [];
  let pos = 0;
  for (const w of words) {
    const tok = String(w.text).trim(); if (!tok) continue;
    const k = text.indexOf(tok, pos);
    // 上一个词和这个词之间的标点，挂到上一个字后面（字幕断句靠它）
    if (k >= 0) { const between = text.slice(pos, k).replace(/\s/g, ''); if (between && units.length) units[units.length - 1].display_text += between; pos = k + tok.length; }
    const chars = [...tok].filter(ch => !/[\s\p{P}]/u.test(ch));
    if (!chars.length) continue;
    if (chars.every(isCJK)) { const d = (w.end - w.start) / chars.length; chars.forEach((ch, i) => units.push({ text: ch, display_text: ch, start: offset + w.start + d * i, end: offset + w.start + d * (i + 1), confidence: 1, timing_warnings: [] })); }
    else units.push({ text: chars.join(''), display_text: tok, start: offset + w.start, end: offset + w.end, confidence: 1, timing_warnings: ['number_or_acronym'] });
  }
  if (units.length) { const tail = text.slice(pos).replace(/\s/g, ''); if (tail) units[units.length - 1].display_text += tail; }
  return units;
}

function edgePython(args: string[]): { ok: boolean; err: string } {
  const script = fileURLToPath(new URL('../../scripts/edge_words.py', import.meta.url));
  const tries: string[][] = process.env.HJ_PYTHON ? [[process.env.HJ_PYTHON]] : [['uv', 'run', '--quiet', '--with', 'edge-tts', 'python'], ['python3'], ['python']];
  let last = '';
  for (const t of tries) {
    const r = spawnSync(t[0], [...t.slice(1), script, ...args], { encoding: 'utf8' });
    if (r.error) continue; // 这个命令不存在
    if (r.status === 0) return { ok: true, err: '' };
    if (r.status === 3) { last = 'NO_EDGE_TTS'; continue; }
    return { ok: false, err: (r.stderr || '').trim().split('\n').pop() ?? '' };
  }
  return { ok: false, err: last === 'NO_EDGE_TTS' ? 'NO_EDGE_TTS' : 'NO_PYTHON' };
}

export interface EdgeOptions { text: string; outDir: string; voice?: string; rate?: string; pitch?: string; /** 段落之间（空行）至少停多久 */ paragraphGap?: number }
/** 免费合成。按空行分段各合成一次、接成一条音轨（段间补足停顿），时间表跟着平移，所以不需要、也不允许事后再剪 */
export async function synthesizeEdge(o: EdgeOptions): Promise<TtsResult> {
  const voice = o.voice ?? DEFAULT_EDGE_VOICE, preset = EDGE_VOICES[voice], rate = o.rate ?? preset?.rate ?? '+0%', pitch = o.pitch ?? preset?.pitch ?? '+0Hz', gap = o.paragraphGap ?? 1.0, SR = 48000;
  const paras = o.text.trim().split(/\n\s*\n/).map(s => s.replace(/\s*\n\s*/g, '').trim()).filter(Boolean);
  if (!paras.length) throw new Error('朗读稿是空的');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('需要 ffmpeg（把 MP3 转成 WAV、统一响度）。先安装 ffmpeg');
  mkdirSync(o.outDir, { recursive: true });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const pcm: Buffer[] = [], units: any[] = [];
  let t = 0;
  for (let i = 0; i < paras.length; i++) {
    const base = join(o.outDir, `p${String(i + 1).padStart(2, '0')}`);
    writeFileSync(base + '.txt', paras[i]);
    let res = { ok: false, err: '' };
    // 免费接口偶尔 403 或超时：重试不花钱，隔一会儿再试
    for (let n = 0; n < 4 && !res.ok; n++) {
      if (n) await new Promise(r => setTimeout(r, 1500 * n));
      res = edgePython(['--text', base + '.txt', '--voice', voice, `--rate=${rate}`, `--pitch=${pitch}`, '--media', base + '.mp3', '--words', base + '.json', ...(proxy ? ['--proxy', proxy] : [])]);
      if (res.err === 'NO_EDGE_TTS' || res.err === 'NO_PYTHON') break;
    }
    if (res.err === 'NO_PYTHON') throw new Error('找不到 Python。edge-tts 是一个 Python 包：安装 Python 3 后运行 pip install edge-tts（或安装 uv，hj 会自动用它临时装）');
    if (res.err === 'NO_EDGE_TTS') throw new Error('没有安装 edge-tts。运行 pip install edge-tts（或安装 uv，hj 会自动用它临时装），再重试');
    if (!res.ok) throw new Error(`edge-tts 第 ${i + 1} 段合成失败：${res.err}${/NoAudioReceived/.test(res.err) ? `。多半是音色 ${voice} 在免费接口上不可用（edge-tts --list-voices 查看）` : '。这是微软的免费接口，偶尔不稳，过一会儿再试'}`);
    const cv = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', base + '.mp3', '-ar', String(SR), '-ac', '1', '-f', 's16le', base + '.pcm']);
    if (cv.status !== 0) throw new Error(`ffmpeg 转码失败：${String(cv.stderr).trim()}`);
    const buf = readFileSync(base + '.pcm'), words = JSON.parse(readFileSync(base + '.json', 'utf8')).words as { text: string; start: number; end: number }[];
    if (!words?.length) throw new Error(`edge-tts 第 ${i + 1} 段没有返回逐词时间`);
    // 段间停顿：上一段的尾巴加这一段的开头不够长，就补一段静音
    if (i > 0) { const prevEnd = units[units.length - 1].end, natural = t + words[0].start - prevEnd; if (natural < gap) { const pad = Math.round((gap - natural) * SR) * 2; pcm.push(Buffer.alloc(pad)); t += pad / 2 / SR; } }
    units.push(...edgeUnits(paras[i], words, t));
    pcm.push(buf); t += buf.length / 2 / SR;
  }
  const raw = join(o.outDir, 'raw.wav'), out = join(o.outDir, 'narration.wav');
  writeFileSync(raw, wavFile(Buffer.concat(pcm), SR));
  // 统一响度到 -16 LUFS。只动音量，不剪静音、不变速：时间表才对得上
  const ln = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', out]);
  if (ln.status !== 0) writeFileSync(out, readFileSync(raw));
  const duration = Math.max(t, (readFileSync(out).length - 44) / 2 / SR);
  units.forEach((u, i) => { u.sentence_index = 0; if (u.end > duration) u.end = duration; if (i && u.start < units[i - 1].start) u.start = units[i - 1].start; });
  const alignment = { provider: 'edge-tts', speaker: voice, duration_seconds: duration, units };
  writeFileSync(join(o.outDir, 'alignment.json'), JSON.stringify(alignment, null, 2) + '\n');
  writeFileSync(join(o.outDir, 'metadata.json'), JSON.stringify({ provider: 'edge-tts', speaker: voice, rate, pitch, sample_rate: SR, duration_seconds: duration, script_hash: scriptHash(o.text), paragraphs: paras.length }, null, 2) + '\n');
  return { wav: out, alignment: join(o.outDir, 'alignment.json'), duration, units: units.length, shaky: units.filter(u => u.timing_warnings.length).length, logid: null };
}
