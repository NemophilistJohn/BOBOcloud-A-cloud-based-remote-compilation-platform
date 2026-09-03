export type ExtensionProtocolVersion = 1;
export type PluginRpcResultMarker = '__bobocloudPluginRpcResult';
export type PluginRpcResultVersion = 1;

export type ExtensionMessageTypeDto =
  | 'bobocloud.extension.connect'
  | 'initialize'
  | 'activated'
  | 'activationFailed'
  | 'request'
  | 'response'
  | 'fatal';

export type ExtensionHostMethodDto =
  | 'commands.register'
  | 'commands.dispose'
  | 'commands.execute'
  | 'contributions.register'
  | 'contributions.dispose'
  | 'sourceControl.register'
  | 'sourceControl.setState'
  | 'sourceControl.clearState'
  | 'sourceControl.dispose'
  | 'scm.git.request'
  | 'fileDecorations.scm.register'
  | 'fileDecorations.scm.set'
  | 'fileDecorations.scm.clear'
  | 'fileDecorations.scm.dispose'
  | 'documentViews.register'
  | 'documentViews.dispose'
  | 'agents.register'
  | 'agents.setState'
  | 'agents.updateState'
  | 'agents.clearState'
  | 'agents.dispose'
  | 'agent.broker.request'
  | 'services.get'
  | 'host.request';

export type ExtensionSandboxMethodDto =
  | 'command.invoke'
  | 'i18n.changed'
  | 'models.event'
  | 'extension.deactivate';

export type ExtensionErrorCodeDto =
  | 'EXTENSION_CANCELLED'
  | 'EXTENSION_PERMISSION_DENIED'
  | 'EXTENSION_INVALID_REQUEST'
  | 'EXTENSION_NOT_FOUND'
  | 'EXTENSION_PROTOCOL_ERROR'
  | 'EXTENSION_TIMEOUT'
  | 'EXTENSION_UNAVAILABLE';

export type ExtensionRequestId = number | string;

export interface ExtensionDataCloneOptions {
  readonly maxDepth?: number;
  readonly maxItems?: number;
  readonly maxStringLength?: number;
  readonly maxBytes?: number;
}

export type ExtensionDataPrimitive = null | undefined | boolean | number | string;
export type ExtensionData =
  | ExtensionDataPrimitive
  | ExtensionData[]
  | { [key: string]: ExtensionData };

export interface ExtensionDataCloner {
  (value: unknown, options?: ExtensionDataCloneOptions): ExtensionData;
}

export interface ExtensionProtocolError extends Error {
  code: string;
}

export interface SerializedExtensionErrorDto {
  readonly code: string;
  readonly message: string;
}

interface ExtensionProtocolMessageBaseDto {
  readonly protocolVersion: ExtensionProtocolVersion;
}

export interface ExtensionIdentityDto {
  readonly id: string;
  readonly version: string;
}

export type ExtensionLocaleDto = 'en' | 'zh-CN' | 'ja';

export interface ExtensionLocalizationDto {
  readonly locale: ExtensionLocaleDto;
  readonly messages: Readonly<Record<string, string>>;
}

export interface ExtensionInitializeMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'initialize';
  readonly extension: ExtensionIdentityDto;
  readonly apiVersion: string;
  readonly source: string;
  readonly localization: ExtensionLocalizationDto;
}

export interface ExtensionSandboxRequestMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'request';
  readonly id: ExtensionRequestId;
  readonly method: ExtensionSandboxMethodDto;
  readonly args: unknown;
}

export interface ExtensionHostSuccessResponseMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'response';
  readonly id: ExtensionRequestId;
  readonly ok: true;
  readonly value: unknown;
  readonly error?: never;
}

export interface ExtensionHostFailureResponseMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'response';
  readonly id: ExtensionRequestId;
  readonly ok: false;
  readonly error: SerializedExtensionErrorDto;
  readonly value?: never;
}

export type ExtensionHostResponseMessageDto =
  | ExtensionHostSuccessResponseMessageDto
  | ExtensionHostFailureResponseMessageDto;

/** Messages sent by the renderer host to the isolated extension sandbox. */
export type ExtensionHostToSandboxMessageDto =
  | ExtensionInitializeMessageDto
  | ExtensionSandboxRequestMessageDto
  | ExtensionHostResponseMessageDto;

type WithoutProtocolVersion<Message> = Message extends ExtensionProtocolMessageBaseDto
  ? Omit<Message, 'protocolVersion'>
  : never;

/** Host payload before the shared protocol version envelope is attached. */
export type ExtensionHostToSandboxPayloadDto =
  WithoutProtocolVersion<ExtensionHostToSandboxMessageDto>;

export interface ExtensionActivatedMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'activated';
}

export interface ExtensionActivationFailedMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'activationFailed';
  readonly error: SerializedExtensionErrorDto;
}

export interface ExtensionFatalMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'fatal';
  readonly error: SerializedExtensionErrorDto;
}

export interface ExtensionRequestMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'request';
  readonly id: ExtensionRequestId;
  // Runtime validation intentionally accepts any bounded method string. The
  // host dispatch layer remains responsible for checking the method table.
  readonly method: string;
  readonly args: unknown;
}

export interface ExtensionSuccessResponseMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'response';
  readonly id: ExtensionRequestId;
  readonly ok: true;
  readonly value: unknown;
  readonly error?: never;
}

export interface ExtensionFailureResponseMessageDto extends ExtensionProtocolMessageBaseDto {
  readonly type: 'response';
  readonly id: ExtensionRequestId;
  readonly ok: false;
  readonly error: SerializedExtensionErrorDto;
  readonly value?: never;
}

export type ExtensionResponseMessageDto =
  | ExtensionSuccessResponseMessageDto
  | ExtensionFailureResponseMessageDto;

/** Messages accepted by isExtensionMessage on the sandbox-to-host channel. */
export type ExtensionInboundMessageDto =
  | ExtensionActivatedMessageDto
  | ExtensionActivationFailedMessageDto
  | ExtensionFatalMessageDto
  | ExtensionRequestMessageDto
  | ExtensionResponseMessageDto;

type PluginRpcResultBaseDto = Readonly<
  Record<PluginRpcResultMarker, PluginRpcResultVersion>
>;

export interface PluginRpcSuccessResultDto extends PluginRpcResultBaseDto {
  readonly ok: true;
  readonly value: unknown;
  readonly error?: never;
}

export interface PluginRpcFailureResultDto extends PluginRpcResultBaseDto {
  readonly ok: false;
  readonly error: SerializedExtensionErrorDto;
  readonly value?: never;
}

export type PluginRpcResultDto = PluginRpcSuccessResultDto | PluginRpcFailureResultDto;
