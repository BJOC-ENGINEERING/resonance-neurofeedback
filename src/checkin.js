// Check-in sheet: two 1–7 ratings, an optional real-or-sham guess, and a brief psychomotor
// vigilance test (PVT). Resolves with the answers, or null when the viewer closes it.

import { scorePvt } from './study.js';

const $ = (id) => document.getElementById(id);
const PVT_MIN_ISI = 2000, PVT_MAX_ISI = 7000;  // ms between stimuli
const PVT_TIMEOUT = 2000;                       // ms; no response by then counts as a lapse at 2 s
const ANTICIPATION = 100;                       // ms; faster responses are false starts

let active = null;


// opts: { title, sub, ratings: bool, pvt: bool, guess: bool, pvtSeconds }
export function runCheckin(opts) {
  if (active) active.finish(null);
  return new Promise(resolve => {
    const answers = { calm: null, alert: null, guess: null };
    const modal = $('checkinModal');
    const cleanups = [];
    const on = (el, ev, fn, o) => { el.addEventListener(ev, fn, o); cleanups.push(() => el.removeEventListener(ev, fn, o)); };

    $('checkinTitle').textContent = opts.title;
    $('checkinSub').textContent = opts.sub;
    $('checkinForm').hidden = false;
    $('pvtPanel').hidden = true;
    modal.querySelectorAll('.rating[data-key]').forEach(r => { r.hidden = !opts.ratings; });
    $('checkinGuess').hidden = !opts.guess;
    $('btnSkipPvt').hidden = !opts.pvt;
    for (const scale of modal.querySelectorAll('.scale')) {
      scale.innerHTML = Array.from({ length: 7 }, (_, i) => `<button data-v="${i + 1}" aria-label="${i + 1} of 7">${i + 1}</button>`).join('');
    }
    $('guessChoice').querySelectorAll('button').forEach(b => b.classList.remove('active'));

    const ready = () => (!opts.ratings || (answers.calm && answers.alert)) && (!opts.guess || answers.guess);
    const next = $('btnCheckinNext');
    const renderNext = () => {
      next.disabled = !ready();
      next.textContent = opts.pvt ? 'Start reaction test' : 'Continue';
    };
    renderNext();

    const finish = (result) => {
      cleanups.forEach(fn => fn());
      if (pvt.timer) clearTimeout(pvt.timer);
      cancelAnimationFrame(pvt.raf);
      modal.classList.remove('show');
      active = null;
      resolve(result);
    };
    active = { finish };

    on(modal, 'click', e => {
      const b = e.target.closest('.rating[data-key] .scale button');
      if (b) {
        const key = b.closest('.rating').dataset.key;
        answers[key] = Number(b.dataset.v);
        b.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        renderNext();
      }
      const g = e.target.closest('#guessChoice button');
      if (g) {
        answers.guess = g.dataset.v;
        $('guessChoice').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === g));
        renderNext();
      }
    });
    on($('btnCheckinCancel'), 'click', () => finish(null));
    on(document, 'keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } }, true);
    on($('btnSkipPvt'), 'click', () => { if (ready()) finish({ ...answers, pvt: null }); });
    on(next, 'click', () => {
      if (!ready()) return;
      if (!opts.pvt) return finish({ ...answers, pvt: null });
      startPvt();
    });

    // --- PVT ---
    const pvt = { trials: [], timer: null, raf: 0, onset: null, startedAt: 0, waiting: false };
    const box = $('pvtBox'), counter = $('pvtCounter'), prompt = $('pvtPrompt');
    const seconds = opts.pvtSeconds || 60;

    const schedule = () => {
      pvt.onset = null;
      counter.textContent = '';
      box.classList.remove('live');
      const left = seconds * 1000 - (performance.now() - pvt.startedAt);
      const isi = PVT_MIN_ISI + Math.random() * (PVT_MAX_ISI - PVT_MIN_ISI);
      // No stimulus may fall past the end: the test finishes on time.
      pvt.timer = isi < left ? setTimeout(show, isi) : setTimeout(done, Math.max(0, left));
    };
    const show = () => {
      // Onset is the frame the counter first paints.
      pvt.raf = requestAnimationFrame(t0 => {
        pvt.onset = t0;
        box.classList.add('live');
        const tick = (t) => {
          if (pvt.onset === null) return;
          const ms = t - pvt.onset;
          counter.textContent = String(Math.round(ms));
          if (ms >= PVT_TIMEOUT) return respond(pvt.onset + PVT_TIMEOUT);
          pvt.raf = requestAnimationFrame(tick);
        };
        tick(t0);
      });
    };
    const respond = (at) => {
      if (!pvt.startedAt) return;
      cancelAnimationFrame(pvt.raf);
      if (pvt.onset === null) {
        // Pressed before anything appeared.
        pvt.trials.push(null);
        clearTimeout(pvt.timer);
        $('pvtLast').textContent = 'Too soon — wait for the counter';
        return schedule();
      }
      const rt = at - pvt.onset;
      pvt.trials.push(rt < ANTICIPATION ? null : Math.min(rt, PVT_TIMEOUT));
      counter.textContent = String(Math.round(Math.min(rt, PVT_TIMEOUT)));
      $('pvtLast').textContent = rt < ANTICIPATION ? 'Too soon' : `${Math.round(Math.min(rt, PVT_TIMEOUT))} ms`;
      pvt.onset = null;
      box.classList.remove('live');
      pvt.timer = setTimeout(schedule, 700);
    };
    const done = () => {
      clearInterval(pvt.clock);
      finish({ ...answers, pvt: scorePvt(pvt.trials) });
    };
    const startPvt = () => {
      $('checkinForm').hidden = true;
      $('pvtPanel').hidden = false;
      $('pvtLast').textContent = '';
      prompt.textContent = 'Press Space or tap here as soon as the counter appears.';
      box.focus();
      pvt.startedAt = performance.now();
      pvt.clock = setInterval(() => {
        const left = Math.max(0, seconds - (performance.now() - pvt.startedAt) / 1000);
        $('pvtProgress').textContent = `${Math.ceil(left)} s left · ${pvt.trials.length} responses`;
      }, 250);
      cleanups.push(() => clearInterval(pvt.clock));
      schedule();
    };
    on(box, 'pointerdown', e => { e.preventDefault(); respond(e.timeStamp); });
    on(document, 'keydown', e => {
      if ($('pvtPanel').hidden || (e.code !== 'Space' && e.key !== 'Enter')) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) respond(e.timeStamp);
    }, true);

    modal.classList.add('show');
  });
}
