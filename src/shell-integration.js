'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_NAME = '.ai-or-die-shell';
const STALE_AGE_MS = 24 * 60 * 60 * 1000;

function shellKind(command) {
  const base = path.basename(String(command || '')).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return 'powershell';
  if (base === 'bash') return 'bash';
  if (base === 'zsh') return 'zsh';
  if (base === 'fish') return 'fish';
  if (base === 'cmd') return 'cmd';
  return null;
}

function bashShim() {
  return [
    'if [ -r "$HOME/.bashrc" ]; then',
    '  . "$HOME/.bashrc"',
    'fi',
    '_aiordie_emit_osc7() {',
    '  local _raw="$PWD" _encoded="" _ch _hex _i',
    '  local LC_ALL=C',
    '  for ((_i = 0; _i < ${#_raw}; _i++)); do',
    '    _ch="${_raw:_i:1}"',
    '    case "$_ch" in',
    '      [A-Za-z0-9._~/-]) _encoded+="${_ch}" ;;',
    '      *) printf -v _hex "%%%02X" "\'${_ch}"; _encoded+="${_hex}" ;;',
    '    esac',
    '  done',
    '  printf "\\033]7;file://%s\\007" "$_encoded"',
    '}',
    '_aiordie_decl="$(declare -p PROMPT_COMMAND 2>/dev/null || true)"',
    '_aiordie_flags=""',
    'if [[ "$_aiordie_decl" =~ ^declare\\ -([^[:space:]]*) ]]; then',
    '  _aiordie_flags="${BASH_REMATCH[1]}"',
    'fi',
    'if [[ "$_aiordie_flags" != *r* && "$_aiordie_flags" != *n* ]]; then',
    '  if [[ "$_aiordie_flags" == *a* && ( "${BASH_VERSINFO[0]}" -gt 5 || ( "${BASH_VERSINFO[0]}" -eq 5 && "${BASH_VERSINFO[1]}" -ge 1 ) ) ]]; then',
    '    PROMPT_COMMAND+=(_aiordie_emit_osc7)',
    '  elif [[ "$_aiordie_flags" != *a* ]]; then',
    '    PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND};}_aiordie_emit_osc7"',
    '  fi',
    'fi',
    'unset _aiordie_decl _aiordie_flags',
    ': > "$AIORDIE_SHELL_READY"',
    '',
  ].join('\n');
}

function zshEncoderAndHook() {
  return [
    '_aiordie_emit_osc7() {',
    '  local _raw="$PWD" _encoded="" _ch _hex',
    '  local -i _i',
    '  local LC_ALL=C',
    '  for ((_i = 1; _i <= ${#_raw}; _i++)); do',
    '    _ch="${_raw[_i]}"',
    '    case "$_ch" in',
    '      [A-Za-z0-9._~/-]) _encoded+="${_ch}" ;;',
    '      *) printf -v _hex "%%%02X" "\'${_ch}"; _encoded+="${_hex}" ;;',
    '    esac',
    '  done',
    '  printf "\\033]7;file://%s\\007" "$_encoded"',
    '}',
    'typeset -ga precmd_functions',
    'if (( ${precmd_functions[(Ie)_aiordie_emit_osc7]} == 0 )); then',
    '  precmd_functions+=(_aiordie_emit_osc7)',
    'fi',
  ].join('\n');
}

function zshSource(name, { restore = false, hook = false } = {}) {
  const lines = [
    'typeset -g _AIORDIE_USER_ZDOTDIR="${AIORDIE_USER_ZDOTDIR:-$HOME}"',
    'export ZDOTDIR="$_AIORDIE_USER_ZDOTDIR"',
    `if [[ -r "$_AIORDIE_USER_ZDOTDIR/${name}" ]]; then`,
    `  source "$_AIORDIE_USER_ZDOTDIR/${name}"`,
    'fi',
    'typeset -g AIORDIE_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"',
  ];
  if (hook) {
    lines.push(zshEncoderAndHook());
    lines.push(': > "$AIORDIE_SHELL_READY"');
  }
  if (restore === 'unless-login') {
    lines.push('if [[ -o login ]]; then');
    lines.push('  export ZDOTDIR="$AIORDIE_WRAPPER_ZDOTDIR"');
    lines.push('else');
    lines.push('  export ZDOTDIR="$AIORDIE_USER_ZDOTDIR"');
    lines.push('fi');
  } else if (restore) {
    lines.push('export ZDOTDIR="$AIORDIE_USER_ZDOTDIR"');
  } else {
    lines.push('export ZDOTDIR="$AIORDIE_WRAPPER_ZDOTDIR"');
  }
  lines.push('');
  return lines.join('\n');
}

function powershellShim() {
  return [
    '$ErrorActionPreference = "Continue"',
    '$seenProfiles = @{}',
    '$profilePaths = @(',
    '  $PROFILE.AllUsersAllHosts,',
    '  $PROFILE.AllUsersCurrentHost,',
    '  $PROFILE.CurrentUserAllHosts,',
    '  $PROFILE.CurrentUserCurrentHost',
    ')',
    'foreach ($profilePath in $profilePaths) {',
    '  if ($profilePath -and -not $seenProfiles.ContainsKey($profilePath) -and (Test-Path -LiteralPath $profilePath)) {',
    '    $seenProfiles[$profilePath] = $true',
    '    . $profilePath',
    '  }',
    '}',
    '$global:AiOrDieOriginalPrompt = $null',
    '$promptCommand = Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue',
    'if ($promptCommand) { $global:AiOrDieOriginalPrompt = $promptCommand.ScriptBlock }',
    'function global:_AiOrDieEncodePath([string] $value) {',
    '  $bytes = [System.Text.Encoding]::UTF8.GetBytes($value)',
    '  $builder = [System.Text.StringBuilder]::new()',
    '  foreach ($byte in $bytes) {',
    '    $char = [char]$byte',
    '    if (($byte -ge 65 -and $byte -le 90) -or ($byte -ge 97 -and $byte -le 122) -or',
    '        ($byte -ge 48 -and $byte -le 57) -or $char -in ".", "_", "~", "-", "/") {',
    '      [void]$builder.Append($char)',
    '    } else {',
    '      [void]$builder.Append(("%{0:X2}" -f $byte))',
    '    }',
    '  }',
    '  return $builder.ToString()',
    '}',
    'function global:_AiOrDieOsc7Uri([string] $providerPath) {',
    '  $normalized = $providerPath -replace "\\\\", "/"',
    '  $isWindowsHost = [System.IO.Path]::DirectorySeparatorChar -eq "\\"',
    '  if ($isWindowsHost -and $normalized.StartsWith("//")) {',
    '    $unc = $normalized.Substring(2)',
    '    $slash = $unc.IndexOf("/")',
    '    if ($slash -gt 0) {',
    '      $uncHost = _AiOrDieEncodePath $unc.Substring(0, $slash)',
    '      $rest = _AiOrDieEncodePath $unc.Substring($slash)',
    '      return "file://$uncHost$rest"',
    '    }',
    '  }',
    '  if (-not $isWindowsHost) { $normalized = $normalized -replace "^//+", "/" }',
    '  if ($normalized -match "^[A-Za-z]:/") {',
    '    $drive = $normalized.Substring(0, 2)',
    '    $rest = _AiOrDieEncodePath $normalized.Substring(2)',
    '    return "file:///$drive$rest"',
    '  }',
    '  $encoded = _AiOrDieEncodePath $normalized',
    '  if (-not $encoded.StartsWith("/")) { $encoded = "/$encoded" }',
    '  return "file://$encoded"',
    '}',
    'function global:prompt {',
    '  $location = $ExecutionContext.SessionState.Path.CurrentLocation',
    '  if ($location.Provider.Name -eq "FileSystem") {',
    '    $uri = _AiOrDieOsc7Uri $location.ProviderPath',
    '    [Console]::Write("$([char]27)]7;$uri$([char]7)")',
    '  }',
    '  if ($global:AiOrDieOriginalPrompt) { return & $global:AiOrDieOriginalPrompt }',
    '  return "PS $($location.Path)> "',
    '}',
    '[System.IO.File]::WriteAllText($env:AIORDIE_SHELL_READY, "ready")',
    '',
  ].join('\r\n');
}

class ShellIntegrationManager {
  constructor(options = {}) {
    this.root = options.root || path.join(os.tmpdir(), ROOT_NAME);
    this._sessions = new Map();
    this._ready = false;
    this._sweepStale();
  }

  prepare(sessionId, command, env = process.env) {
    if (/^(1|true|yes)$/i.test(String(env.AIORDIE_DISABLE_SHELL_INTEGRATION || ''))) return null;
    const kind = shellKind(command);
    if (!kind || kind === 'fish' || kind === 'cmd') return null;

    try {
      this.cleanup(sessionId);
      this._ensureRoot();
      const dir = fs.mkdtempSync(path.join(this.root, 'session-'));
      fs.chmodSync(dir, 0o700);
      const readyFile = path.join(dir, 'ready');
      const integration = {
        kind,
        dir,
        readyFile,
        args: [],
        env: { AIORDIE_SHELL_READY: readyFile },
      };

      if (kind === 'powershell') {
        const script = path.join(dir, 'profile.ps1');
        this._writeExclusive(script, powershellShim());
        integration.script = script;
        integration.args = ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script];
      } else if (kind === 'bash') {
        const script = path.join(dir, 'bashrc');
        this._writeExclusive(script, bashShim());
        integration.args = ['--rcfile', script];
      } else if (kind === 'zsh') {
        this._writeExclusive(path.join(dir, '.zshenv'), zshSource('.zshenv'));
        this._writeExclusive(path.join(dir, '.zprofile'), zshSource('.zprofile'));
        this._writeExclusive(path.join(dir, '.zshrc'), zshSource('.zshrc', { restore: 'unless-login', hook: true }));
        this._writeExclusive(path.join(dir, '.zlogin'), zshSource('.zlogin', { restore: true }));
        integration.env = {
          ...integration.env,
          ZDOTDIR: dir,
          AIORDIE_WRAPPER_ZDOTDIR: dir,
          AIORDIE_USER_ZDOTDIR: env.ZDOTDIR || os.homedir(),
        };
      }

      this._sessions.set(sessionId, integration);
      return integration;
    } catch (err) {
      if (process.env.DEBUG) {
        console.warn(`terminal-bridge: shell integration disabled for ${sessionId}: ${err.message}`);
      }
      this.cleanup(sessionId);
      return null;
    }
  }

  get(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  cleanup(sessionId) {
    const integration = this._sessions.get(sessionId);
    this._sessions.delete(sessionId);
    if (!integration || !integration.dir) return;
    try { fs.rmSync(integration.dir, { recursive: true, force: true }); } catch (_) {}
  }

  cleanupAll() {
    for (const sessionId of Array.from(this._sessions.keys())) this.cleanup(sessionId);
  }

  _writeExclusive(file, content) {
    fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  _ensureRoot() {
    if (!this._ready) {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`unsafe shell integration root: ${this.root}`);
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`shell integration root is owned by uid ${stat.uid}`);
      }
      fs.chmodSync(this.root, 0o700);
      this._ready = true;
    }
  }

  _sweepStale() {
    try {
      this._ensureRoot();
      const cutoff = Date.now() - STALE_AGE_MS;
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
        const candidate = path.join(this.root, entry.name);
        const stat = fs.lstatSync(candidate);
        if (!stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
          fs.rmSync(candidate, { recursive: true, force: true });
        }
      }
    } catch (err) {
      this._ready = false;
      if (process.env.DEBUG) console.warn(`terminal-bridge: stale shell integration cleanup failed: ${err.message}`);
    }
  }
}

module.exports = {
  ShellIntegrationManager,
  shellKind,
  bashShim,
  zshEncoderAndHook,
  powershellShim,
};
