/*
 * ikuto32 portfolio — 起動と基本表示
 *
 * <head> で同期読み込みし、描画前に html.js を付ける。そのあと DOM の準備ができた時点で
 *   - GSAP が読み込めていて、動きを減らす設定でもない → rich.js に任せる（html.is-rich）
 *   - それ以外                                       → このファイルの基本表示（CSS トランジション）
 * のどちらかに決める。CDN が遅い・落ちているときも基本表示で必ず中身が出る。
 */
(function () {
  'use strict';

  if (!('IntersectionObserver' in window)) return;

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  root.classList.add('js');

  // オープニングは同じタブで1回だけ
  var introSeen = false;
  try {
    introSeen = window.sessionStorage.getItem('intro') === '1';
  } catch (e) { /* ストレージが使えない環境では毎回出る */ }
  if (!reduceMotion && !introSeen) root.classList.add('is-intro');

  function markIntroSeen() {
    root.classList.remove('is-intro');
    try {
      window.sessionStorage.setItem('intro', '1');
    } catch (e) { /* 無視 */ }
  }

  // Hero が出たことを点群（lab.js）に知らせる。先に読み込まれていなくても拾えるようフラグも残す
  function announceHero() {
    window.__heroShown = true;
    window.dispatchEvent(new Event('hero:show'));
  }

  /* ---------- どのモードでも使うもの ---------- */

  function highlightCurrentNav() {
    var links = {};
    document.querySelectorAll('.nav__link').forEach(function (link) {
      links[link.getAttribute('href').slice(1)] = link;
    });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = links[entry.target.id];
        if (!link) return;
        if (entry.isIntersecting) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }, { rootMargin: '-45% 0px -55% 0px' });

    document.querySelectorAll('main section[id]').forEach(function (section) {
      observer.observe(section);
    });
  }

  // 映像は画面に入っている間だけ再生する。動きを減らす設定では自動再生せず、操作ボタンを出す
  function setupVideos() {
    var videos = document.querySelectorAll('.film__video');
    if (reduceMotion) {
      videos.forEach(function (video) {
        video.controls = true;
      });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var video = entry.target;
        if (entry.isIntersecting) {
          var playing = video.play();
          if (playing && playing.catch) playing.catch(function () { /* 自動再生が拒否されたらポスターのまま */ });
        } else {
          video.pause();
        }
      });
    }, { threshold: 0.35 });
    videos.forEach(function (video) {
      observer.observe(video);
    });
  }

  // 帯の中身を複製して、-50% まで流すと継ぎ目なくループするようにする
  function loopMarquee() {
    if (reduceMotion) return;
    document.querySelectorAll('.marquee__track').forEach(function (track) {
      Array.prototype.slice.call(track.children).forEach(function (item) {
        track.appendChild(item.cloneNode(true));
      });
      track.classList.add('is-looped');
    });
  }

  /* ---------- 基本表示（GSAP なし） ---------- */

  // data-stagger の子要素を少しずつ遅らせる（CSSOM 経由なので CSP の style-src に掛からない）
  function staggerChildren() {
    document.querySelectorAll('[data-stagger]').forEach(function (group) {
      group.querySelectorAll('[data-reveal]').forEach(function (el, i) {
        el.style.setProperty('--d', Math.min(i * 0.08, 0.4) + 's');
      });
    });
  }

  function revealOnScroll() {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        // ページ内リンクで途中に飛んだとき、すでに通り過ぎた要素も表示済みにする
        if (!entry.isIntersecting && entry.boundingClientRect.top >= 0) return;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });

    document.querySelectorAll('[data-reveal]').forEach(function (el) {
      observer.observe(el);
    });
  }

  // Web フォントの読み込みを最大 0.8 秒だけ待って、字形の切り替わりを見せない
  function showHero() {
    var done = false;
    function show() {
      if (done) return;
      done = true;
      root.classList.add('is-loaded');
      announceHero();
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(show);
    }
    setTimeout(show, 800);
  }

  function startBasic() {
    markIntroSeen();
    staggerChildren();
    revealOnScroll();
    showHero();
  }

  /* ---------- 起動 ---------- */

  var started = false;

  function start() {
    if (started || document.readyState === 'loading') return;
    started = true;

    highlightCurrentNav();
    setupVideos();
    loopMarquee();

    var canBeRich = !reduceMotion && window.gsap && window.ScrollTrigger && typeof window.__rich === 'function';
    if (canBeRich) {
      root.classList.add('is-rich');
      try {
        window.__rich({ markIntroSeen: markIntroSeen, announceHero: announceHero });
        return;
      } catch (error) {
        // 演出の初期化に失敗しても、中身は必ず見せる
        root.classList.remove('is-rich');
        if (window.console) console.error(error);
      }
    }
    startBasic();
  }

  document.addEventListener('DOMContentLoaded', start);
  // defer のスクリプト（CDN）が遅いと DOMContentLoaded も遅れる。3.5 秒で見切って基本表示にする
  setTimeout(start, 3500);
})();
