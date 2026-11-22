import { useMemo, useRef, useState } from 'react';
import type { Note, Work } from '../types';
import { notifyToast } from './ui';
import '@fontsource/lxgw-wenkai/500.css';
import '@fontsource/lxgw-wenkai/700.css';
import './share-poster.css';

type PosterSize = 'portrait' | 'square';
type Source = { kind: 'work' | 'note'; title: string; subtitle: string; content: string; tags: string[] };
type Props = { source: Source; onClose: () => void };

const PALETTES = {
  mist: { paper: '#f8f2e8', ink: '#302e2a', soft: '#63746a', mountain: '#b7c2b9', accent: '#809582', wash: '#e1e6d9' },
  paper: { paper: '#f7eee0', ink: '#3b302a', soft: '#8a7260', mountain: '#d1bba6', accent: '#a27e60', wash: '#efe0cd' },
  night: { paper: '#243532', ink: '#f3e9d5', soft: '#becabd', mountain: '#536a64', accent: '#c7b58a', wash: '#455b54' },
};
const serif = '"LXGW WenKai","Noto Serif SC","Source Han Serif SC","Songti SC",serif';
const emphasisSerif = serif;

export function sourceFromWork(w: Work): Source {
  return {
    kind: 'work', title: w.title || '未命名词作',
    subtitle: [w.dynasty, w.author].filter(Boolean).join(' · '),
    content: w.content, tags: w.tags || [],
  };
}
export function sourceFromNote(n: Note, works: Work[]): Source {
  return {
    kind: 'note', title: n.title || '未命名札记',
    subtitle: works.length ? '读' + works.slice(0, 2).map(w => (w.author ? w.author + ' ' : '') + '《' + w.title + '》').join('、') : '阅读札记',
    content: n.content, tags: n.tags || [],
  };
}

/** Share text is plain text; never render user Markdown as arbitrary SVG/HTML. */
function plainText(s: string) {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/[*_`~]/g, '')
    .replace(/^\s*>\s?/gm, '').replace(/\r/g, '').trim();
}

/** CJK aware, approximate-width wrapping; export and preview use the same SVG. */
function breakLines(text: string, maxUnits: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    if (!paragraph.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    let line = '', width = 0;
    for (const ch of Array.from(paragraph.trim())) {
      const n = /[\u0000-\u00ff]/.test(ch) ? 0.55 : 1;
      if (width + n > maxUnits && line) { out.push(line); line = ''; width = 0; }
      line += ch; width += n;
    }
    if (line) out.push(line);
  }
  return out;
}
function filename(s: string) { return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 48) || '词间'; }


const BACKGROUNDS = [
  { id: 'spring', name: '春山亭影', ink: '#302e2a', soft: '#68766a', accent: '#809582' },
  { id: 'mountain', name: '远山春晓', ink: '#302e2a', soft: '#68766a', accent: '#809582' },
  { id: 'lake', name: '江南烟水', ink: '#302e2a', soft: '#68766a', accent: '#809582' },
  { id: 'plum', name: '梅岸归舟', ink: '#302e2a', soft: '#806c61', accent: '#a27e60' },
  { id: 'moon', name: '月夜青山', ink: '#f6eedf', soft: '#e1e4d8', accent: '#bcb99a' },
] as const;
type BackgroundId = typeof BACKGROUNDS[number]['id'];
const backgroundUrl = (id: BackgroundId) => '/share-bg/' + id + '.webp';


type PosterLine = { text: string; y: number; emphasized: boolean };
type PosterLayout = { pages: PosterLine[][]; fontSize: number; bottomY: number };
type TextPart = { text: string; paragraphStart: boolean; emphasized: boolean };
type LayoutConfig = { fontSize: number; lineHeight: number; paragraphGap: number; wrapUnits: number };

function layoutLines(raw: string, highlight: string, size: PosterSize, kind: Source['kind']): PosterLayout {
  const square = size === 'square';
  // Leave only a modest bottom safety margin. The backdrop already contains its own decoration.
  const startY = square ? 510 : 705;
  const bottomY = square ? 985 : 1770;
  const selected = plainText(highlight).replace(/\s+/g, '').trim();
  const configs: LayoutConfig[] = square
    ? [
        { fontSize: 37, lineHeight: 70, paragraphGap: 28, wrapUnits: 23 },
        { fontSize: 34, lineHeight: 61, paragraphGap: 20, wrapUnits: 25 },
        { fontSize: 31, lineHeight: 55, paragraphGap: 16, wrapUnits: 28 },
      ]
    : kind === 'work'
      ? [
          { fontSize: 43, lineHeight: 88, paragraphGap: 46, wrapUnits: 21 },
          { fontSize: 40, lineHeight: 79, paragraphGap: 34, wrapUnits: 23 },
          { fontSize: 37, lineHeight: 70, paragraphGap: 24, wrapUnits: 25 },
          { fontSize: 35, lineHeight: 65, paragraphGap: 18, wrapUnits: 27 },
        ]
      : [
          { fontSize: 39, lineHeight: 78, paragraphGap: 36, wrapUnits: 24 },
          { fontSize: 36, lineHeight: 69, paragraphGap: 26, wrapUnits: 26 },
          { fontSize: 33, lineHeight: 61, paragraphGap: 19, wrapUnits: 28 },
        ];
  const paragraphs = plainText(raw).split(/\n+/).map(s => s.trim()).filter(Boolean);
  const prepare = (cfg: LayoutConfig): TextPart[] => paragraphs.flatMap((paragraph, index) => {
    const lines = breakLines(paragraph, cfg.wrapUnits);
    return lines.map((line, i) => {
      const compact = line.replace(/\s+/g, '');
      return { text: line, paragraphStart: index > 0 && i === 0,
        emphasized: !!selected && (compact.includes(selected) ||
          (selected.length >= 5 && selected.includes(compact))) };
    });
  });
  const canFit = (parts: TextPart[], cfg: LayoutConfig) => {
    let y = startY;
    for (const part of parts) {
      if (part.paragraphStart) y += cfg.paragraphGap;
      if (y + (part.emphasized ? 7 : 0) > bottomY) return false;
      y += cfg.lineHeight;
    }
    return true;
  };
  const config = configs.find(cfg => canFit(prepare(cfg), cfg)) || configs[configs.length - 1];
  const parts = prepare(config);
  const pages: PosterLine[][] = [[]];
  let y = startY;
  for (const part of parts) {
    const extra = part.paragraphStart && pages[pages.length - 1].length > 0 ? config.paragraphGap : 0;
    if (y + extra + (part.emphasized ? 7 : 0) > bottomY && pages[pages.length - 1].length > 0) {
      pages.push([]);
      y = startY;
    } else {
      y += extra;
    }
    pages[pages.length - 1].push({ text: part.text, y, emphasized: part.emphasized });
    y += config.lineHeight;
  }
  // Visually balance short complete pages without consuming the safety margin.
  for (const page of pages) {
    if (!page.length) continue;
    const remaining = bottomY - page[page.length - 1].y;
    const shift = Math.min(square ? 50 : 115, Math.max(0, remaining * 0.3));
    for (const line of page) line.y += shift;
  }
  return { pages, fontSize: config.fontSize, bottomY };
}

function PosterArt({ source, background, size, layout, page }: {
  source: Source; background: BackgroundId; size: PosterSize; layout: PosterLayout; page: number;
}) {
  const p = BACKGROUNDS.find(b => b.id === background) ?? BACKGROUNDS[0];
  const square = size === 'square', height = square ? 1080 : 1920;
  const fontSize = layout.fontSize;
  const titleSize = source.title.length > 15 ? 48 : source.title.length > 10 ? 60 : 74;
  const labelY = square ? 310 : 410;
  const titleY = square ? 402 : 520;
  const subtitleY = square ? 465 : 598;
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 1080 ${height}`}
    width="1080" height={height} aria-label={source.title + '分享海报'} role="img">
    <image href={backgroundUrl(background)} x="0" y="0" width="1080" height={height}
      preserveAspectRatio={square ? 'xMidYMin slice' : 'none'} />
    {/* Logo and red seal are already printed in the curated background. */}
    <text x="100" y={labelY} fill={p.soft} fontFamily={serif} fontSize="29" letterSpacing="5">
      {source.kind === 'work' ? '词作' : '札记'}
    </text>
    <path d={`M224 ${labelY - 9} H348`} stroke={p.accent} strokeWidth="1.4" opacity=".65" />
    <text x="98" y={titleY} fontFamily={serif} fontSize={titleSize}
      fill={p.ink} fontWeight="500" textLength={source.title.length > 19 ? 850 : undefined}
      lengthAdjust="spacingAndGlyphs">{source.title}</text>
    <text x="101" y={subtitleY} fontFamily={serif} fontSize="27" fill={p.soft}>
      {source.subtitle.slice(0, 36)}
    </text>
    <g fontFamily={serif} fontSize={fontSize}>
      {(layout.pages[page] || []).map((line, i) => (
        <text key={i} x="100" y={line.y} fill={p.ink}
          fontFamily={line.emphasized ? emphasisSerif : serif}
          fontSize={line.emphasized ? fontSize + 6 : fontSize}
          fontWeight={line.emphasized ? 700 : 500}>
          {line.text}
        </text>
      ))}
      {layout.pages.length > 1 ? <text x="980" y={square ? 1015 : 1815}
        fill={p.soft} fontSize="25" textAnchor="end">{page + 1} / {layout.pages.length}</text> : null}
    </g>
  </svg>;
}

/**
 * Render directly to Canvas so the bundled Web Font also appears in the downloaded PNG.
 * SVG image rasterization does not reliably carry @font-face into a data: SVG document.
 */
async function exportPng(svg: SVGSVGElement, title: string) {
  const family = '"LXGW WenKai"';
  const textSample = svg.textContent || '词间诗词札记';
  await Promise.all([
    document.fonts.load('500 43px ' + family, textSample),
    document.fonts.load('700 49px ' + family, textSample),
  ]);
  await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = svg.viewBox.baseVal.width;
  canvas.height = svg.viewBox.baseVal.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持图片导出');

  // Same-origin image: no blob: image URL or cross-origin canvas taint.
  const bg = svg.querySelector('image');
  const href = bg?.getAttribute('href');
  if (!href) throw new Error('找不到背景图片');
  const image = new Image();
  image.src = href;
  await image.decode();
  const square = canvas.height === 1080;
  if (square) {
    // Match SVG preserveAspectRatio="xMidYMin slice" for 1080×1080 cards.
    const visibleHeight = image.naturalWidth === 0 ? 1080 :
      image.naturalWidth * canvas.height / canvas.width;
    ctx.drawImage(image, 0, 0, image.naturalWidth, Math.min(image.naturalHeight, visibleHeight),
      0, 0, canvas.width, canvas.height);
  } else {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }

  // All dynamic copy is drawn from the same SVG element coordinates.
  // This keeps live preview and export consistent without serializing font faces.
  for (const el of svg.querySelectorAll<SVGTextElement>('text')) {
    const style = getComputedStyle(el);
    const x = Number(el.getAttribute('x') || 0);
    const y = Number(el.getAttribute('y') || 0);
    const weight = el.getAttribute('font-weight') || style.fontWeight || '500';
    const size = Number(el.getAttribute('font-size') || 0) ||
      Number.parseFloat(style.fontSize) || 39;
    ctx.font = weight + ' ' + size + 'px ' + family;
    ctx.fillStyle = el.getAttribute('fill') || style.fill || '#302e2a';
    ctx.textAlign = el.getAttribute('text-anchor') === 'end' ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    const maxWidth = Number(el.getAttribute('textLength') || 0);
    if (maxWidth > 0) ctx.fillText(el.textContent || '', x, y, maxWidth);
    else ctx.fillText(el.textContent || '', x, y);
  }

  // Small section separator from the SVG artwork.
  const label = svg.querySelector('path');
  if (label) {
    const y = square ? 301 : 401;
    ctx.strokeStyle = '#809582';
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(224, y);
    ctx.lineTo(348, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG 图片生成失败');
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.download = '词间-' + filename(title) + '.png';
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

export function SharePoster({ source, onClose }: Props) {
  const [background, setBackground] = useState<BackgroundId>('spring');
  const [size, setSize] = useState<PosterSize>('portrait');
  const [excerpt, setExcerpt] = useState(source.content);
  const [highlight, setHighlight] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const svgRef = useRef<HTMLDivElement>(null);
  const count = useMemo(() => plainText(excerpt).length, [excerpt]);
  const layout = useMemo(() => layoutLines(excerpt, highlight, size, source.kind), [excerpt, highlight, size, source.kind]);
  const currentPage = Math.min(page, layout.pages.length - 1);
  async function save() {
    const svg = svgRef.current?.querySelector('svg');
    if (!svg || busy) return;
    setBusy(true);
    try { await exportPng(svg, layout.pages.length > 1 ? source.title + '-第' + (currentPage + 1) + '页' : source.title); notifyToast('图片已导出'); }
    catch (e) { notifyToast(e instanceof Error ? e.message : '图片导出失败'); }
    finally { setBusy(false); }
  }
  return <div className="cj-share-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="cj-share-dialog" role="dialog" aria-modal="true" aria-label="制作分享图片">
      <div className="cj-share-heading">
        <div><h2>制作分享图片</h2><p>文字与排版由浏览器生成，所见即所得</p></div>
        <button type="button" onClick={onClose} aria-label="关闭分享预览">×</button>
      </div>
      <div className="cj-share-layout">
        <div className="cj-share-controls">
          <label>画面比例<select value={size} onChange={e=>setSize(e.target.value as PosterSize)}><option value="portrait">竖版 · 9:16</option><option value="square">方形 · 1:1</option></select></label>
          <fieldset className="cj-share-backgrounds"><legend>选择背景</legend><div className="cj-share-background-grid">
            {BACKGROUNDS.map(item => <button key={item.id} type="button" className={background === item.id ? 'cj-share-bg-on' : ''}
              aria-pressed={background === item.id} onClick={() => setBackground(item.id)}>
              <img src={backgroundUrl(item.id)} alt="" loading="lazy" /><span>{item.name}</span>
            </button>)}
          </div></fieldset>
          <label>海报正文<textarea value={excerpt} rows={8} onChange={e=>setExcerpt(e.target.value)} placeholder="填写要分享到图片上的文字" /></label>
          <p className="cj-share-hint">当前 {count} 字，自动选择适合的字号与行距。较长内容自动分页，正文不会被截断。</p>
          <label>重点句（可选）<input value={highlight} maxLength={70} onChange={e=>setHighlight(e.target.value)} placeholder="单独强调的一句" /></label>
          {layout.pages.length > 1 ? <div className="cj-share-pager">
            <button type="button" disabled={currentPage === 0} onClick={() => setPage(Math.max(0, currentPage - 1))}>上一页</button>
            <span>第 {currentPage + 1} / {layout.pages.length} 页</span>
            <button type="button" disabled={currentPage === layout.pages.length - 1} onClick={() => setPage(Math.min(layout.pages.length - 1, currentPage + 1))}>下一页</button>
          </div> : null}
          <button type="button" className="cn-btn cn-btn-primary" onClick={save} disabled={busy}>{busy ? '正在生成…' : layout.pages.length > 1 ? '保存当前页 PNG' : '保存 PNG 图片'}</button>
          <p className="cj-share-hint">分享到朋友圈或抖音前，请先保存图片。本站不自动发布到第三方平台。</p>
        </div>
        <div className="cj-share-preview"><div ref={svgRef}><PosterArt source={source} background={background} size={size} layout={layout} page={currentPage} /></div></div>
      </div>
    </section>
  </div>;
}
