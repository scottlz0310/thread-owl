// Actor identity check and bot loop prevention

export interface Actor {
  login: string;
  type: "User" | "Bot" | "App";
}

export function isBotActor(_actor: Actor, _appSlug: string): boolean {
  throw new Error("not implemented");
}

export function shouldIgnoreEvent(_senderLogin: string, _appSlug: string): boolean {
  throw new Error("not implemented");
}
