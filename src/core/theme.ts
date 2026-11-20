import type { Box } from './strokes';

export interface Format { name: string; W: number; H: number; /** 画板：元素坐标系的原点与范围，已避开平台界面与字幕区 */ board: Box; subY: number; subSize: number; subMax: number }
export const FORMATS: Record<string, Format> = {
  portrait:  { name: 'portrait',  W: 1080, H: 1920, board: { x: 60, y: 210, w: 960, h: 1250 }, subY: 1590, subSize: 66, subMax: 13 },
  landscape: { name: 'landscape', W: 1920, H: 1080, board: { x: 110, y: 60, w: 1700, h: 800 }, subY: 968, subSize: 58, subMax: 24 },
};

/** 画风：ink 克制墨线（hj init 新建的项目用它）：墨色的线，一个朱砂红做强调，东西只淡淡上一层色；color 彩色：马克笔涂色、带阴影 */
export type StyleName = 'ink' | 'color';
const STYLES: Record<StyleName, { paper: string; ink: string; colors: Record<string, string>; pen: number; rough: number }> = {
  color: {
    paper: '#f8f5ed', ink: '#24211e',
    colors: { ink: '#24211e', red: '#d9433a', blue: '#2f6fb7', green: '#3c8f4f', yellow: '#f2b830', orange: '#e8792b', purple: '#7556c2', gray: '#8a8580', paper: '#f8f5ed' },
    pen: 7, rough: 0.9,
  },
  // 墨、朱砂，加几种压低了饱和度的颜色（黛、苍、赭）：要分类时还分得开，但不抢强调色
  ink: {
    paper: '#f7f4ee', ink: '#1f1d1b',
    colors: { ink: '#1f1d1b', red: '#c4402f', blue: '#3f5f7a', green: '#52705a', yellow: '#efc64f', orange: '#b56a3a', purple: '#6b5b86', gray: '#8c8781', paper: '#f7f4ee' },
    pen: 6.5, rough: 0.75,
  },
};
export const STYLE_NAMES = Object.keys(STYLES) as StyleName[];

export const THEME = {
  style: 'color' as StyleName,
  paper: STYLES.color.paper,
  ink: STYLES.color.ink,
  colors: { ...STYLES.color.colors } as Record<string, string>,
  pen: STYLES.color.pen,
  rough: STYLES.color.rough,
  textSize: 72,
  /** “自然”书写速度：用来估算每个动作本来要画多久 */
  pace: { px: 3000, penUp: 0.05, min: 0.18 },
};
/** 换画风：编译一个项目之前调用（画面在编译时生成，渲染时重新生成的活元素也照这个） */
export function setStyle(name: StyleName = 'color') {
  const s = STYLES[name] ?? STYLES.ink;
  THEME.style = STYLES[name] ? name : 'ink';
  THEME.paper = s.paper; THEME.ink = s.ink; THEME.pen = s.pen; THEME.rough = s.rough;
  for (const k of Object.keys(THEME.colors)) delete THEME.colors[k];
  Object.assign(THEME.colors, s.colors);
}
export const isInk = () => THEME.style === 'ink';
export const color = (c: string | undefined, fallback = THEME.ink): string => (c ? THEME.colors[c] ?? c : fallback);

/** 淡彩：把一个颜色压低饱和度、提亮，当作东西身上薄薄的一层底色 */
export function wash(c: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return c;
  const n = parseInt(m[1], 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0; const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  if (l > 0.93) return c; // 本来就是纸色、白色
  const S = Math.min(sat, 1) * 0.42, L = Math.max(0.78, Math.min(0.86, l + 0.32));
  const C = (1 - Math.abs(2 * L - 1)) * S, X = C * (1 - Math.abs(((h / 60) % 2) - 1)), M = L - C / 2;
  const [R, G, B] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  const hex = (v: number) => Math.round((v + M) * 255).toString(16).padStart(2, '0');
  return `#${hex(R)}${hex(G)}${hex(B)}`;
}
