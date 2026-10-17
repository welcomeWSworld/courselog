// 위치 계산·인코딩 관련 순수 함수 모음 (DOM 의존 없음)
const Geo = (() => {
  const R = 6371008.8; // 지구 평균 반지름(m)
  const rad = (d) => (d * Math.PI) / 180;

  // 두 좌표 [lat, lng] 사이 거리(m)
  function distance(a, b) {
    const dLat = rad(b[0] - a[0]);
    const dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function pathLength(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += distance(points[i - 1], points[i]);
    return sum;
  }

  // Douglas-Peucker 단순화. tolerance 단위는 m
  function simplify(points, tolerance = 4) {
    if (points.length < 3) return points.slice();
    const lat0 = rad(points[0][0]);
    const xy = points.map((p) => [rad(p[1]) * R * Math.cos(lat0), rad(p[0]) * R]);
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = 0, idx = -1;
      const [x1, y1] = xy[s], [x2, y2] = xy[e];
      const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
      for (let i = s + 1; i < e; i++) {
        const [px, py] = xy[i];
        let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tolerance) {
        keep[idx] = 1;
        stack.push([s, idx], [idx, e]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  // Google Encoded Polyline (precision 5)
  function encodePolyline(points) {
    let out = '', pLat = 0, pLng = 0;
    const enc = (v) => {
      v = v < 0 ? ~(v << 1) : v << 1;
      let s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    };
    for (const [lat, lng] of points) {
      const iLat = Math.round(lat * 1e5), iLng = Math.round(lng * 1e5);
      out += enc(iLat - pLat) + enc(iLng - pLng);
      pLat = iLat; pLng = iLng;
    }
    return out;
  }

  function decodePolyline(str) {
    const pts = [];
    let i = 0, lat = 0, lng = 0;
    const next = () => {
      let r = 0, shift = 0, b;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= str.length);
      return r & 1 ? ~(r >> 1) : r >> 1;
    };
    while (i < str.length) {
      lat += next(); lng += next();
      pts.push([lat / 1e5, lng / 1e5]);
    }
    return pts;
  }

  // UTF-8 안전한 base64url
  function toB64url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  // 기록 → 공유 링크용 문자열
  function packRecord(rec) {
    const payload = {
      v: 1,
      m: rec.mode,
      d: Math.round(rec.distanceM),
      t: Math.round(rec.durationMs / 1000),
      s: Math.round(rec.startedAt / 1000),
      p: rec.segments.map((seg) => encodePolyline(simplify(seg, 4))),
    };
    return toB64url(JSON.stringify(payload));
  }
  function unpackRecord(str) {
    const o = JSON.parse(fromB64url(str));
    if (o.v !== 1 || !Array.isArray(o.p)) throw new Error('지원하지 않는 링크');
    return {
      id: 'shared-' + o.s,
      mode: o.m === 'run' ? 'run' : 'walk',
      distanceM: +o.d || 0,
      durationMs: (+o.t || 0) * 1000,
      startedAt: (+o.s || 0) * 1000,
      segments: o.p.map(decodePolyline),
      shared: true,
    };
  }

  function toGPX(rec) {
    const name = `${rec.mode === 'run' ? 'Run' : 'Walk'} ${new Date(rec.startedAt).toISOString().slice(0, 10)}`;
    const segs = rec.segments.map((seg) =>
      '    <trkseg>\n' +
      seg.map((p) => `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${p[2] ? `<time>${new Date(p[2]).toISOString()}</time>` : ''}</trkpt>`).join('\n') +
      '\n    </trkseg>'
    ).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="CourseLog" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <type>${rec.mode === 'run' ? 'running' : 'walking'}</type>
${segs}
  </trk>
</gpx>
`;
  }

  // 표시용 포맷
  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  function fmtKm(m) { return (m / 1000).toFixed(2); }
  function fmtPace(ms, m) {
    if (m < 50) return `-'--"`;
    const secPerKm = ms / 1000 / (m / 1000);
    if (!isFinite(secPerKm) || secPerKm > 3600) return `-'--"`;
    const mm = Math.floor(secPerKm / 60), ss = Math.round(secPerKm % 60);
    return ss === 60 ? `${mm + 1}'00"` : `${mm}'${String(ss).padStart(2, '0')}"`;
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} (${days[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  return { distance, pathLength, simplify, encodePolyline, decodePolyline, packRecord, unpackRecord, toGPX, fmtDuration, fmtKm, fmtPace, fmtDate };
})();
