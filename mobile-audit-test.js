/**
 * Mobile UX Audit Script
 * Tests iPhone SE (375x667) and iPhone 14 (390x844) viewports
 */

const playwright = require('@playwright/test');

async function runAudit() {
  const browser = await playwright.chromium.launch({ headless: true });
  
  const devices = [
    { name: 'iPhone SE', width: 375, height: 667 },
    { name: 'iPhone 14', width: 390, height: 844 }
  ];
  
  const issues = [];
  
  for (const device of devices) {
    console.log(`\n=== Testing ${device.name} (${device.width}x${device.height}) ===\n`);
    
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
    });
    
    const page = await context.newPage();
    
    try {
      // Navigate to the app
      await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      
      // Test 1: Initial load and layout
      console.log('Testing initial load...');
      const bodyOverflow = await page.evaluate(() => {
        const body = document.body;
        return {
          scrollWidth: body.scrollWidth,
          clientWidth: body.clientWidth,
          hasHorizontalOverflow: body.scrollWidth > body.clientWidth
        };
      });
      
      if (bodyOverflow.hasHorizontalOverflow) {
        issues.push({
          device: device.name,
          severity: 'Critical',
          category: 'Layout',
          issue: 'Horizontal overflow detected',
          details: `Page width ${bodyOverflow.scrollWidth}px exceeds viewport ${bodyOverflow.clientWidth}px`,
          reproduction: 'Load the app and check body scroll width'
        });
      }
      
      // Test 2: Session tabs visibility and readability
      console.log('Testing session tabs...');
      const tabsInfo = await page.evaluate(() => {
        const tabsBar = document.querySelector('.session-tabs-bar');
        const tabs = document.querySelectorAll('.session-tab');
        const tabNew = document.querySelector('.tab-new-main, .tab-new');
        
        return {
          tabsBarVisible: tabsBar && window.getComputedStyle(tabsBar).display !== 'none',
          tabCount: tabs.length,
          tabs: Array.from(tabs).map(tab => ({
            width: tab.offsetWidth,
            height: tab.offsetHeight,
            fontSize: window.getComputedStyle(tab).fontSize,
            visible: tab.offsetWidth > 0 && tab.offsetHeight > 0,
            text: tab.textContent.trim()
          })),
          newButtonVisible: tabNew && window.getComputedStyle(tabNew).display !== 'none'
        };
      });
      
      console.log('Tabs info:', JSON.stringify(tabsInfo, null, 2));
      
      // Test 3: Bottom navigation
      console.log('Testing bottom navigation...');
      const bottomNavInfo = await page.evaluate(() => {
        const bottomNav = document.querySelector('.bottom-nav');
        const navItems = document.querySelectorAll('.bottom-nav-item');
        
        return {
          visible: bottomNav && window.getComputedStyle(bottomNav).display === 'flex',
          position: bottomNav ? window.getComputedStyle(bottomNav).position : null,
          bottom: bottomNav ? window.getComputedStyle(bottomNav).bottom : null,
          height: bottomNav ? bottomNav.offsetHeight : 0,
          itemCount: navItems.length,
          items: Array.from(navItems).map(item => ({
            label: item.textContent.trim(),
            width: item.offsetWidth,
            height: item.offsetHeight,
            fontSize: window.getComputedStyle(item).fontSize
          }))
        };
      });
      
      console.log('Bottom nav info:', JSON.stringify(bottomNavInfo, null, 2));
      
      if (!bottomNavInfo.visible) {
        issues.push({
          device: device.name,
          severity: 'Important',
          category: 'Navigation',
          issue: 'Bottom navigation not visible on mobile',
          details: 'Bottom nav should display on mobile viewports',
          reproduction: 'Load app at mobile viewport and check bottom nav'
        });
      }
      
      // Test 4: Terminal container
      console.log('Testing terminal...');
      const terminalInfo = await page.evaluate(() => {
        const terminal = document.querySelector('#terminal');
        const terminalContainer = document.querySelector('.terminal-container');
        const app = document.querySelector('#app');
        
        return {
          terminalExists: !!terminal,
          containerExists: !!terminalContainer,
          terminalDimensions: terminal ? {
            width: terminal.offsetWidth,
            height: terminal.offsetHeight,
            padding: window.getComputedStyle(terminal).padding
          } : null,
          appPaddingBottom: app ? window.getComputedStyle(app).paddingBottom : null
        };
      });
      
      console.log('Terminal info:', JSON.stringify(terminalInfo, null, 2));
      
      // Test 5: Try opening settings modal
      console.log('Testing settings modal...');
      const settingsBtn = await page.$('.tab-settings, .hamburger-btn');
      if (settingsBtn) {
        await settingsBtn.click();
        await page.waitForTimeout(500);
        
        const modalInfo = await page.evaluate(() => {
          const modal = document.querySelector('.settings-modal, .mobile-menu');
          const modalContent = document.querySelector('.modal-content, .mobile-menu-content');
          
          return {
            modalVisible: modal && window.getComputedStyle(modal).display !== 'none',
            modalDimensions: modal ? {
              width: modal.offsetWidth,
              height: modal.offsetHeight,
              overflow: window.getComputedStyle(modal).overflow
            } : null,
            contentDimensions: modalContent ? {
              width: modalContent.offsetWidth,
              height: modalContent.offsetHeight,
              scrollHeight: modalContent.scrollHeight,
              clientHeight: modalContent.clientHeight,
              needsScroll: modalContent.scrollHeight > modalContent.clientHeight
            } : null
          };
        });
        
        console.log('Modal info:', JSON.stringify(modalInfo, null, 2));
        
        if (modalInfo.modalVisible && modalInfo.contentDimensions) {
          if (modalInfo.contentDimensions.width > device.width) {
            issues.push({
              device: device.name,
              severity: 'Important',
              category: 'Modal',
              issue: 'Settings modal wider than viewport',
              details: `Modal width ${modalInfo.contentDimensions.width}px exceeds viewport ${device.width}px`,
              reproduction: 'Open settings modal and check width'
            });
          }
        }
        
        // Take screenshot of modal
        await page.screenshot({ 
          path: `/tmp/mobile-audit-${device.name.replace(' ', '-')}-settings.png`,
          fullPage: true 
        });
        
        // Close modal
        const closeBtn = await page.$('.close-menu-btn, .modal-close, .close-btn');
        if (closeBtn) {
          await closeBtn.click();
          await page.waitForTimeout(300);
        }
      }
      
      // Test 6: Check for touch target sizes
      console.log('Testing touch target sizes...');
      const touchTargets = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, .tab-close, .session-tab, .bottom-nav-item');
        const smallTargets = [];
        
        buttons.forEach(btn => {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
            smallTargets.push({
              element: btn.className,
              width: rect.width,
              height: rect.height,
              text: btn.textContent.trim().substring(0, 30)
            });
          }
        });
        
        return smallTargets;
      });
      
      if (touchTargets.length > 0) {
        console.log('Small touch targets found:', touchTargets);
        issues.push({
          device: device.name,
          severity: 'Suggestion',
          category: 'Accessibility',
          issue: `${touchTargets.length} touch targets smaller than 44x44px`,
          details: JSON.stringify(touchTargets.slice(0, 5), null, 2),
          reproduction: 'Inspect button sizes - some are less than recommended 44x44px'
        });
      }
      
      // Test 7: Take screenshots
      await page.screenshot({ 
        path: `/tmp/mobile-audit-${device.name.replace(' ', '-')}-home.png`,
        fullPage: true 
      });
      
      // Test 8: Test landscape orientation
      console.log('Testing landscape orientation...');
      await page.setViewportSize({ width: device.height, height: device.width });
      await page.waitForTimeout(500);
      
      const landscapeInfo = await page.evaluate(() => {
        const bottomNav = document.querySelector('.bottom-nav');
        const terminal = document.querySelector('#terminal');
        
        return {
          bottomNavVisible: bottomNav && window.getComputedStyle(bottomNav).display === 'flex',
          terminalVisible: terminal && terminal.offsetHeight > 0,
          bodyOverflow: {
            scrollWidth: document.body.scrollWidth,
            clientWidth: document.body.clientWidth
          }
        };
      });
      
      console.log('Landscape info:', JSON.stringify(landscapeInfo, null, 2));
      
      await page.screenshot({ 
        path: `/tmp/mobile-audit-${device.name.replace(' ', '-')}-landscape.png`,
        fullPage: true 
      });
      
    } catch (error) {
      console.error(`Error testing ${device.name}:`, error);
      issues.push({
        device: device.name,
        severity: 'Critical',
        category: 'Testing',
        issue: 'Test execution failed',
        details: error.message,
        reproduction: 'Run test script'
      });
    }
    
    await context.close();
  }
  
  await browser.close();
  
  // Print summary
  console.log('\n=== AUDIT SUMMARY ===\n');
  console.log(`Total issues found: ${issues.length}\n`);
  
  const bySeverity = {
    'Critical': issues.filter(i => i.severity === 'Critical'),
    'Important': issues.filter(i => i.severity === 'Important'),
    'Suggestion': issues.filter(i => i.severity === 'Suggestion')
  };
  
  for (const [severity, items] of Object.entries(bySeverity)) {
    if (items.length > 0) {
      console.log(`${severity} (${items.length}):`);
      items.forEach(issue => {
        console.log(`  - [${issue.device}] ${issue.category}: ${issue.issue}`);
      });
      console.log('');
    }
  }
  
  // Save issues to JSON for report generation
  const fs = require('fs');
  fs.writeFileSync('/tmp/mobile-audit-issues.json', JSON.stringify(issues, null, 2));
  
  console.log('Screenshots saved to /tmp/');
  console.log('Issues saved to /tmp/mobile-audit-issues.json');
}

runAudit().catch(console.error);
