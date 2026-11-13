# 字段参考

## 项目目录

```
<项目>/
  project.yaml        项目设置
  voice/              alignment.json（时间表）、narration.wav（配音）
  cast.yaml           （可选）角色表：全片反复出现的人和东西，长相只定义一次
  outline.md          hj init 生成：写分镜前先填的提纲（全景、分区、怎么连、从哪儿切入）
  scenes/             一个文件是一块板。一条片子通常只有一个（01-board.yaml）；分章时一章一个，按文件名排序
  doodles/            （可选）本项目自己画的手绘件
  brief.md            hj brief 生成：逐句时间简报
  storyboard.md       hj plan 生成：给用户确认的文字分镜表
  approvals.json      hj approve 写入：确认记录
  out/                关键帧与视频
```

## project.yaml

| 字段 | 默认 | 说明 |
|---|---|---|
| `title` | | 标题 |
| `format` | `portrait` | `portrait` 竖屏 1080×1920；`landscape` 横屏 1920×1080 |
| `fps` | 30 | |
| `voice` | `voice/alignment.json` | 时间表。也接受 `.srt`（降级：只有句级精度） |
| `audio` | 无 | 配音文件。没有则成片只有落笔音效 |
| `subtitles` | `true` | 字幕 |
| `subtitleMaxChars` | 竖 13 / 横 24 | 每行字幕最多字数 |
| `sfx` | `true` | 落笔音效。`true`：稀疏模式，每落一次笔一声很轻的短响，两声之间至少隔 0.9 秒；`full`：更密；`false`：关 |
| `sfxVolume` | 1 | 音效音量倍数 |
| `sfxSamples` | 无 | 用真实录音替换合成音：`{ pen: sfx/pen.wav, mark: sfx/circle.wav, erase: sfx/wipe.wav }`（16-bit WAV，路径相对项目目录）。合成音不如录音自然，有条件就换 |
| `pen` | `false` | 显示一个极小的笔尖 |
| `shade` | `true` | 灰色马克笔阴影：手绘件、形状、柱状图的柱子画完后在右下侧扫一道灰，小人脚下有一小团影子。`false` 关掉全片的阴影 |
| `autoframe` | `true` | 自动取景：一块板上的东西没铺满画板时，镜头推近到刚好装满（最多 1.4 倍），位置关系不变，东西和字整体变大。`false` 关掉全片；单个场景里写 `frame: false` 关掉这一场。沿用（recall）的场景和原场景取同一个景 |
| `layout` | 无 | 默认一条片子一块板，切成很多小板会被检查器当作翻页。确实要分页（素材陈列、每页自成一体的讲法）写 `pages` |
| `board` | 1 | 全片的板相对屏幕的倍数（1–3）。也可以写在单个场景里 |
| `tail` | 0.6 | 口播结束后多留几秒 |

## 画板坐标

元素坐标以**画板**左上角为原点，x 向右、y 向下。画板已经避开了平台按钮和字幕区，画在里面就是安全的。

| 画幅 | 画板大小 |
|---|---|
| 竖屏 | 960 × 1250 |
| 横屏 | 1700 × 800 |

坐标可以写数字，也可以写百分比：`at: ["50%", "30%"]`。

## 场景文件

| 字段 | 必填 | 说明 |
|---|---|---|
| `from` | 第一个场景可省 | 场景开口的头几个字（口播锚点） |
| `intent` | 是 | 全景：这块板讲完是一张什么图。写给用户看的人话，会原样出现在分镜表最上面 |
| `enter` | | `pan`（默认，镜头平移到新板面）/ `wipe`（把上一场擦掉）/ `cut` |
| `recall` | | 沿用前面某个场景的画面，见下文 |
| `frame` | | `false`：这一场不要自动取景（见项目设置的 `autoframe`） |
| `regions` | | 板面分区：`区名: [x, y, w, h]`（数字或百分比）。全景的骨架。元素写 `in: 区名` 后，`at` 的数字和百分比都相对这一块；只写 `in` 不写位置就放在分区正中。镜头可以推近一个分区（`camera: { focus: 区名 }`）。划了却到最后空着的分区会被警告；分区不能和元素重名 |
| `board` | 1 | 这块板相对屏幕的倍数（1–3）。`1.5` 表示宽高都是 1.5 倍：全景把整块板缩进画面，推近才是原大。内容多、一屏放不下时用它，不要换板 |
| `pattern` | | 表现手法：自带构图和动作编排的场景骨架，见下文 |
| `elements` | | `id: 定义` 的映射。id 只在本场景内有效 |
| `beats` | | 节拍列表，按口播顺序 |
| `id` | | 场景名，默认取文件名（去掉序号） |
| `note` | | 随便写的备注，不参与任何计算 |

## 沿用前面的画面（recall）

分章的片子里（一章一块板），前面那块板上的图在后面再出现时，不要把元素抄一遍。同一块板上不需要它：画过的东西本来就在原位。

```yaml
from: "那被调去海军"
recall: army-navy                 # 前面那个场景的名字（文件名去掉序号）
# 或者只要其中一部分：
# recall: { scene: army-navy, show: [land, office, boat, sea], except: [flow] }
elements:
  mid: { figure: slump, at: [520, 1000] }      # 这一场新加的东西，可以引用沿用过来的元素
```

- 被沿用的元素**定义和位置原样带过来**，进场时已经在板上，不占口播时间重画，和原场景一模一样。
- 不写 `show` 时，带过来的是那个场景结束时还留在板上的东西（被擦掉、隐去、移动过的不带）。
- 沿用过来的元素和自己的元素一样用：可以圈、可以擦、可以让小人走过去、可以当批注的目标。
- 只能沿用前面的场景。改 `recall` 属于“画什么变了”，会让用户的确认失效。

## 角色表（cast.yaml）

```yaml
# cast.yaml
boss:   { figure: stand, face: smug, wear: [tophat] }
worker: { figure: stand, size: 140 }
money:  { doodle: banknote }
```

场景里写 `{ cast: boss, size: 300, at: [140, 240] }`，其余字段照常写，会覆盖角色表里的同名字段（换姿势写 `pose: think`，换表情写 `face: worried`）。手法的角色、`crowd` 的 `of`、`carry` 里也能用。

## 表现手法（pattern）

手法替你决定位置、大小、箭头走向和动作顺序；你决定角色是谁、每一步卡在哪句话上。

```yaml
from: "咱们跟着一百块钱"
intent: 一张钞票从公司到政府、到你、再回公司，公司一分没多赚。
pattern:
  kind: cycle
  nodes:
    - { id: company, doodle: factory, label: 公司 }
    - { id: gov, doodle: gov, label: 政府 }
    - { id: you, figure: stand, label: 你 }
  result: "+0"
beats:
  - at: "收走一百块税"
    intent: 画出政府，钞票沿箭头滑过去
    do:
      - { step: show.2 }
      - { step: go.1 }
  - at: "一分没有"
    intent: 写下 +0
    do:
      - { step: result }
      - { pose: you, to: shrug, with: prev }     # 手法的步骤和自己的动作可以混着写
```

- `hj patterns` 列出全部九种，`hj patterns cycle` 看某一种的参数和步骤。实际效果见 `examples/patterns/`。
- 手法里的角色写法和普通元素一样，只是不用写位置；大小可省（手法会给合适的默认值），也可以自己写 `size` 覆盖。
- 给角色写 `id`，之后就能在自己的动作里引用它（换姿势、圈起来、推镜头）。没写 id 的，用手法自动起的名字：`hj patterns <名字>` 会列出例子展开后的全部元素名（如柱子是 `b1 b2…`，数值是 `v1…`，标签是 `t1…`），`hj layout` 也能看到。
- 手法生成的元素和你自己写的 `elements` 是一家：`elements` 里的批注、标记、箭头可以直接以它们为目标（`{ note: 饿了, target: me }`）。
- 手法自己算出来的字号最小是 36，不会再触发“字号太小”。
- `{ step: 名字 }` 上可以加 `at`、`with: prev`、`delay`，作用于这一步的第一个动作。
- `area: 分区名` 把手法放进一个分区（见场景的 `regions`）；也可以直接写 `area: [x, y, w, h]`（可用百分比）。手法是往全景上添的一块，一般不占整块板。
- **一块板放多种手法**：`pattern` 写成列表，每种都写 `area`（分区名或坐标）。这时步骤名要带前缀 `<kind>.<步骤>`（如 `cycle.go.1`、`bars.cut.1`）；同一种手法用两次时给它们各写一个 `name` 当前缀。
- `cycle` 的 `flows`、`chain` 的 `links` 给每条箭头写小字；`timeline` 的事件可以带 `note`。
- `bars` 的数值可以单独卡点：`col.N` 先立柱子，`value.N` 等口播说出那个数再写（`bar.N` 是两者一起）。`split` 的某一份写 `blank: true` 就留白打问号。
- 手法展开后就是普通元素。位置不满意时，可以把 `hj check` 通过后的那个元素在 `elements` 里重新定义一个，或者干脆不用手法、照着它的布局自己摆。

## 口播锚点

节拍的 `at`、场景的 `from`、动作的 `at` 都用它。

| 写法 | 含义 |
|---|---|
| `"收走一百块税"` | 这几个字开口的那一刻 |
| `"一百块#2"` | 本场景口播里第 2 次出现的“一百块” |
| `"一分没有@end"` | 说完这几个字的那一刻 |
| `"发给你-0.3"` / `"发给你+0.2"` | 提前 / 推后若干秒 |
| `"一百块#2@end+0.1"` | 可以组合，顺序固定：文字、`#n`、`@end`、偏移 |

锚点只在**本场景的口播范围内**查找，所以片段不用写很长，够在本场景里唯一就行。标点会被忽略。

## 节拍

```yaml
- at: "收走一百块税"     # 必填：口播锚点
  lead: 0.3               # 可选：比锚点提前几秒起笔
  intent: 钞票从公司滑到政府   # 必填：这一拍画面上发生什么（人话）
  do: [ … ]               # 动作列表
```

**动作怎么排时间：** 默认一个接一个顺序执行，从节拍的时刻开始，到下一拍为止。
`draw` 的时长是自动的：按笔画长度估算“自然时长”，时间不够就整体加快，时间富余则最多放慢到 1.25 倍。

每个动作都可以加：

| 选项 | 说明 |
|---|---|
| `with: prev` | 和上一个动作同时开始（不排队） |
| `dur: 0.8` | 指定时长（秒） |
| `delay: 0.2` | 开始前多等一会儿 |
| `at: "口播片段"` | 这个动作自己卡一个点；它后面的动作接着它排 |

## 动作

| 动作 | 写法 | 说明 |
|---|---|---|
| 画 | `draw: id` 或 `draw: [a, b, c]` | 一笔一笔画出来。数组表示依次画 |
| 画（内联） | `draw: { mark: circle, target: x }` | 直接在动作里定义一个元素，省得去 elements 里起名 |
| 擦 | `erase: id` / `[ids]` / `all` | `style: wipe`（默认，板擦擦掉）或 `fade` |
| 走过去 | `walk: 小人id`，配 `to` / `by` | 边移动边迈步，到了恢复原姿势。时长默认 1.1 秒，远的话写 `dur`。`to` 是**脚落在哪儿**（`to: boat.deck`）；几个人一起走（`walk: p6..p10`）会保持队形并收紧，不会叠成一个 |
| 移动 | `move: id`，配 `to` / `by` / `along` | `to: gov` 或 `to: you.handR` 或 `to: [x, y]`；`by: [dx, dy]`；`along: 箭头id` 沿箭头走 |
| 缩放 | `scale: id, to: 1.6` | 相对原始大小的倍数 |
| 换姿势 | `pose: 小人id, to: shrug` | 可同时 `face: surprised` |
| 换表情 | `face: 小人id, to: worried` | |
| 弹出 / 淡入 | `pop: id` / `fade: id` | 不经过“画”直接出现。少用，这是 PPT 的出场方式 |
| 隐去 | `hide: id` | 快速淡出 |
| 晃动 / 放大强调 / 点头 | `shake: id` / `pulse: id` / `nod: id` | 吸引注意 |
| 镜头 | `camera: { focus: [a, b], pad: 90 }` / `camera: home` | 推近若干元素 / 回到全景 |
| 等待 | `wait: 0.5` | |

`move` 之后，元素的新位置会被后续的 `move ... to` 和 `camera focus` 认到；但先前已经画好的箭头和标记不会跟着动。

## 元素

### 不重叠是引擎保证的

手绘的板面上，东西不会互相压着。这一条不靠你自己检查，由引擎在布局时保证：

- **压到了就自动挪开。** 一个元素按你写的位置会压到同时在板上的其他元素时，引擎把它挪到最近的空位，并在 `hj check` 里用一条“提示”告诉你挪了多少。
- **出了画板就自动拉回来。**
- **连线自动绕路。** 箭头、连线如果会从别的元素身上穿过，引擎换一个弯度绕开。
- **小字和批注自动换边。** 箭头上的小字、批注想放的那一侧放不下，就换到另一侧或就近的空地。
- **位置可以不写。** 不写任何定位的元素，由引擎像人在板上找地方一样，从上到下、从左到右找第一块放得下的空地；写 `near: 某元素` 则放在离它最近的空地。拿不准坐标时，不写比乱写好。
- 只有**同时在板上**的元素才互相避让：一个东西被擦掉之后，它的位置可以再画别的。

以下情况不算重叠，引擎不会动它们：标记（圈、叉、下划线，本来就是画在目标上的）；用 `at: 某元素` 明确放在另一个元素上面的东西（气泡里的字、手里的钞票），以及挨着它们摆的元素；写了 `overlap: true` 的元素。

板上实在挤到找不到空位时，引擎会放弃并给出警告——这说明这块板该擦掉一些，或者该换一块板了。

### 定位（可以不写；要写就选一种）

| 写法 | 说明 |
|---|---|
| `at: [x, y]` | 元素中心放在这个点 |
| `at: other` / `at: other.top` | 放在另一个元素的中心 / 某个锚点上 |
| `at: [other.left, 440]` | 两个坐标各自可以引用别的元素的锚点（取它的 x 或 y）：和它共用一根轴。配合 `anchor: left` 就是“左端对齐它的左端”。被引用的元素要写在前面 |
| `in: 区名` | 放进一个分区，见场景的 `regions` |
| `rightOf: other`、`leftOf`、`above`、`below` | 贴在另一个元素旁边，`gap`（默认 40）控制间距，`align: start/center/end` 控制对齐 |
| `anchor: bottom` | 配合 `at`：用自己的哪个点去对齐（默认 `center`；可选 `top bottom left right topLeft …`） |
| `dx`、`dy` | 在以上基础上再微调。**改位置优先用它** |
| （都不写） | 引擎自动找空位。可加 `near: other` 指定靠近谁 |
| `overlap: true` | 声明“我就是要压在别的东西上”，引擎不再挪它 |

被引用的元素必须写在前面。锚点有：`center top bottom left right topLeft topRight bottomLeft bottomRight`，小人另有 `head handL handR hip feet`，手绘件还可以有自己声明的锚点（见“自己画手绘件”）。

**站上去、放进去，用锚点，不要估坐标。** 手绘件的外框往往比“能站人的地方”大得多（船的外框上半截是桅杆和帆）。让小人站在甲板上：`{ figure: stand, at: boat.deck, anchor: bottom }`；走过去：`{ walk: p1, to: boat.deck }`。

**手里的东西用 `carry`，不要摆在 `小人.handR` 上。** 摆上去的东西会盖住身体，小人换姿势、走动时也不跟着。

### 通用外观

`size`（大小）、`color`、`fill`（填充色）、`fillAlpha`（填充浓度）、`fillStyle`（`marker` 马克笔涂色，默认 / `hachure` 细排线 / `solid` 平涂 / `zigzag` / `cross-hatch` / `dots`）、`pen`（线宽，默认 5.5）、`rough`（抖动程度，默认 0.9）、`label` + `labelSize`（写在元素正下方的标签，随元素一起画）。

`shade: false`：这个元素不要灰色阴影（默认有，见项目设置的 `shade`）。阴影是引擎自动加的，只加在外轮廓上，不占位置、不参与避让；光永远从左上来，全片一致。

颜色名：`ink red blue green yellow orange purple gray paper`，也可以直接写 `"#rrggbb"`。

### 各类元素

| 类型 | 写法 | 说明 |
|---|---|---|
| 文字 | `{ text: "+0", size: 150, color: red }` | `\n` 换行；`align`。`size` 是字高。字体是手写马克笔体「霞鹜漫黑」 |
| 小人 | `{ figure: stand, face: happy, wear: [tophat, tie], size: 420 }` | `size` 是身高；`accent` 是配饰颜色；`carry: { doodle: moneybag, hand: left }` 手里拿一样东西（默认右手，跟着手动）。姿势/表情/配饰清单：`hj assets figure` |
| 手绘件 | `{ doodle: banknote, size: 200, vars: { text: "100" } }` | **首选**。123 个，和小人同一画风：`hj assets doodles` 查看；`peep-` 开头的 32 个是真人插画（`peep-bust-*` 半身、`peep-sit-*` 坐蹲骑、`peep-stand-*` 站立），要坐着、蹲着、拿东西的人时用它们，火柴人仍是默认角色；`vars` 是该手绘件开放的可调项 |
| 图标 | `{ icon: building-bank, size: 280 }` | 兜底。5000+ 个线条图标，`hj assets icons <英文关键词>` 搜索。造型偏“界面图标”，手绘件里有的就别用它 |
| 形状 | `{ shape: rect, w: 300, h: 180 }` | `rect ellipse circle diamond triangle cloud` |
| 批注 | `{ note: 写进州宪法, target: safe, side: right }` | 一行小字贴在目标旁边，用细线牵过去。`side`: `right`（默认）`left top bottom`；`gap` 距离；`size` 默认 46；默认灰色。用来补数字、名字、出处 |
| 箭头 | `{ arrow: [a, b], curve: 0.2, label: 交税 }` | 起终点可以是元素 id（自动停在边缘外）、`"id.锚点"` 或 `[x, y]`。`curve` 弯曲程度（正负决定朝向）、`both: true` 双向、`head` 箭头大小、`pad` 离元素的距离、`label` 写在箭头中段的小字（`labelSize` 默认 46） |
| 连线 | `{ line: [a, b] }` | 同箭头，没有箭头尖 |
| 标记 | `{ mark: circle, target: x }` | `circle box underline strike cross highlight check burst`。`target` 可以是数组；`pad` 调松紧；默认红色 |
| 图表 | `{ chart: bar, data: [3800, 1200], labels: [法定, 实发], values: true }` | `bar` / `line`。`highlight: 1` 或 `highlight: {1: red}` 标红某项；`unit` 数值后缀；`w`、`h` |
| 自由图形 | `{ parts: [ … ], box: [w, h], size: 200 }` | 就地用基本图形拼一个，格式同手绘件 |
| 人群 | `{ crowd: 10, cols: 5, of: { figure: stand, size: 140 }, at: [250, 800] }` | 一群一样的东西。`at` 是整群的中心，`cols` 每排几个，`gap: 110` 或 `gap: [横, 竖]` 调间距。成员自动叫 `<id>1`…`<id>N`；整群作为一个整体定位，不会有谁被单独挪走 |

**成组引用。** 人群的名字可以当全体成员用，`名字6..名字10` 取其中一段，动作和标记的目标里都能写：`draw: p`、`walk: p6..p10`、`erase: p6..p10`、`{ mark: box, target: p1..p5 }`。

折线图和箭头、连线一样，可以当作 `move … along` 的轨迹。

## 自己画手绘件

在项目的 `doodles/<名字>.yaml` 里：

```yaml
desc: 钞票
box: [220, 120]              # 设计尺寸；使用时 size 对应长边
vars: { text: "100", tint: green }   # 可调项及默认值
anchors: { slot: [110, 0] }          # （可选）自己的锚点，坐标在 box 内；分镜里写 at: 元素id.slot
parts:                       # 按书写顺序排列，坐标在 box 内
  - rect: [0, 0, 220, 120]   # x, y, w, h
    color: $tint
    fill: $tint
  - ellipse: [110, 60, 96, 76]   # cx, cy, w, h
  - text: $text
    at: [110, 60]
    size: 46
```

可用图形：`line: [x1,y1,x2,y2]`、`rect: [x,y,w,h]`、`ellipse: [cx,cy,w,h]`、`circle: [cx,cy,直径]`、`arc: [cx,cy,w,h,起始角,终止角]`、`poly: [[x,y],…]`（加 `close: true` 闭合）、`curve: [[x,y],…]`（过这些点的平滑曲线）、`path: "SVG 路径"`、`icon: 名字`（配 `at`、`size`）、`text`（配 `at`、`size`）。
每个图形可带 `color fill fillStyle fillAlpha fillGap pen rough`。
自己画手绘件时不用管阴影：闭合的图形（`rect ellipse circle`、`close: true` 的 `poly`、以 `Z` 结尾的 `path`）里，够大且没被别的图形包住的那几个会自动得到阴影；某个图形不想要就给它写 `shade: false`。

`anchors` 用来标出“别的东西该落在哪儿”：船的甲板、桌面、门口、保险箱的口。名字不能和内置锚点重名。就地拼的 `parts` 元素也可以写 `anchors`。

画完用 `hj assets sheet` 看效果。内置的在仓库根目录 `doodles/`，可以照着写。

## 从外部导入手绘件

导入的只是几何形状：进来之后由本项目的笔重新画一遍，线条、涂色、阴影都和内置素材一致；原来的颜色会并到调色板里最接近的那个。

**Excalidraw 素材库**（[excalidraw-libraries](https://github.com/excalidraw/excalidraw-libraries)，整个仓库 MIT）。下载一个 `.excalidrawlib` 文件，然后：

```bash
npx hj import excalidraw 素材库.excalidrawlib --out work/<项目>/doodles [--only 名字,名字] [--prefix 前缀] [--text]
npx hj assets sheet --dir work/<项目>/doodles --out sheet.png      # 看长相
```

一个文件里通常有几十个，先全部导进一个临时目录、出一张图看，再把要的挑进项目。素材里的文字默认丢掉（多半是英文标签），`--text` 保留。没有名字的素材叫 `item-N`，自己改名并把 `desc` 改成中文。不要导入品牌 logo。

**SVG**：任意 `.svg` 文件，一个文件转成一个手绘件。核对过授权再导入。

```bash
npx hj import svg 人物.svg --out work/<项目>/doodles [--name 名字] [--desc 说明] [--source "出处"] [--pen 2] [--rough 0.3] [--paper]
```

支持路径、矩形、圆、椭圆、线、折线、多边形，以及 `g` 上的 `transform`、`fill-rule`。渐变、裁剪、蒙版、文字、`<use>`、图片不支持，会提示。处理方式随图形种类不同：

- **只有描边的线条**：当作中线笔画，由本项目的笔重画。这类素材转得最像内置手绘件。
- **深色的填充块**（Open Peeps 这类“用墨块拼出线条”的插画就是这样）：画成平涂的墨色块，`fillStyle: solid`、不透明、细 `pen`（默认 2，内置的是 7，对满幅的细线稿太粗）、低 `rough`（默认 0.3，顶点不动，细线不会被抖断）。镂空的洞用一条零宽的桥并进外轮廓，所以洞留得住。
- **纸色/白色填充**：默认丢掉（底板本来就是纸色），`--paper` 保留。
- **其他颜色**：并到调色板里最接近的那个，用马克笔涂色。
- 所有图形默认 `shade: false`，不加灰色阴影（墨块上的阴影是一团脏灰）。

注意：引擎先画所有涂色、再画所有线，所以后画的白块盖不住先画的线。一个 SVG 里如果有“上层遮住下层”的关系（人的头盖住身体的线），要在导入前自己把被遮住的部分裁掉。内置的 `peep-*` 就是这样做的。

**Quick Draw**（Google，CC BY 4.0，[数据集](https://github.com/googlecreativelab/quickdraw-dataset)）：真人 20 秒内画的简笔画，带真实的落笔顺序。要 simplified 版的 `<类别>.ndjson`（文件很大，下载开头几百 KB 就够挑）。

```bash
npx hj import quickdraw tree.ndjson --sheet candidates.png --count 48        # 候选图，每张带编号
npx hj import quickdraw tree.ndjson --pick 17 --name tree --out work/<项目>/doodles [--color green]
```

它们只有线、没有涂色，比内置手绘件潦草，适合“随手一画”的场合；成片里用了要按 CC BY 署名。

导入的文件里有一行 `source:` 记着出处，留着它。

## 命令

| 命令 | 作用 |
|---|---|
| `hj init <目录> --voice <材料> [--format portrait\|landscape] [--title 标题]` | 建项目，导入时间表和配音 |
| `hj brief <目录>` | 口播逐句时间简报 |
| `hj check <目录> [--strict]` | 编译加质量检查。有错误时退出码为 1；`--strict` 时有警告也算失败 |
| `hj layout <目录> [--scene 场景]` | 布局线框：每个元素最后落在哪儿（坐标表、占用图、线框 PNG）。不画笔画，不需要用户确认，写分镜时随时跑 |
| `hj plan <目录>` | 生成文字分镜表 `storyboard.md` |
| `hj approve <目录> plan\|keyframes --by "<用户原话>"` | 记录用户确认 |
| `hj stills <目录> --draft [--scene 场景] [--guides]` | 草稿关键帧：半分辨率、带“草稿 · 未确认”水印，输出到 `out/draft/`。给写分镜的人自查用，不需要用户确认，也不解锁后面的步骤。`--guides` 画出画板边界（蓝色虚线）：元素坐标的原点在这个框的左上角，竖屏画板是 960×1250，横屏是 1700×800，框外是平台界面和字幕的地方。分镜有错误时不出图，目录里留着的是旧图 |
| `hj stills <目录> [--scene 场景] [--at 秒数或口播片段] [--guides]` | 正式关键帧（需先确认文字分镜）。`--guides` 画出画板边界 |
| `hj render <目录> [--scene 场景 \| --from 秒 --to 秒] [--draft] [--out 文件]` | 渲染。`--draft` 为半分辨率、15 帧 |
| `hj patterns [名字]` | 表现手法清单；带名字时打印参数、步骤和完整例子 |
| `hj assets doodles \| figure \| icons <关键词> \| colors \| sheet [--out 文件] [--dir 目录]` | 素材。`sheet --dir` 只画某个目录里的手绘件 |
| `hj import excalidraw\|svg\|quickdraw <文件> …` | 把外部手绘素材转成手绘件，见“从外部导入手绘件” |
| `hj fake-align <稿.txt> [--cps 4]` | 没有配音时造一份匀速时间表打草稿 |

## 检查器会拦什么

| 级别 | 情况 |
|---|---|
| 错误 | 锚点在口播里找不到；引用了不存在的元素；缺 `intent`；板书照抄口播 ≥7 字；元素整个在画板外；批注/标记比它的目标先出现（或目标从没画出来） |
| 警告：摆放 | 标记（圈、框、叉）压到了目标以外的东西；字被线穿过；被引擎挪了很远（超过 80px）；一排东西里被单独挪走一个；贴着画板边缘；东西摆在小人手的位置上而不是 `carry`；元素重叠（引擎没能自动挪开时）；画面太空；板面有一整条横带是空的；字号太小 |
| 警告：节奏 | 画得太赶（超过自然速度 2.5 倍）；一拍里赶着画一大群；一拍的动作拖过了下一拍；画面静止超过 4.2 秒；新板面空着超过 1.5 秒才落第一笔；连续 11 秒只有晃动、换姿势这类小动作；刚画完就被擦掉；小人走到一半原地消失；最后一个动作收在配音结束之后 |
| 警告：内容 | 纯文字场景；信息密度偏低（讲得久、东西少；一模一样的东西重复画只算一组）；板书太多；一块板上红字超过四处；弹出/淡入用得太多；卡点落在时间不可靠的字上；锚点有歧义 |
