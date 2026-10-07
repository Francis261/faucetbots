
        document.addEventListener('DOMContentLoaded', function () {
            var root    = document.getElementById('w_52fe7487e7');
            var form    = root.closest('form') || document.querySelector('form');
            var gate    = document.getElementById('g_52fe7487e7');
            var spin    = document.getElementById('sp_52fe7487e7');
            var tick    = document.getElementById('tk_52fe7487e7');
            var errBox  = document.getElementById('er_52fe7487e7');
            var errText = document.getElementById('et_52fe7487e7');
            var errBtn  = document.getElementById('eb_52fe7487e7');
            var card    = document.getElementById('c_52fe7487e7');
            var stage   = document.getElementById('st_52fe7487e7');
            var refHost = document.getElementById('rh_52fe7487e7');
            var timer   = document.getElementById('tm_52fe7487e7');
            var expired = document.getElementById('ex_52fe7487e7');
            var btnNext = document.getElementById('nx_52fe7487e7');
            var btnRs   = document.getElementById('rs_52fe7487e7');
            var btnVf   = document.getElementById('vf_52fe7487e7');
            var countEl = document.getElementById('ct_52fe7487e7');
            var ansEl   = document.getElementById('ca_52fe7487e7');

            var SCENE_URL = "https:\/\/onlyfaucet.com\/faucet\/captcha_image";
            var W = 450, H = 280, MAX_TAPS = 8, TTL = 60;
            var UNTAP_RADIUS = 18;
            var taps = [], loading = false, loaded = false, submitting = false, shownAt = 0, raf = 0;

            // the canvases sit in closed shadow roots
            function shadowCanvas(host, w, h, css) {
                var sh = host.attachShadow({ mode: 'closed' });
                var st = document.createElement('style');
                st.textContent = ':host{display:block;width:100%;height:100%}' +
                    '.wrap{position:relative;width:100%;height:100%;user-select:none;-webkit-user-select:none}' +
                    'canvas{display:block;width:100%;height:100%;touch-action:manipulation}' + (css || '');
                var wrap = document.createElement('div'); wrap.className = 'wrap';
                var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
                wrap.appendChild(cv); sh.appendChild(st); sh.appendChild(wrap);
                return { canvas: cv, wrap: wrap };
            }
            var scene = shadowCanvas(stage, W, H,
                'canvas{cursor:pointer}' +
                '.mk{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #3b82f6;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 2px 6px rgba(0,0,0,.35);pointer-events:none;animation:pop .16s ease-out}' +
                '.mk span{position:absolute;top:-9px;right:-9px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#3b82f6;color:#fff;font:700 11px/17px system-ui,sans-serif;text-align:center;border:1.5px solid #fff}' +
                '@keyframes pop{from{transform:scale(.3)}to{transform:scale(1)}}');
            var ref = shadowCanvas(refHost, 150, 110);

            // the claim form can only be sent by Verify
            form.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) e.preventDefault(); });
            form.addEventListener('submit', function (e) { if (!submitting) { e.preventDefault(); return false; } });

            function showError(msg, canRetry, detail) {
                if (window.console) console.error('[captcha] ' + msg + (detail ? ' — ' + detail : ''));
                loading = false;
                spin.style.display = 'none';
                errText.textContent = msg;
                errBtn.hidden = !canRetry;
                errBox.hidden = false;
            }
            function decode(dataUrl) {
                return new Promise(function (ok, bad) {
                    var im = new Image();
                    im.onload = function () { ok(im); };
                    im.onerror = function () { bad(new Error('image decode failed')); };
                    im.src = dataUrl;
                });
            }
            function draw(c, im) { var x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height); }

            // one request creates the challenge and returns both pictures
            function load() {
                if (loading || submitting) return;
                loading = true;
                errBox.hidden = true;
                if (!loaded) spin.style.display = 'block';
                var status = 0;
                fetch(SCENE_URL + (SCENE_URL.indexOf('?') < 0 ? '?' : '&') + '_t=' + Date.now(), {
                    credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' }
                })
                    .then(function (r) { status = r.status; return r.text(); })
                    .then(function (txt) {
                        var data = null;
                        try { data = JSON.parse(txt); } catch (err) { /* not JSON: login page, error page… */ }
                        // rate limited: the controller has already stored the message as a
                        // SweetAlert flash (faucet_sweet_alert), so reload to show it
                        if (status === 429) throw { reload: true };
                        // blocked: reload so the faucet page shows its block state straight away
                        if (status === 403 && data && data.error === 'blocked') throw { reload: true };
                        if (status === 404 || status === 403) throw { msg: 'A new challenge could not be started. Refresh the page.', retry: false, detail: 'HTTP ' + status };
                        if (!data || !data.scene || !data.ref) {
                            throw { msg: status >= 500 ? 'The server could not draw the challenge.' : 'Unexpected server reply. Refresh the page.',
                                    retry: true, detail: 'HTTP ' + status + ': ' + String(txt).slice(0, 160) };
                        }
                        return Promise.all([decode(data.scene), decode(data.ref)]);
                    })
                    .then(function (ims) {
                        draw(scene.canvas, ims[0]);
                        draw(ref.canvas, ims[1]);
                        taps = []; redraw();
                        expired.hidden = true;
                        stage.style.opacity = ''; stage.style.pointerEvents = '';
                        loading = false;
                        var first = !loaded;
                        loaded = true;
                        shownAt = Date.now();
                        if (first) {
                            spin.style.display = 'none'; tick.style.display = 'block';
                            setTimeout(function () { gate.hidden = true; card.hidden = false; runTimer(); }, 300);
                        } else {
                            runTimer();
                        }
                    })
                    .catch(function (err) {
                        if (err && err.reload) { window.location.reload(); return; }
                        if (err && err.msg) showError(err.msg, err.retry, err.detail);
                        else showError('Could not load the challenge. Check your connection.', true, err && err.message);
                    });
            }
            gate.addEventListener('click', load);
            gate.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); load(); } });
            errBtn.addEventListener('click', load);
            btnNext.addEventListener('click', load);

            function coords(e) {
                var r = scene.canvas.getBoundingClientRect();
                var x = Math.round((e.clientX - r.left) / r.width * W), y = Math.round((e.clientY - r.top) / r.height * H);
                return { x: Math.max(0, Math.min(W - 1, x)), y: Math.max(0, Math.min(H - 1, y)) };
            }
            function redraw() {
                scene.wrap.querySelectorAll('.mk').forEach(function (m) { m.remove(); });
                taps.forEach(function (t, i) {
                    var m = document.createElement('div'); m.className = 'mk';
                    var n = document.createElement('span'); n.textContent = i + 1; m.appendChild(n);
                    m.style.left = (t.x / W * 100) + '%'; m.style.top = (t.y / H * 100) + '%';
                    scene.wrap.appendChild(m);
                });
                ansEl.value = taps.map(function (t) { return t.x + ',' + t.y; }).join(';');
                btnVf.disabled = taps.length === 0;
                btnRs.disabled = taps.length === 0;
                countEl.textContent = taps.length ? taps.length + ' selected' : 'Nothing selected';
            }
            scene.canvas.addEventListener('click', function (e) {
                if (!loaded || loading || submitting || !expired.hidden) return;
                var c = coords(e);
                // tapping an existing marker again removes it
                for (var i = 0; i < taps.length; i++) {
                    if (Math.hypot(taps[i].x - c.x, taps[i].y - c.y) <= UNTAP_RADIUS) { taps.splice(i, 1); redraw(); return; }
                }
                if (taps.length >= MAX_TAPS) return;
                taps.push(c);
                redraw();
            });
            btnRs.addEventListener('click', function () { if (!submitting) { taps = []; redraw(); } });

            btnVf.addEventListener('click', function () {
                if (!taps.length || submitting || loading || !expired.hidden) return;
                submitting = true;
                cancelAnimationFrame(raf);
                btnVf.disabled = true; btnRs.disabled = true; btnVf.textContent = 'Verifying…';
                stage.style.opacity = '.6'; stage.style.pointerEvents = 'none';
                HTMLFormElement.prototype.submit.call(form);
            });

            function runTimer() {
                cancelAnimationFrame(raf);
                (function step() {
                    var frac = Math.max(0, (TTL - (Date.now() - shownAt) / 1000) / TTL);
                    timer.style.transform = 'scaleX(' + frac + ')';
                    timer.style.background = frac > 0.5 ? '#10b981' : (frac > 0.2 ? '#f59e0b' : '#ef4444');
                    if (submitting) return;
                    if (frac <= 0) {
                        taps = []; redraw();
                        expired.hidden = false;
                        countEl.textContent = 'Time ran out';
                        return;
                    }
                    raf = requestAnimationFrame(step);
                })();
            }
        });
        