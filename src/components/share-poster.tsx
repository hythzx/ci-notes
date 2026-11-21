import { useMemo, useRef, useState } from 'react';
import type { Note, Work } from '../types';
import { notifyToast } from './ui';
import './share-poster.css';

type PosterTheme = 'mist' | 'paper' | 'night';
type PosterSize = 'portrait' | 'square';
type Source = { kind: 'work' | 'note'; title: string; subtitle: string; content: string; tags: string[] };
type Props = { source: Source; onClose: () => void };

const PALETTES = {
  mist: { paper: '#f8f2e8', ink: '#302e2a', soft: '#63746a', mountain: '#b7c2b9', accent: '#809582', wash: '#e1e6d9' },
  paper: { paper: '#f7eee0', ink: '#3b302a', soft: '#8a7260', mountain: '#d1bba6', accent: '#a27e60', wash: '#efe0cd' },
  night: { paper: '#243532', ink: '#f3e9d5', soft: '#becabd', mountain: '#536a64', accent: '#c7b58a', wash: '#455b54' },
};
const serif = '"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",serif';

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

function Blossom({ x, y, scale = 1, dark = false }: { x: number; y: number; scale?: number; dark?: boolean }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`} opacity={dark ? .5 : .83}>
    {[0, 72, 144, 216, 288].map(a => <ellipse key={a} cx="0" cy="-12" rx="8" ry="15" transform={`rotate(${a})`} fill={dark ? '#b0b9aa' : '#fff8eb'} stroke="#9eaa94" strokeWidth="1.2" />)}
    <circle r="5" fill="#cfb17c" />
  </g>;
}

function PosterArt({ source, theme, size, highlight, excerpt }: {
  source: Source; theme: PosterTheme; size: PosterSize; highlight: string; excerpt: string;
}) {
  const p = PALETTES[theme], square = size === 'square', height = square ? 1080 : 1920;
  const maxLines = square ? 6 : (source.kind === 'work' ? 10 : 11);
  const fontSize = square ? 38 : source.kind === 'work' ? 44 : 38;
  const lineHeight = square ? 63 : source.kind === 'work' ? 85 : 69;
  const lines = breakLines(plainText(excerpt), square ? 24 : source.kind === 'work' ? 22 : 26);
  const shown = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;
  const titleSize = source.title.length > 15 ? 56 : source.title.length > 9 ? 65 : 84;
  const contentStart = square ? 415 : 540;
  const maxY = square ? 815 : 1390;
  const emphasis = highlight.trim().slice(0, 70);
  const showEmphasis = !!emphasis;
  const contentBottom = Math.min(maxY, contentStart + shown.length * lineHeight);
  const emphasisY = Math.min(maxY + 65, contentBottom + (square ? 38 : 70));
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 1080 ${height}`} width="1080" height={height} role="img" aria-label={source.title + '分享海报'}>
      <defs>
        <linearGradient id="cj-share-fog" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor={p.paper} stopOpacity="0" /><stop offset=".95" stopColor={p.wash} stopOpacity=".87" />
        </linearGradient>
        <pattern id="cj-share-grain" width="75" height="75" patternUnits="userSpaceOnUse">
          <circle cx="12" cy="8" r=".8" fill={p.ink} opacity=".085" />
          <circle cx="42" cy="57" r=".65" fill={p.ink} opacity=".07" />
          <circle cx="68" cy="26" r=".8" fill={p.ink} opacity=".06" />
        </pattern>
      </defs>
      <rect width="1080" height={height} fill={p.paper} />
      <rect width="1080" height={height} fill="url(#cj-share-grain)" />
      <circle cx="750" cy="265" r="146" fill={p.wash} opacity=".42" />
      <g opacity=".45" stroke={p.soft} strokeWidth="5" fill="none">
        <path d="M1078 15 C940 45 887 98 836 148 S740 192 670 235" />
        <path d="M958 64 Q1015 119 1060 175" />
        <path d="M849 137 Q841 80 808 43" />
        <path d="M746 190 Q726 145 693 133" />
      </g>
      <g fill={p.soft} opacity=".40">
        <ellipse cx="874" cy="97" rx="26" ry="10" transform="rotate(-37 874 97)"/>
        <ellipse cx="931" cy="97" rx="28" ry="9" transform="rotate(28 931 97)"/>
        <ellipse cx="772" cy="177" rx="23" ry="9" transform="rotate(-28 772 177)"/>
      </g>
      <Blossom x={956} y={59} scale={1.3} dark={theme === 'night'} />
      <Blossom x={854} y={134} scale={.95} dark={theme === 'night'} />
      <Blossom x={1017} y={167} scale={1.13} dark={theme === 'night'} />
      <Blossom x={718} y={219} scale={.75} dark={theme === 'night'} />

      {/* Brand intentionally only in header. No promotional footer. */}
      <rect x="76" y="75" width="76" height="76" rx="16" fill={p.accent} opacity=".86" />
      <path d="M94 115 Q114 92 134 115 M90 116 H138 M99 121 V139 M129 121 V139 M97 140 H132" fill="none" stroke={p.paper} strokeWidth="3" strokeLinecap="round"/>
      <text x="176" y="121" fontFamily={serif} fontSize="45" fill={p.ink} letterSpacing="6">词间</text>
      <text x="178" y="152" fontFamily={serif} fontSize="18" fill={p.soft} letterSpacing="7">诗词与札记</text>

      <rect x="78" y="247" width="119" height="46" rx="21" fill="none" stroke={p.accent} strokeWidth="2" />
      <text x="137" y="278" textAnchor="middle" fill={p.soft} fontSize="24" letterSpacing="4" fontFamily={serif}>{source.kind === 'work' ? '词作' : '札记'}</text>
      <path d="M235 270 H407" stroke={p.accent} opacity=".48" strokeWidth="1.5"/>
      <text x="76" y="387" fill={p.ink} fontSize={titleSize} fontFamily={serif} fontWeight="600" textLength={source.title.length > 16 ? 930 : undefined} lengthAdjust="spacingAndGlyphs">{source.title}</text>
      <rect x="970" y="338" width="30" height="47" rx="3" fill="none" stroke="#a65f4b" strokeWidth="2"/>
      <text x="984" y="358" fill="#a65f4b" fontSize="14" textAnchor="middle">词</text><text x="984" y="376" fill="#a65f4b" fontSize="14" textAnchor="middle">间</text>
      <text x="80" y="453" fill={p.soft} fontSize="26" fontFamily={serif}>{source.subtitle.slice(0, 55)}</text>

      <g fill={p.ink} fontSize={fontSize} fontFamily={serif}>
        {shown.map((line, i) => line ? <text x="80" y={contentStart + i * lineHeight} key={i}>{line}</text> : null)}
        {truncated && <text x="80" y={contentStart + shown.length * lineHeight} fontSize="30" fill={p.soft}>……</text>}
      </g>
      {showEmphasis && emphasisY < height - 210 && <>
        <rect x="59" y={emphasisY - 44} width="962" height="66" rx="22" fill={p.accent} opacity=".18" />
        <text x="85" y={emphasisY + 3} fontFamily={serif} fontSize={emphasis.length > 23 ? 29 : 39} fill={p.ink}>{emphasis}</text>
      </>}
      {source.tags.length > 0 && <g transform={`translate(78 ${height - (square ? 163 : 347)})`}>
        {source.tags.slice(0, 3).map((tag, i) => <g key={i} transform={`translate(${i * 160} 0)`}>
          <rect width="142" height="44" rx="22" stroke={p.accent} strokeWidth="1.5" fill={p.paper} fillOpacity=".55" />
          <text x="71" y="29" textAnchor="middle" fontSize="22" fill={p.soft} fontFamily={serif}>{tag.slice(0, 6)}</text>
        </g>)}
      </g>}

      <g opacity=".53" pointerEvents="none">
        <path d={`M0 ${height - 220} Q180 ${height - 430} 340 ${height - 275} Q490 ${height - 460} 625 ${height - 290} Q820 ${height - 510} 1080 ${height - 285} L1080 ${height} H0 Z`} fill={p.mountain}/>
        <path d={`M0 ${height - 135} Q220 ${height - 325} 440 ${height - 168} Q645 ${height - 302} 790 ${height - 158} Q940 ${height - 295} 1080 ${height - 157} L1080 ${height} H0 Z`} fill={p.wash}/>
        <rect y={height - 290} width="1080" height="290" fill="url(#cj-share-fog)" />
      </g>
      <g transform={`translate(820 ${height - 274})`} opacity=".44" stroke={p.soft} fill="none" strokeWidth="5">
        <path d="M0 66 Q95 -14 200 66 M13 69 H213 M40 74 V205 M181 74 V205 M28 151 H198 M28 211 H198"/>
        <path d="M13 210 H211 M60 95 H166 M60 122 H166"/>
      </g>
    </svg>
  );
}

async function exportPng(svg: SVGSVGElement, title: string) {
  // Data URL avoids external assets; all decorations are native vectors.
  await document.fonts.ready;
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = svg.viewBox.baseVal.width;
    canvas.height = svg.viewBox.baseVal.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持图片导出');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('图片生成失败');
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `词间-${filename(title)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000);
    return blob;
  } finally { URL.revokeObjectURL(url); }
}

export function SharePoster({ source, onClose }: Props) {
  const [theme, setTheme] = useState<PosterTheme>('mist');
  const [size, setSize] = useState<PosterSize>('portrait');
  const [excerpt, setExcerpt] = useState(source.content);
  const [highlight, setHighlight] = useState('');
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<HTMLDivElement>(null);
  const count = useMemo(() => plainText(excerpt).length, [excerpt]);
  async function save() {
    const svg = svgRef.current?.querySelector('svg');
    if (!svg || busy) return;
    setBusy(true);
    try { await exportPng(svg, source.title); notifyToast('图片已导出'); }
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
          <label>纸张风格<select value={theme} onChange={e=>setTheme(e.target.value as PosterTheme)}><option value="mist">青绿水墨</option><option value="paper">暖纸素笺</option><option value="night">夜色墨绿</option></select></label>
          <label>海报正文<textarea value={excerpt} rows={8} onChange={e=>setExcerpt(e.target.value)} placeholder="填写要分享到图片上的文字" /></label>
          <p className="cj-share-hint">当前 {count} 字。长文建议节选；超出画面的部分会以省略号提示，不会修改原文。</p>
          <label>重点句（可选）<input value={highlight} maxLength={70} onChange={e=>setHighlight(e.target.value)} placeholder="单独强调的一句" /></label>
          <button type="button" className="cn-btn cn-btn-primary" onClick={save} disabled={busy}>{busy ? '正在生成…' : '保存 PNG 图片'}</button>
          <p className="cj-share-hint">分享到朋友圈或抖音前，请先保存图片。本站不自动发布到第三方平台。</p>
        </div>
        <div className="cj-share-preview"><div ref={svgRef}><PosterArt source={source} theme={theme} size={size} highlight={highlight} excerpt={excerpt} /></div></div>
      </div>
    </section>
  </div>;
}
