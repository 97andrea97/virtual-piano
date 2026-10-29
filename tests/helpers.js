// Builds a synthetic 21-point hand: palm facing the camera, fingers pointing
// up, wrist at (x, y + 120). `bend` (0..1 per finger) moves a fingertip down
// towards its knuckle, like pressing a key. `tipY` overrides tip positions.
export function makeHand({ x, y, size = 100, bend = [0, 0, 0, 0, 0], tipY = [] }) {
  const pts = new Array(21);
  const wrist = { x, y: y + size * 1.2 };
  pts[0] = wrist;
  const fingerX = [-0.55, -0.3, 0, 0.25, 0.48].map((f) => x + f * size);
  const knuckleY = y + size * 0.2; // MCP joints; wrist→middle MCP = size
  for (let f = 0; f < 5; f++) {
    const base = f === 0 ? 1 : f * 4 + 1; // thumb: 1..4, others: 5..8, 9..12, ...
    const mcpY = f === 0 ? y + size * 0.6 : knuckleY;
    const len = f === 0 ? size * 0.6 : size * 0.8;
    const extended = mcpY - len;
    const tip = tipY[f] ?? extended + (bend[f] ?? 0) * len;
    for (let j = 0; j < 4; j++) {
      const k = j / 3;
      pts[base + j] = { x: fingerX[f], y: mcpY + (tip - mcpY) * k };
    }
  }
  // Move the thumb CMC (1) towards the wrist so the thumb MCP is index 2.
  pts[1] = { x: fingerX[0], y: y + size * 0.9 };
  pts[2] = { x: fingerX[0], y: y + size * 0.6 };
  pts[9] = { x: x, y: knuckleY };
  return pts;
}
