// Lazy terminal presentation bundle. Networking and session state remain in
// src/terminal.js; this file contains only the xterm rendering dependency.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

window.BOBO = window.BOBO || {};
window.BOBO.terminalUi = Object.freeze({ Terminal, FitAddon });
