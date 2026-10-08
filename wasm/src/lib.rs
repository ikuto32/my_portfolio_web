//! Interactive kernels for the ikuto32 portfolio, compiled to WebAssembly.
//!
//! JavaScript (p5.js) owns the canvas, the frame loop and the input.
//! This module owns the per-point / per-pixel work and writes straight into
//! RGBA buffers that JavaScript blits to the canvas.
//!
//!   cloud_*  3D point cloud of a quadcopter + software point rasteriser   (Hero)
//!   glyph_*  Zhang–Suen thinning and skeleton length                      (font-length)
//!   rd_*     Gray–Scott reaction–diffusion + image-pyramid renderer       (super-resolution-gan)
//!
//! Everything lives in fixed-size statics, so there is no allocator and the
//! exported pointers stay valid for the lifetime of the instance.

use core::f32::consts::{PI, TAU};
use core::ptr::addr_of_mut;

/// `&'static mut` to a static. Sound here because wasm runs single-threaded
/// and no exported function is re-entrant.
macro_rules! st {
    ($s:ident) => {
        unsafe { &mut *addr_of_mut!($s) }
    };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Palette {
    ink: [u8; 3],
    accent: [u8; 3],
    muted: [u8; 3],
    paper: [u8; 3],
}

static mut PAL: Palette = Palette {
    ink: [17, 17, 16],
    accent: [255, 74, 28],
    muted: [98, 97, 92],
    paper: [242, 240, 234],
};

fn rgb(v: u32) -> [u8; 3] {
    [(v >> 16) as u8, (v >> 8) as u8, v as u8]
}

/// Colours as 0xRRGGBB, read from the page's CSS variables.
#[no_mangle]
pub extern "C" fn set_palette(ink: u32, accent: u32, muted: u32, paper: u32) {
    let p = st!(PAL);
    p.ink = rgb(ink);
    p.accent = rgb(accent);
    p.muted = rgb(muted);
    p.paper = rgb(paper);
}

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// [0, 1)
    fn f(&mut self) -> f32 {
        (self.next() >> 8) as f32 / 16_777_216.0
    }
    /// [-1, 1)
    fn sym(&mut self) -> f32 {
        self.f() * 2.0 - 1.0
    }
}

fn hash01(i: u32) -> f32 {
    let mut x = i.wrapping_mul(0x9E37_79B1);
    x ^= x >> 15;
    x = x.wrapping_mul(0x85EB_CA77);
    x ^= x >> 13;
    (x >> 8) as f32 / 16_777_216.0
}

fn clamp01(v: f32) -> f32 {
    v.max(0.0).min(1.0)
}

fn mix(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let t = clamp01(t);
    [
        (a[0] as f32 + (b[0] as f32 - a[0] as f32) * t) as u8,
        (a[1] as f32 + (b[1] as f32 - a[1] as f32) * t) as u8,
        (a[2] as f32 + (b[2] as f32 - a[2] as f32) * t) as u8,
    ]
}

// ---------------------------------------------------------------------------
// cloud: quadcopter point cloud
// ---------------------------------------------------------------------------

const MAX_PTS: usize = 20_000;
const FB_PIXELS: usize = 2_400_000;

const K_GROUND: u8 = 0; // stored as (radius, y, angle): the "LiDAR" rings on the floor
const K_INK: u8 = 1;
const K_RING: u8 = 2;
const K_BLADE: u8 = 3; // stored as (radius, y, angle0), aux = rotor index

const ARM: f32 = 0.72;
const GROUND_Y: f32 = -0.62;
const CAM_DIST: f32 = 4.0;

struct Cloud {
    x: [f32; MAX_PTS],
    y: [f32; MAX_PTS],
    z: [f32; MAX_PTS],
    aux: [f32; MAX_PTS],
    kind: [u8; MAX_PTS],
    n: usize,
}

impl Cloud {
    fn push(&mut self, x: f32, y: f32, z: f32, kind: u8, aux: f32) {
        if self.n < MAX_PTS {
            let i = self.n;
            self.x[i] = x;
            self.y[i] = y;
            self.z[i] = z;
            self.kind[i] = kind;
            self.aux[i] = aux;
            self.n += 1;
        }
    }
}

static mut CLOUD: Cloud = Cloud {
    x: [0.0; MAX_PTS],
    y: [0.0; MAX_PTS],
    z: [0.0; MAX_PTS],
    aux: [0.0; MAX_PTS],
    kind: [0; MAX_PTS],
    n: 0,
};
static mut FB: [u8; FB_PIXELS * 4] = [0; FB_PIXELS * 4];
static mut BBOX: [f32; 4] = [0.0; 4];

fn rotor_center(i: usize) -> (f32, f32) {
    let a = TAU / 8.0 + i as f32 * TAU / 4.0;
    (ARM * a.cos(), ARM * a.sin())
}

#[no_mangle]
pub extern "C" fn fb_ptr() -> *mut u8 {
    addr_of_mut!(FB) as *mut u8
}

#[no_mangle]
pub extern "C" fn fb_capacity() -> u32 {
    FB_PIXELS as u32
}

/// `[min_x, min_y, max_x, max_y]` of the drone on screen, from the last `cloud_render`.
#[no_mangle]
pub extern "C" fn cloud_bbox_ptr() -> *const f32 {
    addr_of_mut!(BBOX) as *const f32
}

/// Builds the point cloud. Returns the number of points.
/// Points are appended back-to-front in paint order: floor, airframe, rotors.
#[no_mangle]
pub extern "C" fn cloud_init(seed: u32) -> u32 {
    let c = st!(CLOUD);
    let mut r = Rng(seed | 1);
    c.n = 0;

    // Floor: concentric scan rings, denser as they get longer.
    for i in 0..14 {
        let radius = 0.42 + i as f32 * 0.15;
        let n = 70 + i * 26;
        for j in 0..n {
            let a = (j as f32 + r.f() * 0.6) / n as f32 * TAU;
            c.push(radius + r.sym() * 0.006, GROUND_Y + r.sym() * 0.004, a, K_GROUND, 0.0);
        }
    }

    // Fuselage: ellipsoid shell.
    for _ in 0..2600 {
        let u = r.sym();
        let a = r.f() * TAU;
        let s = (1.0 - u * u).sqrt();
        c.push(s * a.cos() * 0.24, u * 0.10, s * a.sin() * 0.36, K_INK, 0.0);
    }

    // Camera gimbal under the nose.
    for _ in 0..360 {
        let u = r.sym();
        let a = r.f() * TAU;
        let s = (1.0 - u * u).sqrt();
        c.push(s * a.cos() * 0.065, -0.155 + u * 0.065, 0.25 + s * a.sin() * 0.065, K_INK, 0.0);
    }

    // Landing gear: four struts and two skids.
    for &sx in &[-1.0f32, 1.0] {
        for &sz in &[-1.0f32, 1.0] {
            for _ in 0..80 {
                let t = r.f();
                c.push(sx * (0.14 + 0.06 * t), -0.06 - 0.26 * t, sz * 0.2 + r.sym() * 0.004, K_INK, 0.0);
            }
        }
        for _ in 0..190 {
            c.push(sx * 0.20 + r.sym() * 0.006, -0.32 + r.sym() * 0.006, r.sym() * 0.34, K_INK, 0.0);
        }
    }

    for i in 0..4 {
        let (cx, cz) = rotor_center(i);
        let (dx, dz) = (cx / ARM, cz / ARM);

        // Arm: thin tube from the fuselage to the motor.
        for _ in 0..520 {
            let t = 0.22 + r.f() * 0.78;
            let phi = r.f() * TAU;
            let off = 0.032 * phi.cos();
            c.push(dx * t * ARM - dz * off, 0.02 + 0.032 * phi.sin(), dz * t * ARM + dx * off, K_INK, 0.0);
        }
        // Motor can.
        for _ in 0..200 {
            let phi = r.f() * TAU;
            c.push(cx + 0.055 * phi.cos(), r.f() * 0.10 - 0.02, cz + 0.055 * phi.sin(), K_INK, 0.0);
        }
    }

    for i in 0..4 {
        let (cx, cz) = rotor_center(i);

        // Prop guard: thin torus.
        for _ in 0..620 {
            let phi = r.f() * TAU;
            let psi = r.f() * TAU;
            let rr = 0.29 + 0.012 * psi.cos();
            c.push(cx + rr * phi.cos(), 0.10 + 0.012 * psi.sin(), cz + rr * phi.sin(), K_RING, 0.0);
        }
        // Two blades, kept in polar form so the renderer can spin them.
        for j in 0..280 {
            let rr = 0.03 + r.f() * 0.24;
            let half_width = 0.022 * (1.0 - rr / 0.6);
            let off = r.sym() * half_width;
            let base = if j % 2 == 0 { 0.0 } else { PI };
            c.push((rr * rr + off * off).sqrt(), 0.11, base + off / rr, K_BLADE, i as f32);
        }
    }

    c.n as u32
}

#[inline]
fn plot(fb: &mut [u8], w: i32, h: i32, x: i32, y: i32, c: [u8; 3], a: u32) {
    if x < 0 || y < 0 || x >= w || y >= h {
        return;
    }
    let i = ((y * w + x) * 4) as usize;
    let a0 = fb[i + 3] as u32;
    fb[i] = c[0];
    fb[i + 1] = c[1];
    fb[i + 2] = c[2];
    fb[i + 3] = (a0 + a * (255 - a0) / 255) as u8;
}

/// Rotates, projects and rasterises the cloud into the RGBA framebuffer.
///
/// * `scale`    pixels per model unit at the model origin
/// * `cx, cy`   where the model origin lands on screen
/// * `t`        seconds, drives the rotors, the hover and the floor sweep
/// * `mx, my`   pointer in pixels (negative = no pointer); points are pushed away from it
/// * `reveal`   0 → points scattered, 1 → assembled
/// * `dot`      base point size in pixels
///
/// Returns the number of points drawn.
#[no_mangle]
pub extern "C" fn cloud_render(
    w: u32,
    h: u32,
    yaw: f32,
    pitch: f32,
    scale: f32,
    cx: f32,
    cy: f32,
    t: f32,
    mx: f32,
    my: f32,
    reveal: f32,
    dot: u32,
) -> u32 {
    let (wu, hu) = (w as usize, h as usize);
    let bbox = st!(BBOX);
    if wu == 0 || hu == 0 || wu * hu > FB_PIXELS {
        *bbox = [0.0; 4];
        return 0;
    }
    let (wi, hi) = (w as i32, h as i32);
    let fb = &mut st!(FB)[..wu * hu * 4];
    fb.fill(0);

    let c = st!(CLOUD);
    let pal = *st!(PAL);
    let (sy, cyw) = yaw.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    let hover = 0.035 * (t * 1.7).sin();
    let sweep = (t * 1.4).rem_euclid(TAU);
    let push_r = scale * 0.34;
    let dot = dot.max(1) as i32;

    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    let mut drawn = 0u32;

    for i in 0..c.n {
        let kind = c.kind[i];
        let mut boost = 0.0f32;

        // Model-space position.
        let (mut x, mut y, mut z) = match kind {
            K_GROUND => {
                let a = c.z[i];
                // Rotating scan line: bright at the sweep angle, fading behind it.
                let behind = (sweep - a).rem_euclid(TAU);
                let trail = 1.0 - behind / 1.7;
                if trail > 0.0 {
                    boost = trail * trail;
                }
                (c.x[i] * a.cos(), c.y[i], c.x[i] * a.sin())
            }
            K_BLADE => {
                let rotor = c.aux[i] as usize;
                let (rcx, rcz) = rotor_center(rotor);
                let dir = if rotor % 2 == 0 { 1.0 } else { -1.0 };
                let a = c.z[i] + t * 21.0 * dir;
                (rcx + c.x[i] * a.cos(), c.y[i] + hover, rcz + c.x[i] * a.sin())
            }
            _ => (c.x[i], c.y[i] + hover, c.z[i]),
        };

        // Intro: each point flies in from a scattered position, slightly staggered.
        let mut fade = 1.0f32;
        if reveal < 1.0 {
            let id = i as u32;
            let local = clamp01(reveal * 1.7 - hash01(id) * 0.7);
            let ease = 1.0 - (1.0 - local) * (1.0 - local) * (1.0 - local);
            let k = (1.0 - ease) * 5.0;
            x += (hash01(id * 3 + 1) - 0.5) * k;
            y += (hash01(id * 3 + 2) - 0.5) * k;
            z += (hash01(id * 3 + 3) - 0.5) * k;
            fade = local;
        }

        // Yaw (around Y), then pitch (around X).
        let xr = x * cyw + z * sy;
        let zr = -x * sy + z * cyw;
        let yr = y * cp - zr * sp;
        let zf = y * sp + zr * cp;

        let depth = CAM_DIST - zf;
        if depth < 0.4 {
            continue;
        }
        let s = CAM_DIST / depth;
        let mut px = cx + xr * scale * s;
        let mut py = cy - yr * scale * s;

        if kind != K_GROUND && reveal >= 1.0 {
            x0 = x0.min(px);
            y0 = y0.min(py);
            x1 = x1.max(px);
            y1 = y1.max(py);
        }

        // Pointer pushes points away.
        if mx >= 0.0 {
            let dx = px - mx;
            let dy = py - my;
            let d2 = dx * dx + dy * dy;
            if d2 < push_r * push_r {
                let d = d2.sqrt() + 0.001;
                let f = 1.0 - d / push_r;
                let f = f * f * push_r * 0.6;
                px += dx / d * f;
                py += dy / d * f;
            }
        }

        // Depth cue: nearer points are darker and a little larger.
        let near = clamp01((CAM_DIST + 1.5 - depth) / 3.0);
        let (col, alpha) = match kind {
            K_GROUND => {
                let col = if boost > 0.45 { pal.accent } else { pal.muted };
                (col, 36.0 + 64.0 * near + 170.0 * boost)
            }
            K_INK => (pal.ink, 70.0 + 150.0 * near),
            _ => (pal.accent, 110.0 + 145.0 * near),
        };
        let a = (alpha * fade).min(255.0) as u32;
        if a < 4 {
            continue;
        }

        let size = dot + if near > 0.62 && kind != K_GROUND { 1 } else { 0 };
        let ix = px as i32;
        let iy = py as i32;
        for oy in 0..size {
            for ox in 0..size {
                plot(fb, wi, hi, ix + ox, iy + oy, col, a);
            }
        }
        drawn += 1;
    }

    *bbox = if x1 > x0 { [x0, y0, x1, y1] } else { [0.0; 4] };
    drawn
}

// ---------------------------------------------------------------------------
// glyph: thinning (what font-length does to every character)
// ---------------------------------------------------------------------------

const G: usize = 512;

static mut GLY: [u8; G * G] = [0; G * G]; // 1 = ink, written by JavaScript
static mut GMARK: [u8; G * G] = [0; G * G];
static mut GLAYER: [u8; G * G] = [0; G * G]; // iteration at which a pixel was peeled off
static mut GFB: [u8; G * G * 4] = [0; G * G * 4];
static mut GITER: u32 = 0;

fn glyph_dims(w: u32, h: u32) -> (usize, usize) {
    ((w as usize).min(G), (h as usize).min(G))
}

#[no_mangle]
pub extern "C" fn glyph_ptr() -> *mut u8 {
    addr_of_mut!(GLY) as *mut u8
}

#[no_mangle]
pub extern "C" fn glyph_fb_ptr() -> *mut u8 {
    addr_of_mut!(GFB) as *mut u8
}

#[no_mangle]
pub extern "C" fn glyph_max() -> u32 {
    G as u32
}

/// Call after writing a `w × h` mask (row-major, non-zero = ink) to `glyph_ptr()`.
/// Returns the number of ink pixels.
#[no_mangle]
pub extern "C" fn glyph_begin(w: u32, h: u32) -> u32 {
    let (w, h) = glyph_dims(w, h);
    let g = st!(GLY);
    let layer = st!(GLAYER);
    let mark = st!(GMARK);
    *st!(GITER) = 0;

    let mut count = 0;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            // The thinning pass never looks at the outermost ring of pixels.
            let border = x == 0 || y == 0 || x == w - 1 || y == h - 1;
            g[i] = if g[i] != 0 && !border { 1 } else { 0 };
            layer[i] = 0;
            mark[i] = 0;
            count += g[i] as u32;
        }
    }
    count
}

/// One Zhang–Suen iteration (both sub-passes). Returns how many pixels were removed;
/// 0 means the skeleton has converged.
#[no_mangle]
pub extern "C" fn thin_step(w: u32, h: u32) -> u32 {
    let (w, h) = glyph_dims(w, h);
    if w < 3 || h < 3 {
        return 0;
    }
    let g = st!(GLY);
    let mark = st!(GMARK);
    let layer = st!(GLAYER);
    let iter = st!(GITER);
    *iter += 1;
    let tag = (*iter).min(255) as u8;

    let mut removed = 0;
    for pass in 0..2 {
        let mut hit = 0;
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let i = y * w + x;
                if g[i] == 0 {
                    continue;
                }
                // Neighbours clockwise from north.
                let p2 = g[i - w];
                let p3 = g[i - w + 1];
                let p4 = g[i + 1];
                let p5 = g[i + w + 1];
                let p6 = g[i + w];
                let p7 = g[i + w - 1];
                let p8 = g[i - 1];
                let p9 = g[i - w - 1];

                let b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
                if !(2..=6).contains(&b) {
                    continue;
                }
                let a = (p2 == 0 && p3 == 1) as u8
                    + (p3 == 0 && p4 == 1) as u8
                    + (p4 == 0 && p5 == 1) as u8
                    + (p5 == 0 && p6 == 1) as u8
                    + (p6 == 0 && p7 == 1) as u8
                    + (p7 == 0 && p8 == 1) as u8
                    + (p8 == 0 && p9 == 1) as u8
                    + (p9 == 0 && p2 == 1) as u8;
                if a != 1 {
                    continue;
                }
                let ok = if pass == 0 {
                    p2 * p4 * p6 == 0 && p4 * p6 * p8 == 0
                } else {
                    p2 * p4 * p8 == 0 && p2 * p6 * p8 == 0
                };
                if ok {
                    mark[i] = 1;
                    hit += 1;
                }
            }
        }
        if hit > 0 {
            for i in 0..w * h {
                if mark[i] == 1 {
                    mark[i] = 0;
                    g[i] = 0;
                    layer[i] = tag;
                }
            }
        }
        removed += hit;
    }
    removed
}

/// Length of the 8-connected skeleton in pixels: 1 per orthogonal link,
/// √2 per diagonal link that is not already covered by an orthogonal detour.
#[no_mangle]
pub extern "C" fn skeleton_length(w: u32, h: u32) -> f32 {
    let (w, h) = glyph_dims(w, h);
    if w < 3 || h < 3 {
        return 0.0;
    }
    let g = st!(GLY);
    let mut len = 0.0f32;
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let i = y * w + x;
            if g[i] == 0 {
                continue;
            }
            let e = g[i + 1];
            let s = g[i + w];
            let wst = g[i - 1];
            len += (e + s) as f32;
            if g[i + w + 1] == 1 && e == 0 && s == 0 {
                len += core::f32::consts::SQRT_2;
            }
            if g[i + w - 1] == 1 && wst == 0 && s == 0 {
                len += core::f32::consts::SQRT_2;
            }
        }
    }
    len
}

/// Paints the current state into `glyph_fb_ptr()`.
/// While thinning: remaining ink is solid, the layer just peeled is accent,
/// older layers are faint alternating bands. When `done`, the skeleton is drawn
/// in accent, three pixels wide, over the ghost of the original shape.
#[no_mangle]
pub extern "C" fn glyph_render(w: u32, h: u32, done: u32) {
    let (w, h) = glyph_dims(w, h);
    let g = st!(GLY);
    let layer = st!(GLAYER);
    let fb = st!(GFB);
    let pal = *st!(PAL);
    let iter = (*st!(GITER)).min(255) as u8;
    let done = done != 0;

    for i in 0..w * h {
        let o = i * 4;
        let (col, a) = if g[i] == 1 {
            (pal.ink, if done { 0 } else { 255 })
        } else if layer[i] > 0 {
            if !done && layer[i] == iter {
                (pal.accent, 255)
            } else {
                (pal.ink, if layer[i] % 2 == 1 { 40 } else { 20 })
            }
        } else {
            (pal.ink, 0)
        };
        fb[o] = col[0];
        fb[o + 1] = col[1];
        fb[o + 2] = col[2];
        fb[o + 3] = a;
    }

    if done && w >= 3 && h >= 3 {
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                if g[y * w + x] == 0 {
                    continue;
                }
                for oy in 0..3 {
                    for ox in 0..3 {
                        let o = ((y + oy - 1) * w + (x + ox - 1)) * 4;
                        fb[o] = pal.accent[0];
                        fb[o + 1] = pal.accent[1];
                        fb[o + 2] = pal.accent[2];
                        fb[o + 3] = 255;
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// rd: Gray–Scott reaction–diffusion, rendered at any level of an image pyramid
// ---------------------------------------------------------------------------

const R: usize = 256;

static mut RU: [f32; R * R] = [0.0; R * R];
static mut RV: [f32; R * R] = [0.0; R * R];
static mut RU2: [f32; R * R] = [0.0; R * R];
static mut RV2: [f32; R * R] = [0.0; R * R];
static mut RTONE: [f32; R * R] = [0.0; R * R];
static mut RFB: [u8; R * R * 4 * 2] = [0; R * R * 4 * 2];
static mut RFLIP: bool = false;
static mut RD_RNG: Rng = Rng(0x2545_F491);

#[no_mangle]
pub extern "C" fn rd_size() -> u32 {
    R as u32
}

/// Two `R × R` RGBA slots (0 and 1), so one frame can show two pyramid levels.
#[no_mangle]
pub extern "C" fn rd_fb_ptr(slot: u32) -> *mut u8 {
    let base = addr_of_mut!(RFB) as *mut u8;
    unsafe { base.add((slot.min(1) as usize) * R * R * 4) }
}

fn rd_bufs() -> (&'static mut [f32; R * R], &'static mut [f32; R * R], &'static mut [f32; R * R], &'static mut [f32; R * R]) {
    if *st!(RFLIP) {
        (st!(RU2), st!(RV2), st!(RU), st!(RV))
    } else {
        (st!(RU), st!(RV), st!(RU2), st!(RV2))
    }
}

#[no_mangle]
pub extern "C" fn rd_reset(seed: u32) {
    *st!(RFLIP) = false;
    let (u, v, _, _) = rd_bufs();
    u.fill(1.0);
    v.fill(0.0);
    let mut r = Rng(seed | 1);
    *st!(RD_RNG) = Rng(seed.rotate_left(13) | 1);
    for _ in 0..26 {
        let cx = (r.f() * R as f32) as i32;
        let cy = (r.f() * R as f32) as i32;
        let rad = 3 + (r.f() * 6.0) as i32;
        rd_seed(u, v, cx, cy, rad);
    }
}

/// A noisy disc of half-depleted substrate with some activator.
/// Pure activator burns through its substrate and dies out, and a perfectly
/// uniform disc settles into a single spot that never divides; the noise
/// breaks the symmetry so the pattern keeps splitting.
fn rd_seed(u: &mut [f32; R * R], v: &mut [f32; R * R], cx: i32, cy: i32, rad: i32) {
    let n = R as i32;
    let rng = st!(RD_RNG);
    for dy in -rad..=rad {
        for dx in -rad..=rad {
            if dx * dx + dy * dy > rad * rad {
                continue;
            }
            let x = (cx + dx).rem_euclid(n) as usize;
            let y = (cy + dy).rem_euclid(n) as usize;
            u[y * R + x] = 0.5 + rng.sym() * 0.12;
            v[y * R + x] = 0.25 + rng.sym() * 0.12;
        }
    }
}

fn rd_stamp(field: &mut [f32; R * R], cx: i32, cy: i32, rad: i32, value: f32) {
    let n = R as i32;
    for dy in -rad..=rad {
        for dx in -rad..=rad {
            if dx * dx + dy * dy > rad * rad {
                continue;
            }
            let x = (cx + dx).rem_euclid(n) as usize;
            let y = (cy + dy).rem_euclid(n) as usize;
            field[y * R + x] = value;
        }
    }
}

/// Drops activator at grid position (`x`, `y`), both in 0..R.
#[no_mangle]
pub extern "C" fn rd_touch(x: f32, y: f32, radius: f32) {
    let (u, v, _, _) = rd_bufs();
    rd_seed(u, v, x as i32, y as i32, (radius as i32).max(1));
}

/// Wipes a disc back to the empty state, leaving room for the pattern to grow into.
#[no_mangle]
pub extern "C" fn rd_erase(x: f32, y: f32, radius: f32) {
    let (u, v, _, _) = rd_bufs();
    let rad = (radius as i32).max(1);
    rd_stamp(u, x as i32, y as i32, rad, 1.0);
    rd_stamp(v, x as i32, y as i32, rad, 0.0);
}

/// `iters` explicit Euler steps on a torus (edges wrap).
#[no_mangle]
pub extern "C" fn rd_step(iters: u32, feed: f32, kill: f32) {
    const DU: f32 = 1.0;
    const DV: f32 = 0.5;
    for _ in 0..iters {
        let (u, v, u2, v2) = rd_bufs();
        for y in 0..R {
            let ym = (if y == 0 { R - 1 } else { y - 1 }) * R;
            let yp = (if y == R - 1 { 0 } else { y + 1 }) * R;
            let yc = y * R;
            for x in 0..R {
                let xm = if x == 0 { R - 1 } else { x - 1 };
                let xp = if x == R - 1 { 0 } else { x + 1 };
                let i = yc + x;
                let (a, b) = (u[i], v[i]);
                let lap_u = (u[yc + xm] + u[yc + xp] + u[ym + x] + u[yp + x]) * 0.2
                    + (u[ym + xm] + u[ym + xp] + u[yp + xm] + u[yp + xp]) * 0.05
                    - a;
                let lap_v = (v[yc + xm] + v[yc + xp] + v[ym + x] + v[yp + x]) * 0.2
                    + (v[ym + xm] + v[ym + xp] + v[yp + xm] + v[yp + xp]) * 0.05
                    - b;
                let abb = a * b * b;
                u2[i] = clamp01(a + DU * lap_u - abb + feed * (1.0 - a));
                v2[i] = clamp01(b + DV * lap_v + abb - (kill + feed) * b);
            }
        }
        let flip = st!(RFLIP);
        *flip = !*flip;
    }
}

fn rd_colour(pal: &Palette, t: f32) -> [u8; 3] {
    if t < 0.5 {
        mix(pal.paper, pal.accent, t * 2.0)
    } else {
        mix(pal.accent, pal.ink, (t - 0.5) * 2.0)
    }
}

/// Renders the field into `slot` as if it were a `res × res` image
/// (block-averaged, then shown with hard pixel edges). `res` is clamped to a
/// power of two between 1 and R.
#[no_mangle]
pub extern "C" fn rd_render(slot: u32, res: u32) {
    let pal = *st!(PAL);
    let (_, v, _, _) = rd_bufs();
    let tone = st!(RTONE);
    for i in 0..R * R {
        let t = clamp01((v[i] - 0.10) / 0.20);
        tone[i] = t * t * (3.0 - 2.0 * t);
    }

    let mut res = (res.max(1) as usize).min(R);
    while R % res != 0 {
        res -= 1;
    }
    let block = R / res;
    let base = (slot.min(1) as usize) * R * R * 4;
    let fb = &mut st!(RFB)[base..base + R * R * 4];

    for by in 0..res {
        for bx in 0..res {
            let mut sum = 0.0;
            for y in 0..block {
                let row = (by * block + y) * R + bx * block;
                for x in 0..block {
                    sum += tone[row + x];
                }
            }
            let col = rd_colour(&pal, sum / (block * block) as f32);
            for y in 0..block {
                let row = (by * block + y) * R + bx * block;
                for x in 0..block {
                    let o = (row + x) * 4;
                    fb[o] = col[0];
                    fb[o + 1] = col[1];
                    fb[o + 2] = col[2];
                    fb[o + 3] = 255;
                }
            }
        }
    }
}
