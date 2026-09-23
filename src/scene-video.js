// Video scene: the classic neurofeedback setup. Any video plays on the stage and
// dims, blurs and quietens when you drift off target, clearing as you hold it.
// Sources are a local file (never uploaded) or a YouTube link.

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTube(input) {
  const text = String(input || '').trim();
  if (YT_ID.test(text)) return text;
  let url;
  try { url = new URL(text.includes('://') ? text : `https://${text}`); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    const m = url.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/);
    if (!id && m) id = m[2];
  }
  return id && YT_ID.test(id) ? id : null;
}

export class VideoScene {
  constructor(root) {
    this.root = root;
    this.empty = root.querySelector('.scene-empty');
    this.video = root.querySelector('video');
    this.frame = null;
    this.kind = null;       // 'file' | 'youtube' | null
    this.objectUrl = null;
    this.floor = 0.25;      // brightness when fully off target
    this.level = -1;
    this.volume = -1;
    this.playing = true;
  }

  get loaded() { return !!this.kind; }

  clear() {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.hidden = true;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.frame?.remove();
    this.frame = null;
    this.kind = null;
    this.empty.hidden = false;
    this.level = this.volume = -1;
    this.playing = true;
  }

  loadFile(file) {
    this.clear();
    this.objectUrl = URL.createObjectURL(file);
    this.video.src = this.objectUrl;
    this.video.hidden = false;
    this.empty.hidden = true;
    this.kind = 'file';
    this.video.play().catch(() => {});
    return file.name;
  }

  loadYouTube(input) {
    const id = parseYouTube(input);
    if (!id) return null;
    this.clear();
    const params = new URLSearchParams({ enablejsapi: '1', autoplay: '1', loop: '1', playlist: id, rel: '0', playsinline: '1', modestbranding: '1' });
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?${params}`;
    frame.title = 'Training video';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    // Commands sent before the player loads are dropped, so resend state once it is up.
    frame.addEventListener('load', () => { this.level = this.volume = -1; });
    this.root.insertBefore(frame, this.empty);
    this.frame = frame;
    this.kind = 'youtube';
    this.empty.hidden = true;
    return id;
  }

  command(func, args = []) {
    this.frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
  }

  setFloor(floor) { this.floor = floor; this.level = -1; }

  // level: 0 fully off target .. 1 rewarded.
  setLevel(level) {
    const l = Math.round(Math.max(0, Math.min(1, level)) * 50) / 50;
    if (l === this.level) return;
    this.level = l;
    const bright = this.floor + (1 - this.floor) * l;
    this.root.style.setProperty('--scene-bright', bright.toFixed(3));
    this.root.style.setProperty('--scene-blur', `${((1 - l) * 7).toFixed(1)}px`);
    this.root.style.setProperty('--scene-sat', (0.35 + 0.65 * l).toFixed(2));
    const volume = Math.round((0.2 + 0.8 * l) * 100);
    if (volume !== this.volume) {
      this.volume = volume;
      if (this.kind === 'file') this.video.volume = volume / 100;
      else if (this.kind === 'youtube') this.command('setVolume', [volume]);
    }
  }

  setPlaying(playing) {
    if (playing === this.playing) return;
    this.playing = playing;
    if (this.kind === 'file') { if (playing) this.video.play().catch(() => {}); else this.video.pause(); }
    else if (this.kind === 'youtube') this.command(playing ? 'playVideo' : 'pauseVideo');
  }
}
