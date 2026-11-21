import { useMemo, useRef, useState } from 'react';
import type { Note, Work } from '../types';
import { notifyToast } from './ui';
import './share-poster.css';

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
function layoutLines(raw: string, highlight: string, size: PosterSize, kind: Source['kind']): { lines: PosterLine[]; truncated: boolean } {
  const square = size === 'square';
  const fontSize = square ? 37 : kind === 'work' ? 43 : 39;
  const lineHeight = square ? 67 : kind === 'work' ? 88 : 80;
  const maxY = square ? 910 : 1450;
  const startY = square ? 516 : 725;
  const selected = plainText(highlight).replace(/\\s+/g, '').trim();
  const paragraphs = plainText(raw).split(/\\n+/).map(x => x.trim()).filter(Boolean);
  const result: PosterLine[] = [];
  let y = startY;
  let truncated = false;
  for (let i = 0; i < paragraphs.length; i++) {
    const lines = breakLines(paragraphs[i], square ? 23 : (kind === 'work' ? 21 : 24));
    for (let j = 0; j < lines.length; j++) {
      if (y > maxY) { truncated = true; break; }
      const line = lines[j];
      // Emphasize the original text in place. No duplicated quote or opaque banner.
      const compact = line.replace(/\\s+/g, '');
      result.push({ text: line, y, emphasized: !!selected && (compact.includes(selected) || (selected.length >= 5 && selected.includes(compact))) });
      y += lineHeight;
    }
    if (truncated) break;
    if (i < paragraphs.length - 1) y += square ? 28 : 48;
  }
  return { lines: result, truncated };
}

function PosterArt({ source, background, size, highlight, excerpt }: {
  source: Source; background: BackgroundId; size: PosterSize; highlight: string; excerpt: string;
}) {
  const p = BACKGROUNDS.find(b => b.id === background) ?? BACKGROUNDS[0];
  const square = size === 'square', height = square ? 1080 : 1920;
  const fontSize = square ? 37 : source.kind === 'work' ? 43 : 39;
  const layout = layoutLines(excerpt, highlight, size, source.kind);
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
      fill={p.ink} fontWeight="600" textLength={source.title.length > 19 ? 850 : undefined}
      lengthAdjust="spacingAndGlyphs">{source.title}</text>
    <text x="101" y={subtitleY} fontFamily={serif} fontSize="27" fill={p.soft}>
      {source.subtitle.slice(0, 36)}
    </text>
    <g fontFamily={serif} fontSize={fontSize}>
      {layout.lines.map((line, i) => <g key={i}>
        {line.emphasized ? <path d={`M87 ${line.y - fontSize + 6} v${fontSize + 13}`}
          stroke={p.accent} strokeWidth="5" strokeLinecap="round" /> : null}
        <text x={line.emphasized ? 108 : 100} y={line.y} fill={line.emphasized ? p.accent : p.ink}
          fontWeight={line.emphasized ? 600 : 400}>{line.text}</text>
      </g>)}
      {layout.truncated ? <text x="100" y={Math.min(square ? 987 : 1532, (layout.lines.at(-1)?.y || 720) + 78)}
        fill={p.soft} fontSize="29">……</text> : null}
    </g>
  </svg>;
}

async function exportPng(svg: SVGSVGElement, title: string) {
  // Inline the static background as a data URL before Canvas export.
  await document.fonts.ready;
  // Inline the same-origin backdrop before SVG → Canvas to avoid broken image exports.
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const bg = clone.querySelector('image');
  if (bg) {
    const href = bg.getAttribute('href');
    if (href) {
      const response = await fetch(href);
      if (!response.ok) throw new Error('背景图片尚未安装，请先复制 public/share-bg 素材');
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('读取背景失败'));
        reader.readAsDataURL(blob);
      });
      bg.setAttribute('href', dataUrl);
    }
  }
  const xml = new XMLSerializer().serializeToString(clone);
  // The app's CSP permits data: images but explicitly blocks blob: in img-src.
  // Embed the SVG in a data URL instead of creating an object URL for Image.src.
  const imageUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  {
    const image = new Image();
    image.src = imageUrl;
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
  }
}

export function SharePoster({ source, onClose }: Props) {
  const [background, setBackground] = useState<BackgroundId>('spring');
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
          <fieldset className="cj-share-backgrounds"><legend>选择背景</legend><div className="cj-share-background-grid">
            {BACKGROUNDS.map(item => <button key={item.id} type="button" className={background === item.id ? 'cj-share-bg-on' : ''}
              aria-pressed={background === item.id} onClick={() => setBackground(item.id)}>
              <img src={backgroundUrl(item.id)} alt="" loading="lazy" /><span>{item.name}</span>
            </button>)}
          </div></fieldset>
          <label>海报正文<textarea value={excerpt} rows={8} onChange={e=>setExcerpt(e.target.value)} placeholder="填写要分享到图片上的文字" /></label>
          <p className="cj-share-hint">当前 {count} 字。长文建议节选；超出画面的部分会以省略号提示，不会修改原文。</p>
          <label>重点句（可选）<input value={highlight} maxLength={70} onChange={e=>setHighlight(e.target.value)} placeholder="单独强调的一句" /></label>
          <button type="button" className="cn-btn cn-btn-primary" onClick={save} disabled={busy}>{busy ? '正在生成…' : '保存 PNG 图片'}</button>
          <p className="cj-share-hint">分享到朋友圈或抖音前，请先保存图片。本站不自动发布到第三方平台。</p>
        </div>
        <div className="cj-share-preview"><div ref={svgRef}><PosterArt source={source} background={background} size={size} highlight={highlight} excerpt={excerpt} /></div></div>
      </div>
    </section>
  </div>;
}
