const assert = require('assert');
const InstallAdvisor = require('../src/install-advisor');

describe('InstallAdvisor', function() {
  let advisor;

  beforeEach(function() {
    advisor = new InstallAdvisor();
  });

  describe('getInstallInfo', function() {
    it('should return install info for claude', function() {
      const info = advisor.getInstallInfo('claude');
      assert(info);
      assert.strictEqual(info.name, 'Claude Code');
      assert(Array.isArray(info.methods));
      assert(info.methods.length > 0);
      assert(info.methods.some(m => m.command && m.command.includes('@anthropic-ai/claude-code')));
      assert(Array.isArray(info.authSteps));
      assert(info.authSteps.some(s => s.command === 'claude login'));
      assert(typeof info.docsUrl === 'string');
      assert(typeof info.verifyCommand === 'string');
    });

    it('should return install info for codex', function() {
      const info = advisor.getInstallInfo('codex');
      assert(info);
      assert.strictEqual(info.name, 'Codex');
      assert(info.methods.some(m => m.command && m.command.includes('@openai/codex')));
      assert(info.authSteps.some(s => s.type === 'env'));
    });

    it('should return install info for gemini', function() {
      const info = advisor.getInstallInfo('gemini');
      assert(info);
      assert.strictEqual(info.name, 'Gemini CLI');
      assert(info.methods.some(m => m.command && m.command.includes('@google/gemini-cli')));
    });

    it('should return install info for copilot', function() {
      const info = advisor.getInstallInfo('copilot');
      assert(info);
      assert.strictEqual(info.name, 'GitHub Copilot CLI');
      assert(info.methods.some(m => m.id === 'gh'));
    });

    it('should return install info for vscode', function() {
      const info = advisor.getInstallInfo('vscode');
      assert(info);
      assert.strictEqual(info.name, 'VS Code');
      assert(Array.isArray(info.methods));
      assert(info.methods.length > 0);
      // VS Code should have platform-specific methods (download, snap/brew/winget)
      assert(info.methods.some(m => m.url || m.command));
    });

    it('should return null for unknown tool', function() {
      const info = advisor.getInstallInfo('nonexistent');
      assert.strictEqual(info, null);
    });

    it('should return null for terminal (always available)', function() {
      const info = advisor.getInstallInfo('terminal');
      assert.strictEqual(info, null);
    });

    it('should include docsUrl for all tools', function() {
      for (const toolId of ['claude', 'codex', 'gemini', 'copilot', 'vscode']) {
        const info = advisor.getInstallInfo(toolId);
        assert(info.docsUrl, `${toolId} should have docsUrl`);
        assert(info.docsUrl.startsWith('http'), `${toolId} docsUrl should be a URL`);
      }
    });

    it('should mark npm methods with requiresNpm', function() {
      for (const toolId of ['claude', 'codex', 'gemini']) {
        const info = advisor.getInstallInfo(toolId);
        const npmMethod = info.methods.find(m => m.id === 'npm');
        assert(npmMethod, `${toolId} should have npm method`);
        assert.strictEqual(npmMethod.requiresNpm, true);
      }
    });
  });

  describe('detectPrerequisites', function() {
    it('should return npm and npx availability', async function() {
      this.timeout(15000);
      const prereqs = await advisor.detectPrerequisites();
      assert(typeof prereqs.npm === 'object');
      assert(typeof prereqs.npm.available === 'boolean');
      assert(typeof prereqs.npx === 'object');
      assert(typeof prereqs.npx.available === 'boolean');
    });

    it('should detect npm is available on this machine', async function() {
      this.timeout(15000);
      const prereqs = await advisor.detectPrerequisites();
      // npm should be available on any machine running these tests
      assert.strictEqual(prereqs.npm.available, true);
      assert(typeof prereqs.npm.version === 'string');
      assert(prereqs.npm.version.length > 0);
    });

    it('should detect npm prefix', async function() {
      this.timeout(15000);
      const prereqs = await advisor.detectPrerequisites();
      assert(typeof prereqs.npm.prefix === 'string');
      assert(prereqs.npm.prefix.length > 0);
    });

    it('should cache results', async function() {
      this.timeout(15000);
      const first = await advisor.detectPrerequisites();
      const second = await advisor.detectPrerequisites();
      // Should be the same object (cached)
      assert.strictEqual(first, second);
    });

    it('should return fresh results after clearing cache', async function() {
      this.timeout(15000);
      const first = await advisor.detectPrerequisites();
      advisor.clearPrerequisitesCache();
      const second = await advisor.detectPrerequisites();
      // Different object (new check), but same values
      assert.notStrictEqual(first, second);
      assert.strictEqual(first.npm.available, second.npm.available);
    });
  });

  describe('getInstallInfoWithPrereqs', function() {
    it('should enrich methods with availability based on prerequisites', async function() {
      this.timeout(15000);
      const info = await advisor.getInstallInfoWithPrereqs('claude');
      assert(info);
      assert(info.prerequisites);
      assert(typeof info.prerequisites.npm === 'object');
      for (const method of info.methods) {
        assert(typeof method.available === 'boolean');
      }
    });

    it('should return null for unknown tool', async function() {
      const info = await advisor.getInstallInfoWithPrereqs('nonexistent');
      assert.strictEqual(info, null);
    });
  });
});
