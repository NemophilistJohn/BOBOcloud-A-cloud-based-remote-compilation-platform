import type { Disposable } from './lifecycle';

export interface OutputPanelState {
  activePanel?: string | null;
  runLogInitialized?: boolean;
}

export interface OutputPanelWorkbenchPort {
  ensureBottomPanelSize?(size: number): void;
  revealPanel?(): void;
  init?(): void;
}

export interface OutputPanelRunOutputPort {
  setPanelActive?(active: boolean): void;
  clearTranscript?(): void;
  clear?(): void;
}

export interface OutputPanelTerminalPort {
  activate?(): void;
  clear?(): void;
}

export interface OutputPanelDapPort {
  clearConsole?(): void;
}

export interface OutputPanelProblemMatcherPort {
  clear?(): void;
}

export interface OutputPanelDependencies {
  readonly document: Document;
  readonly state: OutputPanelState;
  readonly getWorkbench: () => OutputPanelWorkbenchPort | null | undefined;
  readonly getRunOutput: () => OutputPanelRunOutputPort | null | undefined;
  readonly getTerminal: () => OutputPanelTerminalPort | null | undefined;
  readonly getDap: () => OutputPanelDapPort | null | undefined;
  readonly getTaskProblemMatcher: () => OutputPanelProblemMatcherPort | null | undefined;
  readonly getClearRunOutput: () => (() => void) | undefined;
}

export interface OutputPanelFacade {
  init(): void;
  setupOutputResizer(): void;
}

export interface OutputPanelService extends OutputPanelFacade, Disposable {
  readonly disposed: boolean;
  switchToPanel(panelName: string): void;
}
