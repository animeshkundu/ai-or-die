'use strict';

/**
 * Strip the Windows extended-length prefix without changing the path remainder.
 *
 * fs.realpathSync.native() can return either \\?\C:\... or
 * \\?\UNC\server\share\.... The UNC form must regain its leading double
 * separator when the extended prefix and UNC marker are removed.
 *
 * Bare prefix values are not produced by realpathSync.native() and are outside
 * this helper's input contract; their mechanical outputs are pinned by tests
 * solely to detect drift between call sites.
 */
function stripWindowsLongPathPrefix(value) {
  if (typeof value !== 'string' || !value.startsWith('\\\\?\\')) return value;
  return value.startsWith('\\\\?\\UNC\\') ? '\\\\' + value.slice(8) : value.slice(4);
}

module.exports = { stripWindowsLongPathPrefix };
