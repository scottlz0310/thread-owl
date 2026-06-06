// Actor identity check and bot loop prevention

export interface Actor {
  login: string;
  type: "User" | "Bot" | "App";
}

// GitHub App が投稿するコメントの author login は `<app-slug>[bot]` 形式になる。
function botLogin(appSlug: string): string {
  return `${appSlug.toLowerCase()}[bot]`;
}

export function isBotActor(actor: Actor, appSlug: string): boolean {
  if (actor.type === "User") return false;
  return actor.login.toLowerCase() === botLogin(appSlug);
}

// 自身（GitHub App）が起こしたイベントへの反応を抑止し、bot ループを防ぐ。
export function shouldIgnoreEvent(senderLogin: string, appSlug: string): boolean {
  return senderLogin.toLowerCase() === botLogin(appSlug);
}
