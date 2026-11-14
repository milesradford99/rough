// 端到端：真的去跑 hj 命令，验证流程闸门、出图、带音频渲染，以及音画对齐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fakeAlignment } from '../src/core/alignment';

const hj = (...a: string[]) => spawnSync(process.execPath, ['bin/hj.mjs', ...a], { encoding: 'utf8' });
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const CLICK_AT = 2.0; // 测试音频里“咔哒”一声的位置（秒）

/** 一段静音里放一声咔哒：渲染后这声咔哒还在原位，才说明音轨没有被错位 */
function clickWav(file: string, seconds: number) {
  const sr = 48000, n = Math.round(seconds * sr), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < 480; i++) b.writeInt16LE(Math.round(Math.sin(i * 0.6) * 30000 * (1 - i / 480)), 44 + (Math.round(CLICK_AT * sr) + i) * 2);
  writeFileSync(file, b);
}
function loudestAt(mp4: string): number {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', mp4, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  let best = 0, at = 0;
  for (let i = 0; i + 1 < r.stdout.length; i += 2) { const v = Math.abs(r.stdout.readInt16LE(i)); if (v > best) { best = v; at = i / 2; } }
  return at / 48000;
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'hj-e2e-')), voice = join(root, 'voice-src'), dir = join(root, 'proj');
  mkdirSync(voice);
  const al = fakeAlignment('公司交一百块税。政府发给你。你又花回公司。转了一圈，一分没多赚。');
  writeFileSync(join(voice, 'alignment.json'), JSON.stringify(al));
  clickWav(join(voice, 'narration.wav'), al.duration_seconds);
  assert.equal(hj('init', dir, '--voice', voice, '--title', 'e2e').status, 0);
  rmSync(join(dir, 'plan.yaml')); // 这条测试走的是不带计划的老写法；带计划的流程在 plan.test.ts
  writeFileSync(join(dir, 'project.yaml'), readFileSync(join(dir, 'project.yaml'), 'utf8').replace('sfx: true', 'sfx: false'));
  writeFileSync(join(dir, 'scenes/01-loop.yaml'), `intent: 钞票转一圈回到公司
pattern:
  kind: cycle
  nodes: [{ doodle: factory, label: 公司 }, { doodle: gov, label: 政府 }, { figure: stand, label: 你 }]
  flows: [交税, 发钱, 消费]
  result: "+0"
beats:
  - { at: "公司交一百块税", intent: 公司和钞票, do: [{ step: show.1 }, { step: token }] }
  - { at: "政府发给你", intent: 到政府再到你, do: [{ step: show.2 }, { step: go.1 }, { step: show.3 }, { step: go.2 }] }
  - { at: "你又花回公司", intent: 回到公司, do: [{ step: go.3 }] }
  - { at: "一分没多赚", intent: 写下结论, do: [{ step: result }] }
`);
  return dir;
}

test('端到端：init → check → 两道确认闸 → 出图 → 带音频渲染，音画对齐', { timeout: 180000 }, () => {
  const dir = project();
  assert.ok(existsSync(join(dir, 'voice/narration.wav')), 'init 应该把配音一并带进项目');
  assert.match(readFileSync(join(dir, 'project.yaml'), 'utf8'), /audio: voice\/narration\.wav/);

  const check = hj('check', dir);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /0 个错误/);
  assert.equal(hj('brief', dir).status, 0);

  // 闸一：没确认文字分镜，不出图
  const early = hj('stills', dir);
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /文字分镜还没有得到用户确认/);
  assert.ok(!existsSync(join(dir, 'out')), '被拦下时不应该产生任何输出');
  // 草稿关键帧：确认前可以出，给写分镜的人自查；单独存放，不解锁后面的闸
  const draftRun = hj('stills', dir, '--draft', '--scene', '1');
  assert.equal(draftRun.status, 0, draftRun.stderr);
  assert.ok(existsSync(join(dir, 'out/draft/sheet-01-loop.png')));
  assert.ok(!existsSync(join(dir, 'out/stills')), '草稿不应该写进正式关键帧目录');
  assert.notEqual(hj('render', dir, '--draft').status, 0, '出过草稿不等于确认');
  assert.notEqual(hj('approve', dir, 'keyframes', '--by', '可以').status, 0, '没确认文字分镜，不能确认关键帧');

  assert.equal(hj('plan', dir).status, 0);
  assert.match(readFileSync(join(dir, 'storyboard.md'), 'utf8'), /钞票转一圈回到公司/);
  assert.notEqual(hj('approve', dir, 'plan').status, 0, '不带 --by（用户原话）不能确认');
  assert.equal(hj('approve', dir, 'plan', '--by', '可以').status, 0);

  const stills = hj('stills', dir);
  assert.equal(stills.status, 0, stills.stderr);
  assert.ok(existsSync(join(dir, 'out/stills/sheet-01-loop.png')));

  // 闸二：没确认关键帧，不渲染
  const noRender = hj('render', dir, '--draft');
  assert.notEqual(noRender.status, 0);
  assert.match(noRender.stderr, /关键帧还没有得到用户确认/);
  assert.equal(hj('approve', dir, 'keyframes', '--by', '可以').status, 0);

  // 确认之后改了“画什么”，确认自动失效
  const scene = join(dir, 'scenes/01-loop.yaml'), orig = readFileSync(scene, 'utf8');
  writeFileSync(scene, orig.replace('intent: 写下结论', 'intent: 写下另一个结论'));
  assert.match(hj('render', dir, '--draft').stderr, /需要用户重新确认/);
  writeFileSync(scene, orig);

  if (!hasFfmpeg) return; // 没装 ffmpeg 的环境跳过渲染部分
  const full = hj('render', dir, '--draft');
  assert.equal(full.status, 0, full.stderr);
  const mp4 = join(dir, 'out/video.draft.mp4');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).stdout;
  assert.match(probe, /video/); assert.match(probe, /audio/);
  assert.ok(Math.abs(loudestAt(mp4) - CLICK_AT) < 0.06, `整片渲染：咔哒声应在 ${CLICK_AT}s，实际 ${loudestAt(mp4).toFixed(3)}s`);

  // 只渲染一段时，音轨要跟着从同一时刻切入
  const part = hj('render', dir, '--draft', '--from', '1', '--to', '4', '--out', join(dir, 'out/part.mp4'));
  assert.equal(part.status, 0, part.stderr);
  assert.ok(Math.abs(loudestAt(join(dir, 'out/part.mp4')) - (CLICK_AT - 1)) < 0.06, `分段渲染：咔哒声应在 ${CLICK_AT - 1}s，实际 ${loudestAt(join(dir, 'out/part.mp4')).toFixed(3)}s`);

  // 背景音乐：配音在 3 秒之后是静音，成片这一段有声音，说明音乐混进去了
  const sr = 48000, tone = Buffer.alloc(44 + sr * 2);
  tone.write('RIFF', 0); tone.writeUInt32LE(36 + sr * 2, 4); tone.write('WAVEfmt ', 8); tone.writeUInt32LE(16, 16); tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22);
  tone.writeUInt32LE(sr, 24); tone.writeUInt32LE(sr * 2, 28); tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34); tone.write('data', 36); tone.writeUInt32LE(sr * 2, 40);
  for (let i = 0; i < sr; i++) tone.writeInt16LE(Math.round(Math.sin(i * 0.05) * 20000), 44 + i * 2);
  writeFileSync(join(dir, 'voice/bed.wav'), tone); // 只有 1 秒：要靠循环铺满全片
  writeFileSync(join(dir, 'project.yaml'), readFileSync(join(dir, 'project.yaml'), 'utf8') + '\nmusic: voice/bed.wav\n');
  const withMusic = hj('render', dir, '--draft', '--out', join(dir, 'out/music.mp4'));
  assert.equal(withMusic.status, 0, withMusic.stderr);
  assert.match(withMusic.stdout, /背景音乐/);
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-ss', '4', '-t', '1', '-i', join(dir, 'out/music.mp4'), '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 }).stdout;
  let peak = 0; for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak > 500, `第 4 秒应该听得到循环的背景音乐，实际峰值 ${peak}`);
  assert.ok(Math.abs(loudestAt(join(dir, 'out/music.mp4')) - CLICK_AT) < 0.06, '加了音乐，配音仍在原位、仍是最响的');

  // 封面
  const cover = hj('cover', dir);
  assert.equal(cover.status, 0, cover.stderr);
  assert.ok(existsSync(join(dir, 'out/cover.png')));
});

test('位图元素：图片能贴到板上；路径写错时说清楚', () => {
  const dir = project(), scene = join(dir, 'scenes/01-loop.yaml'), orig = readFileSync(scene, 'utf8');
  // 一张 2×1 的 PNG
  mkdirSync(join(dir, 'images'));
  writeFileSync(join(dir, 'images/shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4GBgYEJAAkGAQHZ3nqzAAAAAElFTkSuQmCC', 'base64'));
  const withImg = orig.replace('do: [{ step: show.1 }', 'do: [{ draw: shot }, { step: show.1 }').replace(/\n$/, '') + '\nelements:\n  shot: { image: images/shot.png, size: 200 }\n';
  writeFileSync(scene, withImg.replace('shot.png', 'nope.png'));
  const bad = hj('check', dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /找不到图片/);
  writeFileSync(scene, withImg);
  const ok = hj('layout', dir);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /shot\s+image\s+x\s+\d+…\d+\s+y\s+\d+…\d+/);
});

test('命令行：未知命令、缺参数、分镜写错时给出能照着改的提示，而不是堆栈', () => {
  assert.equal(hj('--help').status, 0);
  assert.match(hj('--version').stdout, /^\d+\.\d+\.\d+/);
  assert.notEqual(hj('nonsense').status, 0);
  const miss = hj('check', join(tmpdir(), 'no-such-project-' + Date.now()));
  assert.notEqual(miss.status, 0);
  assert.match(miss.stderr, /project\.yaml/);
  assert.doesNotMatch(miss.stderr, /at .*\.ts:\d+/, '不应该把堆栈甩给使用者');

  const dir = project(), scene = join(dir, 'scenes/01-loop.yaml');
  writeFileSync(scene, readFileSync(scene, 'utf8').replace('at: "政府发给你"', 'at: "政府发给他"').replace('doodle: gov', 'doodle: goverment'));
  const bad = hj('check', dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /政府发给他/);
  assert.match(bad.stdout, /goverment/);
  assert.match(bad.stdout, /hj assets doodles/);
});
