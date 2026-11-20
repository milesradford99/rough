// 从真实制作里总结出来的坑：每一条都对应一次“下次别再这样犯错”。
// 先写计划再配音、稿子的读法在确认前就改掉、骨架给角色写名字、卡点不歧义、动作选项写错位置、板书和箭头小字重复、封面取全景。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fakeAlignment } from '../src/core/alignment';
import { compile } from '../src/core/compile';

const hj = (...a: string[]) => spawnSync(process.execPath, ['bin/hj.mjs', ...a], { encoding: 'utf8' });
const SCRIPT = '公司交一百块税。政府发给你一百块。你又花回公司。转了一圈，一分没多赚。所以这一百块，谁也没有多出来。';
const PLAN = `thesis: 税、补贴、消费转了一圈，谁也没有多赚一分钱
cast:
  co:  { name: 公司, look: { doodle: factory } }
  gov: { name: 政府, look: { doodle: gov } }
  me:  { name: 你,   look: { figure: stand } }
  crowd: { name: 一群人, look: { crowd: 4, cols: 4, of: { figure: stand } } }
relations:
  tax:   { from: co, to: gov, label: 交税 }
  give:  { from: gov, to: me, label: 发钱 }
  spend: { from: me, to: co, label: 消费 }
  join:  { from: crowd, to: co }
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
      - { at: "政府发给你", act: 例子, in: left, show: [me, crowd], link: [give, join], intent: 政府把钱发给你 }
      - { at: "你又花回公司", act: 例子, in: left, link: [spend], intent: 你把钱花回公司，圈闭合 }
      - { at: "一分没多赚", act: 结论, in: right, revisit: [co], words: ["+0"], intent: 回到公司身上圈一下：它没有多赚 }
`;

/** 只有稿子、还没配音的项目（导演那一步不管：这里测的是规划者） */
function scriptOnly(plan = PLAN, script = SCRIPT): string {
  const root = mkdtempSync(join(tmpdir(), 'hj-lessons-')), sf = join(root, 's.txt'), dir = join(root, 'p');
  writeFileSync(sf, script);
  assert.equal(hj('init', dir, '--script', sf).status, 0);
  rmSync(join(dir, 'story.yaml')); writeFileSync(join(dir, 'project.yaml'), readFileSync(join(dir, 'project.yaml'), 'utf8').replace(/^story:.*\n/m, ''));
  writeFileSync(join(dir, 'plan.yaml'), plan);
  return dir;
}

test('先写计划再配音：没配音也能查计划、出审片页（秒数按稿子估），确认计划和生成骨架要等配好音', { timeout: 120000 }, () => {
  const dir = scriptOnly();
  const ck = hj('check', dir);
  assert.equal(ck.status, 0, ck.stdout + ck.stderr);
  assert.match(ck.stdout, /还没有配音：时间是按每秒/);
  const pl = hj('plan', dir);
  assert.equal(pl.status, 0, pl.stdout + pl.stderr);
  assert.match(readFileSync(join(dir, 'out/review/plan.html'), 'utf8'), /秒数是估的/);
  assert.ok(!existsSync(join(dir, 'voice/alignment.json')), '估出来的时间表不放进 voice/：那里只放真实的配音');
  const ap = hj('approve', dir, 'plan', '--by', '确认');
  assert.notEqual(ap.status, 0); assert.match(ap.stderr, /确认计划、生成骨架要等配好音/);
  assert.notEqual(hj('scaffold', dir).status, 0);
  assert.match(hj('status', dir).stdout, /现在轮到：配音/);
});

test('稿子的读法问题在导演这一步就提醒（确认之前），不要等到配音才发现、再改已经确认的稿子', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-lessons-story-')), sf = join(root, 's.txt'), p = join(root, 'p');
  writeFileSync(sf, '2018年的前九个月，茅台只跌了百分之三。到了最后三个月，茅台却跌了两成。那么，前面越抗跌的，后面是不是一定跌得越多？\n\n市场继续跌的时候，关系几乎是零。所以要看谁在卖，谁在接。');
  assert.equal(hj('init', p, '--script', sf).status, 0);
  writeFileSync(join(p, 'story.yaml'), `audience: 炒股的人
myth: 抗跌的股票迟早要补跌
truth: 补跌不是规律，要看谁在卖
motif: 一个保险箱
hook: { say: "茅台只跌了百分之三", why: 反常 }
predict: { say: "前面越抗跌的，后面是不是一定跌得越多" }
aha: { say: "市场继续跌的时候，关系几乎是零", see: 一根柱子缩到几乎为零, move: change }
land: { say: "要看谁在卖，谁在接", callback: 保险箱 }
`);
  const st = hj('story', p);
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /稿子的读法[\s\S]*阿拉伯数字：2018/);
});

test('骨架：角色带着名字；卡点在这块板里不歧义（片段后面还会再说到，就往后多带几个字）', () => {
  // “发给你”后面还会再说一次：骨架要把卡点写长一点，编译时就不会报“出现了 2 次”
  const script = '公司交一百块税。政府发给你。你又花回公司。转了一圈，一分没多赚，发给你的钱又回来了。';
  const plan = PLAN.replace('at: "政府发给你"', 'at: "发给你"');
  const dir = scriptOnly(plan, script);
  mkdirSync(join(dir, 'voice'), { recursive: true });
  writeFileSync(join(dir, 'voice/alignment.json'), JSON.stringify(fakeAlignment(script)));
  assert.equal(hj('scaffold', dir).status, 0);
  const sc = readFileSync(join(dir, 'scenes/01-loop.yaml'), 'utf8');
  assert.doesNotMatch(sc, /at: "发给你"\n/, '歧义的片段要写长');
  assert.match(sc, /co: \{ cast: co, size: mid, label: "公司"/);
  assert.match(sc, /crowd: \{ cast: crowd, size: mid, label: "一群人"/, '一群也带名字');
  const c = compile(dir);
  assert.ok(!c.issues.some(i => /出现了 \d+ 次，现在取的是第 1 次/.test(i.msg)), c.issues.filter(i => /出现了/.test(i.msg)).map(i => i.msg).join('\n'));
  assert.ok(!c.issues.some(i => /crowd 不认识字段/.test(i.msg)), '人群可以写 label');
  assert.ok(c.tls.some(t => t.el.id === 'crowd_label'), '人群的名字是一个元素，随整群一起画');
});

test('动作的选项写到了元素上：报错直接说该写在哪儿', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-lessons-span-')), dir = join(root, 'p');
  mkdirSync(join(dir, 'voice'), { recursive: true }); mkdirSync(join(dir, 'scenes'));
  writeFileSync(join(dir, 'voice/alignment.json'), JSON.stringify(fakeAlignment('先画一根横条。')));
  writeFileSync(join(dir, 'project.yaml'), 'title: t\nformat: landscape\n');
  writeFileSync(join(dir, 'scenes/01.yaml'), 'from: "先画"\nintent: 一根横条\nelements:\n  t: { axis: [0, 10], length: 600, at: [100, 300] }\n  b: { span: [0, 5], on: t, at: [0, 300], from: end }\nbeats:\n  - { at: "先画", intent: 长出来, do: [{ grow: b }] }\n');
  const c = compile(dir);
  assert.ok(c.issues.some(i => i.level === 'error' && /grow 动作的选项，写在节拍里：\{ grow: 元素id, from: end \}/.test(i.msg)), c.issues.map(i => i.msg).join('\n'));
});

test('板书和箭头上的小字、角色的名字一样：计划这一步就提醒（板上会出现两处一样的字）', () => {
  const plan = PLAN.replace('words: ["100"]', 'words: ["100", 交税, 公司]');
  const dir = scriptOnly(plan);
  const ck = hj('check', dir);
  assert.match(ck.stdout, /板书 "交税" 和关系 tax 箭头上的小字一样/);
  assert.match(ck.stdout, /板书 "公司" 就是角色 co 的名字/);
});
