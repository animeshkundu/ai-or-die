// Minimal SVG icon helper. Returns inline SVG strings using currentColor.
// Usage: window.icons.name(size)

(function () {
  const toSvg = (pathOrContent, attrs = {}) => {
    const base = {
      width: attrs.width || 16,
      height: attrs.height || 16,
      viewBox: attrs.viewBox || '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': attrs.strokeWidth || 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    };
    const attrStr = Object.entries(base)
      .map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<svg ${attrStr}>${pathOrContent}</svg>`;
  };

  const circle = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

  const icons = {
    check: (s = 16) => toSvg('<polyline points="20 6 9 17 4 12"/>', { width: s, height: s }),
    x: (s = 16) => toSvg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', { width: s, height: s }),
    clipboard: (s = 16) => toSvg('<rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="7" x2="16" y2="7"/>', { width: s, height: s }),
    folder: (s = 16) => toSvg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>', { width: s, height: s }),
    download: (s = 16) => toSvg('<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M5 21h14"/>', { width: s, height: s }),
    chartLine: (s = 16) => toSvg('<polyline points="3 17 9 11 13 15 21 7"/><line x1="3" y1="17" x2="3" y2="21"/><line x1="21" y1="7" x2="21" y2="11"/>', { width: s, height: s }),
    dot: (s = 10) => toSvg(circle(12, 12, 5), { width: s, height: s, viewBox: '0 0 24 24', strokeWidth: 0 }),

    // File browser icons
    file: (s = 16) => toSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', { width: s, height: s }),
    fileCode: (s = 16) => toSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M10 12l-2 2 2 2"/><path d="M14 12l2 2-2 2"/>', { width: s, height: s }),
    fileImage: (s = 16) => toSvg('<rect x="3" y="3" width="18" height="18" rx="2"/>' + circle(8.5, 8.5, 1.5) + '<polyline points="21 15 16 10 5 21"/>', { width: s, height: s }),
    fileText: (s = 16) => toSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' + line(8, 13, 16, 13) + line(8, 17, 12, 17), { width: s, height: s }),
    fileJson: (s = 16) => toSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 16c0-2 1-3 2-3s2 1 2 3"/><path d="M12 16c0-2 1-3 2-3s2 1 2 3"/>', { width: s, height: s }),
    fileCsv: (s = 16) => toSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' + line(8, 13, 16, 13) + line(8, 17, 16, 17) + line(12, 10, 12, 20), { width: s, height: s }),
    filePdf: (s = 16) => toSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15v-2h1.5a1.5 1.5 0 0 1 0 3H9z"/><path d="M14 13h2"/>', { width: s, height: s }),
    fileBinary: (s = 16) => toSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 13v4"/><path d="M12 13v4"/><path d="M15 13v4"/>' + circle(9, 18, 0.5) + circle(15, 18, 0.5), { width: s, height: s }),
    fileMarkdown: (s = 16) => toSvg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13v4l2-2 2 2v-4"/><path d="M16 13l-2 4h4z"/>', { width: s, height: s }),
    upload: (s = 16) => toSvg('<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 21h14"/>', { width: s, height: s }),
    edit: (s = 16) => toSvg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>', { width: s, height: s }),
    save: (s = 16) => toSvg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>', { width: s, height: s }),
    search: (s = 16) => toSvg(circle(11, 11, 8) + '<line x1="21" y1="21" x2="16.65" y2="16.65"/>', { width: s, height: s }),
    refresh: (s = 16) => toSvg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', { width: s, height: s }),
    plus: (s = 16) => toSvg(line(12, 5, 12, 19) + line(5, 12, 19, 12), { width: s, height: s }),
    arrowLeft: (s = 16) => toSvg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', { width: s, height: s }),
    folderOpen: (s = 16) => toSvg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M2 10h20"/>', { width: s, height: s }),
  };

  window.icons = icons;
})();

