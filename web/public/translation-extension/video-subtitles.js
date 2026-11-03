/* global document, window, MutationObserver */
// Bilingual video subtitles for HTML5 <video> with text tracks (<track> / addTextTrack).
//
// For the first showing caption/subtitle track of a video we listen to `cuechange`,
// translate each cue's text once (cached by text) and render the translation as a second
// line under the native captions. The native track keeps rendering untouched; turning the
// feature off removes our overlay and listeners. Sites that draw subtitles with their own
// DOM (no TextTrack) are not covered here.
(function attachVideoSubtitles(global) {
  'use strict';
  const MAX_CACHE = 500;

  function create({ translate }) {
    const sessions = new Map(); // video -> session
    let enabled = false;

    function overlayFor(video) {
      const host = document.createElement('div');
      host.setAttribute('data-aih-translation-extension', 'subtitle');
      host.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;display:none;'
        + 'left:0;top:0;width:0;text-align:center;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const line = document.createElement('div');
      line.style.cssText = 'display:inline-block;max-width:92%;margin:0 auto;padding:3px 10px;border-radius:6px;'
        + 'background:rgba(0,0,0,.72);color:#ffe9a8;font:600 clamp(13px,2.1vw,22px)/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
        + 'text-shadow:0 1px 2px #000;white-space:pre-wrap;';
      shadow.append(line);
      document.documentElement.append(host);
      function place() {
        const rect = video.getBoundingClientRect();
        if (!rect.width || !rect.height) { host.style.display = 'none'; return; }
        host.style.left = `${rect.left}px`;
        host.style.width = `${rect.width}px`;
        host.style.top = `${rect.top + rect.height * 0.78}px`;
      }
      return {
        show(text) { line.textContent = text; place(); host.style.display = text ? 'block' : 'none'; },
        place,
        remove() { host.remove(); }
      };
    }

    function attach(video) {
      if (sessions.has(video)) return;
      const tracks = Array.from(video.textTracks || []).filter((track) => track.kind === 'subtitles' || track.kind === 'captions');
      if (!tracks.length) return;
      const track = tracks.find((item) => item.mode === 'showing') || tracks[0];
      // Cues are only delivered for tracks that are at least "hidden".
      if (track.mode === 'disabled') track.mode = 'hidden';
      const overlay = overlayFor(video);
      const cache = new Map();
      const inflight = new Map();
      let generation = 0;
      const cueText = (cue) => String(cue.text || '').replace(/<[^>]+>/g, '').trim();
      // A cue is on screen for a few seconds and a translation takes about as long, so
      // translating on cuechange always lags a line behind. All cues are known up front:
      // translate the next few ahead of the playhead, a couple at a time.
      function request(text) {
        if (!text || cache.has(text)) return Promise.resolve(cache.get(text) || '');
        if (inflight.has(text)) return inflight.get(text);
        const pending = translate(text).then((result) => {
          const translated = result && result.ok && result.text ? String(result.text).trim() : '';
          if (translated) { cache.set(text, translated); if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value); }
          return translated;
        }).finally(() => inflight.delete(text));
        inflight.set(text, pending);
        return pending;
      }
      function prefetch() {
        const cues = Array.from(track.cues || []);
        const now = video.currentTime;
        const upcoming = cues.filter((cue) => cue.endTime >= now).slice(0, 4);
        upcoming.slice(0, 2).forEach((cue) => { void request(cueText(cue)); });
      }
      const onCueChange = async () => {
        const cues = Array.from(track.activeCues || []);
        const text = cues.map(cueText).filter(Boolean).join('\n');
        const mine = ++generation;
        prefetch();
        if (!text) { overlay.show(''); return; }
        if (cache.has(text)) { overlay.show(cache.get(text)); return; }
        const translated = await request(text);
        if (mine !== generation || !sessions.has(video)) return;
        overlay.show(translated);
      };
      const onSeek = () => prefetch();
      video.addEventListener('seeked', onSeek);
      video.addEventListener('play', onSeek);
      // A <track> element loads its cues asynchronously; when enabled before that, the
      // first prefetch saw zero cues and the first line would always arrive late.
      const trackElement = Array.from(video.querySelectorAll('track')).find((element) => element.track === track);
      if (trackElement) trackElement.addEventListener('load', onSeek);
      const onLayout = () => overlay.place();
      track.addEventListener('cuechange', onCueChange);
      window.addEventListener('scroll', onLayout, true);
      window.addEventListener('resize', onLayout);
      sessions.set(video, {
        detach() {
          track.removeEventListener('cuechange', onCueChange);
          video.removeEventListener('seeked', onSeek);
          video.removeEventListener('play', onSeek);
          if (trackElement) trackElement.removeEventListener('load', onSeek);
          window.removeEventListener('scroll', onLayout, true);
          window.removeEventListener('resize', onLayout);
          overlay.remove();
        }
      });
      prefetch();
      void onCueChange();
    }

    let observer = null;
    function scan() { document.querySelectorAll('video').forEach(attach); }

    return {
      get enabled() { return enabled; },
      count() { return sessions.size; },
      enable() {
        if (enabled) return sessions.size;
        enabled = true;
        scan();
        observer = new MutationObserver(scan);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        return sessions.size;
      },
      disable() {
        enabled = false;
        if (observer) observer.disconnect();
        observer = null;
        sessions.forEach((session) => session.detach());
        sessions.clear();
      }
    };
  }

  global.AIHVideoSubtitles = { create };
})(globalThis);
