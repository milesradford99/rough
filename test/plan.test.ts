// 规划者 → 执行者：计划的检查、骨架、照计划执行的对照，以及配音的闸门和协议。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fakeAlignment } from '../src/core/alignment';
import { confirmCode, hasCode, type Stage } from '../src/core/review';
import { cpSync, rmSync } from 'node:fs';
import { compile } from '../src/core/compile';
import { lint } from '../src/core/lint';
import { packet, unpack, buildAlignment, scriptWarnings, edgeUnits, EDGE_VOICES, DEFAULT_EDGE_VOICE } from '../src/core/tts';

const hj = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ['bin/hj.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const SCRIPT = '公司交一百块税。政府发给你。你又花回公司。转了一圈，一分没多赚。所以这笔钱，谁也没有多出来。';

const PLAN = `thesis: 税、补贴、消费转了一圈，谁也没有多赚一分钱
cast:
  co:  { name: 公司, look: { doodle: factory } }
  gov: { name: 政府, look: { doodle: gov } }
  me:  { name: 你,   look: { figure: stand } }
relations:
  tax:   { from: co, to: gov, label: 交税 }
  give:  { from: gov, to: me, label: 发钱 }
  spend: { from: me, to: co, label: 消费 }
boards:
  - id: loop
    picture: 公司、政府、你站成一个三角，三条箭头首尾相接成一个圈，圈中间写着结论 +0
    grid:
      areas:
        - [up, up]
        - [left, right]
    regions: { up: 公司和政府, left: 你, right: 结论 }
    segments:
      - { at: "公司交一百块税", act: 例子, in: up, show: [co, gov], link: [tax], words: ["100"], intent: 公司把一百块交给政府 }
      - { at: "政府发给你", act: 例子, in: left, show: [me], link: [give], intent: 政府把钱发给你 }
      - { at: "你又花回公司", act: 例子, in: left, link: [spend], intent: 你把钱花回公司，圈闭合 }
      - { at: "一分没多赚", act: 结论, in: right, revisit: [co], words: ["+0"], intent: 回到公司身上圈一下：它没有多赚 }
`;

function project(plan = PLAN): string {
  const root = mkdtempSync(join(tmpdir(), 'hj-plan-')), voice = join(root, 'v'), dir = join(root, 'proj');
  mkdirSync(voice, { recursive: true });
  writeFileSync(join(voice, 'alignment.json'), JSON.stringify(fakeAlignment(SCRIPT)));
  assert.equal(hj(['init', dir, '--voice', voice]).status, 0);
  if (plan) writeFileSync(join(dir, 'plan.yaml'), plan);
  return dir;
}

const codeOf = (dir: string, stage: Stage) => confirmCode(stage, JSON.parse(readFileSync(join(dir, 'out/review', stage + '.json'), 'utf8')).hash);

test('没填的计划拦住一切：不能跳过规划直接画', () => {
  const dir = project('');
  const st = hj(['status', dir]);
  assert.match(st.stdout, /现在轮到：规划者/);
  writeFileSync(join(dir, 'scenes/01-x.yaml'), 'intent: 随便画\nelements: { a: { text: "字" } }\nbeats: [{ at: "公司交一百块税", intent: 写字, do: [{ draw: a }] }]\n');
  const ck = hj(['check', dir]);
  assert.equal(ck.status, 1);
  assert.match(ck.stderr, /plan\.yaml 还没有填/);
});

test('计划的检查：只有字的段、照抄口播、没连起来的系统、孤岛分区', () => {
  const bad = PLAN
    .replace('{ at: "政府发给你", act: 例子, in: left, show: [me], link: [give], intent: 政府把钱发给你 }', '{ at: "政府发给你", act: 例子, in: left, show: [me], words: ["一百块税政府发给你"], intent: 政府把钱发给你 }')
    .replace('      - { at: "你又花回公司", act: 例子, in: left, link: [spend], intent: 你把钱花回公司，圈闭合 }\n', '      - { at: "你又花回公司", act: 例子, in: left, words: [花回去], intent: 写上花回去 }\n')
    .replace('  give:  { from: gov, to: me, label: 发钱 }\n  spend: { from: me, to: co, label: 消费 }\n', '');
  const dir = project(bad), r = hj(['check', dir]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /这一段只有字，没有画/);
  assert.match(r.stdout, /照抄了口播/);
  assert.match(r.stdout, /系统没有连起来/);
  assert.match(r.stdout, /分区之间没有连起来/);
});

test('规划者 → 用户确认 → 执行者：骨架能直接编译，偏离计划会被拦下', { timeout: 120000 }, () => {
  const dir = project();
  const ck = hj(['check', dir]);
  assert.equal(ck.status, 0, ck.stdout + ck.stderr);
  assert.match(ck.stdout, /0 个错误/);
  // 计划没确认之前，状态指向规划者；分镜表由计划排出来，不需要任何场景
  assert.match(hj(['status', dir]).stdout, /现在轮到：规划者/);
  assert.equal(hj(['plan', dir]).status, 0);
  const sb = readFileSync(join(dir, 'storyboard.md'), 'utf8');
  assert.match(sb, /论点/); assert.match(sb, /公司 → 交税 → 政府/); assert.match(sb, /回头改：公司/);
  // 计划这一步也有图：结构草图。没带图上的确认码不能确认
  assert.ok(existsSync(join(dir, 'out/review/plan.png')) && existsSync(join(dir, 'out/review/plan.html')));
  assert.match(hj(['approve', dir, 'plan', '--by', '可以']).stderr, /没有确认码/);
  assert.equal(hj(['approve', dir, 'plan', '--by', `确认 ${codeOf(dir, 'plan')}`]).status, 0);
  assert.match(hj(['status', dir]).stdout, /现在轮到：执行者[\s\S]*hj scaffold/);

  assert.equal(hj(['scaffold', dir]).status, 0);
  const f = join(dir, 'scenes/01-loop.yaml');
  assert.ok(existsSync(f));
  const c1 = hj(['check', dir]);
  assert.match(c1.stdout, /0 个错误/, '骨架生成出来就应该没有错误：' + c1.stdout);
  // 执行者怎么画都不会让计划的确认失效
  assert.match(c1.stdout, /计划 ✓ 已确认/);

  // 偏离计划：加计划外的角色、加长句板书、把一段的卡点改掉
  const src = readFileSync(f, 'utf8');
  writeFileSync(f, src.replace('elements:\n', 'elements:\n  extra: { doodle: bank, in: right }\n  long: { text: "这是一句计划里没有的话", in: right }\n').replace('  - at: "你又花回公司"', '  - at: "又花回公司"').replace('beats:\n', 'beats:\n  - { at: "公司", intent: 多画两样, do: [{ draw: [extra, long] }] }\n'));
  const c2 = hj(['check', dir]);
  assert.equal(c2.status, 1);
  assert.match(c2.stdout, /计划之外的东西/);
  assert.match(c2.stdout, /不在计划里/);
  assert.match(c2.stdout, /没有卡在这一刻的节拍/);
  // 场景里不能自己划分区
  writeFileSync(f, 'regions: { a: [0, 0, 100, 100] }\n' + src);
  assert.match(hj(['check', dir]).stdout, /场景里不要写 regions/);
  writeFileSync(f, src);

  // 改计划：第一道确认失效，要回到规划者
  writeFileSync(join(dir, 'plan.yaml'), PLAN.replace('谁也没有多赚一分钱', '谁也没有多赚哪怕一分钱'));
  assert.match(hj(['status', dir]).stdout, /现在轮到：规划者[\s\S]*重新确认/);
  const st = hj(['stills', dir]);
  assert.equal(st.status, 1); assert.match(st.stderr, /又改过了/);
});

test('确认码：随内容版本变，全角数字也认，夹在别的数字里不算', () => {
  const c = confirmCode('look', 'abc');
  assert.match(c, /^\d{4}$/);
  assert.notEqual(c, confirmCode('look', 'abd')); assert.notEqual(c, confirmCode('keyframes', 'abc'));
  assert.ok(hasCode(`好的，确认 ${c}`, c)); assert.ok(hasCode(`确认${[...c].map(d => String.fromCharCode(d.charCodeAt(0) + 0xfee0)).join('')}`, c));
  assert.ok(!hasCode('可以', c)); assert.ok(!hasCode(`1${c}9`, c));
});

test('四道确认：计划 → 全景定稿 → 关键帧，每道都有审片页；审片页过期、板上的东西变了都要重来', { timeout: 240000 }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hj-gate-')), 'p');
  cpSync('examples/one-board', dir, { recursive: true }); rmSync(join(dir, 'out'), { recursive: true, force: true }); rmSync(join(dir, 'approvals.json'), { force: true });
  // 没生成这一版的审片页，不能确认
  assert.match(hj(['approve', dir, 'plan', '--by', '确认 1234']).stderr, /还没有生成审片页/);
  assert.equal(hj(['plan', dir]).status, 0);
  assert.equal(hj(['approve', dir, 'plan', '--by', `确认 ${codeOf(dir, 'plan')}`]).status, 0);
  // 全景定稿没确认：不出正式关键帧，不能确认关键帧
  const early = hj(['stills', dir]);
  assert.equal(early.status, 1); assert.match(early.stderr, /全景定稿还没有得到用户确认/);
  assert.match(hj(['status', dir]).stdout, /hj look/);
  const look = hj(['look', dir]);
  assert.equal(look.status, 0, look.stderr);
  assert.match(look.stdout, /必须让用户看到图/);
  const html = readFileSync(join(dir, 'out/review/look.html'), 'utf8');
  assert.match(html, /眯眼看/); assert.match(html, /data:image\/jpeg;base64/); assert.match(html, new RegExp(codeOf(dir, 'look')));
  assert.match(hj(['approve', dir, 'look', '--by', '挺好看的']).stderr, /没有确认码/);
  assert.equal(hj(['approve', dir, 'look', '--by', `确认 ${codeOf(dir, 'look')}，好看`]).status, 0);
  // 微调位置不让全景定稿失效；换了大小的档位就失效
  const f = join(dir, 'scenes/01-board.yaml'), src = readFileSync(f, 'utf8');
  writeFileSync(f, src.replace('at: [690, 78]', 'at: [690, 78], dx: 6'));
  assert.match(hj(['check', dir]).stdout, /全景定稿 ✓ 已确认/);
  writeFileSync(f, src.replace('text: "= 1000", size: hero', 'text: "= 1000", size: key'));
  const ck = hj(['check', dir]);
  assert.match(ck.stdout, /全景定稿 ✗ 需重新确认/); assert.match(ck.stdout, /差得不够开/);
  assert.match(hj(['stills', dir]).stderr, /板上的东西[\s\S]*又改过了/);
  writeFileSync(f, src);
  const st = hj(['stills', dir]);
  assert.equal(st.status, 0, st.stderr);
  assert.match(readFileSync(join(dir, 'out/review/keyframes.html'), 'utf8'), /口播：/);
  assert.equal(hj(['approve', dir, 'keyframes', '--by', `确认 ${codeOf(dir, 'keyframes')}`]).status, 0);
  assert.match(hj(['status', dir]).stdout, /hj render/);
  // 草稿多出一张眯眼图
  assert.equal(hj(['stills', dir, '--draft']).status, 0);
  assert.ok(existsSync(join(dir, 'out/draft/squint-01-board.png')));
});

test('主角和版式：主角必须是板上真有的东西；版式展开成分区；没指定主角会提醒', () => {
  const noHero = hj(['check', project()]);
  assert.match(noHero.stdout, /没有指定主角（hero）/);
  const bad = hj(['check', project(PLAN.replace('  - id: loop\n', '  - id: loop\n    hero: "没有这个词"\n'))]);
  assert.equal(bad.status, 1); assert.match(bad.stdout, /hero 写的 "没有这个词"/);
  const ok = hj(['check', project(PLAN.replace('  - id: loop\n', '  - id: loop\n    hero: "+0"\n'))]);
  assert.doesNotMatch(ok.stdout, /hero/);
  const lay = PLAN.replace(/    grid:\n      areas:\n        - \[up, up\]\n        - \[left, right\]\n    regions: \{[^\n]*\n/, '    layout: cycle\n').replace(/in: up/g, 'in: head').replace(/in: left/g, 'in: loop').replace(/in: right/g, 'in: sum');
  const l1 = hj(['check', project(lay)]);
  assert.match(l1.stdout, /0 个错误/, l1.stdout);
  const l2 = hj(['check', project(lay.replace('layout: cycle', 'layout: spiral'))]);
  assert.equal(l2.status, 1); assert.match(l2.stdout, /没有叫 "spiral" 的版式/);
  assert.match(hj(['layouts']).stdout, /compare[\s\S]*两边对照/);
});

test('构图检查：档位写错、字号太多、漂着的字、差一点对齐、左右失衡；手写坐标会被吸附对齐', () => {
  const dir = project(PLAN.replace('  - id: loop\n', '  - id: loop\n    hero: "+0"\n'));
  assert.equal(hj(['scaffold', dir]).status, 0);
  const f = join(dir, 'scenes/01-loop.yaml'), src = readFileSync(f, 'utf8');
  assert.match(src, /size: hero/, '骨架给主角最大一档'); assert.match(src, /size: key/);
  const msgs = () => lint(compile(dir)).filter(i => i.level !== 'info').map(i => i.msg).join('\n');
  const add = (els: string) => writeFileSync(f, src.replace('beats:\n', 'beats:\n  - { at: "公司", intent: 加几样, do: [{ draw: [x1, x2, x3, x4, x5, x6] }] }\n').replace('elements:\n', 'elements:\n' + els));
  // 档位名写错
  writeFileSync(f, src.replace('size: key', 'size: huge'));
  assert.match(hj(['check', dir]).stdout, /size 没有 "huge" 这一档/);
  // 字号太多 + 漂着的字
  add('  x1: { text: "甲", size: 30, at: [60, 1200] }\n  x2: { text: "乙", size: 37, at: [200, 300] }\n  x3: { text: "丙", size: 43, at: [300, 300] }\n  x4: { text: "丁", size: 52, at: [400, 300] }\n  x5: { text: "戊", size: 58, at: [500, 300] }\n  x6: { text: "己", size: 77, at: [600, 300] }\n');
  const m1 = msgs();
  assert.match(m1, /种字号/); assert.match(m1, /“甲”（x1） 是漂着的字/);
  // 左右失衡：东西全堆在左边
  add('  x1: { shape: rect, w: 200, h: 200, at: [120, 300] }\n  x2: { shape: rect, w: 200, h: 200, at: [120, 520] }\n  x3: { shape: rect, w: 200, h: 200, at: [120, 740] }\n  x4: { shape: rect, w: 200, h: 200, at: [120, 960] }\n  x5: { shape: rect, w: 60, h: 60, at: [330, 300] }\n  x6: { shape: rect, w: 60, h: 60, at: [330, 520] }\n');
  assert.match(msgs(), /左重右轻/);
  // 吸附：左边只差 9px 的两行字被吸到同一条左边；差 40px 的不动；snap: false 关掉
  add('  x1: { text: "第一行字", size: key, at: [300, 300], anchor: left }\n  x2: { text: "第二行", size: key, at: [309, 400], anchor: left }\n  x3: { text: "第三行", size: key, at: [340, 500], anchor: left }\n  x4: { text: "第四行", size: key, at: [309, 600], anchor: left, snap: false }\n  x5: { text: "五", size: key, at: [700, 300] }\n  x6: { text: "六", size: key, at: [800, 300] }\n');
  const c = compile(dir), bx = (id: string) => c.tls.find(t => t.el.id === id)!.el.box.x;
  assert.ok(Math.abs(bx('x2') - bx('x1')) < 0.6, '差 9px 的被吸附到同一条左边');
  assert.ok(Math.abs(bx('x3') - bx('x1')) > 25, '差得多的不动');
  assert.ok(Math.abs(bx('x4') - bx('x1')) > 5, 'snap: false 不吸附');
  assert.match(lint(c).map(i => i.msg).join('\n'), /差一点对齐/, '关掉吸附后剩下的近似对齐会被指出来');
});

test('配音协议：帧的编码和解码', () => {
  const p = packet(100, { a: 1 }, 'sid');
  assert.deepEqual([...p.subarray(0, 4)], [0x11, 0x14, 0x10, 0x00]);
  assert.equal(p.readInt32BE(4), 100); assert.equal(p.readUInt32BE(8), 3); assert.equal(p.subarray(12, 15).toString(), 'sid');
  const frame = (event: number, body: Buffer, kind = 9) => { const sid = Buffer.from('s'), h = Buffer.alloc(8), l = Buffer.alloc(4); h.writeInt32BE(event, 0); h.writeUInt32BE(sid.length, 4); l.writeUInt32BE(body.length); return Buffer.concat([Buffer.from([0x11, kind * 16 + 4, kind === 11 ? 0 : 0x10, 0]), h, sid, l, body]); };
  assert.deepEqual(unpack(frame(364, Buffer.from(JSON.stringify({ words: [{ word: '阳', startTime: 0.1, endTime: 0.3 }] })))).payload.words[0].word, '阳');
  assert.deepEqual([...unpack(frame(352, Buffer.from([0, 1, 2, 3]), 11)).audio!], [0, 1, 2, 3]);
  assert.throws(() => unpack(frame(364, Buffer.from('{}')).subarray(0, -1)));
  // 字词时间 → 时间表：标点不单独占时间，数字和缩写标成不可靠
  const al = buildAlignment([{ text: '阳光，AI', words: [{ word: '阳', startTime: 0.1, endTime: 0.3, confidence: 0.9 }, { word: '光，', startTime: 0.3, endTime: 0.6, confidence: 0.9 }, { word: 'AI', startTime: 0.6, endTime: 0.9, confidence: 0.9 }] }], 1, 'x');
  assert.deepEqual(al.units.map((u: any) => u.text), ['阳', '光', 'AI']);
  assert.equal(al.units[1].display_text, '光，');
  assert.deepEqual(al.units[2].timing_warnings, ['number_or_acronym']);
  assert.ok(scriptWarnings('2026 年 GPU 涨了。').length === 2);
});

test('配音：稿子没确认不调用；确认后合成一次，产物直接能建时间表；改一个字要重新确认', { timeout: 60000 }, async () => {
  // 模拟服务端：照协议回 建连 → 开会话 → 字词时间 + 音频 → 会话完成
  let calls = 0, gotKey = '';
  const wss = new WebSocketServer({ port: 0 });
  const frame = (event: number, body: Buffer, kind = 9, idName = 's') => { const sid = Buffer.from(idName), h = Buffer.alloc(8), l = Buffer.alloc(4); h.writeInt32BE(event, 0); h.writeUInt32BE(sid.length, 4); l.writeUInt32BE(body.length); return Buffer.concat([Buffer.from([0x11, kind * 16 + 4, kind === 11 ? 0 : 0x10, 0]), h, sid, l, body]); };
  const J = (o: any) => Buffer.from(JSON.stringify(o));
  wss.on('connection', (ws, req) => {
    gotKey = String(req.headers['x-api-key']);
    ws.on('message', (raw: Buffer) => {
      const ev = raw.readInt32BE(4);
      if (ev === 1) ws.send(frame(50, J({}), 9, 'c'));
      else if (ev === 100) ws.send(frame(150, J({})));
      else if (ev === 200) {
        calls++;
        const sidLen = raw.readUInt32BE(8), body = JSON.parse(raw.subarray(16 + sidLen).toString('utf8')), text: string = body.req_params.text;
        const chars = [...text].filter(ch => !/[\s\p{P}]/u.test(ch));
        ws.send(frame(352, Buffer.alloc(48000 * 2 * 2), 11)); // 2 秒静音
        ws.send(frame(364, J({ text, words: chars.map((w, i) => ({ word: w, startTime: (i * 1.9) / chars.length, endTime: ((i + 1) * 1.9) / chars.length, confidence: 0.9 })) })));
      } else if (ev === 102) ws.send(frame(152, J({})));
      else if (ev === 2) ws.send(frame(52, J({}), 9, 'c'));
    });
  });
  await new Promise(r => wss.once('listening', r));
  const env = { HJ_TTS_ENDPOINT: `ws://127.0.0.1:${(wss.address() as any).port}`, VOLCENGINE_TTS_API_KEY: 'test-key-123' };
  const run = (args: string[], e: Record<string, string> = env) => new Promise<{ status: number; out: string }>(res => { const p = spawn(process.execPath, ['bin/hj.mjs', ...args], { env: { ...process.env, ...e } }); let out = ''; p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d)); p.on('close', c => res({ status: c ?? 1, out })); });
  try {
    const root = mkdtempSync(join(tmpdir(), 'hj-voice-')), dir = join(root, 'proj'), sf = join(root, 's.txt');
    writeFileSync(sf, SCRIPT);
    assert.equal((await run(['init', dir, '--script', sf])).status, 0);
    assert.match((await run(['status', dir])).out, /现在轮到：配音/);
    // 没确认：列出稿子，不调用
    const r0 = await run(['voice', dir]);
    assert.equal(r0.status, 1); assert.match(r0.out, /还没有得到用户确认/); assert.match(r0.out, /公司交一百块税/); assert.equal(calls, 0);
    assert.equal((await run(['approve', dir, 'script', '--by', '稿子可以'])).status, 0);
    // 没有密钥：不调用，也不把密钥要进对话
    const r1 = await run(['voice', dir], { ...env, VOLCENGINE_TTS_API_KEY: '' });
    assert.equal(r1.status, 1); assert.match(r1.out, /VOLCENGINE_TTS_API_KEY/); assert.equal(calls, 0);
    const r2 = await run(['voice', dir]);
    assert.equal(r2.status, 0, r2.out); assert.equal(calls, 1); assert.equal(gotKey, 'test-key-123');
    assert.ok(!r2.out.includes('test-key-123'));
    assert.ok(!readFileSync(join(dir, 'voice/runs/001/events.jsonl'), 'utf8').includes('test-key-123'));
    assert.match(readFileSync(join(dir, 'project.yaml'), 'utf8'), /^audio: voice\/narration\.wav$/m);
    assert.equal((await run(['brief', dir])).status, 0); // 产物就是引擎要的时间表
    // 同一版稿子不会悄悄再花一次钱
    const r3 = await run(['voice', dir]);
    assert.equal(r3.status, 1); assert.match(r3.out, /已经用同样的音色和语速配过了/); assert.equal(calls, 1);
    // 改一个字：确认失效
    writeFileSync(join(dir, 'script.txt'), SCRIPT.replace('一分', '一毛'));
    const r4 = await run(['voice', dir]);
    assert.equal(r4.status, 1); assert.match(r4.out, /改过了，要重新确认/); assert.equal(calls, 1);
  } finally { wss.close(); }
});

test('免费配音：逐词时间拆成逐字，标点从原文补回，数字和英文保持整体并标成不可靠', () => {
  const text = '结果呢？到2026年，AI涨了。';
  const words = [{ text: '结果', start: 0.1, end: 0.5 }, { text: '呢', start: 0.5, end: 0.8 }, { text: '到', start: 1.3, end: 1.5 }, { text: '2026', start: 1.5, end: 2.0 }, { text: '年', start: 2.0, end: 2.3 }, { text: 'AI', start: 2.7, end: 3.1 }, { text: '涨', start: 3.1, end: 3.3 }, { text: '了', start: 3.3, end: 3.5 }];
  const u = edgeUnits(text, words, 10);
  assert.deepEqual(u.map(x => x.text), ['结', '果', '呢', '到', '2026', '年', 'AI', '涨', '了']);
  assert.equal(u[0].start, 10.1); assert.ok(Math.abs(u[1].start - 10.3) < 1e-9); // 两个字的词按字均分，并平移到整条音轨上
  assert.equal(u[2].display_text, '呢？'); assert.equal(u[5].display_text, '年，'); assert.equal(u[8].display_text, '了。');
  assert.deepEqual(u[4].timing_warnings, ['number_or_acronym']); assert.deepEqual(u[6].timing_warnings, ['number_or_acronym']);
  assert.deepEqual(u[0].timing_warnings, []);
  // 默认值：每个音色都有语速和音高，音高不超过会失真的范围
  assert.ok(EDGE_VOICES[DEFAULT_EDGE_VOICE]);
  for (const v of Object.values(EDGE_VOICES)) { assert.match(v.rate, /^[+-]\d+%$/); assert.ok(Math.abs(parseInt(v.pitch)) <= 15); }
});
