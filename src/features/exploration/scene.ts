import { Application, Graphics } from 'pixi.js';

/** 描画は確定した探索状態だけを受け取り、ゲーム時間を進めない。 */
export function createExplorationScene(
  host: HTMLElement,
  onFailure: () => void,
) {
  const app = new Application();
  let disposed = false;
  let initialized = false;
  let failed = false;
  let observer: ResizeObserver | null = null;
  let paused = true;
  let motion = false;
  let speed = 1;
  let elapsed = 1;
  let enemy = false;
  let paths = 1;
  const graphics = new Graphics();
  const draw = () => {
    const w = app.screen.width;
    const h = app.screen.height;
    const pulse = motion ? Math.sin(Math.min(elapsed, 1) * Math.PI) * 0.035 : 0;
    const left = w * (0.32 - pulse);
    const right = w - left;
    const top = h * (0.28 - pulse);
    const bottom = h - top;
    graphics.clear().rect(0, 0, w, h).fill(0x101923);
    graphics.poly([0, 0, w, 0, right, top, left, top]).fill(0x26333b);
    graphics.poly([0, h, w, h, right, bottom, left, bottom]).fill(0x30363a);
    graphics.poly([0, 0, left, top, left, bottom, 0, h]).fill(0x42454a);
    graphics.poly([w, 0, right, top, right, bottom, w, h]).fill(0x363e45);
    graphics.rect(left, top, right - left, bottom - top).fill(0x19242c);
    for (let i = 1; i <= 4; i++) {
      const x = (left * i) / 5;
      const y = (top * i) / 5;
      graphics
        .poly([x, y, w - x, y, w - x, h - y, x, h - y, x, y])
        .stroke({ color: 0xa7a294, width: 1, alpha: 0.28 });
    }
    for (let i = 0; i < Math.min(paths, 3); i++) {
      const x = left + ((right - left) * (i + 1)) / (Math.min(paths, 3) + 1);
      graphics.rect(x - w * 0.025, h * 0.4, w * 0.05, h * 0.22).fill(0x080f17);
    }
    if (enemy) {
      graphics.circle(w / 2, h * 0.43, h * 0.055).fill(0xbb9152);
      graphics
        .poly([
          w / 2,
          h * 0.46,
          w / 2 - h * 0.09,
          h * 0.67,
          w / 2 + h * 0.09,
          h * 0.67,
        ])
        .fill(0x785637);
    }
  };
  const lost = (event: Event) => {
    event.preventDefault();
    failed = true;
    app.stop();
    onFailure();
  };
  const ready = app
    .init({
      width: 800,
      height: 400,
      resizeTo: host,
      preference: 'webgl',
      autoStart: false,
      background: 0x101923,
    })
    .then(() => {
      initialized = true;
      if (disposed) {
        graphics.destroy();
        app.destroy(true, { children: true });
        return;
      }
      host.appendChild(app.canvas);
      app.canvas.setAttribute('aria-hidden', 'true');
      app.canvas.addEventListener('webglcontextlost', lost);
      app.stage.addChild(graphics);
      observer = new ResizeObserver(() => {
        if (disposed || failed) return;
        app.resize();
        draw();
        app.render();
      });
      observer.observe(host);
      app.ticker.add((ticker) => {
        elapsed = Math.min(1, elapsed + (ticker.deltaMS / 500) * speed);
        draw();
        if (elapsed === 1) app.stop();
      });
      draw();
      app.render();
      if (!paused && motion && elapsed < 1) app.start();
    })
    .catch(() => {
      failed = true;
      initialized = false;
      observer?.disconnect();
      if (app.renderer) app.destroy(true, { children: true });
      graphics.destroy();
      if (!disposed) onFailure();
    });
  return {
    ready,
    update(next: {
      paused: boolean;
      reducedMotion: boolean;
      speed: number;
      enemy: boolean;
      paths: number;
      moved: boolean;
    }) {
      paused = next.paused;
      motion = !next.reducedMotion;
      speed = next.speed;
      enemy = next.enemy;
      paths = next.paths;
      if (next.moved) elapsed = 0;
      if (!initialized || disposed || failed) return;
      draw();
      app.render();
      if (paused || !motion || elapsed === 1) app.stop();
      else app.start();
    },
    destroy() {
      disposed = true;
      observer?.disconnect();
      if (initialized) {
        app.canvas.removeEventListener('webglcontextlost', lost);
        app.destroy(true, { children: true });
      }
    },
  };
}
