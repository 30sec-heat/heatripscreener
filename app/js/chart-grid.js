import { chartTheme } from './chart-theme.js';

export const V_GRID_DIVS = 8;

export function drawVerticalGrid(ctx, pL, xRight, yTop, yBot) {
  for (let g = 1; g < V_GRID_DIVS; g++) {
    const gx = pL + (g / V_GRID_DIVS) * (xRight - pL);
    const strong = g % 2 === 0;
    ctx.strokeStyle = strong ? chartTheme.grid : chartTheme.gridMinor;
    ctx.lineWidth = strong ? 1 : 0.55;
    ctx.beginPath();
    ctx.moveTo(gx, yTop);
    ctx.lineTo(gx, yBot);
    ctx.stroke();
  }
}

export function drawHorizontalGridBands(ctx, pL, xRight, yTop, height, nMajor) {
  if (height <= 0) return;
  const n = Math.max(2, Math.min(4, nMajor | 0));
  for (let i = 0; i <= n; i++) {
    const y = yTop + (i / n) * height;
    ctx.strokeStyle = chartTheme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const y = yTop + ((i + 0.5) / n) * height;
    ctx.strokeStyle = chartTheme.gridMinor;
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
}
