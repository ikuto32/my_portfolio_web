/*
 * ikuto32 portfolio — インタラクティブ要素（WebAssembly + p5.js）
 *
 *   cloud    Hero のドローン点群。回転・投影・点の描き込みは Wasm、入力と重ね描きは p5.js
 *   pyramid  super-resolution-gan のカード。Gray–Scott モデルを Wasm で回し、解像度違いで見比べる
 *   thin     font-length のカード。文字を Wasm で細線化して長さを測る
 *
 * 計算は wasm/src/lib.rs（Rust）にあり、ここは canvas・入力・表示だけを受け持つ。
 * p5.js は大きいので、最初の要素が画面に近づいてから読み込む。
 * 読み込みに失敗した要素には .is-failed が付き、代わりの説明文が出る。
 */
(function () {
  'use strict';

  var P5_URL = 'https://cdn.jsdelivr.net/npm/p5@1.11.13/lib/p5.min.js';
  var P5_INTEGRITY = 'sha384-+4pFSzqrHIcjFoiZQ8s1jUHqNylTGybto+iELDyMA+UQ0UhpTH0B92zF4Bg0mawP';
  var WASM_URL = '/assets/wasm/lab.wasm';
  var MONO = 'JetBrains Mono, ui-monospace, Consolas, monospace';

  if (!('WebAssembly' in window) || !('IntersectionObserver' in window)) {
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll('[data-lab]').forEach(function (host) {
        host.classList.add('is-failed');
      });
    });
    return;
  }

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var palette = { ink: '#111110', accent: '#FF4A1C', muted: '#62615C', paper: '#F2F0EA' };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readPalette() {
    var style = getComputedStyle(document.documentElement);
    var names = { ink: '--fg', accent: '--accent', muted: '--muted', paper: '--bg' };
    Object.keys(names).forEach(function (key) {
      var value = style.getPropertyValue(names[key]).trim();
      if (/^#[0-9a-f]{6}$/i.test(value)) palette[key] = value;
    });
  }

  function hexToInt(hex) {
    return parseInt(hex.slice(1), 16);
  }

  /* ---------- 読み込み ---------- */

  function loadWasm() {
    function fromBytes() {
      return fetch(WASM_URL)
        .then(function (response) {
          if (!response.ok) throw new Error('lab.wasm: HTTP ' + response.status);
          return response.arrayBuffer();
        })
        .then(function (bytes) {
          return WebAssembly.instantiate(bytes, {});
        });
    }
    var loading = WebAssembly.instantiateStreaming
      ? WebAssembly.instantiateStreaming(fetch(WASM_URL), {}).catch(fromBytes)
      : fromBytes();

    return loading.then(function (result) {
      var wasm = result.instance.exports;
      readPalette();
      wasm.set_palette(hexToInt(palette.ink), hexToInt(palette.accent), hexToInt(palette.muted), hexToInt(palette.paper));
      return wasm;
    });
  }

  function loadP5() {
    return new Promise(function (resolve, reject) {
      if (window.p5) {
        resolve(window.p5);
        return;
      }
      var script = document.createElement('script');
      script.src = P5_URL;
      script.integrity = P5_INTEGRITY;
      script.crossOrigin = 'anonymous';
      script.async = true;
      script.onload = function () {
        if (window.p5) resolve(window.p5);
        else reject(new Error('p5.js loaded but window.p5 is missing'));
      };
      script.onerror = function () {
        reject(new Error('p5.js failed to load'));
      };
      document.head.appendChild(script);
    });
  }

  var ready = null;
  function load() {
    if (!ready) {
      ready = Promise.all([loadWasm(), loadP5()]).then(function (parts) {
        return { wasm: parts[0], P5: parts[1] };
      });
    }
    return ready;
  }

  // 画面に入っている間だけ描画ループを回す
  function loopWhileVisible(p, element) {
    if (reduceMotion) return;
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) p.loop();
      else p.noLoop();
    }).observe(element);
  }

  /* ==========================================================================
     cloud — Hero の点群
     ========================================================================== */

  function mountCloud(host, env) {
    var wasm = env.wasm;
    var hero = host.closest('.hero') || host;
    var header = document.querySelector('.header');
    var heroLabel = hero.querySelector('.hero__label');
    var countOut = document.querySelector('[data-cloud-count]');
    var total = wasm.cloud_init(32);
    if (countOut) countOut.textContent = total.toLocaleString('en-US');

    new env.P5(function (p) {
      var frame = null; // Wasm のメモリを直接参照する ImageData（コピーなしで描ける）
      var fw = 0;
      var fh = 0;
      var density = 1;
      var yaw = 0.75;
      var pitch = 0.34;
      var spin = 0;
      var pointer = { x: -1, y: -1, down: false, lastX: 0, lastY: 0 };
      var reveal = reduceMotion ? 1 : 0;
      var revealing = reduceMotion;
      var isSetUp = false;

      function fit() {
        if (!isSetUp) return;
        var w = host.clientWidth;
        var h = host.clientHeight;
        var capacity = wasm.fb_capacity();
        density = Math.min(window.devicePixelRatio || 1, 2);
        while (density > 0.5 && Math.floor(w * density) * Math.floor(h * density) > capacity) density -= 0.25;
        p.pixelDensity(density);
        p.resizeCanvas(w, h);
        fw = p.canvas.width;
        fh = p.canvas.height;
        frame = fw > 0 && fh > 0 && fw * fh <= capacity
          ? new ImageData(new Uint8ClampedArray(wasm.memory.buffer, wasm.fb_ptr(), fw * fh * 4), fw, fh)
          : null;
        if (reduceMotion) p.redraw();
      }

      // 検出枠。ポインターで点を散らすと、そのぶん確信度が下がる
      function drawDetection(t) {
        var box = new Float32Array(wasm.memory.buffer, wasm.cloud_bbox_ptr(), 4);
        if (reveal < 1 || box[2] <= box[0]) return;
        var pad = 12;
        var x0 = box[0] / density - pad;
        var y0 = box[1] / density - pad;
        var x1 = box[2] / density + pad;
        var y1 = box[3] / density + pad;
        var arm = 14;

        var confidence = 0.97 + 0.012 * Math.sin(t * 2.3);
        if (pointer.x >= 0) {
          var reach = Math.max(x1 - x0, y1 - y0) * 0.62;
          var away = Math.hypot(pointer.x - (x0 + x1) / 2, pointer.y - (y0 + y1) / 2);
          confidence -= 0.46 * Math.max(0, 1 - away / reach);
        }

        p.noFill();
        p.stroke(palette.accent);
        p.strokeWeight(1.5);
        p.line(x0, y0, x0 + arm, y0); p.line(x0, y0, x0, y0 + arm);
        p.line(x1, y0, x1 - arm, y0); p.line(x1, y0, x1, y0 + arm);
        p.line(x0, y1, x0 + arm, y1); p.line(x0, y1, x0, y1 - arm);
        p.line(x1, y1, x1 - arm, y1); p.line(x1, y1, x1, y1 - arm);

        var label = 'DRONE ' + confidence.toFixed(2);
        p.noStroke();
        p.textSize(10);
        var labelWidth = p.textWidth(label) + 12;
        p.fill(palette.accent);
        p.rect(x0, y0 - 20, labelWidth, 16);
        p.fill(palette.ink);
        p.text(label, x0 + 6, y0 - 8.5);
      }

      p.setup = function () {
        p.createCanvas(host.clientWidth, host.clientHeight);
        p.textFont(MONO);
        if (reduceMotion) p.noLoop();
        isSetUp = true;
        fit();
      };

      p.windowResized = fit;

      p.draw = function () {
        if (!frame) return;
        var t = p.millis() / 1000;

        if (!pointer.down) {
          yaw += (reduceMotion ? 0 : 0.0032) + spin;
          spin *= 0.94;
          pitch += (0.34 - pitch) * 0.03;
        }
        if (revealing && reveal < 1) reveal = Math.min(1, reveal + p.deltaTime / 2400);

        // ヘッダーの下から「Portfolio / 2026」のラベルの上までの空きに収める
        // （フォントの読み込みで見出しの高さが変わるので、毎フレーム測る）。
        // 縦長の画面では中央、横長では右寄りに置く
        var w = p.width;
        var portrait = p.height > w * 1.15;
        var bandTop = header ? header.offsetHeight : 0;
        var bandHeight = Math.max(120, (heroLabel ? heroLabel.offsetTop : p.height * 0.5) - bandTop);
        var scale = Math.min(w * (portrait ? 0.36 : 0.2), bandHeight * 0.92);
        var cx = portrait ? w * 0.5 : w * 0.56;
        var cy = bandTop + bandHeight * 0.5;

        wasm.cloud_render(
          fw, fh, yaw, pitch,
          scale * density, cx * density, cy * density, t,
          pointer.x < 0 ? -1 : pointer.x * density, pointer.y * density,
          reveal, density >= 1.5 ? 2 : 1
        );
        p.drawingContext.putImageData(frame, 0, 0);
        drawDetection(t);
      };

      /* 入力：Hero のどこでもドラッグで回せる。上に重なっている文字越しでも効くよう、
         canvas ではなく Hero 全体で受ける */
      function release() {
        pointer.down = false;
        hero.classList.remove('is-dragging');
      }

      hero.addEventListener('pointerdown', function (event) {
        if (event.target.closest('a, button')) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        pointer.down = true;
        pointer.lastX = event.clientX;
        pointer.lastY = event.clientY;
        hero.classList.add('is-dragging');
      });

      window.addEventListener('pointermove', function (event) {
        var rect = host.getBoundingClientRect();
        var inside = event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom;
        pointer.x = inside ? event.clientX - rect.left : -1;
        pointer.y = event.clientY - rect.top;

        if (pointer.down) {
          var dx = event.clientX - pointer.lastX;
          var dy = event.clientY - pointer.lastY;
          yaw += dx * 0.008;
          pitch = clamp(pitch + dy * 0.006, -0.15, 1.15);
          spin = clamp(dx * 0.0012, -0.05, 0.05);
          pointer.lastX = event.clientX;
          pointer.lastY = event.clientY;
        }
        if (reduceMotion && (pointer.down || inside)) p.redraw();
      }, { passive: true });

      window.addEventListener('pointerup', function (event) {
        release();
        if (event.pointerType !== 'mouse') pointer.x = -1;
      });
      window.addEventListener('pointercancel', function () {
        release();
        pointer.x = -1;
      });

      // Hero の文字が出るタイミングに合わせて、散らばった点を集める
      function startReveal() {
        revealing = true;
      }
      if (window.__heroShown) startReveal();
      else window.addEventListener('hero:show', startReveal, { once: true });
      setTimeout(startReveal, 2500);

      if ('ResizeObserver' in window) new ResizeObserver(fit).observe(host);
      loopWhileVisible(p, hero);
    }, host);
  }

  /* ==========================================================================
     pyramid — super-resolution-gan
     ========================================================================== */

  function mountPyramid(host, env) {
    var wasm = env.wasm;
    var stage = host.querySelector('[data-lab-canvas]');
    var chips = Array.prototype.slice.call(host.querySelectorAll('[data-res]'));
    var autoButton = host.querySelector('[data-action="auto"]');
    var resetButton = host.querySelector('[data-action="reset"]');

    var SIZE = wasm.rd_size();
    var FEED = 0.0367; // 分裂して増える斑点（MV「微分方程式」と同じ係数）
    var KILL = 0.0649;
    var LEVELS = chips.map(function (chip) {
      return Number(chip.getAttribute('data-res'));
    });

    var level = 3;
    var auto = !reduceMotion;
    var lastSwitch = 0;
    var lastErase = 0;
    var split = 0.5;
    var pointer = { x: 0.5, y: 0.5, over: false, down: false };
    var sketch = null;

    var fastForward = 0; // 始めた直後だけ早送りして、模様が育つところを見せる

    function seed() {
      wasm.rd_reset((Math.random() * 0xffffffff) >>> 0);
      if (reduceMotion) wasm.rd_step(5000, FEED, KILL);
      else fastForward = 45;
    }

    function syncControls() {
      chips.forEach(function (chip, index) {
        chip.setAttribute('aria-pressed', String(index === level));
      });
      autoButton.setAttribute('aria-pressed', String(auto));
    }

    function redraw() {
      if (reduceMotion && sketch) sketch.redraw();
    }

    chips.forEach(function (chip, index) {
      chip.addEventListener('click', function () {
        level = index;
        auto = false;
        syncControls();
        redraw();
      });
    });
    autoButton.addEventListener('click', function () {
      auto = !auto;
      syncControls();
    });
    resetButton.addEventListener('click', function () {
      seed();
      redraw();
    });

    function track(event) {
      var rect = stage.getBoundingClientRect();
      pointer.x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      pointer.y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    }
    stage.addEventListener('pointerenter', function (event) {
      pointer.over = true;
      track(event);
    });
    stage.addEventListener('pointermove', function (event) {
      pointer.over = true;
      track(event);
      redraw();
    });
    stage.addEventListener('pointerdown', function (event) {
      pointer.down = true;
      track(event);
      redraw();
    });
    stage.addEventListener('pointerleave', function () {
      pointer.over = false;
      pointer.down = false;
    });
    window.addEventListener('pointerup', function (event) {
      pointer.down = false;
      if (event.pointerType !== 'mouse') pointer.over = false;
    });

    seed();
    syncControls();

    new env.P5(function (p) {
      var hi = null;
      var lo = null;
      sketch = p; // p5 は環境によって setup を同期で呼ぶので、コンストラクタの戻り値は待たない

      function copy(image, slot) {
        image.loadPixels();
        image.pixels.set(new Uint8ClampedArray(wasm.memory.buffer, wasm.rd_fb_ptr(slot), SIZE * SIZE * 4));
        image.updatePixels();
      }

      function tag(text, x, alignRight) {
        p.textSize(10);
        var width = p.textWidth(text) + 14;
        var left = alignRight ? x - width : x;
        p.noStroke();
        p.fill(palette.ink);
        p.rect(left, 10, width, 18);
        p.fill(palette.paper);
        p.text(text, left + 7, 22.5);
      }

      p.setup = function () {
        p.createCanvas(stage.clientWidth, stage.clientWidth);
        p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
        p.textFont(MONO);
        hi = p.createImage(SIZE, SIZE);
        lo = p.createImage(SIZE, SIZE);
        if (reduceMotion) p.noLoop();
      };

      p.windowResized = function () {
        p.resizeCanvas(stage.clientWidth, stage.clientWidth);
        redraw();
      };

      p.draw = function () {
        var now = p.millis();

        if (auto && now - lastSwitch > 1500) {
          level = (level + 1) % LEVELS.length;
          lastSwitch = now;
          syncControls();
        }

        if (!reduceMotion) {
          // ときどき一部を消して、模様が育ち続ける余地をつくる
          if (now - lastErase > 7000) {
            wasm.rd_erase(Math.random() * SIZE, Math.random() * SIZE, 34);
            lastErase = now;
          }
          wasm.rd_step(fastForward > 0 ? 70 : 20, FEED, KILL);
          if (fastForward > 0) fastForward -= 1;
        }
        if (pointer.down) {
          wasm.rd_touch(pointer.x * SIZE, pointer.y * SIZE, 5);
          if (reduceMotion) wasm.rd_step(300, FEED, KILL);
        }

        // 境界線：ポインターがあれば追従、なければゆっくり往復
        var target = pointer.over ? clamp(pointer.x, 0.04, 0.96) : 0.5 + (reduceMotion ? 0 : 0.24 * Math.sin(now / 1900));
        split += (target - split) * (reduceMotion ? 1 : 0.14);

        var res = LEVELS[level];
        wasm.rd_render(0, SIZE);
        wasm.rd_render(1, res);
        copy(hi, 0);
        copy(lo, 1);

        var w = p.width;
        var h = p.height;
        var cut = Math.round(split * SIZE);
        var edge = cut / SIZE * w;
        var context = p.drawingContext;

        p.clear();
        context.imageSmoothingEnabled = false; // 低解像度側はドットをくっきり見せる
        if (cut > 0) p.image(lo, 0, 0, edge, h, 0, 0, cut, SIZE);
        context.imageSmoothingEnabled = true;
        if (cut < SIZE) p.image(hi, edge, 0, w - edge, h, cut, 0, SIZE - cut, SIZE);

        p.stroke(palette.ink);
        p.strokeWeight(1.5);
        p.line(edge, 0, edge, h);
        p.noStroke();
        p.fill(palette.ink);
        p.circle(edge, h / 2, 26);
        p.fill(palette.paper);
        p.triangle(edge - 9, h / 2, edge - 4, h / 2 - 4, edge - 4, h / 2 + 4);
        p.triangle(edge + 9, h / 2, edge + 4, h / 2 - 4, edge + 4, h / 2 + 4);

        tag(res + ' × ' + res, 10, false);
        tag(SIZE + ' × ' + SIZE, w - 10, true);
      };

      loopWhileVisible(p, host);
    }, stage);
  }

  /* ==========================================================================
     thin — font-length
     ========================================================================== */

  function mountThin(host, env) {
    var wasm = env.wasm;
    var stage = host.querySelector('[data-lab-canvas]');
    var input = host.querySelector('[data-thin-input]');
    var charButtons = Array.prototype.slice.call(host.querySelectorAll('[data-char]'));
    var fontButtons = Array.prototype.slice.call(host.querySelectorAll('[data-font]'));
    var replayButton = host.querySelector('[data-action="replay"]');
    var iterOut = host.querySelector('[data-thin-iter]');
    var lengthOut = host.querySelector('[data-thin-len]');
    var inkOut = host.querySelector('[data-thin-ink]');

    var N = Math.min(448, wasm.glyph_max()); // 細線化する画像の一辺（px）
    // 太字だと画数の多い字で線どうしがくっつき、芯の形が変わってしまうので標準の太さで描く
    var FONTS = {
      sans: '400 SIZEpx "Hiragino Sans", "Hiragino Kaku Gothic ProN", "BIZ UDPGothic", "Yu Gothic UI", "Noto Sans JP", Meiryo, sans-serif',
      serif: '400 SIZEpx "Hiragino Mincho ProN", "Yu Mincho", "BIZ UDPMincho", "Noto Serif JP", serif'
    };

    var character = input.value || '鬱';
    var font = 'sans';
    var em = N;
    var iterations = 0;
    var done = false;
    var sketch = null;
    var raster = null;
    var wantStart = false;

    // 文字を N×N に収まる最大の大きさで中央に描き、白黒のマスクにして Wasm へ渡す
    function rasterise() {
      var context = raster.drawingContext;
      var size = N * 0.82;
      var limit = N * 0.84;
      var metrics = null;
      var inkWidth = 0;
      var inkHeight = 0;

      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, N, N);
      context.fillStyle = '#000';
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';

      for (var attempt = 0; attempt < 3; attempt += 1) {
        context.font = FONTS[font].replace('SIZE', size.toFixed(1));
        metrics = context.measureText(character);
        inkWidth = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight;
        inkHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
        var largest = Math.max(inkWidth, inkHeight);
        if (largest <= limit || largest === 0) break;
        size *= limit / largest;
      }

      context.fillText(
        character,
        (N - inkWidth) / 2 + metrics.actualBoundingBoxLeft,
        (N - inkHeight) / 2 + metrics.actualBoundingBoxAscent
      );
      var pixels = context.getImageData(0, 0, N, N).data;
      context.restore();

      var mask = new Uint8Array(wasm.memory.buffer, wasm.glyph_ptr(), N * N);
      for (var i = 0; i < N * N; i += 1) mask[i] = pixels[i * 4] < 128 ? 1 : 0;

      em = size;
      return wasm.glyph_begin(N, N);
    }

    function start() {
      wantStart = true;
      if (!sketch || !raster) return; // setup がまだなら、setup の最後でもう一度呼ばれる
      var ink = rasterise();
      iterations = 0;
      done = false;
      iterOut.textContent = '0';
      lengthOut.textContent = '…';
      inkOut.textContent = ink.toLocaleString('en-US') + ' px';
      sketch.loop();
    }

    function setCharacter(value) {
      var chars = Array.from(String(value).replace(/\s/g, ''));
      if (!chars.length) return;
      character = chars[chars.length - 1];
      if (input.value !== character) input.value = character;
      start();
    }

    input.addEventListener('input', function (event) {
      if (event.isComposing) return; // 日本語入力の変換中は待つ
      setCharacter(input.value);
    });
    input.addEventListener('compositionend', function () {
      setCharacter(input.value);
    });
    input.addEventListener('focus', function () {
      input.select();
    });
    charButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        setCharacter(button.getAttribute('data-char'));
      });
    });
    fontButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        font = button.getAttribute('data-font');
        fontButtons.forEach(function (other) {
          other.setAttribute('aria-pressed', String(other === button));
        });
        start();
      });
    });
    replayButton.addEventListener('click', start);

    new env.P5(function (p) {
      var image = null;
      sketch = p;

      p.setup = function () {
        p.createCanvas(stage.clientWidth, stage.clientWidth);
        p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
        raster = p.createGraphics(N, N);
        raster.pixelDensity(1);
        image = p.createImage(N, N);
        p.noLoop();
        if (wantStart) start();
      };

      p.windowResized = function () {
        p.resizeCanvas(stage.clientWidth, stage.clientWidth);
        p.redraw();
      };

      p.draw = function () {
        if (!done) {
          // 1層ずつ削る様子が見えるよう、3フレームに1回だけ進める（動きを減らす設定では一気に）
          var steps = reduceMotion ? 400 : (p.frameCount % 3 === 0 ? 1 : 0);
          for (var i = 0; i < steps && !done; i += 1) {
            if (wasm.thin_step(N, N) === 0) done = true;
            else iterations += 1;
          }
          iterOut.textContent = String(iterations);
          if (done) {
            var length = wasm.skeleton_length(N, N);
            lengthOut.textContent = '≈ ' + (length / em).toFixed(2) + ' em';
          }
        }

        wasm.glyph_render(N, N, done ? 1 : 0);
        image.loadPixels();
        image.pixels.set(new Uint8ClampedArray(wasm.memory.buffer, wasm.glyph_fb_ptr(), N * N * 4));
        image.updatePixels();

        p.clear();
        p.image(image, 0, 0, p.width, p.height);
        if (done) p.noLoop();
      };
    }, stage);

    // 画面に入ったときに最初の1回を始める（入るたびにやり直すことはしない）
    var seen = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      seen.disconnect();
      // Web フォントや端末フォントの準備を待ってから描く
      var fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      fontsReady.then(start);
    }, { threshold: 0.25 });
    seen.observe(stage);
  }

  /* ---------- 起動 ---------- */

  var mounts = { cloud: mountCloud, pyramid: mountPyramid, thin: mountThin };

  function boot(host) {
    load()
      .then(function (env) {
        mounts[host.getAttribute('data-lab')](host, env);
        host.classList.add('is-live');
      })
      .catch(function (error) {
        host.classList.add('is-failed');
        if (window.console) console.warn('[lab] ' + host.getAttribute('data-lab') + ': ' + error.message);
      });
  }

  function init() {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        boot(entry.target);
      });
    }, { rootMargin: '700px 0px' });

    document.querySelectorAll('[data-lab]').forEach(function (host) {
      if (mounts[host.getAttribute('data-lab')]) observer.observe(host);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
