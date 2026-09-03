export type {
  DocumentViewDescriptorDto,
  DocumentViewDescriptorRegistrationDto
} from './document-view';
export type {
  SourceControlDescriptorDto,
  SourceControlDescriptorRegistrationDto
} from './source-control';
export type {
  FileDecorationColorDto,
  FileDecorationDto,
  FileDecorationLaneForPoint,
  FileDecorationLaneDto,
  FileDecorationProvider,
  FileDecorationProviderDto,
  FileDecorationProviderResult,
  FileDecorationRegistrationDto
} from './file-decoration';

export type RendererOpaqueContributionDto = object;

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
