// Android screens through scrcpy's server: the app runs the server that the installed
// scrcpy ships (its version must match exactly), reads the H.264 stream itself and
// hands it to the window, which decodes and draws it inside the pane. No scrcpy
// window opens, so the phone shows up in a window capture like any other pane.
//
// A mirror lasts as long as its pane: closing the pane ends the server on the device.

const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const mux = require('./mux');

const REMOTE_PATH = '/data/local/tmp/scrcpy-server.jar'; // where scrcpy itself puts it
const DEVICE_NAME_LENGTH = 64;
const HEADER = 12; // session packet, or a media packet's flags, PTS and size

// adb serials: USB serials, "host:port" and mDNS names like
// "adb-0921...-wXz3Kg._adb-tls-connect._tcp". Never a leading '-' (an option).
const validSerial = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:\[\]@%+-]+$/.test(s) && !s.startsWith('-');

function run(bin, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// adb from config, $PATH or the Android SDK, which the systemd user service has no
// $PATH entry for.
function findAdb(configured) {
  const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Android', 'Sdk')];
  for (const file of [mux.find('adb', configured), ...sdk.filter(Boolean).map((d) => path.join(d, 'platform-tools', 'adb'))]) {
    try {
      if (file) {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      }
    } catch {
      // not here
    }
  }
  return null;
}

// The installed scrcpy's version and server: { version: '5.0', server: '/usr/share/scrcpy/scrcpy-server' }.
// The server sits in <prefix>/share/scrcpy next to <prefix>/bin/scrcpy, or where
// SCRCPY_SERVER_PATH says, as for scrcpy itself.
async function findScrcpy(configured) {
  const bin = mux.find('scrcpy', configured);
  if (!bin) throw new Error('scrcpy is not installed');
  const version = (await run(bin, ['--version'])).match(/^scrcpy (\S+)/m)?.[1];
  if (!version) throw new Error('could not read the scrcpy version');
  const server = process.env.SCRCPY_SERVER_PATH || path.join(path.dirname(path.dirname(fs.realpathSync(bin))), 'share', 'scrcpy', 'scrcpy-server');
  if (!fs.existsSync(server)) throw new Error(`no scrcpy server at ${server}`);
  return { version, server };
}

// Connected devices as [{ serial, model }], from `adb devices -l`. Unauthorized and
// offline devices are left out.
async function devices(adb) {
  const out = await run(adb, ['devices', '-l'], 5000).catch(() => '');
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => state === 'device' && validSerial(serial))
    .map(([serial, , ...props]) => {
      const model = props.find((p) => p.startsWith('model:'))?.slice(6).replace(/_/g, ' ');
      return { serial, model: model || serial };
    })
    .sort((a, b) => a.model.localeCompare(b.model) || a.serial.localeCompare(b.serial));
}

// Control messages (client -> device), as scrcpy's app/src/control_msg.c writes them.
const TYPE = { keycode: 0, text: 1, touch: 2, scroll: 3, backOrScreenOn: 4, resetVideo: 17 };
const POINTER_FINGER = 0xfffffffffffffffen; // SC_POINTER_ID_GENERIC_FINGER
const u16fp = (f) => (f >= 1 ? 0xffff : Math.round(Math.max(0, f) * 0x10000));
const i16fp = (f) => (f >= 1 ? 0x7fff : Math.round(Math.max(-1, f) * 0x8000));

// msg: { type: 'touch', action, x, y, width, height, pressure }
//    | { type: 'scroll', x, y, width, height, h, v }   (h and v in [-16, 16])
//    | { type: 'keycode', action, keycode, metastate }
//    | { type: 'text', text } | { type: 'backOrScreenOn', action } | { type: 'resetVideo' }
// x, y are in video pixels; width, height the video size they refer to.
function encode(msg) {
  const position = (buf, at) => {
    buf.writeInt32BE(Math.round(msg.x), at);
    buf.writeInt32BE(Math.round(msg.y), at + 4);
    buf.writeUInt16BE(msg.width, at + 8);
    buf.writeUInt16BE(msg.height, at + 10);
  };
  switch (msg?.type) {
    case 'touch': {
      const buf = Buffer.alloc(32);
      buf[0] = TYPE.touch;
      buf[1] = msg.action; // AMOTION_EVENT_ACTION_DOWN 0, UP 1, MOVE 2
      buf.writeBigUInt64BE(POINTER_FINGER, 2);
      position(buf, 10);
      buf.writeUInt16BE(u16fp(msg.pressure), 22);
      return buf; // action button and buttons stay 0: a finger, not a mouse
    }
    case 'scroll': {
      const buf = Buffer.alloc(21);
      buf[0] = TYPE.scroll;
      position(buf, 1);
      buf.writeInt16BE(i16fp(msg.h / 16), 13);
      buf.writeInt16BE(i16fp(msg.v / 16), 15);
      return buf;
    }
    case 'keycode': {
      const buf = Buffer.alloc(14);
      buf[0] = TYPE.keycode;
      buf[1] = msg.action; // AKEY_EVENT_ACTION_DOWN 0, UP 1
      buf.writeUInt32BE(msg.keycode, 2);
      buf.writeUInt32BE(msg.metastate >>> 0, 10);
      return buf;
    }
    case 'text': {
      const text = Buffer.from(String(msg.text)).subarray(0, 300);
      const buf = Buffer.alloc(5 + text.length);
      buf[0] = TYPE.text;
      buf.writeUInt32BE(text.length, 1);
      text.copy(buf, 5);
      return buf;
    }
    case 'backOrScreenOn':
      return Buffer.from([TYPE.backOrScreenOn, msg.action]);
    case 'resetVideo':
      return Buffer.from([TYPE.resetVideo]);
    default:
      throw new Error('unknown control message');
  }
}

// Resolves with the socket once the server answers on it. On a forward tunnel adb
// accepts the connection even before the server listens, then drops it; the server
// sends a dummy byte on the first socket so a real connection can be told apart.
function connect(port, deadline, cancelled) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      const retry = () => {
        socket.destroy();
        if (cancelled()) reject(new Error('stopped'));
        else if (Date.now() > deadline) reject(new Error('the scrcpy server did not answer'));
        else setTimeout(attempt, 100);
      };
      socket.once('error', retry);
      socket.once('close', retry);
      socket.once('data', (chunk) => {
        socket.removeListener('error', retry);
        socket.removeListener('close', retry);
        socket.pause();
        socket.unshift(chunk.subarray(1)); // past the dummy byte
        resolve(socket);
      });
    };
    attempt();
  });
}

// One device's screen. Emits 'name' (device name), 'session' ({ width, height },
// again on every rotation), 'packet' ({ config, key, data }) and once 'end' (an
// Error, or null after stop()). A failed start() ends it too, so 'end' is the one
// place to learn that it stopped.
class Mirror extends EventEmitter {
  constructor({ adb, version, server }, serial) {
    super();
    this.adb = adb;
    this.version = version;
    this.server = server;
    this.serial = serial;
    this.proc = null;
    this.video = null;
    this.control = null;
    this.port = null;
    this.ended = false;
  }

  start() {
    this.#start().catch((err) => this.#end(err));
  }

  async #start() {
    const adb = (...args) => run(this.adb, ['-s', this.serial, ...args], 30000);
    await adb('push', this.server, REMOTE_PATH);
    const scid = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
    this.port = Number((await adb('forward', 'tcp:0', `localabstract:scrcpy_${scid}`)).trim());
    if (this.ended) return this.#cleanup();

    this.proc = spawn(this.adb, [
      '-s', this.serial, 'shell', `CLASSPATH=${REMOTE_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', this.version,
      `scid=${scid}`, 'log_level=info', 'tunnel_forward=true', 'audio=false', 'video_codec=h264',
    ]);
    // The last line the server printed explains why it stopped.
    let last = '';
    const log = (data) => {
      const lines = String(data).split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length) last = lines[lines.length - 1].replace(/^\[server\] /, '');
    };
    this.proc.stdout.on('data', log);
    this.proc.stderr.on('data', log);
    this.proc.on('exit', () => this.#end(new Error(last || 'the scrcpy server stopped')));

    // The video socket first, then the control socket.
    this.video = await connect(this.port, Date.now() + 10000, () => this.ended);
    this.control = net.connect(this.port, '127.0.0.1');
    this.control.on('error', () => {});
    this.control.on('data', () => {}); // device messages (clipboard, ...) are not used
    this.video.on('error', () => {});
    this.video.on('close', () => this.#end(new Error('the video stream ended')));
    if (this.ended) return this.#cleanup();
    this.#read();
    this.video.resume();
  }

  // Device name, codec id, then session and media packets (scrcpy's doc/develop.md).
  #read() {
    let buf = Buffer.alloc(0);
    let stage = 'name';
    this.video.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (stage === 'name') {
          if (buf.length < DEVICE_NAME_LENGTH) return;
          this.emit('name', buf.subarray(0, DEVICE_NAME_LENGTH).toString('utf8').replace(/\0[\s\S]*$/, ''));
          buf = buf.subarray(DEVICE_NAME_LENGTH);
          stage = 'codec';
        } else if (stage === 'codec') {
          if (buf.length < 4) return;
          const codec = buf.subarray(0, 4).toString('latin1');
          if (codec !== 'h264') return this.#end(new Error(`unexpected video codec ${codec}`));
          buf = buf.subarray(4);
          stage = 'packets';
        } else {
          if (buf.length < HEADER) return;
          if (buf[0] & 0x80) {
            this.emit('session', { width: buf.readUInt32BE(4), height: buf.readUInt32BE(8) });
            buf = buf.subarray(HEADER);
            continue;
          }
          const size = buf.readUInt32BE(8);
          if (buf.length < HEADER + size) return;
          const flags = buf[0];
          // A copy, so the packet does not keep the whole read buffer alive.
          const data = Buffer.from(buf.subarray(HEADER, HEADER + size));
          this.emit('packet', { config: Boolean(flags & 0x40), key: Boolean(flags & 0x20), data });
          buf = buf.subarray(HEADER + size);
        }
      }
    });
  }

  send(msg) {
    if (this.control && !this.control.destroyed) this.control.write(encode(msg));
  }

  stop() {
    this.#end(null);
  }

  #end(err) {
    if (this.ended) return;
    this.ended = true;
    this.#cleanup();
    this.emit('end', err);
  }

  // Closing the sockets stops the server on the device.
  #cleanup() {
    this.video?.destroy();
    this.control?.destroy();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    if (this.port) run(this.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => {});
    this.port = null;
  }
}

module.exports = { validSerial, findAdb, findScrcpy, devices, encode, Mirror };
