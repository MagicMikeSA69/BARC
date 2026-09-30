/* IME — HX‑6 Aurora launch page behaviours.
   No dependencies. Everything degrades gracefully without JS. */
(function () {
  "use strict";

  var doc = document;
  var root = doc.documentElement;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Navigation: scrolled state ---------- */
  var nav = doc.getElementById("nav");
  function onScroll() {
    if (!nav) return;
    nav.classList.toggle("is-scrolled", window.scrollY > 8);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- Mobile menu ---------- */
  var menuToggle = doc.getElementById("menu-toggle");
  var mobileMenu = doc.getElementById("mobile-menu");
  function setMenu(open) {
    doc.body.classList.toggle("menu-open", open);
    if (menuToggle) {
      menuToggle.setAttribute("aria-expanded", String(open));
      menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    }
  }
  if (menuToggle) {
    menuToggle.addEventListener("click", function () {
      setMenu(!doc.body.classList.contains("menu-open"));
    });
  }
  if (mobileMenu) {
    mobileMenu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setMenu(false);
    });
  }
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && doc.body.classList.contains("menu-open")) setMenu(false);
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth >= 1024) setMenu(false);
  });

  /* ---------- Theme toggle: system → light → dark ---------- */
  var themeBtn = doc.getElementById("theme-toggle");
  function currentTheme() {
    return root.getAttribute("data-theme") || "system";
  }
  function applyTheme(t) {
    if (t === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", t);
    try {
      if (t === "system") localStorage.removeItem("bl-theme");
      else localStorage.setItem("bl-theme", t);
    } catch (err) { /* storage may be unavailable */ }
    if (themeBtn) themeBtn.title = "Theme: " + t;
  }
  if (themeBtn) {
    themeBtn.title = "Theme: " + currentTheme();
    themeBtn.addEventListener("click", function () {
      var order = ["system", "light", "dark"];
      var next = order[(order.indexOf(currentTheme()) + 1) % order.length];
      applyTheme(next);
      toast("Theme: " + next);
    });
  }

  /* ---------- Tabs (demo carousel) ---------- */
  var tablists = doc.querySelectorAll("[role=tablist]");
  Array.prototype.forEach.call(tablists, function (list) {
    var tabs = Array.prototype.slice.call(list.querySelectorAll("[role=tab]"));
    function activate(tab, focus) {
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute("aria-selected", String(selected));
        t.tabIndex = selected ? 0 : -1;
        var panel = doc.getElementById(t.getAttribute("aria-controls"));
        if (panel) {
          if (selected) {
            panel.removeAttribute("hidden");
            panel.setAttribute("data-active", "");
          } else {
            panel.setAttribute("hidden", "");
            panel.removeAttribute("data-active");
          }
        }
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () { activate(tab, false); });
      tab.addEventListener("keydown", function (e) {
        var i = tabs.indexOf(tab);
        var n = null;
        if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") n = tabs[0];
        else if (e.key === "End") n = tabs[tabs.length - 1];
        if (n) { e.preventDefault(); activate(n, true); }
      });
    });
  });

  /* ---------- Reveal on scroll + chart bar growth ----------
     Only elements that start below the fold are hidden, so the page is complete
     at rest (thumbnails, print, and readers without scrolling all see content). */
  var revealTargets = doc.querySelectorAll(".reveal, .viz");
  if ("IntersectionObserver" in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    Array.prototype.forEach.call(revealTargets, function (el) {
      if (el.getBoundingClientRect().top > window.innerHeight) {
        el.classList.add("will-reveal");
        io.observe(el);
      }
    });
  }

  /* ---------- Charts: view toggle + tooltips ---------- */
  var vizzes = doc.querySelectorAll("[data-viz]");
  Array.prototype.forEach.call(vizzes, function (viz) {
    var buttons = viz.querySelectorAll(".viz-actions button[data-view]");
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener("click", function () {
        var view = btn.getAttribute("data-view");
        viz.setAttribute("data-view", view);
        Array.prototype.forEach.call(buttons, function (b) {
          b.setAttribute("aria-pressed", String(b === btn));
        });
      });
    });

    var tip = viz.querySelector(".viz-tip");
    if (!tip) return;
    var rows = viz.querySelectorAll(".bar-row");

    function showTip(row) {
      var series = row.getAttribute("data-series") || "";
      var value = row.getAttribute("data-value") || "";
      var metric = "";
      var mini = row.closest(".mini");
      if (mini) {
        var h = mini.querySelector("h4");
        if (h) metric = h.childNodes[0] ? h.childNodes[0].textContent.trim() : h.textContent.trim();
      }
      tip.innerHTML = "<b>" + escapeHtml(series) + "</b> · " + escapeHtml(value) + (metric ? "<br>" + escapeHtml(metric) : "");
      var vr = viz.getBoundingClientRect();
      var bar = row.querySelector(".bar");
      var br = (bar || row).getBoundingClientRect();
      var x = br.left - vr.left + Math.min(br.width, 160) / 2;
      var first = row === row.parentNode.firstElementChild;
      /* First row in a group sits under the metric title, so drop its tip below the bar. */
      var y = first ? br.bottom - vr.top + 8 : br.top - vr.top - 8;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
      tip.style.transform = first ? "translate(-50%, 0)" : "translate(-50%, -100%)";
      tip.classList.add("show");
      tip.setAttribute("aria-hidden", "false");
    }
    function hideTip() {
      tip.classList.remove("show");
      tip.setAttribute("aria-hidden", "true");
    }
    Array.prototype.forEach.call(rows, function (row) {
      row.addEventListener("mouseenter", function () { showTip(row); });
      row.addEventListener("mouseleave", hideTip);
      row.addEventListener("focus", function () { showTip(row); });
      row.addEventListener("blur", hideTip);
    });
  });

  /* ---------- Share rail ---------- */
  var shareButtons = doc.querySelectorAll("[data-share]");
  Array.prototype.forEach.call(shareButtons, function (btn) {
    btn.addEventListener("click", function () {
      var url = window.location.href.split("#")[0];
      var title = doc.title;
      var kind = btn.getAttribute("data-share");
      if (kind === "copy") {
        copyText(url).then(function () { toast("Link copied"); }, function () { toast("Copy failed"); });
      } else if (kind === "x") {
        openShare("https://twitter.com/intent/tweet?text=" + encodeURIComponent(title) + "&url=" + encodeURIComponent(url));
      } else if (kind === "linkedin") {
        openShare("https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(url));
      } else if (kind === "mail") {
        window.location.href = "mailto:?subject=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(url);
      }
    });
  });
  function openShare(href) {
    window.open(href, "_blank", "noopener,noreferrer,width=600,height=520");
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = doc.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      doc.body.appendChild(ta);
      ta.select();
      try { doc.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); }
      doc.body.removeChild(ta);
    });
  }

  /* ---------- Toast ---------- */
  var toastEl = doc.getElementById("toast");
  var toastTimer;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1800);
  }

  /* ---------- Footer year ---------- */
  var year = doc.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
