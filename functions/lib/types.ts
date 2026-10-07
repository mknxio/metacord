export type { DiscordUser, DiscordGuild, DiscordMember } from '../../shared/types';

export interface Env {
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_REDIRECT_URI: string;
  SESSION_SECRET: string;
  DEV_ASSETS_URL?: string;
  SESSIONS: KVNamespace;
}

export interface SessionRecord {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  created_at: number;
}

export interface SessionData {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  createdAt: number;
}

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}
