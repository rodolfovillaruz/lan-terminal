// Terminal multiplexers a pane can attach to: ptmux (the pseudo-terminal project), tmux
// and GNU screen. A pane runs the multiplexer's client in its pty, so closing the pane
// (SIGHUP to the client) only detaches and the session keeps running.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Per multiplexer:
//   env    the variable its sessions set; a client started with it set would nest
//          (ptmux refuses, screen opens a window in the outer session instead)
//   ls     arguments that list sessions; parse turns the output into Map name -> target
//   spawn  client arguments that show session name, starting it if it is not running
const MUXES = {
  ptmux: {
    env: 'PTMUX',
    ls: ['ls'],
    parse: (out) => new Map(out.split('\n').filter(Boolean).map((n) => [n, n])),
    spawn: (name, target) => (target ? ['attach', '-t', target] : ['new', '-s', name]),
  },
  tmux: {
    env: 'TMUX',
    ls: ['list-sessions', '-F', '#{session_name}'],
    parse: (out) => new Map(out.split('\n').filter(Boolean).map((n) => [n, n])),
    // -A attaches when the session exists, so tmux needs no target.
    spawn: (name) => ['new-session', '-A', '-s', name],
  },
  screen: {
    env: 'STY',
    ls: ['-ls'],
    // "\t94839.work\t(Detached)". The target is "pid.name": a bare name matches as a
    // prefix, so "1" would also pick "10".
    parse: (out) => new Map([...out.matchAll(/^\t(\d+)\.([^\t]+)\t/gm)].map((m) => [m[2], `${m[1]}.${m[2]}`])),
    spawn: (name, target) => (target ? ['-x', target] : ['-S', name]),
  },
};

const NAMES = Object.keys(MUXES);

// Session names end up as socket file names and tmux targets, so no '/', '.' or ':',
// and no leading '-' that a client would read as an option.
const validSession = (name) => typeof name === 'string' && name !== '' && !/[/.:]/.test(name) && !name.startsWith('-');

// The binary from config, $PATH or cargo's install dir. The systemd user service runs
// without ~/.cargo/bin on its PATH, where `cargo install` puts ptmux.
function find(mux, configured) {
  if (configured) return configured;
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.cargo', 'bin')];
  for (const dir of dirs.filter(Boolean)) {
    const file = path.join(dir, mux);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return null;
}

// Live sessions as Map name -> target. tmux with no server and screen always exit
// non-zero, so the output counts whatever the exit status.
function list(mux, bin) {
  return new Promise((resolve) => {
    execFile(bin, MUXES[mux].ls, { timeout: 2000 }, (_err, stdout) => resolve(MUXES[mux].parse(stdout || '')));
  });
}

module.exports = { MUXES, NAMES, validSession, find, list };
