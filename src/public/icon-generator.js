// Cortex icon generator for PWA
// Brain/terminal hybrid icon — neural arcs with >_ prompt

function generateIcon(size) {
    const svg = `
        <svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" fill="#1a1a1a" rx="10"/>
            <path d="M50 18 C28 18 18 32 18 48 C18 58 24 66 32 70 L32 74 C32 78 36 80 40 78 L44 76"
                  fill="none" stroke="#ff6b00" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
            <path d="M50 18 C72 18 82 32 82 48 C82 58 76 66 68 70 L68 74 C68 78 64 80 60 78 L56 76"
                  fill="none" stroke="#ff6b00" stroke-width="3.5" stroke-linecap="round" opacity="0.6"/>
            <circle cx="38" cy="38" r="3" fill="#ff6b00" opacity="0.5"/>
            <circle cx="62" cy="38" r="3" fill="#ff6b00" opacity="0.5"/>
            <circle cx="50" cy="28" r="2.5" fill="#ff6b00" opacity="0.4"/>
            <text x="50" y="62" text-anchor="middle" dominant-baseline="middle"
                  font-family="'JetBrains Mono',monospace" font-size="28" font-weight="700" fill="#ff6b00">
              &gt;_
            </text>
        </svg>
    `;
    return 'data:image/svg+xml;base64,' + btoa(svg);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generateIcon };
}
