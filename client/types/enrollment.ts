export interface EnrollmentPreview {
  readonly id: string;
  readonly kind: string;
  readonly host: string;
  readonly httpPort: number;
  readonly certificateFingerprint: string;
  readonly version: string;
  readonly expiresAt: string;
  readonly syncMode: string;
  readonly requiresPasswordSetup?: boolean;
}

export interface EnrollmentAuthentication {
  readonly id?: string;
  readonly identity?: string;
  readonly username?: string;
  readonly email?: string;
  readonly password: string;
}

export interface EnrollmentAuthResult {
  readonly success: boolean;
  readonly token: string;
  readonly expiresAt: string;
  readonly user: Record<string, unknown>;
  readonly syncReady: boolean;
}

/** Main-owned enrollment APIs exposed only to the host workbench. */
export interface EnrollmentHostPort {
  accountsList(): Promise<SavedAccount[]>;
  accountsSwitch(id: string): Promise<EnrollmentAuthResult | { unchanged: true }>;
  accountsLogout(): Promise<void>;
  accountsRemove(id: string): Promise<boolean>;
  enrollmentPreview(link: string): Promise<EnrollmentPreview>;
  enrollmentActivate(id: string): Promise<Record<string, unknown>>;
  enrollmentAuthenticate(payload: EnrollmentAuthentication): Promise<EnrollmentAuthResult>;
  enrollmentLogin(payload: EnrollmentAuthentication): Promise<EnrollmentAuthResult>;
  enrollmentRefreshSync(): Promise<boolean>;
  enrollmentIncoming(): Promise<string>;
  onEnrollmentOpen(listener: () => void): () => void;
  readServerSettings(): Promise<Record<string, unknown>>;
  writeServerSettings(settings: unknown): Promise<unknown>;
  commitServerSettings(): Promise<unknown>;
}

export interface SavedAccount {
  readonly id: string;
  readonly username: string;
  readonly userId: string;
  readonly uid: string;
  readonly name: string;
  readonly avatar: string;
  readonly role: string;
  readonly server: string;
  readonly online: boolean;
  readonly authorized: boolean;
  readonly savedAt: number;
}
