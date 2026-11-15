'use strict';

// ssh2 1.17 exposes Client.subsys() before the SFTP VERSION handshake, but
// Client.sftp() exposes a cancellation handle only after readiness. Keep this
// version-sensitive codec bridge in one adapter, never in workspace logic.
const { SFTP } = require('ssh2/lib/protocol/SFTP');
const { version } = require('ssh2/package.json');
const WINDOW_BYTES = 512 * 1024;
const PACKET_BYTES = 32 * 1024;

function openSftpChannel(raw, options, callback) {
  if (version !== '1.17.0') throw new Error('ssh2_sftp_adapter_version_unsupported');
  let cancelled = false;
  let channel;
  let codec;
  let finished = false;
  const finish = (error, value) => {
    if (finished) return;
    finished = true;
    callback(error, value);
  };
  const cancel = () => {
    cancelled = true;
    if (channel) channel.close();
    if (codec) codec.destroy();
  };
  raw.subsys('sftp', (error, stream) => {
    if (error) { finish(error); return; }
    channel = stream;
    options.onChannelSettled();
    if (cancelled) { channel.close(); finish(new Error('sftp_open_cancelled')); return; }
    const outgoing = { id: 0, state: 'open', window: WINDOW_BYTES, packetSize: PACKET_BYTES };
    let ended = false;
    const eof = () => {
      if (ended) return;
      ended = true;
      outgoing.state = 'closed';
      codec.push(null);
    };
    const failed = (err) => {
      finish(err);
      codec.emit('error', err);
      codec.destroy();
    };
    const protocol = {
      // SFTP VERSION extensions, not this vendor label, control capability use.
      _remoteIdentRaw: '',
      channelData(_id, bytes) {
        if (ended) return;
        channel.write(bytes, (err) => {
          if (err) { if (!ended) failed(err); return; }
          // The codec queues a remaining frame only after channelData returns.
          // Wake it after that boundary, following real SSH stream backpressure.
          queueMicrotask(() => {
            if (ended) return;
            outgoing.window += bytes.length;
            if (codec._chunkcb) codec._chunkcb();
          });
        });
      },
      channelClose() {
        channel.close();
        eof();
        codec.emit('close');
      }
    };
    codec = new SFTP({ _protocol: protocol }, {
      type: 'session', outgoing,
      incoming: { id: 0, state: 'open', window: WINDOW_BYTES, packetSize: PACKET_BYTES }
    }, {});
    // This listener owns protocol errors even before the caller gets a handle.
    codec.on('error', (err) => finish(err));
    codec.once('ready', () => finish(null, codec));
    channel.on('data', (bytes) => { if (!ended) codec.push(bytes); });
    channel.on('error', failed);
    channel.on('end', () => { finish(new Error('sftp_open_eof')); eof(); });
    channel.on('close', () => { finish(new Error('sftp_channel_closed')); eof(); codec.emit('close'); });
    channel.stderr?.resume();
    options.onChannel(codec);
    if (cancelled) { codec.destroy(); finish(new Error('sftp_open_cancelled')); return; }
    codec._init();
  });
  return cancel;
}

module.exports = { openSftpChannel };
