# my_portfolio_web

ikuto32 のポートフォリオサイト。1ページ構成で、フレームワークは使っていません。

- HTML / CSS / JavaScript
- Rust → WebAssembly（点群の描画、細線化、反応拡散の計算）
- p5.js（canvas と入力）、GSAP + Lenis（スクロール演出）
- Cloudflare Workers の静的アセットとして配信。`main` への push で自動デプロイ

## 構成

```
.
├─ public/                 配信されるのはこのフォルダの中身だけ
│  ├─ index.html           Hero / About / Works / Skills / Links
│  ├─ 404.html
│  ├─ _headers             セキュリティヘッダー（CSP など）
│  └─ assets/
│     ├─ css/style.css
│     ├─ js/main.js        起動と基本表示（ライブラリなしで動く）
│     ├─ js/rich.js        GSAP / Lenis を使った演出
│     ├─ js/lab.js         Wasm + p5.js のインタラクティブ要素
│     ├─ wasm/lab.wasm     wasm/ のビルド結果（コミットしている）
│     ├─ img/  video/      スクリーンショットと MV の抜粋
├─ wasm/                   Rust のソース（src/lib.rs）と動作確認（test.mjs）
├─ tools/
│  ├─ serve.ps1            ローカル確認用サーバー
│  └─ build-wasm.ps1       Wasm のビルド
└─ wrangler.jsonc          Cloudflare Workers の設定
```

## ローカルで確認する

PowerShell 7 があれば動きます。Node も Python も不要です。

```bash
pwsh tools/serve.ps1
```

<http://localhost:8787/> を開きます。本番に近づけるため、`public/_headers` の CSP などもそのまま付けて返します。

## インタラクティブ要素

計算は Rust（`wasm/src/lib.rs`）、canvas・入力・表示は p5.js（`public/assets/js/lab.js`）という分担です。Wasm 側は RGBA のバッファに直接描き込み、JavaScript はそれを canvas に転送するだけにしています。

| 場所 | 内容 |
| --- | --- |
| Hero | クアッドコプターの3D点群（約13,000点）。回転・透視投影・点の描き込みを Wasm で行う。ドラッグで回転、ポインターで点が散り、検出枠の確信度が下がる |
| super-resolution-gan | Gray–Scott 反応拡散を Wasm で計算し、同じ模様を 1×1〜128×128 と 256×256 で見比べる画像ピラミッドのイメージ図。なぞると模様が増える |
| font-length | 入力した文字を端末のフォントで描き、Zhang–Suen 法で細線化して芯の線の長さを測る。font-length の考え方をブラウザ内で再現したもの |

### Wasm を作り直す

`wasm/src/lib.rs` を変更したら、ビルドして `public/assets/wasm/lab.wasm` を更新します。

```bash
rustup target add wasm32-unknown-unknown
```

```bash
pwsh tools/build-wasm.ps1
```

動作確認は Deno か Node で実行できます。

```bash
deno run --allow-read wasm/test.mjs
```

## 表示のモード

読み込み状況と端末の設定に応じて、3段階で表示します。

1. **JavaScript なし** — 最初から全部見える。デモの場所には説明文が出る
2. **基本表示** — CSS のトランジションだけで要素がせり上がる。CDN のライブラリが読み込めなかったときもここに落ちる
3. **リッチ表示** — GSAP が読み込めたとき。オープニング、慣性スクロール、文字のスクラブ、画像のマスク展開、MV の横スクロールなど

OS の「視差効果を減らす」設定（`prefers-reduced-motion: reduce`）が有効なときは、常に基本表示より控えめになります。移動・帯・オープニングを止めて短いフェードだけにし、点群とデモは静止画（操作したときだけ描き直す）、動画は自動再生しません。

## 内容を書き換える

| 変えたいもの | 場所 |
| --- | --- |
| About の文章 | `public/index.html` の `<!-- About 本文 -->` 以下の `<p>` |
| 資格・関心分野の表 | `public/index.html` の `<dl class="facts">` |
| Works | `public/index.html` の `<li class="project">`（フォークは `<li class="work">`） |
| Skills | `public/index.html` の `.skills__group`（帯の文字は `.marquee__track`） |
| 配色・フォント | `public/assets/css/style.css` 冒頭の `:root` の変数。点群やデモの色もここから読む |

注意点が2つあります。

- **インラインの `style=""` や `<script>` は使えません。** `_headers` の CSP で禁止しています。
- **外部の読み込み元を増やすときは `public/_headers` の CSP も更新します。** CDN のライブラリはバージョンを固定して `integrity` を付けているので、バージョンを上げるときはハッシュも更新してください。

Hero の `ikuto32` は、文字幅から逆算したフォントサイズで画面幅いっぱいに組んでいます。名前や書体を変えた場合は、`style.css` の `.hero__title` にある除数（`4.3` と `2.85`）を調整してください。

## 使用しているもの

| 名前 | ライセンス | 読み込み方 |
| --- | --- | --- |
| [GSAP](https://gsap.com/) 3.15.0（ScrollTrigger） | [Standard "no charge" license](https://gsap.com/standard-license) | jsDelivr |
| [Lenis](https://lenis.darkroom.engineering/) 1.3.26 | MIT | jsDelivr |
| [p5.js](https://p5js.org/) 1.11.13 | LGPL-2.1 | jsDelivr（無改変） |
| Archivo / JetBrains Mono | SIL OFL 1.1 | Google Fonts |

スクリーンショットと映像は、自分のリポジトリ（[MyImageSearch](https://github.com/ikuto32/MyImageSearch)、[MV_test](https://github.com/ikuto32/MV_test)）から切り出したものです。
