import type { Disposable } from './lifecycle';

export type {
  SourceControlDescriptorDto,
  SourceControlDescriptorRegistrationDto
} from './source-control';

export type RendererOpaqueContributionDto = object;

export type FileDecorationLaneDto = 'sync' | 'scm' | 'diagnostic';
export type FileDecorationColorDto = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export interface FileDecorationDto {
  readonly status: string;
  readonly badge: string;
  readonly color?: FileDecorationColorDto;
  readonly tooltip?: string;
  readonly ariaLabel?: string;
  readonly transient?: boolean;
}

export interface FileDecorationProviderDto<Lane extends FileDecorationLaneDto> {
  readonly id?: string;
  readonly namespace: string;
  readonly lane: Lane;
  readonly priority?: number;
  readonly getDecoration: (
    resourcePath: string,
    node: unknown
  ) => FileDecorationDto | null | false | undefined;
  readonly onDidChange?: (
    listener: (paths?: readonly string[]) => void
  ) => Disposable | null | void;
}

export interface DocumentViewDescriptorDto {
  readonly id: string;
  readonly title: string;
  readonly extensions: readonly string[];
  readonly entry: string;
  readonly resources: readonly string[];
  readonly priority: number;
}

export interface DocumentViewDescriptorRegistrationDto {
  readonly id: string;
  readonly title: string;
  readonly extensions: readonly string[];
  readonly entry: string;
  readonly resources?: readonly string[];
  readonly priority?: number;
}

export type AgentModeDto = 'chat' | 'goal';
export type AgentReasoningEffortDto = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentAccessModeDto = 'ask' | 'auto' | 'full';

export interface AgentCommandMapDto {
  readonly create: string;
  readonly select: string;
  readonly delete: string;
  readonly send: string;
  readonly cancel: string;
  readonly approve: string;
  readonly reject: string;
  readonly preferences: string;
  readonly configure: string;
}

export interface AgentCapabilitiesDto {
  readonly modes: readonly AgentModeDto[];
  readonly reasoningEfforts: readonly AgentReasoningEffortDto[];
  readonly accessModes: readonly AgentAccessModeDto[];
  readonly skills: boolean;
  readonly localTools: boolean;
}

export interface AgentDescriptorDto {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: 'sparkles';
  readonly order: number;
  readonly commands: AgentCommandMapDto;
  readonly capabilities: AgentCapabilitiesDto;
}
