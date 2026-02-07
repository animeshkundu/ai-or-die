const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Extension-to-MIME mapping (no external dependency)
const MIME_MAP = {
  // Images
  '.png': { mimeType: 'image/png', category: 'image' },
  '.jpg': { mimeType: 'image/jpeg', category: 'image' },
  '.jpeg': { mimeType: 'image/jpeg', category: 'image' },
  '.gif': { mimeType: 'image/gif', category: 'image' },
  '.webp': { mimeType: 'image/webp', category: 'image' },
  '.svg': { mimeType: 'image/svg+xml', category: 'image' },
  '.ico': { mimeType: 'image/x-icon', category: 'image' },
  '.bmp': { mimeType: 'image/bmp', category: 'image' },
  // Markdown
  '.md': { mimeType: 'text/markdown', category: 'markdown' },
  '.mdx': { mimeType: 'text/markdown', category: 'markdown' },
  // JSON
  '.json': { mimeType: 'application/json', category: 'json' },
  '.jsonl': { mimeType: 'application/json', category: 'json' },
  '.json5': { mimeType: 'application/json', category: 'json' },
  // CSV
  '.csv': { mimeType: 'text/csv', category: 'csv' },
  '.tsv': { mimeType: 'text/tab-separated-values', category: 'csv' },
  // PDF
  '.pdf': { mimeType: 'application/pdf', category: 'pdf' },
  // Code
  '.js': { mimeType: 'text/javascript', category: 'code' },
  '.mjs': { mimeType: 'text/javascript', category: 'code' },
  '.cjs': { mimeType: 'text/javascript', category: 'code' },
  '.ts': { mimeType: 'text/typescript', category: 'code' },
  '.tsx': { mimeType: 'text/typescript', category: 'code' },
  '.jsx': { mimeType: 'text/javascript', category: 'code' },
  '.py': { mimeType: 'text/x-python', category: 'code' },
  '.rb': { mimeType: 'text/x-ruby', category: 'code' },
  '.go': { mimeType: 'text/x-go', category: 'code' },
  '.rs': { mimeType: 'text/x-rust', category: 'code' },
  '.java': { mimeType: 'text/x-java', category: 'code' },
  '.c': { mimeType: 'text/x-c', category: 'code' },
  '.cpp': { mimeType: 'text/x-c++', category: 'code' },
  '.h': { mimeType: 'text/x-c', category: 'code' },
  '.hpp': { mimeType: 'text/x-c++', category: 'code' },
  '.cs': { mimeType: 'text/x-csharp', category: 'code' },
  '.php': { mimeType: 'text/x-php', category: 'code' },
  '.sh': { mimeType: 'text/x-shellscript', category: 'code' },
  '.bash': { mimeType: 'text/x-shellscript', category: 'code' },
  '.zsh': { mimeType: 'text/x-shellscript', category: 'code' },
  '.ps1': { mimeType: 'text/x-powershell', category: 'code' },
  '.bat': { mimeType: 'text/x-batch', category: 'code' },
  '.cmd': { mimeType: 'text/x-batch', category: 'code' },
  '.yaml': { mimeType: 'text/yaml', category: 'code' },
  '.yml': { mimeType: 'text/yaml', category: 'code' },
  '.toml': { mimeType: 'text/toml', category: 'code' },
  '.xml': { mimeType: 'text/xml', category: 'code' },
  '.html': { mimeType: 'text/html', category: 'code' },
  '.htm': { mimeType: 'text/html', category: 'code' },
  '.css': { mimeType: 'text/css', category: 'code' },
  '.scss': { mimeType: 'text/x-scss', category: 'code' },
  '.less': { mimeType: 'text/x-less', category: 'code' },
  '.sql': { mimeType: 'text/x-sql', category: 'code' },
  '.graphql': { mimeType: 'text/x-graphql', category: 'code' },
  '.swift': { mimeType: 'text/x-swift', category: 'code' },
  '.kt': { mimeType: 'text/x-kotlin', category: 'code' },
  '.scala': { mimeType: 'text/x-scala', category: 'code' },
  '.r': { mimeType: 'text/x-r', category: 'code' },
  '.lua': { mimeType: 'text/x-lua', category: 'code' },
  '.pl': { mimeType: 'text/x-perl', category: 'code' },
  '.dockerfile': { mimeType: 'text/x-dockerfile', category: 'code' },
  '.makefile': { mimeType: 'text/x-makefile', category: 'code' },
  // Text
  '.txt': { mimeType: 'text/plain', category: 'text' },
  '.log': { mimeType: 'text/plain', category: 'text' },
  '.cfg': { mimeType: 'text/plain', category: 'text' },
  '.ini': { mimeType: 'text/plain', category: 'text' },
  '.env': { mimeType: 'text/plain', category: 'text' },
  '.gitignore': { mimeType: 'text/plain', category: 'text' },
  '.editorconfig': { mimeType: 'text/plain', category: 'text' },
  '.properties': { mimeType: 'text/plain', category: 'text' },
};

// Categories that can be previewed as text
const TEXT_CATEGORIES = new Set(['text', 'code', 'markdown', 'json', 'csv']);

// Categories that can be edited in the Ace editor
const EDITABLE_CATEGORIES = new Set(['text', 'code', 'markdown', 'json', 'csv']);

// Dangerous executable extensions (blocked from upload)
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.dll',
  '.ps1', '.vbs', '.wsf', '.scr', '.pif', '.reg',
  '.inf', '.hta', '.cpl', '.jar'
]);

function getFileInfo(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const entry = MIME_MAP[ext];

  if (entry) {
    return {
      extension: ext,
      mimeType: entry.mimeType,
      mimeCategory: entry.category,
      previewable: true,
      editable: EDITABLE_CATEGORIES.has(entry.category),
    };
  }

  // Check for extensionless filenames that are known text files
  const basename = path.basename(filePath).toLowerCase();
  if (['dockerfile', 'makefile', 'gemfile', 'rakefile', 'procfile'].includes(basename)) {
    return {
      extension: '',
      mimeType: 'text/plain',
      mimeCategory: 'code',
      previewable: true,
      editable: true,
    };
  }

  return {
    extension: ext || '',
    mimeType: 'application/octet-stream',
    mimeCategory: 'binary',
    previewable: false,
    editable: false,
  };
}

function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('File name is required');
  }

  // Strip path separators, null bytes, and control characters
  let sanitized = name
    .replace(/[/\\]/g, '')
    .replace(/\0/g, '')
    .replace(/[\x01-\x1f\x7f]/g, '');

  // Trim whitespace and dots from start/end
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '');

  if (!sanitized) {
    throw new Error('File name is empty after sanitization');
  }

  if (sanitized.length > 255) {
    const ext = path.extname(sanitized);
    sanitized = sanitized.slice(0, 255 - ext.length) + ext;
  }

  return sanitized;
}

function isBlockedExtension(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return BLOCKED_EXTENSIONS.has(ext);
}

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function isBinaryFile(filePath) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
      fs.closeSync(fd);

      // Check for null bytes in the first 512 bytes
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          resolve(true);
          return;
        }
      }
      resolve(false);
    } catch (err) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
      reject(err);
    }
  });
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
  return `${size} ${units[i]}`;
}

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

module.exports = {
  MIME_MAP,
  TEXT_CATEGORIES,
  EDITABLE_CATEGORIES,
  BLOCKED_EXTENSIONS,
  getFileInfo,
  sanitizeFileName,
  isBlockedExtension,
  computeFileHash,
  isBinaryFile,
  formatFileSize,
  normalizePath,
};
