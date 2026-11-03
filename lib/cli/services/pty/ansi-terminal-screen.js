'use strict';

const MAX_CURSOR_POSITION = 1000;
const WIDE_CHARACTER_CONTINUATION = Symbol('wide-character-continuation');

function clampCursor(value) {
  return Math.max(0, Math.min(MAX_CURSOR_POSITION, Number(value) || 0));
}

function parseCsiParameters(sequence) {
  const body = sequence.slice(0, -1).replace(/^[?>!]+/, '');
  if (!body) return [];
  return body.split(';').map((value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function isWideCharacter(character) {
  const codePoint = character.codePointAt(0);
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function createAnsiTerminalScreen() {
  const lines = new Map();
  let cursorRow = 0;
  let cursorColumn = 0;
  let savedCursor = { row: 0, column: 0 };
  let parserState = 'text';
  let csiSequence = '';

  function getLine(row, create = false) {
    if (!lines.has(row) && create) lines.set(row, []);
    return lines.get(row);
  }

  function writeCharacter(character) {
    const line = getLine(cursorRow, true);
    if (line[cursorColumn] === WIDE_CHARACTER_CONTINUATION && cursorColumn > 0) {
      delete line[cursorColumn - 1];
    }
    if (line[cursorColumn + 1] === WIDE_CHARACTER_CONTINUATION) {
      delete line[cursorColumn + 1];
    }
    line[cursorColumn] = character;
    const width = isWideCharacter(character) ? 2 : 1;
    if (width === 2) line[cursorColumn + 1] = WIDE_CHARACTER_CONTINUATION;
    cursorColumn = clampCursor(cursorColumn + width);
  }

  function eraseLine(mode) {
    const line = getLine(cursorRow);
    if (!line) return;
    if (mode === 2) {
      lines.delete(cursorRow);
      return;
    }
    if (mode === 1) {
      for (let index = 0; index <= cursorColumn; index += 1) delete line[index];
      return;
    }
    line.length = Math.min(line.length, cursorColumn);
  }

  function eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      lines.clear();
      return;
    }
    eraseLine(mode);
    for (const row of Array.from(lines.keys())) {
      if ((mode === 1 && row < cursorRow) || (mode === 0 && row > cursorRow)) {
        lines.delete(row);
      }
    }
  }

  function applyCsi(sequence) {
    const command = sequence.slice(-1);
    const parameters = parseCsiParameters(sequence);
    const count = (index = 0) => Math.max(1, parameters[index] || 1);

    if (command === 'A') cursorRow = clampCursor(cursorRow - count());
    else if (command === 'B') cursorRow = clampCursor(cursorRow + count());
    else if (command === 'C') cursorColumn = clampCursor(cursorColumn + count());
    else if (command === 'D') cursorColumn = clampCursor(cursorColumn - count());
    else if (command === 'E') {
      cursorRow = clampCursor(cursorRow + count());
      cursorColumn = 0;
    } else if (command === 'F') {
      cursorRow = clampCursor(cursorRow - count());
      cursorColumn = 0;
    } else if (command === 'G') cursorColumn = clampCursor(count() - 1);
    else if (command === 'H' || command === 'f') {
      cursorRow = clampCursor(count(0) - 1);
      cursorColumn = clampCursor(count(1) - 1);
    } else if (command === 'd') cursorRow = clampCursor(count() - 1);
    else if (command === 'J') eraseDisplay(parameters[0] || 0);
    else if (command === 'K') eraseLine(parameters[0] || 0);
    else if (command === 'X') {
      const line = getLine(cursorRow);
      if (line) {
        for (let index = 0; index < count(); index += 1) delete line[cursorColumn + index];
      }
    } else if (command === 's') savedCursor = { row: cursorRow, column: cursorColumn };
    else if (command === 'u') {
      cursorRow = savedCursor.row;
      cursorColumn = savedCursor.column;
    }
  }

  function consumeTextCharacter(character) {
    if (character === '\u001b') {
      parserState = 'escape';
      return;
    }
    if (character === '\r') {
      cursorColumn = 0;
      return;
    }
    if (character === '\n') {
      cursorRow = clampCursor(cursorRow + 1);
      return;
    }
    if (character === '\b') {
      cursorColumn = clampCursor(cursorColumn - 1);
      return;
    }
    if (character === '\t') {
      cursorColumn = clampCursor((Math.floor(cursorColumn / 8) + 1) * 8);
      return;
    }
    if (character >= ' ') writeCharacter(character);
  }

  function feed(value) {
    for (const character of String(value || '')) {
      if (parserState === 'text') {
        consumeTextCharacter(character);
        continue;
      }
      if (parserState === 'escape') {
        if (character === '[') {
          csiSequence = '';
          parserState = 'csi';
        } else if (character === ']' || character === 'P' || character === '_' || character === '^') {
          parserState = 'control-string';
        } else if (character === '7') {
          savedCursor = { row: cursorRow, column: cursorColumn };
          parserState = 'text';
        } else if (character === '8') {
          cursorRow = savedCursor.row;
          cursorColumn = savedCursor.column;
          parserState = 'text';
        } else if ('()*+-./'.includes(character)) {
          parserState = 'escape-intermediate';
        } else {
          parserState = 'text';
        }
        continue;
      }
      if (parserState === 'escape-intermediate') {
        parserState = 'text';
        continue;
      }
      if (parserState === 'csi') {
        csiSequence += character;
        if (character >= '@' && character <= '~') {
          applyCsi(csiSequence);
          csiSequence = '';
          parserState = 'text';
        }
        continue;
      }
      if (parserState === 'control-string') {
        if (character === '\u0007') parserState = 'text';
        else if (character === '\u001b') parserState = 'control-string-escape';
        continue;
      }
      if (parserState === 'control-string-escape') {
        parserState = character === '\\' ? 'text' : 'control-string';
      }
    }
  }

  function toText() {
    if (lines.size === 0) return '';
    const lastRow = Math.max(...lines.keys());
    const output = [];
    for (let row = 0; row <= lastRow; row += 1) {
      const line = getLine(row) || [];
      output.push(Array.from({ length: line.length }, (_, index) => {
        const cell = line[index];
        if (cell === WIDE_CHARACTER_CONTINUATION) return '';
        return cell || ' ';
      })
        .join('')
        .trimEnd());
    }
    return output.join('\n');
  }

  return { feed, toText };
}

module.exports = {
  createAnsiTerminalScreen
};
