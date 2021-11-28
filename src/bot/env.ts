import { UserType } from "../services/user-service";

export const adminUsername = "not_hello_world";
export const sessions: Record<string, SessionData> = {};

type SessionState = "change-type" | "change-group" | "normal" | "feedback";
interface SessionData {
  state?: SessionState;
  type?: UserType;
}

export function setUserSessionState(userId: string, newState: SessionState) {
  if (!sessions[userId]) sessions[userId] = { state: newState };
  else sessions[userId].state = newState;
}

export function tryResetUserSessionState(userId: string) {
  if (sessions[userId]) sessions[userId].state = "normal";
}
