/*
 * ikuto32 portfolio — リッチ表示（GSAP + ScrollTrigger + Lenis）
 *
 * main.js が「GSAP が読み込めていて、動きを減らす設定でもない」と判断したときだけ
 * window.__rich() を呼ぶ。ここで例外が出た場合は main.js が基本表示に切り替える。
 */
(function () {
  'use strict';

  window.__rich = function (ctx) {
    var gsap = window.gsap;
    var ScrollTrigger = window.ScrollTrigger;
    var root = document.documentElement;
    var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    var EASE = 'expo.out';

    gsap.registerPlugin(ScrollTrigger);

    function all(selector, scope) {
      return gsap.utils.toArray(selector, scope);
    }

    // テキストを1文字ずつ <span> で包む。読み上げ用には元の文章をそのまま残し、
    // 1文字ずつの <span> は aria-hidden にする
    function wrapChars(el, className) {
      var text = el.textContent;
      var chars = [];
      var spoken = document.createElement('span');
      spoken.className = 'sr-only';
      spoken.textContent = text;
      el.textContent = '';
      el.appendChild(spoken);
      Array.from(text).forEach(function (ch) {
        var span = document.createElement('span');
        span.className = className;
        span.setAttribute('aria-hidden', 'true');
        span.textContent = ch;
        el.appendChild(span);
        chars.push(span);
      });
      return chars;
    }

    /* ---------- 慣性スクロール（マウス・トラックパッドのときだけ） ---------- */

    var lenis = null;
    if (window.Lenis && finePointer) {
      lenis = new window.Lenis({ lerp: 0.11, autoRaf: false });
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(function (time) {
        lenis.raf(time * 1000);
      });
      gsap.ticker.lagSmoothing(0);

      // ページ内リンクも Lenis で送る
      var headerHeight = document.querySelector('.header').offsetHeight;
      document.addEventListener('click', function (event) {
        var link = event.target.closest('a[href^="#"]');
        if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
        var target = document.querySelector(link.getAttribute('href'));
        if (!target) return;
        event.preventDefault();
        lenis.scrollTo(target, { offset: target.id === 'top' ? 0 : -headerHeight, duration: 1.4 });
        window.history.replaceState(null, '', link.getAttribute('href'));
        // スキップリンクなどで飛んだ先にフォーカスも移す
        if (link.classList.contains('skip')) {
          target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }
      });
    }

    /* ---------- オープニング → Hero ---------- */

    var opening = gsap.timeline({ defaults: { ease: EASE } });
    var intro = document.querySelector('.intro');

    if (intro && root.classList.contains('is-intro')) {
      var counter = { value: 0 };
      var counterOut = intro.querySelector('[data-intro-count]');
      if (lenis) lenis.stop();
      window.scrollTo(0, 0);

      opening
        .to(counter, {
          value: 100,
          duration: 1.15,
          ease: 'power2.inOut',
          onUpdate: function () {
            counterOut.textContent = String(Math.round(counter.value)).padStart(3, '0');
          }
        })
        .to('.intro__bar', { scaleX: 1, duration: 1.15, ease: 'power2.inOut' }, 0)
        .to(intro, { yPercent: -100, duration: 0.9, ease: 'expo.inOut' }, '+=0.1')
        .add(function () {
          ctx.markIntroSeen();
          gsap.set(intro, { clearProps: 'all' });
          if (lenis) lenis.start();
        })
        .addLabel('hero', '-=0.55');
    } else {
      ctx.markIntroSeen();
      opening.addLabel('hero', 0.1);
    }

    opening
      .add(ctx.announceHero, 'hero')
      .from('.hero__letter', { yPercent: 112, duration: 1.3, stagger: 0.07 }, 'hero')
      .from('.hero__label, .hero__hud', { opacity: 0, y: 16, duration: 0.9 }, 'hero+=0.35')
      .from('.hero__foot', { opacity: 0, y: 24, duration: 1 }, 'hero+=0.45')
      .from('.header', { yPercent: -100, duration: 0.9 }, 'hero+=0.3');

    // スクロールで Hero が奥へ退く
    gsap.to('.hero__title', {
      yPercent: 16,
      ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true }
    });
    gsap.to('.hero__stage', {
      yPercent: 12,
      opacity: 0.15,
      ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true }
    });

    gsap.to('.progress', {
      scaleX: 1,
      ease: 'none',
      scrollTrigger: { start: 0, end: 'max', scrub: 0.3 }
    });

    /* ---------- 見出し・罫線 ---------- */

    all('.section__title').forEach(function (title) {
      var chars = wrapChars(title.querySelector('.mask__in'), 'char');
      gsap.from(chars, {
        yPercent: 112,
        duration: 1.2,
        ease: EASE,
        stagger: 0.045,
        scrollTrigger: { trigger: title, start: 'top 90%', once: true }
      });
    });

    all('.rule').forEach(function (rule) {
      gsap.from(rule, {
        scaleX: 0,
        duration: 1.5,
        ease: EASE,
        scrollTrigger: { trigger: rule, start: 'top 94%', once: true }
      });
    });

    /* ---------- About のリード：スクロールに合わせて文字が色づく ---------- */

    all('[data-fill]').forEach(function (lead) {
      var chars = wrapChars(lead, 'fill');
      gsap.fromTo(chars, { opacity: 0.14 }, {
        opacity: 1,
        ease: 'none',
        stagger: 0.06,
        scrollTrigger: { trigger: lead, start: 'top 82%', end: 'top 30%', scrub: 0.4 }
      });
    });

    /* ---------- せり上がり（まとめて入ってきた要素は順番に） ---------- */

    var revealTargets = all('[data-reveal]').filter(function (el) {
      var type = el.getAttribute('data-reveal');
      return type !== 'mask' && type !== 'rule' && !el.hasAttribute('data-fill');
    });
    gsap.set(revealTargets, { opacity: 0, y: 36 });
    ScrollTrigger.batch(revealTargets, {
      start: 'top 90%',
      once: true,
      onEnter: function (batch) {
        gsap.to(batch, { opacity: 1, y: 0, duration: 1.1, ease: EASE, stagger: 0.09, overwrite: true });
      }
    });

    /* ---------- 画像・デモ：下から幕が開く + パララックス ---------- */

    all('[data-media]').forEach(function (media) {
      gsap.fromTo(media, { clipPath: 'inset(100% 0% 0% 0%)' }, {
        clipPath: 'inset(0% 0% 0% 0%)',
        duration: 1.5,
        ease: 'expo.inOut',
        clearProps: 'clipPath',
        scrollTrigger: { trigger: media, start: 'top 86%', once: true }
      });

      var inner = media.querySelector('[data-parallax]');
      if (inner) {
        gsap.fromTo(inner, { yPercent: -3, scale: 1.07 }, {
          yPercent: 3,
          scale: 1.07,
          ease: 'none',
          scrollTrigger: { trigger: media, start: 'top bottom', end: 'bottom top', scrub: true }
        });
      }
    });

    // スマホ画面のスクリーンショットは、手前に浮いているように少し速く動かす
    all('[data-float]').forEach(function (el) {
      gsap.from(el, {
        opacity: 0,
        y: 60,
        duration: 1.3,
        ease: EASE,
        scrollTrigger: { trigger: el, start: 'top 95%', once: true }
      });
      gsap.fromTo(el, { yPercent: 14 }, {
        yPercent: -14,
        ease: 'none',
        scrollTrigger: { trigger: el.parentNode, start: 'top bottom', end: 'bottom top', scrub: true }
      });
    });

    /* ---------- MV_test：PC では縦スクロールで横に送る ---------- */

    var media = gsap.matchMedia();
    media.add('(min-width: 60rem) and (hover: hover)', function () {
      var films = document.querySelector('[data-films]');
      if (!films) return undefined;
      var track = films.querySelector('.films__track');

      films.classList.add('is-pinned');
      films.scrollLeft = 0;

      // 最後の1本の右端が、画面右の余白の位置にちょうど来るまで送る。
      // ピン留め中は films 自体の幅が変わるので、画面幅から計算する
      function distance() {
        var gutter = parseFloat(getComputedStyle(films).paddingLeft);
        return Math.max(0, track.scrollWidth - (root.clientWidth - 2 * gutter));
      }

      gsap.to(track, {
        x: function () {
          return -distance();
        },
        ease: 'none',
        scrollTrigger: {
          trigger: films,
          start: 'center center',
          end: function () {
            return '+=' + distance();
          },
          pin: true,
          scrub: 0.6,
          anticipatePin: 1,
          invalidateOnRefresh: true
        }
      });

      return function () {
        films.classList.remove('is-pinned');
      };
    });

    /* ---------- Skills の帯：スクロールの速さと向きに反応する ---------- */

    var tracks = all('.marquee__track.is-looped').map(function (el, index) {
      return { el: el, x: 0, half: 0, base: index % 2 ? 1 : -1, set: gsap.quickSetter(el, 'x', 'px') };
    });
    var boost = 0;
    var direction = 1;

    function measureMarquee() {
      tracks.forEach(function (track) {
        track.half = track.el.scrollWidth / 2;
      });
    }

    if (tracks.length) {
      measureMarquee();
      ScrollTrigger.addEventListener('refresh', measureMarquee);
      ScrollTrigger.create({
        onUpdate: function (self) {
          boost = Math.min(Math.abs(self.getVelocity()) / 90, 36);
          direction = self.direction;
        }
      });
      gsap.ticker.add(function (time, deltaTime) {
        boost *= 0.93;
        tracks.forEach(function (track) {
          if (!track.half) return;
          track.x += track.base * direction * (0.045 + boost * 0.03) * deltaTime;
          track.x = gsap.utils.wrap(-track.half, 0, track.x);
          track.set(track.x);
        });
      });
    }

    /* ---------- フッターの大きなロゴ ---------- */

    gsap.from('.footer__mark', {
      yPercent: 70,
      ease: 'none',
      scrollTrigger: { trigger: '.footer', start: 'top bottom', end: 'bottom bottom', scrub: true }
    });

    /* ---------- カーソルと、吸い付くボタン（マウスのときだけ） ---------- */

    if (finePointer) {
      var cursor = document.querySelector('.cursor');
      var cursorLabel = cursor.querySelector('.cursor__label');
      var moveX = gsap.quickTo(cursor, 'x', { duration: 0.4, ease: 'power3' });
      var moveY = gsap.quickTo(cursor, 'y', { duration: 0.4, ease: 'power3' });

      root.classList.add('has-cursor');
      window.addEventListener('pointermove', function (event) {
        if (event.pointerType !== 'mouse') return;
        moveX(event.clientX);
        moveY(event.clientY);
        cursor.classList.add('is-on');
      }, { passive: true });
      root.addEventListener('mouseleave', function () {
        cursor.classList.remove('is-on');
      });
      document.addEventListener('pointerover', function (event) {
        var target = event.target.closest ? event.target.closest('[data-cursor]') : null;
        cursorLabel.textContent = target ? target.getAttribute('data-cursor') : '';
        cursor.classList.toggle('is-label', Boolean(target));
      });

      all('[data-magnetic]').forEach(function (el) {
        var toX = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3' });
        var toY = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3' });
        el.addEventListener('pointermove', function (event) {
          var rect = el.getBoundingClientRect();
          toX((event.clientX - rect.left - rect.width / 2) * 0.35);
          toY((event.clientY - rect.top - rect.height / 2) * 0.35);
        });
        el.addEventListener('pointerleave', function () {
          toX(0);
          toY(0);
        });
      });
    }

    /* ---------- レイアウトが変わったら位置を計算し直す ---------- */

    function refresh() {
      ScrollTrigger.refresh();
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
    window.addEventListener('load', refresh);
  };
})();
