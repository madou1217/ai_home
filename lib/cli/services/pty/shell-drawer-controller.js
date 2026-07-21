'use strict';

// Shell drawer: the bottom real-shell panel toggled by Ctrl+Alt+J inside an
// interactive provider session. Owns the terminal scroll-region (viewport)
// state, frame rendering, the drawer PTY child, and buffering of main-session
// output while the drawer is open. The runtime routes stdin/pty-output/resize/
// cleanup events through the handle*/write*/destroy interface; everything
// escape-sequence-related lives here. Extracted from runCliPty.

function createShellDrawerController(deps = {}) {
  const {
    processObj,
    available,
    getShellDrawerLayout,
    spawnShellDrawerPty,
    isToggleSequence,
    getStatusSummaryFallback,
    republishUsage,
    isCleanedUp
  } = deps;

  let shellDrawerProc = null;
  let shellDrawerVisible = false;
  let shellDrawerBufferedMainOutput = '';
  let shellDrawerDroppedMainOutput = false;
  let shellDrawerStatusSummary = '';
  let lastAppliedViewportSignature = '';
  let lastKnownShellDrawerLayout = null;

  function getPlainTextWidth(text) {
    const normalized = String(text || '');
    let width = 0;
    for (const ch of normalized) {
      const code = ch.codePointAt(0) || 0;
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
      width += code > 0xff ? 2 : 1;
    }
    return width;
  }

  function truncatePlainText(text, maxWidth) {
    const normalized = String(text || '');
    if (maxWidth <= 0) return '';
    let output = '';
    let width = 0;
    for (const ch of normalized) {
      const code = ch.codePointAt(0) || 0;
      const nextWidth = (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) ? 0 : (code > 0xff ? 2 : 1);
      if (width + nextWidth > maxWidth) break;
      output += ch;
      width += nextWidth;
    }
    return output;
  }

  function padPlainText(text, targetWidth) {
    const normalized = truncatePlainText(text, targetWidth);
    const width = getPlainTextWidth(normalized);
    if (width >= targetWidth) return normalized;
    return `${normalized}${' '.repeat(targetWidth - width)}`;
  }

  // The shell drawer is the only feature that sets a scroll region; this resets
  // it to the full screen. The usage surface lives in the title now, so the
  // main output path never reserves rows.
  function applyFullTerminalViewport(options = {}) {
    const force = !!options.force;
    if (!force && lastAppliedViewportSignature === 'full') return;
    processObj.stdout.write('\x1b[r');
    lastAppliedViewportSignature = 'full';
  }

  function writeMainPtyOutput(data) {
    // Returning from the shell drawer leaves a scroll region set; reset to full
    // before forwarding. Otherwise the child's output is pure passthrough.
    if (lastAppliedViewportSignature && lastAppliedViewportSignature !== 'full') {
      applyFullTerminalViewport({ force: true });
    }
    processObj.stdout.write(data);
  }

  function clearTerminalRows(rows) {
    const uniqueRows = [...new Set((rows || [])
      .map((row) => Math.floor(Number(row)))
      .filter((row) => Number.isFinite(row) && row > 0))]
      .sort((a, b) => a - b);
    if (!uniqueRows.length) return;
    // SCO save/restore (\x1b[s/\x1b[u) so we never touch the child CLI's DEC
    // save/restore slot (Ink uses \x1b7/\x1b8); used by the shell drawer only.
    processObj.stdout.write('\x1b[s');
    uniqueRows.forEach((row) => {
      processObj.stdout.write(`\x1b[${row};1H\x1b[2K`);
    });
    processObj.stdout.write('\x1b[u');
  }

  function buildShellDrawerHeaderText() {
    const hiddenSuffix = shellDrawerBufferedMainOutput
      ? ` | 主会话后台输出已缓存${shellDrawerDroppedMainOutput ? '（部分截断）' : ''}`
      : '';
    return `[aih] Shell Drawer · Ctrl+Alt+J 收起 · cwd: ${processObj.cwd()}${hiddenSuffix}`;
  }

  function buildShellDrawerTopBorder(width) {
    const safeWidth = Math.max(8, Number(width) || 80);
    const innerWidth = Math.max(2, safeWidth - 2);
    const label = ' Shell Drawer ';
    const labelWidth = Math.min(getPlainTextWidth(label), innerWidth);
    const text = truncatePlainText(label, innerWidth);
    return `┌${text}${'─'.repeat(Math.max(0, innerWidth - labelWidth))}┐`;
  }

  function buildShellDrawerHeaderLine(width) {
    const safeWidth = Math.max(8, Number(width) || 80);
    const innerWidth = Math.max(2, safeWidth - 4);
    return `│ ${padPlainText(buildShellDrawerHeaderText(), innerWidth)} │`;
  }

  function buildShellDrawerBottomBorder(width) {
    const safeWidth = Math.max(8, Number(width) || 80);
    return `└${'─'.repeat(Math.max(2, safeWidth - 2))}┘`;
  }

  function buildShellDrawerStatusLine(width) {
    const safeWidth = Math.max(8, Number(width) || 80);
    const innerWidth = Math.max(2, safeWidth);
    const summary = shellDrawerStatusSummary || getStatusSummaryFallback();
    return padPlainText(`{ ${summary} }`, innerWidth);
  }

  function getShellDrawerRows(layout) {
    if (!layout) return [];
    const rows = [Math.max(1, layout.topBorderRow - 1)];
    for (let row = layout.topBorderRow; row <= layout.bottomBorderRow; row += 1) {
      rows.push(row);
    }
    return rows;
  }

  function clearShellDrawerRegion(layout = getShellDrawerLayout()) {
    clearTerminalRows(getShellDrawerRows(layout));
  }

  function clearShellDrawerLayouts(layouts) {
    clearTerminalRows((layouts || []).flatMap((layout) => getShellDrawerRows(layout)));
  }

  function writeShellDrawerFrame() {
    if (!shellDrawerVisible) return;
    const layout = getShellDrawerLayout();
    lastKnownShellDrawerLayout = layout;
    const width = processObj.stdout.columns || 80;
    processObj.stdout.write('\x1b7');
    processObj.stdout.write(`\x1b[${Math.max(1, layout.topBorderRow - 1)};1H\x1b[2K${buildShellDrawerStatusLine(width)}`);
    processObj.stdout.write(`\x1b[${layout.topBorderRow};1H\x1b[2K${buildShellDrawerTopBorder(width)}`);
    processObj.stdout.write(`\x1b[${layout.headerRow};1H\x1b[2K${buildShellDrawerHeaderLine(width)}`);
    processObj.stdout.write(`\x1b[${layout.bottomBorderRow};1H\x1b[2K${buildShellDrawerBottomBorder(width)}`);
    processObj.stdout.write('\x1b8');
  }

  function focusShellDrawerCursor() {
    if (!shellDrawerVisible) return;
    const layout = getShellDrawerLayout();
    processObj.stdout.write(`\x1b[${layout.contentTop};1H`);
  }

  function applyShellDrawerViewport(options = {}) {
    if (!shellDrawerVisible) return;
    const layout = getShellDrawerLayout();
    const signature = `drawer:${layout.contentTop}:${layout.contentBottom}`;
    const force = !!options.force;
    if (force || lastAppliedViewportSignature !== signature) {
      processObj.stdout.write(`\x1b[s\x1b[${layout.contentTop};${layout.contentBottom}r\x1b[u`);
      lastAppliedViewportSignature = signature;
    }
    lastKnownShellDrawerLayout = layout;
    if (options.writeFrame !== false) writeShellDrawerFrame();
  }

  function flushShellDrawerBufferedMainOutput() {
    if (!shellDrawerBufferedMainOutput) return;
    const bufferedOutput = shellDrawerBufferedMainOutput;
    const hadDroppedOutput = shellDrawerDroppedMainOutput;
    shellDrawerBufferedMainOutput = '';
    shellDrawerDroppedMainOutput = false;
    applyFullTerminalViewport({ force: true });
    let output = '\r\n';
    if (hadDroppedOutput) {
      output += '\x1b[33m[aih] Shell Drawer 期间主会话输出过多，已截断最早部分内容。\x1b[0m\r\n';
    }
    output += bufferedOutput;
    writeMainPtyOutput(output);
  }

  function ensureShellDrawerProc() {
    if (shellDrawerProc) return shellDrawerProc;
    shellDrawerProc = spawnShellDrawerPty();
    shellDrawerProc.onData((data) => {
      if (!shellDrawerVisible) return;
      applyShellDrawerViewport({ force: true, writeFrame: false });
      processObj.stdout.write(data);
      writeShellDrawerFrame();
    });
    shellDrawerProc.onExit(() => {
      shellDrawerProc = null;
      if (!shellDrawerVisible || isCleanedUp()) return;
      shellDrawerVisible = false;
      applyFullTerminalViewport({ force: true });
      clearShellDrawerRegion(lastKnownShellDrawerLayout || getShellDrawerLayout());
      writeMainPtyOutput('\r\n\x1b[33m[aih] Shell Drawer 已退出，回到主会话。\x1b[0m\r\n');
      flushShellDrawerBufferedMainOutput();
      republishUsage();
    });
    return shellDrawerProc;
  }

  function openShellDrawer() {
    if (!available || shellDrawerVisible) return false;
    applyFullTerminalViewport({ force: true });
    shellDrawerVisible = true;
    shellDrawerStatusSummary = getStatusSummaryFallback();
    clearShellDrawerRegion();
    applyShellDrawerViewport({ force: true });
    ensureShellDrawerProc();
    if (shellDrawerProc) {
      const layout = getShellDrawerLayout();
      try { shellDrawerProc.resize(processObj.stdout.columns || 80, layout.ptyRows); } catch (_error) {}
    }
    focusShellDrawerCursor();
    return true;
  }

  function closeShellDrawer() {
    if (!shellDrawerVisible) return false;
    const previousLayout = lastKnownShellDrawerLayout || getShellDrawerLayout();
    shellDrawerVisible = false;
    applyFullTerminalViewport({ force: true });
    clearShellDrawerRegion(previousLayout);
    processObj.stdout.write(`\x1b[${Math.max(1, Number(processObj.stdout.rows) || 1)};1H`);
    flushShellDrawerBufferedMainOutput();
    republishUsage();
    return true;
  }

  function toggleShellDrawer() {
    if (!available) return false;
    if (shellDrawerVisible) return closeShellDrawer();
    return openShellDrawer();
  }

  // ---- runtime-facing interface (event routing) ----

  function isShellDrawerVisible() {
    return shellDrawerVisible;
  }

  function setShellDrawerStatusSummary(summary) {
    shellDrawerStatusSummary = String(summary || '');
  }

  // Main-session pty output: buffered (and frame refreshed) while the drawer
  // is open, plain passthrough otherwise.
  function writeChildMainOutput(data) {
    if (shellDrawerVisible) {
      shellDrawerBufferedMainOutput += data;
      if (shellDrawerBufferedMainOutput.length > 120000) {
        shellDrawerBufferedMainOutput = shellDrawerBufferedMainOutput.slice(-120000);
        shellDrawerDroppedMainOutput = true;
      }
      writeShellDrawerFrame();
    } else {
      writeMainPtyOutput(data);
    }
  }

  // Returns true when the drawer consumed the stdin chunk (toggle or routed
  // into the drawer PTY).
  function handleDrawerStdin(data) {
    if (typeof isToggleSequence === 'function' && isToggleSequence(data)) {
      toggleShellDrawer();
      return true;
    }
    if (shellDrawerVisible) {
      if (shellDrawerProc) shellDrawerProc.write(data);
      return true;
    }
    return false;
  }

  // Terminal resize: resets the viewport, lets the runtime resize the main pty
  // at the right moment via the callback, then redraws the drawer. Returns
  // true when the drawer is visible (the runtime skips its own re-publish).
  function handleTerminalResize(options = {}) {
    const previousDrawerLayout = lastKnownShellDrawerLayout;
    if (shellDrawerVisible || lastAppliedViewportSignature) {
      applyFullTerminalViewport({ force: true });
    }
    if (typeof options.resizeMainPty === 'function') options.resizeMainPty();
    if (shellDrawerProc) {
      const layout = getShellDrawerLayout();
      try { shellDrawerProc.resize(processObj.stdout.columns || 80, layout.ptyRows); } catch (_error) {}
    }
    if (shellDrawerVisible) {
      const nextLayout = getShellDrawerLayout();
      clearShellDrawerLayouts([previousDrawerLayout, nextLayout]);
      applyShellDrawerViewport({ force: true });
      focusShellDrawerCursor();
      return true;
    }
    return false;
  }

  function destroyShellDrawer() {
    applyFullTerminalViewport({ force: true });
    shellDrawerVisible = false;
    clearShellDrawerLayouts([lastKnownShellDrawerLayout, getShellDrawerLayout()]);
    if (shellDrawerProc) {
      try { shellDrawerProc.kill(); } catch (_error) {}
      shellDrawerProc = null;
    }
  }

  return {
    isShellDrawerVisible,
    setShellDrawerStatusSummary,
    writeChildMainOutput,
    handleDrawerStdin,
    handleTerminalResize,
    toggleShellDrawer,
    destroyShellDrawer
  };
}

module.exports = {
  createShellDrawerController
};
