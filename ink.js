/*
 * 글자 잉크 찾기 엔진
 * 이미지에서 "배경과 다른 가는 획"만 골라 글줄·단어·글자 위치를 찾는다.
 * 글자를 읽지는 않는다(OCR 아님). 그래서 언어·글꼴과 상관없이 빠르다.
 *
 * 1) 회색조로 바꾼 뒤 closing/opening(최댓값·최솟값 필터)으로 배경을 추정하고,
 *    배경과 차이가 큰 가는 획만 잉크로 남긴다. 밝은 바탕의 검은 글자, 어두운 바탕의 흰 글자 모두 잡힌다.
 * 2) 잉크 지도를 가로·세로 빈 공간으로 계속 잘라(XY-cut) 글줄을 찾는다.
 * 3) 글줄 안에서 세로 빈 칸의 폭으로 글자 조각과 단어를 나눈다.
 */
(function (root) {
  'use strict';

  function toGray(rgba, n) {
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }

  // 1차원 이동 최댓값/최솟값 (van Herk / Gil-Werman, 창 크기와 상관없이 O(n))
  function run1D(src, dst, w, h, k, horiz, isMax) {
    const r = k >> 1;
    const len = horiz ? w : h;
    const count = horiz ? h : w;
    const n = len + 2 * r;
    const buf = new Uint8Array(n);
    const fwd = new Uint8Array(n);
    const bwd = new Uint8Array(n);
    const pad = isMax ? 0 : 255;
    for (let l = 0; l < count; l++) {
      for (let i = 0; i < r; i++) { buf[i] = pad; buf[n - 1 - i] = pad; }
      if (horiz) {
        const off = l * w;
        for (let i = 0; i < len; i++) buf[r + i] = src[off + i];
      } else {
        for (let i = 0; i < len; i++) buf[r + i] = src[i * w + l];
      }
      for (let i = 0; i < n; i++) {
        if (i % k === 0) fwd[i] = buf[i];
        else {
          const a = fwd[i - 1], b = buf[i];
          fwd[i] = isMax ? (a > b ? a : b) : (a < b ? a : b);
        }
      }
      for (let i = n - 1; i >= 0; i--) {
        if (i === n - 1 || (i + 1) % k === 0) bwd[i] = buf[i];
        else {
          const a = bwd[i + 1], b = buf[i];
          bwd[i] = isMax ? (a > b ? a : b) : (a < b ? a : b);
        }
      }
      for (let i = 0; i < len; i++) {
        const a = bwd[i], b = fwd[i + k - 1];
        const v = isMax ? (a > b ? a : b) : (a < b ? a : b);
        if (horiz) dst[l * w + i] = v; else dst[i * w + l] = v;
      }
    }
  }

  // maxFirst=true → closing(어두운 가는 획 제거), false → opening(밝은 가는 획 제거)
  function morph(src, w, h, k, maxFirst) {
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    run1D(src, a, w, h, k, true, maxFirst);
    run1D(a, b, w, h, k, false, maxFirst);
    run1D(b, a, w, h, k, true, !maxFirst);
    run1D(a, b, w, h, k, false, !maxFirst);
    return b;
  }

  // 주변 평균 밝기(적분 영상으로 빠르게 계산)
  function boxMean(g, w, h, r) {
    const W = w + 1;
    const sat = new Uint32Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      const off = y * w;
      for (let x = 0; x < w; x++) {
        row += g[off + x];
        sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
        const s = sat[yb * W + xb] - sat[ya * W + xb] - sat[yb * W + xa] + sat[ya * W + xa];
        out[y * w + x] = s / ((yb - ya) * (xb - xa));
      }
    }
    return out;
  }

  function inkMask(g, w, h, k, t) {
    const close = morph(g, w, h, k, true);
    const open = morph(g, w, h, k, false);
    const mean = boxMean(g, w, h, Math.max(15, k * 2));
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) {
      // 바탕은 주변 평균에 가깝다. 밝은 바탕이면 어두운 획만, 어두운 바탕이면 밝은 획만 잉크로 본다.
      const lightBackground = (close[i] - mean[i]) <= (mean[i] - open[i]);
      m[i] = lightBackground ? (close[i] - g[i] > t ? 1 : 0) : (g[i] - open[i] > t ? 1 : 0);
    }
    return m;
  }

  // 0이 아닌 구간 [시작, 끝). minGap보다 짧은 빈칸은 이어 붙인다.
  function runs(arr, minGap) {
    const out = [];
    let s = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]) {
        if (s < 0) {
          if (out.length && i - out[out.length - 1][1] < minGap) s = out.pop()[0];
          else s = i;
        }
      } else if (s >= 0) {
        out.push([s, i]);
        s = -1;
      }
    }
    if (s >= 0) out.push([s, arr.length]);
    return out;
  }

  function colProfile(m, w, x0, y0, x1, y1) {
    const cols = new Int32Array(x1 - x0);
    for (let y = y0; y < y1; y++) {
      const off = y * w;
      for (let x = x0; x < x1; x++) cols[x - x0] += m[off + x];
    }
    return cols;
  }

  function rowProfile(m, w, x0, y0, x1, y1) {
    const rows = new Int32Array(y1 - y0);
    for (let y = y0; y < y1; y++) {
      const off = y * w;
      let s = 0;
      for (let x = x0; x < x1; x++) s += m[off + x];
      rows[y - y0] = s;
    }
    return rows;
  }

  // 가로·세로 빈 공간으로 계속 잘라서 글줄 후보를 찾는다.
  function xyCut(m, w, h) {
    const leaves = [];
    const stack = [[0, 0, w, h, 0]];
    while (stack.length) {
      const [x0, y0, x1, y1, depth] = stack.pop();
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      const rows = rowProfile(m, w, x0, y0, x1, y1);
      const yr = runs(rows, 1);
      if (!yr.length) continue;
      if (yr.length > 1 && depth < 40) {
        for (const [a, b] of yr) stack.push([x0, y0 + a, x1, y0 + b, depth + 1]);
        continue;
      }
      const by0 = y0 + yr[0][0];
      const by1 = y0 + yr[0][1];
      const bh = by1 - by0;
      const cols = colProfile(m, w, x0, by0, x1, by1);
      const gapMin = Math.max(24, Math.round(bh * 1.2));
      const xr = runs(cols, gapMin);
      if (xr.length > 1 && depth < 40) {
        for (const [a, b] of xr) stack.push([x0 + a, by0, x0 + b, by1, depth + 1]);
        continue;
      }
      let ink = 0;
      for (let i = xr[0][0]; i < xr[0][1]; i++) ink += cols[i];
      leaves.push({ x0: x0 + xr[0][0], y0: by0, x1: x0 + xr[0][1], y1: by1, ink });
    }
    return leaves;
  }

  function median(values) {
    if (!values.length) return 0;
    const s = values.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  function lineHeightMedian(leaves) {
    const text = leaves.filter((l) => l.x1 - l.x0 > (l.y1 - l.y0) * 2);
    return median((text.length ? text : leaves).map((l) => l.y1 - l.y0));
  }

  // 줄 사이가 붙어 한 덩어리가 된 경우, 가운데 가장 옅은 행에서 나눈다.
  function splitTall(m, w, leaf, mh, out, depth) {
    const h = leaf.y1 - leaf.y0;
    if (depth > 4 || h < mh * 1.65 || h > mh * 6) { out.push(leaf); return; }
    const rows = rowProfile(m, w, leaf.x0, leaf.y0, leaf.x1, leaf.y1);
    const from = Math.round(mh * 0.6);
    const to = h - Math.round(mh * 0.6);
    if (to <= from) { out.push(leaf); return; }
    let best = from;
    for (let i = from; i < to; i++) if (rows[i] < rows[best]) best = i;
    const peak = Math.max(...rows);
    if (rows[best] > peak * 0.35) { out.push(leaf); return; }
    const a = { x0: leaf.x0, y0: leaf.y0, x1: leaf.x1, y1: leaf.y0 + best };
    const b = { x0: leaf.x0, y0: leaf.y0 + best + 1, x1: leaf.x1, y1: leaf.y1 };
    for (const part of [a, b]) {
      const pr = rowProfile(m, w, part.x0, part.y0, part.x1, part.y1);
      const r = runs(pr, 1);
      if (!r.length) continue;
      part.y0 += r[0][0];
      part.y1 = part.y0 + (r[r.length - 1][1] - r[0][0]);
      splitTall(m, w, part, mh, out, depth + 1);
    }
  }

  // 점·꼬리처럼 너무 작은 조각은 가까운 글줄에 붙인다.
  function mergeSmall(leaves, mh) {
    const big = [];
    const small = [];
    for (const l of leaves) ((l.y1 - l.y0) < mh * 0.45 ? small : big).push(l);
    for (const s of small) {
      let best = null;
      let bestD = Infinity;
      for (const b of big) {
        const xo = Math.min(s.x1, b.x1) - Math.max(s.x0, b.x0);
        if (xo < -mh * 0.6) continue;
        const dy = s.y1 <= b.y0 ? b.y0 - s.y1 : s.y0 >= b.y1 ? s.y0 - b.y1 : 0;
        if (dy < mh * 0.55 && dy < bestD) { bestD = dy; best = b; }
      }
      if (best) {
        best.x0 = Math.min(best.x0, s.x0); best.x1 = Math.max(best.x1, s.x1);
        best.y0 = Math.min(best.y0, s.y0); best.y1 = Math.max(best.y1, s.y1);
      } else if ((s.x1 - s.x0) > mh * 0.8) {
        big.push(s); // 작은 글씨로 된 한 줄일 수 있다
      }
    }
    return big;
  }

  // 붙어 있는 글자(한글 음절 등)를 잉크가 가장 옅은 세로줄에서 나눈다.
  function splitValleys(cols, a, b, h) {
    let peak = 0;
    for (let i = a; i < b; i++) if (cols[i] > peak) peak = cols[i];
    const low = Math.max(1, Math.floor(peak * 0.14));
    const minW = h * 0.45;
    const cuts = [];
    let last = a;
    let i = a;
    while (i < b) {
      if (cols[i] <= low) {
        let j = i;
        while (j < b && cols[j] <= low) j++;
        const mid = (i + j) >> 1;
        if (mid - last >= minW && b - mid >= minW) { cuts.push(mid); last = mid; }
        i = j;
      } else i++;
    }
    const out = [];
    let s = a;
    for (const c of cuts) { out.push([s, c]); s = c; }
    out.push([s, b]);
    return out;
  }

  // 한 줄 안의 빈칸 폭을 좁은 무리(글자 사이)와 넓은 무리(띄어쓰기)로 나누는 경계.
  // 두 무리가 뚜렷하지 않으면 줄 높이의 28%를 띄어쓰기로 본다.
  function wordThreshold(gaps, h) {
    const floor = h * 0.15;
    const fallback = Math.max(floor, h * 0.28);
    if (gaps.length < 3) return fallback;
    const s = gaps.slice().sort((a, b) => a - b);
    const total = s.reduce((a, b) => a + b, 0);
    let left = 0;
    let best = null;
    let bestScore = -1;
    let m1 = 0;
    let m2 = 0;
    for (let i = 1; i < s.length; i++) {
      left += s[i - 1];
      if (s[i] === s[i - 1]) continue;
      const a = left / i;
      const b = (total - left) / (s.length - i);
      const score = (i / s.length) * (1 - i / s.length) * (b - a) * (b - a);
      if (score > bestScore) { bestScore = score; best = (s[i - 1] + s[i]) / 2; m1 = a; m2 = b; }
    }
    if (best !== null && m2 > m1 * 1.6 && m2 - m1 > h * 0.1) return Math.max(floor, best);
    return fallback;
  }

  // 글줄 안의 글자 조각 → 단어
  function unitsOf(m, w, leaf) {
    const h = leaf.y1 - leaf.y0;
    const cols = colProfile(m, w, leaf.x0, leaf.y0, leaf.x1, leaf.y1);
    const glyphGap = Math.max(2, Math.round(h * 0.1));
    const pieces = runs(cols, glyphGap);
    if (!pieces.length) return [];
    const gaps = [];
    for (let i = 1; i < pieces.length; i++) gaps.push(pieces[i][0] - pieces[i - 1][1]);
    const wordGap = wordThreshold(gaps, h);
    const words = [];
    let cur = { units: [] };
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0 && pieces[i][0] - pieces[i - 1][1] > wordGap) { words.push(cur); cur = { units: [] }; }
      for (const [a, b] of splitValleys(cols, pieces[i][0], pieces[i][1], h)) {
        // 한글 음절은 폭이 거의 일정하므로, 빈칸 없이 붙은 넓은 덩어리는 글자 폭만큼 나눈다.
        const width = b - a;
        const n = width > h * 1.5 ? Math.round(width / (h * 1.02)) : 1;
        for (let j = 0; j < n; j++) {
          cur.units.push({ x0: leaf.x0 + a + Math.round(width * j / n), x1: leaf.x0 + a + Math.round(width * (j + 1) / n) });
        }
      }
    }
    words.push(cur);
    // 조각의 세로 길이: 한글 자모(ㅇ|ㅑ)는 키가 크고, 라틴 소문자는 작다.
    const tall = (u) => {
      let top = -1, bottom = -1;
      for (let y = leaf.y0; y < leaf.y1; y++) {
        const off = y * w;
        for (let x = u.x0; x < u.x1; x++) {
          if (m[off + x]) { if (top < 0) top = y; bottom = y; break; }
        }
      }
      return top < 0 ? 0 : bottom - top + 1;
    };
    for (const word of words) {
      const merged = [];
      for (const u of word.units) {
        const prev = merged[merged.length - 1];
        const gap = prev ? u.x0 - prev.x1 : Infinity;
        // 마침표처럼 아주 좁은 조각은 앞 글자에 붙인다.
        if (prev && u.x1 - u.x0 < h * 0.3 && gap < h * 0.2) { prev.x1 = u.x1; continue; }
        // '야'의 ㅇ과 ㅑ처럼 떨어진 자모는 합쳐서 한 글자 폭이 될 때 붙인다.
        // (문장부호가 뒤에 붙은 경우까지 생각해 한 글자 폭의 1.3배까지 허용한다)
        if (prev && gap <= h * 0.14 && u.x1 - prev.x0 <= h * 1.3 && tall(prev) >= h * 0.45 && tall(u) >= h * 0.45) { prev.x1 = u.x1; continue; }
        merged.push({ x0: u.x0, x1: u.x1 });
      }
      word.units = merged;
    }
    return words;
  }

  function readingOrder(lines) {
    const sorted = lines.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const out = [];
    let row = [];
    let rowBottom = -Infinity;
    let rowTop = Infinity;
    for (const l of sorted) {
      const cy = (l.y0 + l.y1) / 2;
      if (row.length && cy > rowTop && cy < rowBottom) {
        row.push(l);
        rowTop = Math.min(rowTop, l.y0); rowBottom = Math.max(rowBottom, l.y1);
      } else {
        out.push(...row.sort((a, b) => a.x0 - b.x0));
        row = [l]; rowTop = l.y0; rowBottom = l.y1;
      }
    }
    out.push(...row.sort((a, b) => a.x0 - b.x0));
    return out;
  }

  function detect(g, w, h, k, t) {
    const m = inkMask(g, w, h, k, t);
    let leaves = xyCut(m, w, h);
    const mh0 = lineHeightMedian(leaves) || 12;
    const split = [];
    for (const l of leaves) splitTall(m, w, l, mh0, split, 0);
    leaves = mergeSmall(split, mh0);
    return { m, leaves, mh: lineHeightMedian(leaves) || mh0 };
  }

  function segment(input) {
    const t0 = Date.now();
    const w = input.width;
    const h = input.height;
    const g = toGray(input.data, w * h);
    const threshold = input.threshold || 36;
    let k = 9;
    let res = detect(g, w, h, k, threshold);
    // 글씨가 아주 크면 획이 창보다 굵어져서 놓치므로 창을 키워 다시 찾는다.
    if (res.mh > 46) {
      k = Math.min(41, (Math.round(res.mh * 0.24) | 1));
      res = detect(g, w, h, k, threshold);
    }
    const lines = [];
    for (const leaf of res.leaves) {
      const lh = leaf.y1 - leaf.y0;
      if (lh > res.mh * 6) continue; // 사진·아이콘 덩어리
      const words = unitsOf(res.m, w, leaf);
      if (!words.length) continue;
      lines.push({ x0: leaf.x0, y0: leaf.y0, x1: leaf.x1, y1: leaf.y1, words });
    }
    return { lines: readingOrder(lines), medianHeight: res.mh, kernel: k, ms: Date.now() - t0 };
  }

  const api = { segment, _internals: { toGray, inkMask, colProfile, runs } };
  root.InkEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
