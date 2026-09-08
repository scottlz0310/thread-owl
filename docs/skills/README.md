# レビュー用 skill の所在と配置

`thread-owl-pr-reviewer` の収蔵と各 CLI クライアントへの配置は Mcp-Docker が管理する。このリポジトリには skill の実体を置かない。

- [正本: Mcp-Docker/skills/thread-owl-pr-reviewer/](https://github.com/scottlz0310/Mcp-Docker/tree/main/skills/thread-owl-pr-reviewer)
- [skill 本文](https://github.com/scottlz0310/Mcp-Docker/blob/main/skills/thread-owl-pr-reviewer/SKILL.md)
- [エージェント設定](https://github.com/scottlz0310/Mcp-Docker/blob/main/skills/thread-owl-pr-reviewer/agents/openai.yaml)

Mcp-Docker v2.18.0 以降で、各 CLI への配置・更新と状態確認を行う。

```bash
mcp-docker skill install
mcp-docker skill status
```

skill を変更するときは Mcp-Docker 側の正本を更新する。変更を含む mcp-docker バイナリへ更新してから `mcp-docker skill install` を実行し、`mcp-docker skill status` で配置状態を確認する。

手動配置した既存の skill は初回に「管理外」と判定され、上書き確認が必要になる。詳細は [Mcp-Docker](https://github.com/scottlz0310/Mcp-Docker) を参照。
