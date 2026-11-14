// 规划者 → 执行者：计划的检查、骨架、照计划执行的对照，以及配音的闸门和协议。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { fakeAlignment } from '../src/core/alignment';
import { packet, unpack, buildAlignment, scriptWarnings } from '../src/core/tts';

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
  assert.equal(hj(['approve', dir, 'plan', '--by', '可以']).status, 0);
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
  assert.match(c2.stdout, /没有卡在这几个字上的节拍/);
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
