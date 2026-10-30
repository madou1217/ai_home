'use strict';

// Local benchmark fixture: redraw a full ANSI screen on each PTY resize.
const output = process.stdout;
let revision = 0;
let liveSequence = 0;
const continuous = process.argv.includes('--continuous-output');
function draw() {
  const cols = Math.max(2, output.columns || 80);
  const rows = Math.max(2, output.rows || 24);
  const lines = [`BENCH_TUI ${rows}x${cols} revision=${revision++}`.padEnd(cols - 1)];
  const sample = ' Resize performance - hello world 0123456789 | ';
  for (let row = 1; row < rows; row += 1) {
    const prefix = continuous && row === rows - 1 ? `LIVE #${liveSequence} 汉字 ` : `${String(row).padStart(3, '0')} 汉字 `;
    // The two CJK characters each occupy two terminal cells.
    const remaining = Math.max(0, cols - 1 - (prefix.length + 2));
    const text = prefix + sample.repeat(Math.ceil(cols / sample.length) + 1).slice(0, remaining);
    lines.push(`\x1b[${row % 2 ? 36 : 37}m${text}\x1b[0m`);
  }
  // Each redraw replaces the full visible line, including any cells exposed
  // by shrinking after a wider grid. The final erase clears below the screen.
  output.write(`\x1b[?25l\x1b[2J\x1b[H${lines.join('\x1b[K\r\n')}\x1b[J`);
}
output.write('\x1b[?1049h\x1b[2J');
output.on('resize', draw);
process.stdin.resume();
draw();
if (continuous) {
  setInterval(() => {
    liveSequence += 1;
    const rows = Math.max(2, output.rows || 24);
    const cols = Math.max(2, output.columns || 80);
    const text = `LIVE #${liveSequence} 汉字 `.slice(0, Math.max(0, cols - 3));
    // Preserve the TUI cursor while independently updating the last row.
    output.write(`\x1b7\x1b[${rows};1H${text}\x1b[K\x1b8`);
  }, 50);
}
