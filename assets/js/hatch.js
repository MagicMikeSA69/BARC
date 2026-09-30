/* IME — scroll‑driven hatch sequence.
   A sticky hatcher window pins while the surrounding scroller passes, and the
   scroll fraction drives one egg from incubating to a counted chick. Reduced
   motion shows the finished state without pinning. */
(function () {
  "use strict";
  var scroller = document.getElementById("hatch-scroller");
  var stage = document.getElementById("hatch-stage");
  if (!scroller || !stage) return;

  function q(id) { return document.getElementById(id); }
  var el = {
    rock: q("egg-rock"), cap: q("shell-cap"), whole: q("shell-whole"), chick: q("chick"),
    crackL: q("crack-l"), crackR: q("crack-r"), crackLHi: q("crack-l-hi"), crackRHi: q("crack-r-hi"), cracks: q("cracks"), pip: q("pip"),
    reticle: q("reticle"), eyeOpen: q("chick-eye-open"), eyeClosed: q("chick-eye-closed"),
    light: q("hatch-light"), bgPips: q("bg-pips"), probeDot: q("probe-dot"),
    fluff: q("fluff-map"), wet: q("chick-wet"), fog: q("hatch-fog"), shards: q("shards"),
    shard0: q("shard-0"), shard1: q("shard-1"), shard2: q("shard-2"),
    status: q("hatch-status"), day: q("hatch-day"), temp: q("m-temp"), rh: q("m-rh"),
    co2: q("m-co2"), pull: q("m-pull"), phases: q("hatch-phases")
  };
  for (var k in el) { if (!el[k]) return; }
  var phaseItems = Array.prototype.slice.call(el.phases.children);

  var lenL = el.crackL.getTotalLength(), lenR = el.crackR.getTotalLength();
  [el.crackL, el.crackLHi].forEach(function (e) { e.style.strokeDasharray = lenL; });
  [el.crackR, el.crackRHi].forEach(function (e) { e.style.strokeDasharray = lenR; });

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smooth(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
  function fmt(n, d) { return n.toFixed(d); }

  /* Phase boundaries along the scroll (0..1). */
  var P = { internal: 0.18, external: 0.35, zip: 0.42, open: 0.62, out: 0.85 };

  var lastP = -1, lastStatus = "";
  function render(p) {
    if (p === lastP) return;
    lastP = p;
    stage.style.setProperty("--p", p);

    /* Rocking: faint while incubating, strongest while zipping, still once open;
       sharp little jolts while the chick works at the shell. */
    var amp = p < P.internal ? 0.6 : p < P.zip ? 2.2 : p < P.open ? 3 : 0;
    var jolt = (p > P.internal && p < P.open) ? Math.pow(Math.max(0, Math.sin(p * 260)), 10) * 2.4 : 0;
    var theta = Math.sin(p * 95) * amp + jolt;
    el.rock.setAttribute("transform", "rotate(" + theta.toFixed(2) + " 0 200)");

    /* External pip: a small star of fractures appears. */
    var pipT = smooth(P.external, P.zip, p);
    el.pip.setAttribute("transform", "translate(15 -60) scale(" + pipT.toFixed(3) + ")");

    /* Zipping: the crack draws outward from the pip in both directions. */
    var zip = smooth(P.zip, P.open, p);
    el.crackL.style.strokeDashoffset = el.crackLHi.style.strokeDashoffset = lenL * (1 - zip);
    el.crackR.style.strokeDashoffset = el.crackRHi.style.strokeDashoffset = lenR * (1 - zip);

    /* Once the cap starts to lift, the intact shell and drawn crack give way to the two pieces. */
    var open = p >= P.open;
    el.whole.setAttribute("opacity", open ? 0 : 1);
    el.cracks.setAttribute("opacity", open ? 0 : 1);
    el.pip.setAttribute("opacity", open ? 0 : 1);

    /* Chick rises out of the shell; eyes open once it is out. */
    var rise = smooth(P.open, 0.92, p);
    el.chick.setAttribute("transform", "translate(0 " + fmt(-118 * rise, 1) + ")");

    /* Cap: pushed up by the chick's head and tilting on its left hinge, then it
       swings over the rim and hangs off the side of the shell by its membrane. */
    var lift = smooth(P.open, 0.82, p), fall = smooth(0.8, 1, p);
    var angle = -22 * lift - 88 * fall;
    var tx = -6 * lift - 12 * fall;
    var ty = -118 * rise * 0.6 * (1 - fall) + 10 * fall;
    el.cap.setAttribute("transform", "translate(" + fmt(tx, 1) + " " + fmt(ty, 1) + ") rotate(" + fmt(angle, 1) + " -125 -60)");
    var awake = p > 0.9;
    el.eyeOpen.setAttribute("opacity", awake ? 1 : 0);
    el.eyeClosed.setAttribute("opacity", awake ? 0 : 1);

    /* Shell fragments fall from the pip and come to rest in the basket. */
    var drop = smooth(P.external + 0.02, P.open, p);
    el.shards.setAttribute("opacity", p > P.external + 0.02 ? 1 : 0);
    [el.shard0, el.shard1, el.shard2].forEach(function (sh, i) {
      var t = clamp01(drop * (1.25 - i * 0.12));
      var x = 15 + (i - 1) * 34 * t + 18 * i * t;
      var y = Math.min(-60 + 330 * t * t, 196 - i * 3);
      sh.setAttribute("transform", "translate(" + fmt(x, 1) + " " + fmt(y, 1) + ") rotate(" + fmt(160 * t * (i + 1), 0) + ")");
    });

    /* The chick emerges wet and slick, then fluffs up as it dries under the lamp. */
    var dry = smooth(0.84, 1, p);
    el.fluff.setAttribute("scale", fmt(2.5 + 7.5 * dry, 2));
    el.wet.setAttribute("opacity", fmt(0.6 * (1 - dry), 2));

    /* Humidity fogs the lower glass as the basket hatches. */
    el.fog.setAttribute("opacity", fmt(0.22 * smooth(0.3, 0.9, p), 3));

    /* Vision system locks on and counts; hatcher light cycle comes up; neighbours begin to pip. */
    el.reticle.setAttribute("opacity", smooth(0.9, 0.97, p).toFixed(3));
    el.light.setAttribute("opacity", (0.14 * smooth(0.8, 1, p)).toFixed(3));
    el.bgPips.setAttribute("opacity", smooth(0.7, 0.9, p).toFixed(3));
    el.probeDot.setAttribute("opacity", (0.35 + 0.65 * Math.abs(Math.sin(p * 40))).toFixed(3));

    /* Readouts */
    var day = 19 + 2 * p;
    el.day.textContent = "Day " + fmt(day, 1);
    el.temp.textContent = fmt(37.6 - 0.3 * p, 1) + " °C";
    el.rh.textContent = Math.round(58 + 16 * smooth(0.25, 0.85, p)) + "%";
    el.co2.textContent = fmt(0.45 - 0.17 * smooth(0.1, 0.9, p), 2) + "%";
    var hours = Math.round(36 * (1 - p));
    el.pull.textContent = hours > 0 ? hours + " h" : "Now";

    var idx = p < P.internal ? 0 : p < P.external ? 1 : p < P.zip ? 2 : p < P.open ? 3 : p < P.out ? 4 : 5;
    var labels = ["Incubating", "Internal pip · air cell breached", "External pip", "Zipping", "Hatching", "Hatched · chick 1 counted"];
    if (labels[idx] !== lastStatus) {
      lastStatus = labels[idx];
      el.status.textContent = lastStatus;
      phaseItems.forEach(function (li, i) {
        li.classList.toggle("is-active", i === idx);
        li.classList.toggle("is-done", i < idx);
        if (i === idx) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
      });
    }
  }

  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    stage.classList.add("is-static");
    scroller.classList.add("is-static");
    render(1);
    return;
  }

  function progress() {
    var rect = scroller.getBoundingClientRect();
    var stickyTop = parseFloat(getComputedStyle(stage).top) || 0;
    /* Finish a little before the stage unpins so the hatched frame holds on screen. */
    var travel = (scroller.offsetHeight - stage.offsetHeight) * 0.9;
    if (travel <= 0) return 1;
    return clamp01((stickyTop - rect.top) / travel);
  }
  function measure() { stage.style.setProperty("--stage-h", stage.offsetHeight + "px"); }
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; render(progress()); });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", function () { measure(); onScroll(); });
  measure();
  render(progress());
})();
