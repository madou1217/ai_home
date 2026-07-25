export function beginDictationSession(options) {
  let recognition;
  try {
    recognition = new options.Recognition();
  } catch {
    return null;
  }

  const prefix = String(options.baseText || '').trim()
    ? `${String(options.baseText).trim()} `
    : '';
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    options.onFinish(recognition);
  };

  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    if (!finished) options.onStart(recognition);
  };
  recognition.onresult = (event) => {
    if (finished) return;
    let transcript = '';
    for (let index = 0; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript;
    }
    options.onTranscript(prefix + transcript);
  };
  recognition.onerror = finish;
  recognition.onend = finish;
  options.onReady(recognition);

  try {
    recognition.start();
    return recognition;
  } catch {
    finish();
    return null;
  }
}
