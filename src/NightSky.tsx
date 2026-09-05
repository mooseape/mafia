import { useEffect, useRef } from "react";

type Dot = {
  x: number;
  y: number;
  r: number;
  base: number;
  speed: number;
  phase: number;
  color: string;
};

type Flare = {
  index: number;
  start: number;
  duration: number;
};

function makeDots(count: number): Dot[] {
  const tints = [
    "236, 242, 255",
    "220, 232, 255",
    "255, 248, 235",
    "210, 226, 255",
    "255, 244, 220",
  ];
  const dots: Dot[] = [];
  for (let i = 0; i < count; i++) {
    const faint = Math.random();
    dots.push({
      x: Math.random(),
      y: Math.random(),
      r: faint > 0.88 ? 1.05 + Math.random() * 0.35 : 0.35 + Math.random() * 0.55,
      base: faint > 0.88 ? 0.55 + Math.random() * 0.3 : 0.1 + Math.random() * 0.32,
      speed: 0.4 + Math.random() * 1.4,
      phase: Math.random() * Math.PI * 2,
      color: tints[Math.floor(Math.random() * tints.length)],
    });
  }
  return dots;
}

function nextFlare(now: number, taken: Set<number>, count: number): Flare {
  let index = Math.floor(Math.random() * count);
  let guard = 0;
  while (taken.has(index) && guard < 12) {
    index = Math.floor(Math.random() * count);
    guard += 1;
  }
  return {
    index,
    start: now + 10000 + Math.random() * 14000,
    duration: 1200 + Math.random() * 900,
  };
}

function flareAmount(now: number, flare: Flare) {
  const p = (now - flare.start) / flare.duration;
  if (p <= 0 || p >= 1) return 0;
  return Math.sin(p * Math.PI) ** 1.25;
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  alpha: number,
  glow: number,
) {
  const spike = r * 2.2 + glow * 7;
  if (r > 0.7 || glow > 0.08) {
    ctx.strokeStyle = `rgba(${color}, ${Math.min(0.55, alpha * 0.55 + glow * 0.35)})`;
    ctx.lineWidth = 0.6 + glow * 0.5;
    ctx.beginPath();
    ctx.moveTo(x - spike, y);
    ctx.lineTo(x + spike, y);
    ctx.moveTo(x, y - spike);
    ctx.lineTo(x, y + spike);
    ctx.stroke();
  }

  if (glow > 0.04) {
    const haloR = 4 + glow * 10;
    const halo = ctx.createRadialGradient(x, y, 0, x, y, haloR);
    halo.addColorStop(0, `rgba(${color}, ${0.18 + glow * 0.28})`);
    halo.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, haloR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(x, y, r + glow * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${color}, ${alpha})`;
  ctx.fill();
}

export default function NightSky() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let dots: Dot[] = [];
    let raf = 0;
    let running = true;
    const flares: Flare[] = [];

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(190, Math.max(110, Math.floor((w * h) / 8000)));
      dots = makeDots(count);
      const now = performance.now();
      flares.length = 0;
      flares.push(nextFlare(now, new Set(), dots.length));
    }

    function draw(now: number) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      const taken = new Set<number>();
      for (const flare of flares) {
        if (now < flare.start + flare.duration) taken.add(flare.index);
      }

      for (let i = flares.length - 1; i >= 0; i--) {
        if (now > flares[i].start + flares[i].duration + 80) {
          flares.splice(i, 1);
        }
      }
      while (!reduceMotion && flares.length < 1) {
        flares.push(nextFlare(now, taken, dots.length));
        taken.add(flares[flares.length - 1].index);
      }

      for (let i = 0; i < dots.length; i++) {
        const dot = dots[i];
        const twinkle = reduceMotion
          ? 1
          : 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(now * 0.001 * dot.speed + dot.phase));
        let glow = 0;
        for (const flare of flares) {
          if (flare.index === i) glow = Math.max(glow, flareAmount(now, flare));
        }

        const alpha = Math.min(1, dot.base * twinkle + glow * 0.7);
        drawStar(ctx, dot.x * w, dot.y * h, dot.r, dot.color, alpha, glow);
      }
    }

    resize();
    window.addEventListener("resize", resize);

    if (reduceMotion) {
      draw(0);
      return () => window.removeEventListener("resize", resize);
    }

    const tick = (now: number) => {
      if (!running) return;
      draw(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="night-sky" aria-hidden="true" />;
}
