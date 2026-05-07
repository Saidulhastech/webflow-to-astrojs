/*!
 * site-ui.js — companion to webflow.js (MIT-licensed Webflow runtime).
 *
 * Roles:
 *   1. Re-init webflow.js after Astro ViewTransitions page swaps. webflow.js
 *      runs once on initial DOMContentLoaded; client-side nav swaps the DOM
 *      without firing that event so all IX2 / slider / tab / dropdown / nav
 *      bindings get lost on subsequent pages.
 *   2. Lightweight fallback bindings if webflow.js failed to load (slider /
 *      dropdown / nav-toggle). No-op when window.Webflow is present.
 */
(function () {
  'use strict';

  function reinitWebflow() {
    if (!window.Webflow) return false;
    try {
      // Tear down + re-mount every IX2/slider/tab/dropdown binding.
      if (typeof window.Webflow.destroy === 'function') window.Webflow.destroy();
      if (typeof window.Webflow.ready   === 'function') window.Webflow.ready();
      // Re-init Interactions 2.0 explicitly — `ready()` alone doesn't always
      // pick up newly-injected nodes after a ViewTransitions swap.
      if (typeof window.Webflow.require === 'function') {
        try { window.Webflow.require('ix2').init(); } catch (_) { /* IX2 absent */ }
      }
      return true;
    } catch (_) { return false; }
  }

  // Astro ViewTransitions hook.
  document.addEventListener('astro:page-load', function () {
    // Defer one rAF so the swapped DOM is painted before Webflow re-binds.
    requestAnimationFrame(reinitWebflow);
  });

  // ── Vanilla fallback (only fires if webflow.js never loaded) ─────────────
  function fallbackBoot() {
    if (window.Webflow) return; // Webflow runtime already handles everything.

    // Slider — minimal fade autoplay.
    document.querySelectorAll('.slider, .w-slider').forEach(function (root) {
      if (root.__siteSliderInit) return;
      root.__siteSliderInit = true;
      var mask = root.querySelector('.slider-mask, .w-slider-mask');
      if (!mask) return;
      var slides = Array.prototype.slice.call(mask.children).filter(function (n) {
        return n.classList && (n.classList.contains('slide') || n.classList.contains('w-slide'));
      });
      if (slides.length < 2) return;
      slides.forEach(function (s, i) { s.style.transition = 'opacity .5s'; if (i) s.style.opacity = '0'; });
      var idx = 0;
      function step() {
        slides[idx].style.opacity = '0';
        idx = (idx + 1) % slides.length;
        slides[idx].style.opacity = '1';
      }
      setInterval(step, parseInt(root.getAttribute('data-delay'), 10) || 4000);
    });

    // Dropdown click + hover.
    document.querySelectorAll('.dropdown, .w-dropdown').forEach(function (root) {
      if (root.__siteDropdownInit) return;
      root.__siteDropdownInit = true;
      var toggle = root.querySelector('.dropdown-toggle, .w-dropdown-toggle');
      var list   = root.querySelector('.dropdown-list, .w-dropdown-list');
      if (!toggle || !list) return;
      function toggleOpen() {
        var open = !root.classList.contains('w--open');
        root.classList.toggle('w--open', open);
        list.classList.toggle('w--open', open);
        toggle.classList.toggle('w--open', open);
        toggle.setAttribute('aria-expanded', String(open));
      }
      toggle.addEventListener('click', function (e) { e.stopPropagation(); toggleOpen(); });
      document.addEventListener('click', function (e) {
        if (!root.contains(e.target)) {
          root.classList.remove('w--open');
          list.classList.remove('w--open');
          toggle.classList.remove('w--open');
        }
      });
    });

    // Nav menu hamburger.
    document.querySelectorAll('.nav-menu-button, .hamburger-menu-icon-wrapper, .nav-button, .w-nav-button').forEach(function (btn) {
      if (btn.__siteNavInit) return;
      btn.__siteNavInit = true;
      var menu = document.querySelector('.full-screen-menu, .w-nav-overlay');
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!menu) return;
        var open = menu.classList.contains('hidden') || !menu.classList.contains('is-open');
        menu.classList.toggle('hidden', !open);
        menu.classList.toggle('is-open', open);
        document.body.classList.toggle('menu-open', open);
      });
    });

    // Entrance animations: strip inline opacity:0/transform on intersection.
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var s = e.target.style;
          s.transition = s.transition || 'transform .9s cubic-bezier(.215,.61,.355,1),opacity .9s ease';
          requestAnimationFrame(function () {
            s.transform = ''; s.webkitTransform = ''; s.mozTransform = ''; s.msTransform = '';
            s.opacity = '';
          });
          io.unobserve(e.target);
        });
      }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
      document.querySelectorAll('[style*="opacity:0"], [style*="opacity: 0"]').forEach(function (el) {
        if (el.__animInit) return;
        el.__animInit = true;
        io.observe(el);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fallbackBoot);
  } else {
    fallbackBoot();
  }
})();
