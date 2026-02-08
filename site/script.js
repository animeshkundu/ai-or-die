(function () {
  'use strict';

  // Dynamic year
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Mobile hamburger toggle
  const navToggle = document.querySelector('.nav-toggle');
  const navMenu = document.querySelector('.site-header nav');
  if (navToggle && navMenu) {
    navToggle.addEventListener('click', () => {
      navMenu.classList.toggle('nav-open');
      const expanded = navMenu.classList.contains('nav-open');
      navToggle.setAttribute('aria-expanded', expanded);
    });
    navMenu.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        navMenu.classList.remove('nav-open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Copy button handler
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-btn');
    if (btn) {
      const text = btn.dataset.copy;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      }).catch(() => {
        btn.textContent = 'Failed';
        setTimeout(() => {
          btn.textContent = 'Copy';
        }, 2000);
      });
    }
  });

  // Intersection Observer for fade-in
  const fadeEls = document.querySelectorAll('.fade-in');
  if ('IntersectionObserver' in window && fadeEls.length) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    fadeEls.forEach((el) => {
      observer.observe(el);
    });
  } else {
    fadeEls.forEach((el) => {
      el.classList.add('visible');
    });
  }

  // Fetch latest version from GitHub API
  const versionDisplay = document.getElementById('version-display');
  fetch('https://api.github.com/repos/animeshkundu/ai-or-die/releases/latest')
    .then((res) => res.json())
    .then((data) => {
      if (data && data.tag_name && versionDisplay) {
        versionDisplay.textContent = data.tag_name;
      }
    })
    .catch((err) => {
      console.warn('Failed to fetch latest version:', err);
      if (versionDisplay) versionDisplay.textContent = 'latest';
    });

  // Typing animation in the hero terminal
  const typedCmd = document.getElementById('typed-cmd');
  const termOutput = document.getElementById('term-output');
  const cursor = document.querySelector('.cursor');

  if (typedCmd && termOutput) {
    const command = 'npx ai-or-die';
    const outputLines = [
      { text: 'Starting ai-or-die...', cls: 'dim' },
      { text: 'Port: 7777', cls: 'dim' },
      { text: '\uD83D\uDE80 ai-or-die is running at: http://localhost:7777', cls: 'accent' },
      { text: '\uD83D\uDD12 Generated auth token: a8Kp2mXv4Q', cls: '', hasToken: true },
      { text: '', cls: 'dim' },
      { text: 'Press Ctrl+C to stop the server', cls: 'dim' }
    ];

    const BASE_TYPING_DELAY = 60;
    const TYPING_VARIANCE = 40;

    const showOutput = () => {
      let i = 0;
      const addLine = () => {
        if (i >= outputLines.length) return;
        const line = outputLines[i];
        const div = document.createElement('div');
        div.className = 'line' + (line.cls ? ' ' + line.cls : '');

        if (line.hasToken) {
          const parts = line.text.split('a8Kp2mXv4Q');
          div.textContent = parts[0];
          const span = document.createElement('span');
          span.className = 'token';
          span.textContent = 'a8Kp2mXv4Q';
          div.appendChild(span);
          if (parts[1]) div.appendChild(document.createTextNode(parts[1]));
        } else if (line.text === '') {
          div.innerHTML = '&nbsp;';
        } else {
          div.textContent = line.text;
        }

        termOutput.appendChild(div);
        i++;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          addLine();
        } else {
          setTimeout(addLine, 150);
        }
      };
      addLine();
    };

    // Respect prefers-reduced-motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      typedCmd.textContent = command;
      if (cursor) cursor.style.display = 'none';
      showOutput();
    } else {
      let charIndex = 0;
      const typeCommand = () => {
        if (charIndex < command.length) {
          typedCmd.textContent += command[charIndex];
          charIndex++;
          setTimeout(typeCommand, BASE_TYPING_DELAY + Math.random() * TYPING_VARIANCE);
        } else {
          if (cursor) cursor.style.display = 'none';
          setTimeout(showOutput, 400);
        }
      };
      setTimeout(typeCommand, 800);
    }
  }
})();
