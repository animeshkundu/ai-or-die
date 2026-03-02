class PlanDetector {
  constructor() {
    this.isMonitoring = false;
    this.outputBuffer = [];
    this.planModeActive = false;
    this.currentPlan = null;
    this.currentTool = null;
    this.planStartMarker = '## Implementation Plan:';
    this.planEndMarker = 'User has approved your plan';
    this.maxBufferSize = 10000;
    this.onPlanDetected = null;
    this.onPlanModeChange = null;
    this.onStepProgress = null;
    // Overlap buffer for detecting triggers that span chunk boundaries
    this._lastChunkTail = '';
    // Suppress detection when echoed text might trigger false positives
    this._suppressDetection = false;
    // Throttle for step progress emissions
    this._lastStepEmit = 0;
    // All keywords that could trigger a state change -- checked against
    // each new output chunk instead of the entire buffer every time
    this._triggerKeywords = [
      // Claude
      'Plan mode is active',
      'MUST NOT make any edits',
      'present your plan by calling the ExitPlanMode tool',
      'Starting plan mode',
      'Implementation Plan',
      '### ',
      'Plan Overview',
      'Proposed Solution',
      'approved your plan',
      'start coding',
      'Plan mode exited',
      'Exiting plan mode',
      // Copilot
      'PLAN MODE',
      'Plan accepted',
      'Executing on autopilot',
      'All steps complete',
      // Codex
      '[DRAFT PLAN]',
      '[APPROVED PLAN]',
      '[REFINED PLAN]'
    ];
  }

  setTool(tool) {
    this.currentTool = tool;
    this.clearBuffer();
  }

  processOutput(data) {
    if (!this.isMonitoring || this._suppressDetection) return;

    // Add to buffer
    this.outputBuffer.push({
      timestamp: Date.now(),
      data: data
    });

    // Keep buffer size manageable
    if (this.outputBuffer.length > this.maxBufferSize) {
      this.outputBuffer = this.outputBuffer.slice(-this.maxBufferSize / 2);
    }

    // Stage 1: Quick trigger scan on the new chunk only (O(k) where k = chunk size).
    // Prepend overlap from the previous chunk to catch triggers spanning boundaries.
    const cleanChunk = data
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\[[0-9]*[A-Za-z]/g, '');
    const scanTarget = this._lastChunkTail + cleanChunk;
    this._lastChunkTail = cleanChunk.slice(-512);

    // Check for step progress while plan mode is active (throttled)
    if (this.planModeActive) {
      this.detectStepProgress(scanTarget);
    }

    if (!this._triggerKeywords.some(t => scanTarget.includes(t))) return;

    // Stage 2: Full buffer analysis -- only runs when a trigger keyword is found
    const recentText = this.getRecentText();

    // Check for plan mode activation
    if (!this.planModeActive && this.detectPlanModeStart(recentText)) {
      this.planModeActive = true;
      if (this.onPlanModeChange) {
        this.onPlanModeChange(true);
      }
    }

    // Check for completed plan
    if (this.planModeActive && this.detectCompletedPlan(recentText)) {
      const plan = this.extractPlan(recentText);
      if (plan) {
        this.currentPlan = plan;
        if (this.onPlanDetected) {
          this.onPlanDetected(plan);
        }
      }
    }

    // Check for plan mode exit
    if (this.planModeActive && this.detectPlanModeEnd(recentText)) {
      this.planModeActive = false;
      if (this.onPlanModeChange) {
        this.onPlanModeChange(false);
      }
    }
  }

  getRecentText(maxChars = 50000) {
    // Get recent output as text, stripping ANSI codes
    const text = this.outputBuffer
      .map(item => item.data)
      .join('')
      .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI color codes
      .replace(/\x1b\[[0-9]*[A-Za-z]/g, ''); // Remove other ANSI sequences

    return text.slice(-maxChars);
  }

  detectPlanModeStart(text) {
    const tool = this.currentTool;

    // Claude indicators (always checked when tool is 'claude' or unknown)
    if (!tool || tool === 'claude') {
      const claudeIndicators = [
        'Plan mode is active',
        'you MUST NOT make any edits',
        'present your plan by calling the ExitPlanMode tool',
        'Starting plan mode'
      ];
      if (claudeIndicators.some(indicator => text.includes(indicator))) {
        return true;
      }
    }

    // Copilot indicators
    if (!tool || tool === 'copilot') {
      if (text.includes('PLAN MODE')) {
        return true;
      }
    }

    // Codex indicators
    if (!tool || tool === 'codex') {
      if (text.includes('[DRAFT PLAN]')) {
        return true;
      }
    }

    return false;
  }

  detectCompletedPlan(text) {
    const tool = this.currentTool;

    // Claude patterns (default)
    if (!tool || tool === 'claude') {
      const claudePatterns = [
        /## Implementation Plan:/,
        /### \d+\. /,
        /## Plan:/,
        /### Plan Overview/,
        /## Proposed Solution:/
      ];
      const hasPattern = claudePatterns.some(pattern => pattern.test(text));
      const recentText = text.slice(-10000);
      if (hasPattern && recentText.includes('###')) {
        return true;
      }
    }

    // Copilot: numbered list after PLAN MODE header
    if (!tool || tool === 'copilot') {
      const planModeIdx = text.lastIndexOf('PLAN MODE');
      if (planModeIdx !== -1) {
        const afterPlan = text.slice(planModeIdx);
        // Look for at least 2 numbered items
        const numberedItems = afterPlan.match(/^\s*\d+\.\s+/gm);
        if (numberedItems && numberedItems.length >= 2) {
          return true;
        }
      }
    }

    // Codex: action items section
    if (!tool || tool === 'codex') {
      if (/## Action items/i.test(text)) {
        return true;
      }
    }

    return false;
  }

  extractPlan(text) {
    const tool = this.currentTool;
    let plan = null;

    // Copilot extraction: numbered step list after last 'PLAN MODE' marker
    if (!tool || tool === 'copilot') {
      const planModeIdx = text.lastIndexOf('PLAN MODE');
      if (planModeIdx !== -1) {
        const afterPlan = text.slice(planModeIdx);
        const numberedItems = afterPlan.match(/^\s*\d+\.\s+/gm);
        if (numberedItems && numberedItems.length >= 2) {
          // Extract from PLAN MODE to end of numbered section or next major marker
          const endMatch = afterPlan.match(/(?:Plan accepted|All steps complete|Executing on autopilot)/);
          const endIdx = endMatch ? endMatch.index : afterPlan.length;
          plan = afterPlan.slice(0, endIdx).trim();
        }
      }
    }

    // Codex extraction: text between [DRAFT PLAN] and [APPROVED PLAN]
    if (!plan && (!tool || tool === 'codex')) {
      const draftIdx = text.lastIndexOf('[DRAFT PLAN]');
      if (draftIdx !== -1) {
        const approvedIdx = text.indexOf('[APPROVED PLAN]', draftIdx);
        const refinedIdx = text.indexOf('[REFINED PLAN]', draftIdx);
        const endIdx = approvedIdx !== -1 ? approvedIdx
          : refinedIdx !== -1 ? refinedIdx
            : -1;
        if (endIdx !== -1) {
          plan = text.slice(draftIdx, endIdx + (approvedIdx !== -1 ? '[APPROVED PLAN]'.length : '[REFINED PLAN]'.length)).trim();
        } else {
          // No end marker yet; extract from [DRAFT PLAN] to end
          plan = text.slice(draftIdx).trim();
        }
      }
    }

    // Claude extraction strategies (scan backward for most recent plan)
    if (!plan && (!tool || tool === 'claude')) {
      // Strategy 1: Find LAST ## Implementation Plan: and extract from there
      const implIdx = text.lastIndexOf('## Implementation Plan:');
      if (implIdx !== -1) {
        const fromPlan = text.slice(implIdx);
        const endMatch = fromPlan.match(/(?:User has approved|Exit plan mode|[$>]|^[a-z]+@)/m);
        plan = endMatch ? fromPlan.slice(0, endMatch.index).trim() : fromPlan.trim();
      }

      // Strategy 2: Look for structured plan with ### sections (scan backward)
      if (!plan) {
        // Find all ## headers that look like plans, take the last one
        const planHeaders = [];
        const headerRe = /##[^#].*?Plan.*?:/gi;
        let match;
        while ((match = headerRe.exec(text)) !== null) {
          planHeaders.push(match.index);
        }
        if (planHeaders.length > 0) {
          const lastIdx = planHeaders[planHeaders.length - 1];
          const fromPlan = text.slice(lastIdx);
          const structuredMatch = fromPlan.match(/^##[^#].*?Plan.*?:[\s\S]*?(?:###[\s\S]*?){2,}(?=(?:User has approved|Exit plan mode|[$>]|^[a-z]+@))/im);
          if (structuredMatch) {
            plan = structuredMatch[0].trim();
          }
        }
      }

      // Strategy 3: Look for recent plan-like content (last 5000 chars)
      if (!plan) {
        const recentText = text.slice(-5000);
        const planMatch = recentText.match(/(?:##|Plan:)[\s\S]*?(?:###[\s\S]*?){1,}/);
        if (planMatch) {
          plan = planMatch[0].trim();
        }
      }
    }

    if (plan) {
      // Clean up the plan text
      plan = plan
        .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI codes
        .replace(/\r\n/g, '\n') // Normalize line endings
        .replace(/\r/g, '\n')
        .trim();

      return {
        content: plan,
        timestamp: Date.now(),
        raw: plan
      };
    }

    return null;
  }

  detectPlanModeEnd(text) {
    const tool = this.currentTool;

    // Claude end indicators (always checked when tool is 'claude' or unknown)
    if (!tool || tool === 'claude') {
      const claudeEnd = [
        'User has approved your plan',
        'You can now start coding',
        'Plan mode exited',
        'Exiting plan mode'
      ];
      if (claudeEnd.some(indicator => text.includes(indicator))) {
        return true;
      }
    }

    // Copilot end indicators
    if (!tool || tool === 'copilot') {
      const copilotEnd = [
        'Plan accepted',
        'All steps complete'
      ];
      if (copilotEnd.some(indicator => text.includes(indicator))) {
        return true;
      }
    }

    // Codex end indicators
    if (!tool || tool === 'codex') {
      const codexEnd = [
        '[APPROVED PLAN]'
      ];
      if (codexEnd.some(indicator => text.includes(indicator))) {
        return true;
      }
    }

    return false;
  }

  detectStepProgress(text) {
    const stepMatch = text.match(/Step (\d+)\/(\d+):\s*(.*)/);
    if (!stepMatch) return;

    const now = Date.now();
    if (now - this._lastStepEmit < 500) return;
    this._lastStepEmit = now;

    if (this.onStepProgress) {
      this.onStepProgress({
        current: parseInt(stepMatch[1], 10),
        total: parseInt(stepMatch[2], 10),
        description: stepMatch[3].trim()
      });
    }
  }

  startMonitoring() {
    this.isMonitoring = true;
    this.outputBuffer = [];
    this.planModeActive = false;
    this.currentPlan = null;
    this._lastChunkTail = '';
  }

  stopMonitoring() {
    this.isMonitoring = false;
    this.outputBuffer = [];
    this.planModeActive = false;
    this.currentPlan = null;
    this._lastChunkTail = '';
  }

  clearBuffer() {
    this.outputBuffer = [];
    this.currentPlan = null;
    this._lastChunkTail = '';
  }

  getPlanModeStatus() {
    return this.planModeActive;
  }

  getCurrentPlan() {
    return this.currentPlan;
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PlanDetector;
}
