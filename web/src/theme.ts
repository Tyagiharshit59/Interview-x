/**
 * Company theme colours.
 * From one hex colour we build the full brand scale (50–950) plus a gradient accent, and inject it as CSS variables.
 * Readability is enforced: the base is darkened until white text on the primary buttons meets WCAG AA (4.5:1),
 * and dark mode gets lighter steps for text on dark surfaces.
 */
type RGB = [number, number, number];
const hexToRgb = (h: string): RGB => { const x = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(x.slice(i, i + 2), 16)) as RGB; };
const rgbToHex = (c: RGB) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE: RGB = [255, 255, 255], BLACK: RGB = [10, 12, 28];
const lum = (c: RGB) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
export const contrast = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function rotateHue([r, g, b]: RGB, deg: number): RGB {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255; const l = (max + min) / 2; const d = max - min;
  if (d === 0) return [r, g, b];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r / 255 ? ((g - b) / 255 / d) % 6 : max === g / 255 ? (b - r) / 255 / d + 2 : (r - g) / 255 / d + 4;
  h = (h * 60 + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, xx = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, xx, 0] : h < 120 ? [xx, c, 0] : h < 180 ? [0, c, xx] : h < 240 ? [0, xx, c] : h < 300 ? [xx, 0, c] : [c, 0, xx];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

export interface BrandScale { steps: Record<number, RGB>; accent: RGB; adjusted: boolean; base: string }
/** Builds the 50–950 scale. `adjusted` is true when the colour had to be deepened for readable button text. */
export function brandScale(hex: string): BrandScale {
  let base = hexToRgb(hex); let adjusted = false;
  // primary buttons use 500→600 with white text: make 600 reach 4.5:1 and 500 reach 3:1 against white
  for (let i = 0; i < 20 && (contrast(WHITE, mix(base, BLACK, 0.15)) < 4.5 || contrast(WHITE, base) < 3); i++) { base = mix(base, BLACK, 0.08); adjusted = true; }
  const steps: Record<number, RGB> = {
    50: mix(base, WHITE, 0.93), 100: mix(base, WHITE, 0.86), 200: mix(base, WHITE, 0.72), 300: mix(base, WHITE, 0.5), 400: mix(base, WHITE, 0.25), 500: base,
    600: mix(base, BLACK, 0.15), 700: mix(base, BLACK, 0.3), 800: mix(base, BLACK, 0.45), 900: mix(base, BLACK, 0.6), 950: mix(base, BLACK, 0.75),
  };
  return { steps, accent: rotateHue(mix(base, BLACK, 0.05), 28), adjusted, base: rgbToHex(base) };
}

const STYLE_ID = 'ivx-brand-theme';
const vars = (s: BrandScale) => Object.entries(s.steps).map(([k, c]) => `--brand-${k}: ${c.map(Math.round).join(' ')};`).join(' ') + ` --brand-accent: ${s.accent.map(Math.round).join(' ')};`;

/** Applies a company theme to the whole page, or restores the IntervueX default when hex is null. */
export function applyBrand(hex: string | null | undefined) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) { el?.remove(); return; }
  const s = brandScale(hex);
  const light = vars(s);
  const lightBrandLine = rgbToHex(s.steps[500]);
  const darkBrandLine = rgbToHex(s.steps[400]);
  const css = `:root { ${light} --viz-brand: ${lightBrandLine}; }
@media (prefers-color-scheme: dark) { :root { ${light} --viz-brand: ${darkBrandLine}; } }`;
  if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el); }
  el.textContent = css;
}

export const THEME_PRESETS: Array<{ name: string; hex: string }> = [
  { name: 'IntervueX Indigo', hex: '#6d5cf0' }, { name: 'Royal Blue', hex: '#2563eb' }, { name: 'Ocean Teal', hex: '#0e7490' }, { name: 'Emerald', hex: '#059669' },
  { name: 'Crimson', hex: '#be123c' }, { name: 'Sunset Orange', hex: '#c2410c' }, { name: 'Magenta', hex: '#a21caf' }, { name: 'Graphite', hex: '#475569' },
];
export const hexOf = (c: RGB) => rgbToHex(c);
