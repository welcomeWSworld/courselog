(() => {
  'use strict';

  // ---------- 설정 ----------
  const MAX_ACCURACY = 35;               // 이보다 오차가 큰 위치는 기록하지 않음(m)
  const MIN_STEP = 3;                     // 이보다 짧은 이동은 GPS 흔들림으로 보고 무시(m)
  const MAX_SPEED = { walk: 6, run: 10 }; // 이보다 빠르면 튐으로 판단(m/s)
  const STALE_MS = 12000;                 // 이 시간 동안 위치가 안 오면 "신호 없음"
  const RECORDS_KEY = 'courselog.records';
  const ACTIVE_KEY = 'courselog.active';

  // ?sim=1 (또는 ?sim=5 처럼 배속) 이면 가짜 GPS로 동작 — PC 테스트용
  const params = new URLSearchParams(location.search);
  const SIM = params.has('sim') ? Math.max(1, Number(params.get('sim')) || 1) : 0;

  const $ = (s) => document.querySelector(s);
  const MODE_LABEL = { walk: '산책', run: '러닝' };

  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
    },
    del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
  };

  // ---------- 지도 ----------
  const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([37.5665, 126.978], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const routeLayer = L.layerGroup().addTo(map);
  let liveLines = [];
  let meMarker = null;
  let meCircle = null;

  const accentColor = () => getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#16a34a';

  function updateMe(latlng, accuracy) {
    if (!meMarker) {
      meMarker = L.marker(latlng, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      meCircle = L.circle(latlng, { radius: accuracy, color: '#2563eb', weight: 1, opacity: 0.4, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng(latlng);
      meCircle.setLatLng(latlng).setRadius(accuracy);
    }
  }

  function sheetPadding() {
    const sheet = document.querySelector('.sheet:not(.hidden)');
    return { paddingTopLeft: [30, 80], paddingBottomRight: [30, (sheet ? sheet.offsetHeight : 0) + 30] };
  }

  function pinIcon(kind) {
    return L.divIcon({ className: '', html: `<div class="pin ${kind}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
  }

  function drawRecord(rec) {
    routeLayer.clearLayers();
    const color = rec.mode === 'run' ? '#ea580c' : '#16a34a';
    const all = [];
    rec.segments.forEach((seg) => {
      const ll = seg.map((p) => [p[0], p[1]]);
      all.push(...ll);
      L.polyline(ll, { color, weight: 6, opacity: 0.9, lineJoin: 'round', lineCap: 'round' }).addTo(routeLayer);
    });
    if (!all.length) return;
    L.marker(all[0], { icon: pinIcon('start'), interactive: false }).addTo(routeLayer);
    L.marker(all[all.length - 1], { icon: pinIcon('end'), interactive: false }).addTo(routeLayer);
    map.fitBounds(L.latLngBounds(all), sheetPadding());
  }

  function clearLive() {
    liveLines.forEach((l) => l.remove());
    liveLines = [];
  }

  function drawLive() {
    const segs = session.segments;
    while (liveLines.length < segs.length) {
      liveLines.push(L.polyline([], { color: accentColor(), weight: 6, opacity: 0.9, lineJoin: 'round', lineCap: 'round' }).addTo(map));
    }
    segs.forEach((seg, i) => {
      if (i >= segs.length - 2 || liveLines[i].getLatLngs().length !== seg.length) {
        liveLines[i].setLatLngs(seg.map((p) => [p[0], p[1]]));
      }
    });
  }

  // ---------- 화면 전환 ----------
  const views = ['home', 'track', 'result', 'history'];
  function showView(name) {
    views.forEach((v) => $('#view-' + v).classList.toggle('hidden', v !== name));
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------- 모드 ----------
  let mode = 'walk';
  function setMode(m) {
    mode = m;
    document.body.classList.toggle('run', m === 'run');
    document.querySelectorAll('.mode').forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    });
  }
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------- 위치 제공자 ----------
  function makeSimGeo() {
    let center = null, angle = 0, ids = 0;
    const timers = {};
    const fix = () => {
      if (!center) center = map.getCenter();
      const speed = ((session && session.mode === 'run') ? 3 : 1.4) * SIM;
      const r = 250;
      angle += speed / r;
      const wob = 1 + 0.25 * Math.sin(angle * 3); // 꽃잎 모양 루프
      const dLat = (r * wob * Math.sin(angle)) / 111320;
      const dLng = (r * wob * Math.cos(angle)) / (111320 * Math.cos((center.lat * Math.PI) / 180));
      const noise = () => (Math.random() - 0.5) * 0.00003;
      const bad = Math.random() < 0.05; // 가끔 오차 큰 위치(필터 테스트)
      return {
        coords: { latitude: center.lat + dLat + noise(), longitude: center.lng + dLng + noise(), accuracy: bad ? 60 : 5 + Math.random() * 6 },
        timestamp: Date.now(),
      };
    };
    return {
      getCurrentPosition(ok) { setTimeout(() => ok(fix()), 100); },
      watchPosition(ok) {
        const id = ++ids;
        setTimeout(() => ok(fix()), 100);
        timers[id] = setInterval(() => ok(fix()), 1000);
        return id;
      },
      clearWatch(id) { clearInterval(timers[id]); delete timers[id]; },
    };
  }
  const geo = SIM ? makeSimGeo() : navigator.geolocation;
  const GEO_OPTS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

  // ---------- 기록 세션 ----------
  let session = null;   // 진행 중인 기록
  let watchId = null;
  let timerId = null;
  let wakeLock = null;
  let follow = true;
  let lastFixAt = 0;
  let lastAccuracy = null;
  let rejects = 0;

  function elapsed(now = Date.now()) {
    if (!session) return 0;
    const pausedNow = session.pauseStart ? now - session.pauseStart : 0;
    return now - session.startedAt - session.pausedMs - pausedNow;
  }

  function persistActive() {
    if (session) store.set(ACTIVE_KEY, { ...session, savedAt: Date.now() });
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  function onPosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    const t = pos.timestamp || Date.now();
    lastFixAt = Date.now();
    lastAccuracy = accuracy;
    updateMe([latitude, longitude], accuracy);
    renderGpsBadge();

    if (!session || session.pauseStart) return;
    if (follow) map.panTo([latitude, longitude], { animate: true });
    if (accuracy > MAX_ACCURACY) return;

    const segs = session.segments;
    let seg = segs[segs.length - 1];
    const p = [round6(latitude), round6(longitude), t];
    const last = seg[seg.length - 1];

    if (last) {
      const d = Geo.distance(last, p);
      const dt = Math.max(1, (t - last[2]) / 1000);
      if (d < Math.max(MIN_STEP, accuracy * 0.3)) return;
      if (d / dt > MAX_SPEED[session.mode] * (SIM || 1)) {
        // 튄 값으로 보고 버림. 계속 튀면(=이전 점이 틀렸던 것) 새 구간으로 다시 시작
        if (++rejects < 5) return;
        if (seg.length === 1) seg.pop(); else { seg = []; segs.push(seg); }
        rejects = 0;
        seg.push(p);
        drawLive();
        persistActive();
        return;
      }
      if (dt > 30) toast('잠시 위치 기록이 끊겼다가 다시 이어졌어요');
      session.distanceM += d;
    }
    rejects = 0;
    seg.push(p);
    drawLive();
    renderStats();
    persistActive();
  }

  function onPositionError(err) {
    if (err.code === 1) {
      $('#gps-badge').textContent = '위치 권한 없음';
      $('#gps-badge').className = 'badge bad';
      toast('위치 권한이 꺼져 있어요. 설정 > 개인정보 보호 > 위치 서비스 > Safari 웹 사이트에서 허용해 주세요.', 6000);
    }
  }

  function startWatch() {
    if (watchId !== null) return;
    watchId = geo.watchPosition(onPosition, onPositionError, GEO_OPTS);
  }
  function stopWatch() {
    if (watchId !== null) geo.clearWatch(watchId);
    watchId = null;
  }

  function renderGpsBadge() {
    const el = $('#gps-badge');
    if (!lastFixAt) { el.textContent = 'GPS 찾는 중'; el.className = 'badge'; return; }
    if (Date.now() - lastFixAt > STALE_MS) { el.textContent = 'GPS 신호 없음'; el.className = 'badge bad'; return; }
    if (lastAccuracy <= 15) { el.textContent = `GPS 좋음 ±${Math.round(lastAccuracy)}m`; el.className = 'badge ok'; }
    else if (lastAccuracy <= MAX_ACCURACY) { el.textContent = `GPS 보통 ±${Math.round(lastAccuracy)}m`; el.className = 'badge'; }
    else { el.textContent = `GPS 약함 ±${Math.round(lastAccuracy)}m (기록 보류)`; el.className = 'badge bad'; }
  }

  function renderStats() {
    if (!session) return;
    const ms = elapsed();
    $('#s-time').textContent = Geo.fmtDuration(ms);
    $('#s-dist').textContent = Geo.fmtKm(session.distanceM);
    $('#s-pace').textContent = Geo.fmtPace(ms, session.distanceM);
  }

  function startTimer() {
    stopTimer();
    timerId = setInterval(() => { renderStats(); renderGpsBadge(); }, 1000);
  }
  function stopTimer() { clearInterval(timerId); timerId = null; }

  // 화면 꺼짐 방지 (iOS 16.4+ Safari 지원)
  async function requestWake() {
    const el = $('#wake-badge');
    if (!('wakeLock' in navigator)) { el.textContent = '화면 자동잠금을 꺼주세요'; return; }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      el.textContent = '화면 켜짐 유지 중';
      el.className = 'badge ok';
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        if (session) { el.textContent = '화면 켜짐 유지 해제됨'; el.className = 'badge muted'; }
      });
    } catch {
      el.textContent = '화면 자동잠금을 꺼주세요';
      el.className = 'badge muted';
    }
  }
  function releaseWake() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    $('#wake-badge').textContent = '';
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session && !wakeLock) requestWake();
  });

  function setPauseUI() {
    const paused = !!(session && session.pauseStart);
    $('#btn-pause').textContent = paused ? '재개' : '일시정지';
    $('#btn-pause').className = paused ? 'primary' : 'secondary';
  }

  function beginTracking() {
    showView('track');
    setMode(session.mode);
    clearLive();
    routeLayer.clearLayers();
    drawLive();
    follow = true;
    startWatch();
    startTimer();
    requestWake();
    setPauseUI();
    renderStats();
    renderGpsBadge();
  }

  function start() {
    if (!geo) { toast('이 브라우저는 위치 기능을 지원하지 않아요'); return; }
    if (!SIM && !window.isSecureContext) { toast('GPS는 https:// 주소에서만 동작해요', 5000); return; }
    session = { mode, startedAt: Date.now(), segments: [[]], distanceM: 0, pausedMs: 0, pauseStart: null };
    lastFixAt = 0;
    rejects = 0;
    persistActive();
    beginTracking();
  }

  function togglePause() {
    if (!session) return;
    if (session.pauseStart) {
      session.pausedMs += Date.now() - session.pauseStart;
      session.pauseStart = null;
      // 일시정지 동안 이동한 부분은 선으로 잇지 않도록 새 구간 시작
      if (session.segments[session.segments.length - 1].length) session.segments.push([]);
    } else {
      session.pauseStart = Date.now();
    }
    setPauseUI();
    renderStats();
    persistActive();
  }

  function stop() {
    if (!session) return;
    if (!confirm('기록을 종료할까요?')) return;
    const durationMs = elapsed();
    stopWatch();
    stopTimer();
    releaseWake();
    store.del(ACTIVE_KEY);
    const segments = session.segments.filter((s) => s.length > 1);
    const s = session;
    session = null;
    clearLive();

    if (!segments.length || s.distanceM < 20) {
      toast('이동 거리가 너무 짧아서 저장하지 않았어요');
      showView('home');
      return;
    }
    const rec = { id: String(s.startedAt), mode: s.mode, startedAt: s.startedAt, endedAt: Date.now(), durationMs, distanceM: s.distanceM, segments };
    saveRecord(rec);
    openResult(rec);
  }

  // ---------- 저장된 기록 ----------
  function loadRecords() { return store.get(RECORDS_KEY, []); }
  function saveRecord(rec) {
    const list = loadRecords().filter((r) => r.id !== rec.id);
    list.unshift(rec);
    if (!store.set(RECORDS_KEY, list)) toast('저장 공간이 부족해서 기록을 저장하지 못했어요. 오래된 기록을 지워주세요.', 5000);
  }
  function deleteRecord(id) {
    store.set(RECORDS_KEY, loadRecords().filter((r) => r.id !== id));
  }

  function renderHistory() {
    const ul = $('#history-list');
    const list = loadRecords();
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="empty">아직 기록이 없어요</li>';
      return;
    }
    list.forEach((rec) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="h-main">
          <div class="h-dist">${rec.mode === 'run' ? '🏃' : '🚶'} ${Geo.fmtKm(rec.distanceM)} km</div>
          <div class="h-sub">${Geo.fmtDate(rec.startedAt)} · ${Geo.fmtDuration(rec.durationMs)}${rec.shared ? ' · 공유받음' : ''}</div>
        </div>
        <button class="h-del" aria-label="삭제">삭제</button>`;
      li.querySelector('.h-main').addEventListener('click', () => openResult(rec));
      li.querySelector('.h-del').addEventListener('click', () => {
        if (confirm('이 기록을 삭제할까요?')) { deleteRecord(rec.id); renderHistory(); }
      });
      ul.appendChild(li);
    });
  }

  // ---------- 결과 화면 ----------
  let current = null;

  function openResult(rec, { fromLink = false } = {}) {
    current = rec;
    setMode(rec.mode);
    showView('result');
    $('#r-title').textContent = fromLink ? `공유받은 ${MODE_LABEL[rec.mode]} 코스` : `${MODE_LABEL[rec.mode]} 코스`;
    $('#r-date').textContent = rec.startedAt ? Geo.fmtDate(rec.startedAt) : '';
    $('#r-dist').textContent = Geo.fmtKm(rec.distanceM);
    $('#r-time').textContent = Geo.fmtDuration(rec.durationMs);
    $('#r-pace').textContent = Geo.fmtPace(rec.durationMs, rec.distanceM);
    $('#result-actions').classList.toggle('hidden', fromLink);
    $('#shared-actions').classList.toggle('hidden', !fromLink);
    drawRecord(rec);
  }

  function closeResult() {
    current = null;
    routeLayer.clearLayers();
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    showView('home');
  }

  function shareUrl(rec) {
    return `${location.origin}${location.pathname}#r=${Geo.packRecord(rec)}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('링크를 복사했어요');
    } catch {
      prompt('아래 링크를 복사하세요', text);
    }
  }

  async function shareLink() {
    if (!current) return;
    const url = shareUrl(current);
    const text = `${MODE_LABEL[current.mode]} ${Geo.fmtKm(current.distanceM)}km · ${Geo.fmtDuration(current.durationMs)} — CourseLog`;
    if (navigator.share) {
      try { await navigator.share({ title: 'CourseLog 코스', text, url }); }
      catch (e) { if (e.name !== 'AbortError') copyText(url); }
    } else {
      copyText(url);
    }
  }

  async function shareOrDownload(file) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function fileStamp(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // 공유용 이미지 카드 (1080x1350, 인스타 세로 비율)
  function renderCard(rec) {
    const W = 1080, H = 1350;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const color = rec.mode === 'run' ? '#fb923c' : '#4ade80';
    const font = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0f172a');
    bg.addColorStop(1, '#1e293b');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // 경로를 박스 안에 맞춰 그리기
    const pts = rec.segments.flat();
    const lat0 = (pts.reduce((s, p) => s + p[0], 0) / pts.length) * Math.PI / 180;
    const proj = (p) => [p[1] * Math.cos(lat0), -p[0]];
    const xy = pts.map(proj);
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const box = { x: 110, y: 190, w: W - 220, h: 760 };
    const scale = Math.min(box.w / (maxX - minX || 1e-9), box.h / (maxY - minY || 1e-9));
    const ox = box.x + (box.w - (maxX - minX) * scale) / 2;
    const oy = box.y + (box.h - (maxY - minY) * scale) / 2;
    const toPx = (p) => { const [x, y] = proj(p); return [ox + (x - minX) * scale, oy + (y - minY) * scale]; };

    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = color;
    g.lineWidth = 16;
    g.shadowColor = color;
    g.shadowBlur = 30;
    rec.segments.forEach((seg) => {
      g.beginPath();
      seg.forEach((p, i) => { const [x, y] = toPx(p); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    });
    g.shadowBlur = 0;
    const dot = (p, fill) => { const [x, y] = toPx(p); g.beginPath(); g.arc(x, y, 18, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); g.lineWidth = 6; g.strokeStyle = '#fff'; g.stroke(); };
    dot(pts[0], '#22c55e');
    dot(pts[pts.length - 1], '#ef4444');

    g.fillStyle = 'rgba(255,255,255,.6)';
    g.font = `600 36px ${font}`;
    g.fillText(`CourseLog · ${MODE_LABEL[rec.mode]}`, 80, 110);

    g.fillStyle = '#fff';
    g.font = `800 150px ${font}`;
    const km = Geo.fmtKm(rec.distanceM);
    g.fillText(km, 80, 1130);
    const kmW = g.measureText(km).width;
    g.font = `700 60px ${font}`;
    g.fillText('km', 80 + kmW + 18, 1130);

    g.font = `600 44px ${font}`;
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.fillText(`${Geo.fmtDuration(rec.durationMs)}   ·   ${Geo.fmtPace(rec.durationMs, rec.distanceM)} /km`, 80, 1210);
    g.font = `500 34px ${font}`;
    g.fillStyle = 'rgba(255,255,255,.5)';
    if (rec.startedAt) g.fillText(Geo.fmtDate(rec.startedAt), 80, 1270);

    return new Promise((res) => c.toBlob(res, 'image/png'));
  }

  async function shareImage() {
    if (!current) return;
    const blob = await renderCard(current);
    await shareOrDownload(new File([blob], `courselog-${fileStamp(current.startedAt)}.png`, { type: 'image/png' }));
  }

  async function shareGpx() {
    if (!current) return;
    const file = new File([Geo.toGPX(current)], `courselog-${fileStamp(current.startedAt)}.gpx`, { type: 'application/gpx+xml' });
    await shareOrDownload(file);
  }

  // ---------- 이벤트 ----------
  $('#btn-start').addEventListener('click', start);
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-stop').addEventListener('click', stop);
  $('#btn-history').addEventListener('click', () => { renderHistory(); showView('history'); });
  $('#btn-close-history').addEventListener('click', () => showView('home'));
  $('#btn-close-result').addEventListener('click', closeResult);
  $('#btn-share-link').addEventListener('click', shareLink);
  $('#btn-share-image').addEventListener('click', shareImage);
  $('#btn-gpx').addEventListener('click', shareGpx);
  $('#btn-save-shared').addEventListener('click', () => {
    if (!current) return;
    saveRecord(current);
    toast('내 기록에 저장했어요');
  });
  $('#btn-go-home').addEventListener('click', closeResult);

  map.on('dragstart', () => { if (session) follow = false; });
  $('#btn-locate').addEventListener('click', () => {
    follow = true;
    if (meMarker) map.setView(meMarker.getLatLng(), Math.max(map.getZoom(), 16));
    if (!geo) return;
    geo.getCurrentPosition(
      (pos) => {
        updateMe([pos.coords.latitude, pos.coords.longitude], pos.coords.accuracy);
        map.setView([pos.coords.latitude, pos.coords.longitude], Math.max(map.getZoom(), 16));
      },
      onPositionError,
      GEO_OPTS
    );
  });

  // ---------- 시작 시 ----------
  function openFromHash() {
    const m = location.hash.match(/^#r=([\w-]+)/);
    if (!m) return false;
    try {
      openResult(Geo.unpackRecord(m[1]), { fromLink: true });
    } catch {
      toast('공유 링크를 읽을 수 없어요');
      history.replaceState(null, '', location.pathname + location.search);
      return false;
    }
    return true;
  }
  window.addEventListener('hashchange', openFromHash);

  if (SIM) toast(`가짜 GPS 모드 (${SIM}배속)`);

  const saved = store.get(ACTIVE_KEY, null);
  if (saved && saved.segments) {
    if (confirm('끝나지 않은 기록이 있어요. 이어서 할까요?\n(취소하면 지금까지의 기록을 저장해요)')) {
      session = saved;
      if (!session.pauseStart) session.pauseStart = saved.savedAt || Date.now(); // 꺼져 있던 시간은 일시정지로 처리
      delete session.savedAt;
      beginTracking();
      toast('일시정지 상태예요. 재개를 누르면 이어서 기록해요.', 4000);
    } else {
      store.del(ACTIVE_KEY);
      const segments = saved.segments.filter((s) => s.length > 1);
      if (segments.length && saved.distanceM >= 20) {
        const end = saved.pauseStart || saved.savedAt || Date.now();
        const rec = { id: String(saved.startedAt), mode: saved.mode, startedAt: saved.startedAt, endedAt: end, durationMs: end - saved.startedAt - saved.pausedMs, distanceM: saved.distanceM, segments };
        saveRecord(rec);
        openResult(rec);
      }
    }
  } else if (!openFromHash()) {
    // 이미 위치 권한을 허용한 경우에만 현재 위치로 이동 (권한 팝업을 바로 띄우지 않음)
    if (SIM) $('#btn-locate').click();
    else if (navigator.permissions && geo) {
      navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') $('#btn-locate').click(); }).catch(() => {});
    }
  }
})();
