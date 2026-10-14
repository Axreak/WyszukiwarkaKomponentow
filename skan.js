/* ============================================================================
   skan.js — skanowanie masterek (kod kreskowy) + rejestracja service workera
   Doczepiany do index.html jedną linijką:  <script src="skan.js" defer></script>
   Korzysta z index.html: db, allItems, goTo(), toast(), fetchItems()
   ========================================================================== */
(function () {
  'use strict';

  // ── Instalacja PWA (service worker) ───────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // ── Co wyciągamy z kodów ──────────────────────────────────────────────────
  // Numer materiału: MP + 8 cyfr + litera, np. MP25058525D.
  // Występuje w kodzie Code39 oraz w DataMatrix (wtedy jest sklejony z dostawcą
  // i partią: MP25058525D1048122607070), dlatego szukamy go wzorcem.
  var RE_MATERIAL = /MP\d{8}[A-Z]/;

  function extractNumer(text, format) {
    var m = RE_MATERIAL.exec(String(text || '').toUpperCase());
    if (m) return m[0];
    // Nietypowy numer, ale z kodu Code39 (to na masterce jest numer materiału)
    if (/code.?39/i.test(String(format || '')) && text) return String(text).trim();
    return null; // inne kody (partia, SSCC, storage unit) ignorujemy
  }

  // ── Budowa interfejsu (kafelek + ekran) ───────────────────────────────────
  var stream = null, zxReader = null, loopOn = false, found = false, hintTimer = null;
  var detector = null;

  function buildUI() {
    var app = document.getElementById('app');
    var tiles = document.querySelector('.home-tiles');
    if (!app || !tiles || document.getElementById('screen-skan')) return;

    var tile = document.createElement('div');
    tile.className = 'tile';
    tile.onclick = function () { openSkan(); };
    tile.innerHTML =
      '<div class="tile-icon" style="background:#FEE2E2">📷</div>' +
      '<div class="tile-txt"><div class="tile-name">Skanuj masterkę</div>' +
      '<div class="tile-desc">Zeskanuj kod kreskowy z numerem palety</div></div>' +
      '<div class="tile-arr">›</div>';
    tiles.insertBefore(tile, tiles.children[1] || null);

    var scr = document.createElement('div');
    scr.className = 'screen';
    scr.id = 'screen-skan';
    scr.innerHTML =
      '<div class="appbar">' +
        '<button class="btn-back" id="skan-back">‹</button>' +
        '<div style="flex:1"><div class="appbar-title">Skanuj masterkę</div></div>' +
      '</div>' +
      '<div style="padding:12px;flex:1;overflow-y:auto">' +
        '<div id="skan-cam">' +
          '<div style="position:relative;border-radius:12px;overflow:hidden;background:#000;aspect-ratio:4/3">' +
            '<video id="skan-video" style="width:100%;height:100%;object-fit:cover" playsinline muted autoplay></video>' +
            '<div style="position:absolute;left:10%;right:10%;top:50%;height:2px;background:rgba(255,59,48,.85);box-shadow:0 0 8px rgba(255,59,48,.6)"></div>' +
          '</div>' +
          '<div id="skan-status" style="text-align:center;font-size:13px;color:var(--muted);margin:10px 0">Nakieruj na kod kreskowy z numerem (MP…)</div>' +
          '<button class="btn btn-ghost" style="width:100%;justify-content:center" id="skan-manual">✏️ Wpisz numer ręcznie</button>' +
        '</div>' +
        '<div id="skan-res" style="display:none;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px">' +
          '<div id="skan-load" style="display:none;text-align:center;color:var(--muted);padding:18px 0">Sprawdzam w bazie…</div>' +
          '<div id="skan-found" style="display:none">' +
            '<div style="font-size:12px;color:var(--green);font-weight:600;margin-bottom:6px">✅ ZNALEZIONO W BAZIE</div>' +
            '<div id="skan-f-numer" style="font-size:20px;font-weight:700;margin-bottom:4px;word-break:break-all"></div>' +
            '<div id="skan-f-opis" style="font-size:15px;color:var(--txt2);margin-bottom:16px"></div>' +
            '<div style="display:flex;gap:8px">' +
              '<button class="btn btn-ghost" style="flex:1;justify-content:center" id="skan-again1">Skanuj dalej</button>' +
              '<button class="btn btn-primary" style="flex:1;justify-content:center" id="skan-tosearch">🔍 W wyszukiwarce</button>' +
            '</div>' +
          '</div>' +
          '<div id="skan-new" style="display:none">' +
            '<div id="skan-n-note" style="font-size:13px;margin-bottom:12px"></div>' +
            '<div class="field"><label>Numer palety</label><input type="text" id="skan-numer" autocapitalize="characters"></div>' +
            '<div class="field" id="skan-opis-wrap"><label>Opis</label><input type="text" id="skan-opis" placeholder="np. PLATE - CENTER - EXH"></div>' +
            '<div style="display:flex;gap:8px;margin-top:4px">' +
              '<button class="btn btn-ghost" style="flex:1;justify-content:center" id="skan-again2">Skanuj dalej</button>' +
              '<button class="btn btn-primary" style="flex:1;justify-content:center" id="skan-primary">Dodaj do bazy</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</div>';
    app.appendChild(scr);

    document.getElementById('skan-back').onclick = function () { stopCam(); goTo('home'); };
    document.getElementById('skan-manual').onclick = function () { stopCam(); showNew('', 'manual'); };
    document.getElementById('skan-again1').onclick = function () { startCam(); };
    document.getElementById('skan-again2').onclick = function () { startCam(); };
    document.getElementById('skan-tosearch').onclick = toSearch;
    document.getElementById('skan-primary').onclick = primaryAction;
    document.getElementById('skan-numer').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') primaryAction();
    });
  }

  function openSkan() {
    goTo('skan');
    startCam();
  }

  // ── Kamera ────────────────────────────────────────────────────────────────
  function setStatus(t) { var e = document.getElementById('skan-status'); if (e) e.textContent = t; }

  async function startCam() {
    stopCam();
    found = false;
    document.getElementById('skan-res').style.display = 'none';
    document.getElementById('skan-cam').style.display = 'block';
    setStatus('Uruchamiam kamerę…');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
    } catch (e) {
      setStatus('Brak dostępu do kamery — wpisz numer ręcznie');
      return;
    }

    // ciągły autofokus, jeśli telefon pozwala
    try {
      var tr = stream.getVideoTracks()[0];
      await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch (e) { /* nie wszystkie telefony wspierają */ }

    var video = document.getElementById('skan-video');
    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    setStatus('Nakieruj na kod kreskowy z numerem (MP…)');

    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      if (!found) setStatus('Nie widzę kodu — zmień odległość, dołóż światła albo wpisz ręcznie');
    }, 12000);

    if ('BarcodeDetector' in window) startNative(video);
    else startZXing(video);
  }

  function stopCam() {
    loopOn = false;
    clearTimeout(hintTimer);
    if (zxReader) { try { zxReader.reset(); } catch (e) {} zxReader = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    var v = document.getElementById('skan-video');
    if (v) v.srcObject = null;
  }

  // Chrome na Androidzie — natywny, szybki detektor
  async function startNative(video) {
    try {
      detector = new BarcodeDetector({ formats: ['code_39', 'code_128', 'data_matrix', 'qr_code'] });
    } catch (e) { return startZXing(video); }
    loopOn = true;
    (async function loop() {
      while (loopOn && !found) {
        try {
          var codes = await detector.detect(video);
          for (var i = 0; i < codes.length; i++) {
            var n = extractNumer(codes[i].rawValue, codes[i].format);
            if (n) { onFound(n); return; }
          }
        } catch (e) { /* klatka bez kodu */ }
        await new Promise(function (r) { setTimeout(r, 120); });
      }
    })();
  }

  // Safari / iPhone i reszta — biblioteka ZXing (ładowana dopiero gdy potrzebna)
  function loadZXing() {
    if (window.ZXing) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.19.1/umd/index.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function startZXing(video) {
    try { await loadZXing(); } catch (e) { setStatus('Nie udało się wczytać skanera — wpisz numer ręcznie'); return; }
    var hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.DATA_MATRIX, ZXing.BarcodeFormat.QR_CODE
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxReader = new ZXing.BrowserMultiFormatReader(hints, 150);
    zxReader.decodeFromStream(stream, video, function (result) {
      if (!result || found) return;
      var fmt = ZXing.BarcodeFormat[result.getBarcodeFormat()];
      var n = extractNumer(result.getText(), fmt);
      if (n) onFound(n);
    });
  }

  // ── Wynik: najpierw SPRAWDŹ w bazie, nic nie dodajemy automatycznie ───────
  var currentNumer = '';
  var mode = 'new'; // 'new' = można dodać, 'manual' = trzeba najpierw sprawdzić

  function showPanel(name) {
    document.getElementById('skan-cam').style.display = 'none';
    document.getElementById('skan-res').style.display = 'block';
    document.getElementById('skan-load').style.display  = name === 'load'  ? 'block' : 'none';
    document.getElementById('skan-found').style.display = name === 'found' ? 'block' : 'none';
    document.getElementById('skan-new').style.display   = name === 'new'   ? 'block' : 'none';
  }

  function onFound(numer) {
    if (found) return;
    found = true;
    if (navigator.vibrate) navigator.vibrate(80);
    stopCam();
    checkNumer(numer);
  }

  async function lookup(numer) {
    var safe = String(numer).replace(/[\\%_]/g, '\\$&'); // bez znaków specjalnych LIKE
    var r = await db.from('items').select('*').ilike('numer', safe).limit(1);
    if (r.error) throw r.error;
    return (r.data && r.data[0]) || null;
  }

  async function checkNumer(numer) {
    numer = String(numer || '').trim().toUpperCase();
    if (!numer) { toast('Wpisz numer palety'); return; }
    currentNumer = numer;
    showPanel('load');
    try {
      var item = await lookup(numer);
      if (item) showFound(item); else showNew(numer, 'new');
    } catch (e) {
      toast('Błąd połączenia: ' + e.message);
      showNew(numer, 'manual'); // można spróbować ponownie przyciskiem „Sprawdź”
    }
  }

  function showFound(item) {
    currentNumer = item.numer;
    document.getElementById('skan-f-numer').textContent = item.numer || '';
    document.getElementById('skan-f-opis').textContent = item.opis || '—';
    showPanel('found');
  }

  function showNew(numer, m) {
    mode = m;
    var note = document.getElementById('skan-n-note');
    var primary = document.getElementById('skan-primary');
    document.getElementById('skan-numer').value = numer;
    document.getElementById('skan-opis').value = '';
    if (m === 'manual') {
      note.textContent = 'Wpisz numer palety i sprawdź, czy jest w bazie.';
      note.style.color = 'var(--txt2)';
      document.getElementById('skan-opis-wrap').style.display = 'none';
      primary.textContent = '🔎 Sprawdź';
    } else {
      note.innerHTML = '🆕 <strong>Tej palety nie ma w bazie.</strong> Możesz ją dodać.';
      note.style.color = 'var(--accent-tx)';
      document.getElementById('skan-opis-wrap').style.display = '';
      primary.textContent = '➕ Dodaj do bazy';
    }
    showPanel('new');
    document.getElementById(m === 'manual' ? 'skan-numer' : 'skan-opis').focus();
  }

  function primaryAction() {
    if (mode === 'manual') checkNumer(document.getElementById('skan-numer').value);
    else addNew();
  }

  // Dodanie — tylko po świadomym kliknięciu „Dodaj do bazy”
  async function addNew() {
    var numer = document.getElementById('skan-numer').value.trim().toUpperCase();
    var opis = document.getElementById('skan-opis').value.trim();
    if (!numer) { toast('Wpisz numer palety'); return; }
    try {
      var dup = await lookup(numer); // zabezpieczenie przed duplikatem
      if (dup) { showFound(dup); toast('Taka paleta już jest w bazie'); return; }
      var r = await db.from('items').insert({ numer: numer, opis: opis || '—' });
      if (r.error) throw r.error;
      toast('Dodano do bazy');
      fetchItems();
      startCam(); // następna paleta
    } catch (e) {
      toast('Błąd zapisu: ' + e.message);
    }
  }

  // Przejście do wyszukiwarki z wpisanym numerem
  function toSearch() {
    goTo('wyszukiwarka');
    var inp = document.getElementById('search-input');
    if (inp) { inp.value = currentNumer; filterItems(); }
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  buildUI();
})();
