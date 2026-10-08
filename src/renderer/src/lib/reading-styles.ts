/**
 * 阅读皮肤 —— 移植自 ThirdC「62 款设计风格」的邮件阅读精选子集（参数化元组方案）
 * 元组：[id, 名称, bg, fg, accent, 字体栈, 标题处理, 附加CSS]
 * 编译为样式表后注入阅读窗正文的 Shadow DOM（:host 作用域），只影响邮件内容不影响应用外壳。
 * 选择持久化在 localStorage（ms_reader_style），一次选择全局记住。
 */

export type ReadingStyleTuple = [string, string, string, string, string, string, string, string]

const F = {
  serif: 'Georgia,"Times New Roman","Songti SC",serif',
  sans: '"Helvetica Neue",Arial,"PingFang SC",sans-serif',
  mono: '"SF Mono","Courier New",monospace',
  disp: 'Futura,"Century Gothic","PingFang SC",sans-serif',
  round: '"Trebuchet MS","PingFang SC",sans-serif'
}

export const READING_STYLES: ReadingStyleTuple[] = [
  ['openflow', 'OpenFlow 玻璃', 'oklch(17% .022 262)', 'oklch(91% .012 262)', 'oklch(72% .14 255)', '"Inter","SF Pro Display","PingFang SC",sans-serif', 'none',
    'body{background-image:radial-gradient(38% 32% at 18% 12%,oklch(45% .12 265/.5),transparent 70%),radial-gradient(34% 30% at 82% 8%,oklch(50% .14 300/.38),transparent 70%),radial-gradient(40% 34% at 60% 92%,oklch(50% .1 200/.32),transparent 72%)}'
    + 'h1{font-weight:700;letter-spacing:-.02em;position:relative;padding-bottom:14px!important}'
    + 'h1::after{content:"";position:absolute;left:0;bottom:0;width:120px;height:3px;border-radius:2px;background:linear-gradient(90deg,oklch(72% .14 255),oklch(65% .18 300))}'
    + 'h2{font-weight:600;background:linear-gradient(90deg,oklch(72% .14 255/.16),oklch(72% .14 255/.02));border-left:3px solid oklch(72% .14 255);border-radius:0 12px 12px 0;padding:9px 16px!important}'
    + 'strong{font-weight:650;color:oklch(83% .1 255)}'
    + 'em{font-style:normal;color:oklch(80% .09 300)}'
    + 'blockquote{background:oklch(30% .03 262/.55);border:1px solid oklch(70% .02 262/.18);border-left:3px solid oklch(72% .14 255);border-radius:0 14px 14px 0}'
    + 'table{border:1px solid oklch(70% .02 262/.16);border-radius:12px;overflow:hidden}table th{background:oklch(30% .03 262/.75);font-weight:600}'
    + 'code{background:oklch(30% .03 262/.7);color:oklch(82% .1 200);border-radius:6px;padding:1px 6px}'
    + 'pre{background:oklch(22% .025 262/.8);border:1px solid oklch(70% .02 262/.14);border-radius:12px}'
    + 'a{color:oklch(78% .12 255);text-decoration:none;border-bottom:1px dashed oklch(78% .12 255/.5)}'
    + 'li::marker{color:oklch(72% .14 255)}'
    + '::selection{background:oklch(72% .14 255/.4)}'
    + 'hr{border:none;height:1px;background:linear-gradient(90deg,transparent,oklch(72% .14 255/.5),transparent)}'],
  ['swiss', '瑞士国际主义 Swiss', '#ffffff', '#111111', '#e30613', F.sans, 'none',
    'body{line-height:1.7}'
    + 'h1{font-size:2.6em!important;font-weight:800;letter-spacing:-.02em}'
    + 'h2{font-weight:700;border-top:2px solid #111;padding-top:.4em!important}'
    + 'h2::before{content:"■ ";color:#e30613;font-size:.55em;vertical-align:.2em}'
    + 'strong{font-weight:700}'
    + 'em{font-style:normal;color:#e30613}'
    + 'blockquote{background:#f2f2f2;border-left:4px solid #111}'
    + 'table th{font-weight:700;text-align:left;border-bottom:2px solid #111}table td{font-weight:300;border-bottom:1px solid #ddd}'
    + 'code,pre{background:#f2f2f2;border-radius:0}'
    + 'a{color:#111;text-decoration:none;border-bottom:2px solid #e30613}'
    + 'li::marker{color:#e30613}'
    + '::selection{background:#e30613;color:#fff}'
    + 'hr{border:none;height:2px;background:#111}'],
  ['bauhaus', '包豪斯 Bauhaus', '#f6f2e8', '#141414', '#d0021b', F.sans, 'uppercase',
    'h1{border-bottom:4px solid #d0021b}'
    + 'h2{font-weight:700;letter-spacing:.04em;border-left:10px solid;border-image:linear-gradient(180deg,#d0021b 33%,#1450c8 33%,#1450c8 66%,#f9c606 66%) 1;padding-left:10px!important}'
    + 'strong{font-weight:700;color:#d0021b}'
    + 'em{font-style:normal;background:#1450c8;color:#fff;padding:0 .25em}'
    + 'blockquote{border-left:6px solid #1450c8;background:#fff}'
    + 'table{border:3px solid #141414}table th{background:#141414;color:#f6f2e8;letter-spacing:.06em}table td{border-bottom:1px solid #d8d2c4}'
    + 'code,pre{background:#eae4d4;border-radius:0}'
    + 'a{color:#1450c8;text-decoration:none;border-bottom:2px solid #f9c606}'
    + 'li::marker{color:#d0021b}'
    + '::selection{background:#d0021b;color:#fff}'
    + 'hr{border:none;height:4px;background:linear-gradient(90deg,#d0021b 33%,#1450c8 33%,#1450c8 66%,#f9c606 66%)}'],
  ['midcentury', '中古现代 Mid-Century', '#f3ead7', '#2b2b28', '#e07a3f', F.disp, 'none',
    'h1,h2{color:#e07a3f}'
    + 'h2{display:inline-block;border-bottom:3px dotted #e07a3c;padding-bottom:2px!important}'
    + 'strong{font-weight:700;color:#b85c2a}'
    + 'em{font-style:italic;color:#5f7d75}'
    + 'blockquote{background:#eadfc3;border-radius:14px;border:none;padding:14px 18px!important}'
    + 'table{border:2px solid #2b2b28;border-radius:10px;overflow:hidden}table th{background:#eadfc3;color:#2b2b28}table td{border-bottom:1px solid #ddcfae}'
    + 'code,pre{background:#eadfc3;border-radius:8px}'
    + 'a{color:#b85c2a;text-decoration:none;border-bottom:2px dotted #e07a3f}'
    + 'li::marker{color:#e07a3f}'
    + '::selection{background:#f0c9a8;color:#2b2b28}'
    + 'hr{border:none;height:3px;background:#2b2b28}'],
  ['scandi', '北欧简约 Scandinavian', '#fafaf8', '#22252a', '#5b8770', F.sans, 'none',
    'body{line-height:1.9}'
    + 'h1,h2{font-weight:600;color:#3d4a45}'
    + 'h2{border-bottom:1px solid #d9dee0;padding-bottom:4px!important}'
    + 'strong{font-weight:700;color:#3d4a45}'
    + 'em{font-style:italic;color:#5b8770}'
    + 'blockquote{background:#f0f4f2;border-left:3px solid #5b8770}'
    + 'table{border:1px solid #d9dee0;border-radius:8px;overflow:hidden}table th{background:#f0f4f2;color:#3d4a45}table td{border-bottom:1px solid #e8ecee}'
    + 'code,pre{background:#f0f4f2;border-radius:6px}'
    + 'a{color:#3d4a45;text-decoration:none;border-bottom:1px solid #5b8770}'
    + 'li::marker{color:#5b8770}'
    + '::selection{background:#cfe0d8;color:#22252a}'
    + 'hr{border:none;height:1px;background:#d9dee0}'],
  ['japandi', 'Japandi 和风北欧', '#f7f5f0', '#2d2a26', '#a3563d', '"Hiragino Mincho ProN","Songti SC",serif', 'none',
    'h1,h2{font-weight:500;letter-spacing:.12em}'
    + 'h2{border-left:2px solid #a3563d;padding-left:.6em!important}'
    + 'strong{font-weight:700;color:#a3563d}'
    + 'em{font-style:normal;color:#5a544c;background:linear-gradient(to bottom,transparent 78%,rgba(163,86,61,.2) 78%)}'
    + 'blockquote{border-left:2px solid #a3563d;background:transparent;font-style:normal;color:#5a544c}'
    + 'table{border-top:2px solid #2d2a26;border-bottom:1px solid #c9c2b5}table th{color:#5a544c;letter-spacing:.1em;border-bottom:1px solid #c9c2b5}table td{border-bottom:1px solid #eae5da}'
    + 'code,pre{background:#efece4;border-radius:0}'
    + 'a{color:#2d2a26;text-decoration:none;border-bottom:1px solid #a3563d}'
    + 'li::marker{color:#a3563d}'
    + '::selection{background:#e3cfc5;color:#2d2a26}'
    + 'hr{border:none;height:1px;background:#c9c2b5}'],
  ['wabisabi', '侘寂 Wabi-Sabi', '#efeae2', '#4a453d', '#7d7461', F.serif, 'none',
    'h1{font-weight:400}'
    + 'h2{font-weight:400;color:#6b6355;display:inline-block;background:linear-gradient(to bottom,transparent 82%,rgba(125,116,97,.22) 82%)}'
    + 'strong{font-weight:700;color:#4a453d}'
    + 'em{font-style:italic;color:#7d7461}'
    + 'blockquote{border:none;background:#e5ddd0;color:#6b6355;border-radius:2px 18px 2px 18px}'
    + 'table{border:1px solid #d5cdbb}table th{background:#e5ddd0;color:#5a544c;font-weight:400}table td{border-bottom:1px solid #ddd5c2}'
    + 'code,pre{background:#e5ddd0;border-radius:2px 12px 2px 12px}'
    + 'a{color:#5a544c;text-decoration:none;border-bottom:1px dotted #7d7461}'
    + 'li::marker{color:#7d7461}'
    + '::selection{background:#d5cdbb;color:#4a453d}'
    + 'hr{border:none;height:10px;background:radial-gradient(ellipse at center,#cfc4ae,transparent 70%)}'],
  ['minimal', '极简主义 Minimal', '#ffffff', '#1a1a1a', '#1a1a1a', F.sans, 'none',
    'body{line-height:1.85;letter-spacing:.01em}'
    + 'h1,h2{font-weight:300}'
    + 'h2{color:#6b6b6b}'
    + 'strong{font-weight:600}'
    + 'em{font-style:italic;color:#1a1a1a;background:linear-gradient(to bottom,transparent 80%,rgba(26,26,26,.12) 80%)}'
    + 'blockquote{border-left:1px solid #1a1a1a;padding-left:14px!important;color:#555}'
    + 'table th{font-weight:500;text-align:left;border-bottom:1px solid #1a1a1a}table td{font-weight:300;border-bottom:1px solid #eee}'
    + 'code,pre{background:#f6f6f6;border-radius:0}'
    + 'a{color:#1a1a1a;text-decoration:underline;text-underline-offset:3px}'
    + 'li::marker{color:#999}'
    + '::selection{background:#1a1a1a;color:#fff}'
    + 'hr{border:none;height:1px;background:#e5e5e5}'],
  ['artdeco', '装饰艺术 Art Deco', '#1a1a24', '#e8d9b5', '#c9a227', '"Didot","Bodoni MT","Songti SC",serif', 'uppercase',
    'h1,h2{letter-spacing:.18em;border-bottom:3px double #c9a227}'
    + 'body{background-image:repeating-linear-gradient(45deg,transparent,transparent 18px,rgba(201,162,39,.06) 18px,rgba(201,162,39,.06) 36px)}'
    + 'h2::before{content:"◆ ";color:#c9a227;font-size:.75em}'
    + 'strong{font-weight:700;color:#c9a227}'
    + 'em{font-style:italic;color:#e8d9b5;background:rgba(201,162,39,.14);padding:0 .2em}'
    + 'blockquote{border:1px solid #c9a227;outline:1px solid #c9a227;outline-offset:3px;background:rgba(201,162,39,.07);text-align:center;padding:16px 22px!important}'
    + 'table{border:3px double #c9a227}table th{color:#c9a227;letter-spacing:.14em;border-bottom:1px solid #c9a227}table td{border-bottom:1px solid rgba(201,162,39,.25)}'
    + 'code,pre{background:rgba(201,162,39,.1);border:1px solid rgba(201,162,39,.3);border-radius:0}'
    + 'a{color:#c9a227;text-decoration:none;border-bottom:1px solid #c9a227}'
    + 'li::marker{color:#c9a227}'
    + '::selection{background:#c9a227;color:#1a1a24}'
    + 'hr{border:none;height:2px;background:linear-gradient(90deg,transparent,#c9a227,transparent)}'],
  ['brutalism', '粗野主义 Brutalism', '#c7c3bb', '#111111', '#111111', F.mono, 'uppercase',
    'h1{border:4px solid #111;padding:10px!important;background:#111;color:#fff}'
    + 'h2{border:4px solid #111;padding:6px 10px!important;background:transparent}'
    + 'strong{font-weight:700;background:#111;color:#c7c3bb;padding:0 .25em}'
    + 'em{font-style:normal;text-decoration:underline;text-decoration-thickness:3px}'
    + 'blockquote{border:4px solid #111;background:#c7c3bb}'
    + 'table{border:4px solid #111}table th{background:#111;color:#c7c3bb;border-bottom:4px solid #111}table td{border:2px solid #111}'
    + 'code,pre{border:3px solid #111;background:#bdb8ad;border-radius:0}'
    + 'a{color:#111;text-decoration:none;border-bottom:4px solid #111}'
    + 'li::marker{color:#111}'
    + '::selection{background:#111;color:#c7c3bb}'
    + 'hr{border:none;border-top:6px solid #111}'],
  ['y2k', '千禧 Y2K', '#eef4ff', '#1b1b3a', '#7b5cff', F.round, 'none',
    'h1,h2{background:linear-gradient(90deg,#7b5cff,#00c2ff);-webkit-background-clip:text;background-clip:text;color:transparent}'
    + 'h2{display:inline-block}'
    + 'strong{font-weight:800;color:#7b5cff}'
    + 'em{font-style:normal;background:linear-gradient(90deg,#7b5cff,#00c2ff);-webkit-background-clip:text;background-clip:text;color:transparent}'
    + 'blockquote{border:1px solid #b9c8ff;background:linear-gradient(135deg,#fff,#e4ecff);border-radius:16px;box-shadow:0 4px 14px rgba(123,92,255,.15)}'
    + 'table{border:1px solid #b9c8ff;border-radius:14px;overflow:hidden;background:#fff}table th{background:linear-gradient(90deg,rgba(123,92,255,.15),rgba(0,194,255,.15))}table td{border-bottom:1px solid #e4ecff}'
    + 'code,pre{background:#fff;border:1px solid #b9c8ff;border-radius:10px}'
    + 'a{color:#7b5cff;text-decoration:none;border-bottom:2px dotted #00c2ff}'
    + 'li::marker{color:#7b5cff}'
    + '::selection{background:#7b5cff;color:#fff}'
    + 'hr{border:none;height:3px;border-radius:2px;background:linear-gradient(90deg,#7b5cff,#00c2ff,transparent)}'],
  ['vaporwave', '蒸汽波 Vaporwave', '#0f0f2d', '#e8e0f0', '#ff71ce', F.disp, 'none',
    'body{background-image:linear-gradient(180deg,#0f0f2d 60%,#3d2352 85%,#ff71ce 140%)}'
    + 'h1,h2{color:#01cdfe;text-shadow:3px 3px 0 #ff71ce}'
    + 'h2{display:inline-block;border:1px solid #ff71ce;padding:4px 12px!important;background:rgba(255,113,206,.08)}'
    + 'strong{font-weight:700;color:#ff71ce;text-shadow:0 0 12px rgba(255,113,206,.7)}'
    + 'em{font-style:italic;color:#05ffa1}'
    + 'blockquote{border:1px solid #ff71ce;background:rgba(1,205,254,.08)}'
    + 'table{border:1px solid #01cdfe;background:rgba(15,15,45,.7)}table th{background:rgba(1,205,254,.15);color:#01cdfe}table td{border-bottom:1px solid rgba(255,113,206,.35)}'
    + 'code,pre{background:rgba(1,205,254,.08);border:1px solid #01cdfe}'
    + 'a{color:#05ffa1;text-decoration:none;border-bottom:1px solid #05ffa1}'
    + 'li::marker{color:#ff71ce}'
    + '::selection{background:#ff71ce;color:#0f0f2d}'
    + 'hr{border:none;height:2px;background:linear-gradient(90deg,transparent,#01cdfe,#ff71ce,transparent)}'],
  ['cyberpunk', '赛博朋克 Cyberpunk', '#0a0e17', '#d1f7ff', '#00f0ff', F.mono, 'uppercase',
    'body{background-image:repeating-linear-gradient(0deg,rgba(0,240,255,.03) 0 2px,transparent 2px 4px)}'
    + 'h1,h2{color:#00f0ff;text-shadow:0 0 12px #00f0ff;border-bottom:1px solid #ff2a6d}'
    + 'h2::before{content:"▸ ";color:#ff2a6d}'
    + 'strong{font-weight:700;color:#ff2a6d}'
    + 'em{font-style:normal;color:#05ffa1}'
    + 'blockquote{border-left:3px solid #ff2a6d;background:rgba(255,42,109,.08)}'
    + 'table{border:1px solid rgba(0,240,255,.4)}table th{background:rgba(0,240,255,.1);color:#00f0ff;border-bottom:1px solid #ff2a6d}table td{border-bottom:1px solid rgba(0,240,255,.2)}'
    + 'code,pre{background:#0d1420;border:1px solid rgba(0,240,255,.35);color:#05ffa1}'
    + 'a{color:#05ffa1;text-decoration:none;border-bottom:1px solid #05ffa1}'
    + 'li::marker{color:#ff2a6d}'
    + '::selection{background:#00f0ff;color:#0a0e17}'
    + 'hr{border:none;height:2px;background:linear-gradient(90deg,#00f0ff,#ff2a6d,transparent)}'],
  ['terminal', '终端 Terminal', '#0c0c0c', '#33ff66', '#33ff66', '"SF Mono","Courier New",monospace', 'none',
    'body{line-height:1.7}'
    + 'h1:before{content:"$ ";color:#e5e5e5}h1,h2{color:#33ff66;border-bottom:1px dashed #1d6b36}'
    + 'h2:before{content:"# ";color:#7ee787}'
    + 'strong{font-weight:700;color:#7ee787}'
    + 'em{font-style:normal;color:#61d6ff}'
    + 'blockquote{border-left:3px solid #1d6b36;background:#111;color:#7ee787;padding-left:16px!important}'
    + 'blockquote::before{content:"> ";color:#1d6b36}'
    + 'table{border:1px solid #1d6b36}table th{background:#111;color:#33ff66;border-bottom:2px solid #1d6b36}table td{border-bottom:1px solid #1d6b36;font-family:"SF Mono","Courier New",monospace}'
    + 'code,pre{background:#111;border:1px solid #1d6b36;color:#7ee787}'
    + 'a{color:#61d6ff;text-decoration:underline}'
    + 'li::marker{color:#33ff66}'
    + '::selection{background:#33ff66;color:#0c0c0c}'
    + 'hr{border:none;border-top:1px dashed #1d6b36}'],
  ['blueprint', '蓝图 Blueprint', '#123a6b', '#dce9f8', '#ffd166', '"Courier New",monospace', 'uppercase',
    'body{background-image:linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px);background-size:22px 22px}'
    + 'h1,h2{color:#ffd166;border-bottom:2px solid #ffd166}'
    + 'h2::before{content:"[ ";color:#dce9f8}h2::after{content:" ]";color:#dce9f8}'
    + 'strong{font-weight:700;color:#ffd166}'
    + 'em{font-style:normal;color:#9fc3f0}'
    + 'blockquote{border:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.06)}'
    + 'table{border:2px solid #dce9f8}table th{background:rgba(255,255,255,.1);color:#ffd166;border-bottom:2px solid #ffd166}table td{border:1px solid rgba(255,255,255,.25)}'
    + 'code,pre{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.35);color:#dce9f8}'
    + 'a{color:#ffd166;text-decoration:none;border-bottom:1px dashed #dce9f8}'
    + 'li::marker{color:#ffd166}'
    + '::selection{background:#ffd166;color:#123a6b}'
    + 'hr{border:none;border-top:2px solid #dce9f8}'],
  ['editorial', '杂志编辑 Editorial', '#ffffff', '#141414', '#c8102e', '"Didot",Georgia,"Songti SC",serif', 'none',
    'h1{font-size:3em!important;line-height:1.1;letter-spacing:-.01em}'
    + 'h2{border-top:3px solid #141414;padding-top:10px!important;display:flex;align-items:baseline;gap:.5em}'
    + 'h2::before{content:"■";font-family:ui-monospace,monospace;font-size:.45em;color:#c8102e}'
    + 'strong{font-weight:700}'
    + 'em{font-style:italic;color:#c8102e}'
    + 'blockquote{border-left:4px solid #c8102e;font-size:1.1em;font-style:italic}'
    + 'table{border-top:4px solid #141414}table th{font-family:ui-monospace,monospace;font-size:.72em;letter-spacing:.12em;text-transform:uppercase;text-align:left;border-bottom:2px solid #141414}table td{border-bottom:1px solid #e5e5e5}'
    + 'code,pre{background:#f6f6f6;border-radius:0}'
    + 'a{color:#141414;text-decoration:none;border-bottom:2px solid #c8102e}'
    + 'li::marker{color:#c8102e}'
    + '::selection{background:#c8102e;color:#fff}'
    + 'hr{border:none;height:2px;background:#141414}'],
  ['newspaper', '报纸 Newspaper', '#f6f3ea', '#1a1a1a', '#1a1a1a', F.serif, 'uppercase',
    'body{line-height:1.65}'
    + 'h1{border-top:5px solid #1a1a1a;border-bottom:2px solid #1a1a1a;text-align:center;padding:10px 0!important}'
    + 'h2{border-bottom:1px solid #999;display:flex;align-items:baseline;gap:.5em}'
    + 'h2::before{content:"■";color:#1a1a1a;font-size:.5em}'
    + 'strong{font-weight:700}'
    + 'em{font-style:italic}'
    + 'blockquote{border-left:3px solid #666;background:#efeadb;font-style:italic}'
    + 'table{border-top:4px double #1a1a1a;border-bottom:1px solid #1a1a1a}table th{border-bottom:2px solid #1a1a1a;letter-spacing:.06em}table td{border-bottom:1px dotted #999}'
    + 'code,pre{background:#efeadb;border:1px solid #999;border-radius:0}'
    + 'a{color:#1a1a1a;text-decoration:none;border-bottom:1px solid #1a1a1a}'
    + 'li::marker{color:#1a1a1a}'
    + '::selection{background:#1a1a1a;color:#f6f3ea}'
    + 'hr{border:none;border-top:1px solid #1a1a1a;border-bottom:3px double #1a1a1a;height:2px}'],
  ['typewriter', '打字机 Typewriter', '#f5f2e9', '#2e2a24', '#8a3324', '"Courier New",monospace', 'none',
    'body{line-height:1.9}'
    + 'h1,h2{font-weight:700;border-bottom:2px solid #2e2a24}'
    + 'h2::before{content:"> ";color:#8a3324}'
    + 'strong{font-weight:700;background:#2e2a24;color:#f5f2e9;padding:0 .2em}'
    + 'em{font-style:italic;text-decoration:underline}'
    + 'blockquote{border-left:4px double #8a3324;background:#eee8d5;font-style:italic}'
    + 'table{border:2px solid #2e2a24}table th{border-bottom:3px double #2e2a24;letter-spacing:.04em}table td{border:1px solid #2e2a24;background:rgba(255,255,255,.4)}'
    + 'code,pre{background:#eee8d5;border:1px dashed #8a3324;border-radius:0}'
    + 'a{color:#8a3324;text-decoration:underline;text-underline-offset:3px}'
    + 'li::marker{color:#8a3324}'
    + '::selection{background:#8a3324;color:#f5f2e9}'
    + 'hr{border:none;height:2px;background:repeating-linear-gradient(90deg,#2e2a24 0 6px,transparent 6px 12px)}'],
  ['ink', '水墨 Chinese Ink', '#f7f5f0', '#26241f', '#26241f', '"Hiragino Mincho ProN","Songti SC",serif', 'none',
    'body{background-image:radial-gradient(ellipse at 85% 10%,rgba(38,36,31,.07),transparent 45%)}'
    + 'h1{font-weight:600;letter-spacing:.18em}'
    + 'h2{font-weight:400;display:inline-block;background:linear-gradient(90deg,rgba(38,36,31,.08),transparent);border-left:3px solid #4a453d;padding:2px 12px 2px 10px!important}'
    + 'strong{font-weight:700;color:#26241f}'
    + 'em{font-style:italic;color:#6b6355}'
    + 'blockquote{border:none;background:#edeae2;border-radius:4px 26px 4px 26px;color:#4a463d}'
    + 'table{border-top:2px solid #4a453d;border-bottom:1px solid #cfc4ae}table th{color:#4a453d;letter-spacing:.14em;border-bottom:1px solid #cfc4ae}table td{border-bottom:1px solid #e2dbcb}'
    + 'code,pre{background:#edeae2;border-radius:4px 18px 4px 18px}'
    + 'a{color:#26241f;text-decoration:none;border-bottom:1px dotted #7d7461}'
    + 'li::marker{color:#7d7461}'
    + '::selection{background:#4a453d;color:#f7f5f0}'
    + 'hr{border:none;height:12px;background:radial-gradient(ellipse at center,rgba(38,36,31,.3),transparent 70%)}'],
  ['notion', 'Notion 工作区', '#ffffff', '#37352f', '#2383e2', '"Inter","PingFang SC",sans-serif', 'none',
    'body{line-height:1.75;color:#37352f}'
    + 'h1,h2{font-weight:700;letter-spacing:-.01em;color:#37352f}'
    + 'h1{border-bottom:1px solid rgba(55,53,47,.16);padding-bottom:6px!important}'
    + 'strong{font-weight:700}'
    + 'em{font-style:italic}'
    + 'blockquote{border-left:3px solid #37352f;padding-left:14px!important;color:#57564f}'
    + 'code{color:#eb5757;background:rgba(135,131,120,.15);border-radius:3px;padding:1px 5px;font-family:"SF Mono",monospace}'
    + 'pre{background:rgba(55,53,47,.06);border-radius:6px;color:#37352f}'
    + 'table th{background:rgba(242,241,238,.6);font-weight:600;text-align:left;border:1px solid rgba(55,53,47,.16);padding:6px 10px!important}table td{border:1px solid rgba(55,53,47,.16);padding:6px 10px!important}'
    + 'a{color:#37352f;text-decoration:underline;text-decoration-color:rgba(55,53,47,.4)}'
    + 'li::marker{color:#9b9a97}'
    + '::selection{background:rgba(35,131,226,.28)}'
    + 'hr{border:none;height:1px;background:rgba(55,53,47,.16)}'],
  ['latex', '学术 LaTeX', '#fdfdfc', '#111111', '#1a3c8e', '"Latin Modern Roman","CMU Serif",Georgia,"Songti SC",serif', 'none',
    'body{line-height:1.7;text-align:justify;hyphens:auto}'
    + 'h1{font-weight:400;text-align:center;font-size:2.1em!important}'
    + 'h2{font-weight:700}h2::before{content:"§ ";color:#555}'
    + 'h3{font-style:italic;font-weight:400}'
    + 'strong{font-weight:700}'
    + 'em{font-style:italic}'
    + 'blockquote{margin:1.2em 2.5em!important;border:none;background:transparent;color:#222}'
    + 'table{border-collapse:collapse;margin:1.2em auto}table th{border-top:2px solid #111;border-bottom:1px solid #111;padding:4px 14px!important;font-weight:400}table td{padding:4px 14px!important}table tr:last-child td{border-bottom:2px solid #111}'
    + 'code,pre{font-family:"Latin Modern Mono","Courier New",monospace;background:transparent;border:1px solid #ddd;color:#303030}'
    + 'a{color:#1a3c8e;text-decoration:none}'
    + 'li::marker{color:#111}'
    + '::selection{background:rgba(180,205,250,.6)}'
    + 'hr{border:none;height:1px;background:#111}'],
  ['keynote', 'Keynote 舞台深空', '#000000', '#f5f5f7', '#0a84ff', '"Inter","SF Pro Display","PingFang SC",sans-serif', 'none',
    'body{line-height:1.8;letter-spacing:.01em}'
    + 'h1{font-weight:200;font-size:3em!important;letter-spacing:-.03em;line-height:1.05}'
    + 'h2{font-weight:600;font-size:1.08em!important;letter-spacing:.02em;color:#a1a1c8}'
    + 'strong{font-weight:700;color:#ffffff}'
    + 'em{font-style:normal;background:linear-gradient(90deg,#0a84ff,#bf5af2,#ff375f);-webkit-background-clip:text;background-clip:text;color:transparent}'
    + 'blockquote{border-left:2px solid rgba(255,255,255,.25);color:#c8c8d8;font-weight:300;font-size:1.05em}'
    + 'table th{font-weight:600;color:#a1a1c8;text-align:left;border-bottom:1px solid rgba(255,255,255,.2)}table td{font-weight:300;border-bottom:1px solid rgba(255,255,255,.1)}'
    + 'code,pre{background:#16161e;border-radius:10px;color:#e8e8f5}'
    + 'a{color:#8ab4ff;text-decoration:none}'
    + 'li::marker{color:#6e6e88}'
    + '::selection{background:rgba(10,132,255,.4)}'
    + 'hr{border:none;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.3),transparent)}'],
  ['medium', 'Medium 博客', '#ffffff', '#292929', '#111111', '"Charter","Iowan Old Style",Georgia,"Noto Serif SC",serif', 'none',
    'body{line-height:1.9;font-size:1.04em;color:#292929}'
    + 'h1,h2{font-family:"Inter","Helvetica Neue","PingFang SC",sans-serif;font-weight:700;letter-spacing:-.02em;color:#111}'
    + 'strong{font-weight:700;color:#111}'
    + 'em{font-style:italic}'
    + 'blockquote{border-left:3px solid #111;padding-left:18px!important;font-style:italic;color:#333}'
    + 'table th{font-family:"Inter","Helvetica Neue",sans-serif;font-weight:600;text-align:left;border-bottom:2px solid #111}table td{border-bottom:1px solid #e5e5e5}'
    + 'code,pre{background:#f2f2f2;border-radius:6px;color:#292929;font-family:"SF Mono",monospace}'
    + 'a{color:#111;text-decoration:underline;text-underline-offset:3px}'
    + 'li::marker{color:#666}'
    + '::selection{background:rgba(255,237,80,.55)}'
    + 'hr{border:none;height:auto;text-align:center}hr::after{content:"﹡ ﹡ ﹡";color:#999;letter-spacing:.8em;font-size:1.1em}'],
  ['substack', 'Substack 通讯', '#fffdf9', '#1a1a1a', '#FF6719', '"Spectral","Georgia","Noto Serif SC",serif', 'none',
    'body{line-height:1.85}'
    + 'h1,h2{font-family:"Inter","PingFang SC",sans-serif;font-weight:700;color:#111}'
    + 'strong{font-weight:700}'
    + 'em{font-style:italic}'
    + 'blockquote{border-left:4px solid #FF6719;padding-left:18px!important;color:#444;font-style:italic}'
    + 'table th{background:#FFF4EB;color:#8a3a00;text-align:left}table td{border-bottom:1px solid #eee}'
    + 'code,pre{background:#f6f2ec;border-radius:6px;font-family:"SF Mono",monospace}'
    + 'a{color:#FF6719;text-decoration:underline}'
    + 'li::marker{color:#FF6719}'
    + '::selection{background:#ffd9c2}'
    + 'hr{border:none;height:3px;width:80px;background:#FF6719;border-radius:2px;margin-left:0}']
]

const STYLE_KEY = 'ms_reader_style'

/** 当前阅读皮肤 id（'' = 默认） */
export function activeReadingStyleId(): string {
  return localStorage.getItem(STYLE_KEY) || ''
}

export function setActiveReadingStyleId(id: string): void {
  localStorage.setItem(STYLE_KEY, id)
}

export function findReadingStyle(id: string): ReadingStyleTuple | undefined {
  return READING_STYLES.find(s => s[0] === id)
}

/**
 * 把元组编译成 Shadow DOM 内的样式表。
 * 与 ThirdC 的 iframe 注入不同：这里 :host/#ms-body 作用域，`body` 选择器全部重写到正文容器。
 */
export function readingStyleCss(p: ReadingStyleTuple): string {
  const [, name, bg, fg, ac, font, head, extra] = p
  const tf =
    head === 'uppercase' ? 'text-transform:uppercase;' :
    head === 'small-caps' ? 'font-variant:small-caps;' :
    head === 'capitalize' ? 'text-transform:capitalize;' : ''
  const scoped = extra.replace(/(^|[^-\w])body\b/g, '$1#ms-body')
  return `/* ${name} */
:host{background:${bg}!important;color:${fg}!important;font-family:${font}!important;display:block}
#ms-body{background:${bg}!important;color:${fg}!important;font-family:${font}!important}
h1,h2,h3,h4,h5,h6{color:${fg}!important;font-family:${font}!important;${tf}line-height:1.25!important}
p,li{color:${fg}!important;line-height:1.8!important}
a{color:${ac}!important}
blockquote{margin:1em 0;color:${fg}!important}
code,pre{font-family:"SF Mono","Courier New",monospace;background:rgba(127,127,127,.12)!important;border-radius:8px}
table{border-collapse:collapse}th,td{border:1px solid rgba(127,127,127,.35)!important;padding:6px 10px!important}
hr{margin:1.6em 0}
${scoped || ''}`
}
