// Smooth scroll for internal anchor links, dynamic year, and copy buttons
(function(){
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  document.addEventListener('click', (e) => {
    // Smooth scroll
    const a = e.target.closest('a[href^="#"]');
    if (a) {
      const id = a.getAttribute('href');
      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }

    // Copy button
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
      });
    }
  });
})();

