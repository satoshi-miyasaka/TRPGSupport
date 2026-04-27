# 設計書（TRPGSupport / MVP）

## 1. 目的とスコープ
- **目的**: スマホ（iPhone/Android）でTRPGセッションを補助するWebアプリを提供する
- **スコープ（MVP）**
  - ルーム作成/参加（アカウントなし）
  - ダイス共有（公開/GMのみの最小）
  - グリッド/マップ/キャラシ/通知は後続（本書に拡張設計は記載）
  - 演出（画面・音・バイブ）: **バイブはベストエフォート**

## 2. 前提（確定事項）
- **クライアント**: Webアプリ（PWA想定）
- **対応端末**: iPhone/Android **両方必須**
- **演出**: 画面演出＋音を主軸、バイブは対応端末のみ
- **認証**: **当面なし**（ルームコード参加 + GMシークレット）
- **AWS**: 外部公開、**東京 `ap-northeast-1`**
- **独自ドメイン**: 当面なし（CloudFrontデフォルトURL）
- **コスト**: 優先（RDSはSingle-AZ最小構成）
- **IaC**: Terraform

## 3. 全体アーキテクチャ

```mermaid
flowchart LR
  client[Client(PWA)] -->|HTTPS(CloudFront)| cdn[CloudFront]
  cdn --> s3web[(S3 static web)]

  client -->|HTTPS/WS(ALB)| alb[ALB]
  alb --> api[ECS(Fargate) API+Realtime]
  api --> db[(RDS Postgres)]
  api --> obj[(S3 assets)]
  api --> cache[(Redis optional)]
```

### 3.1 コンポーネント
- **フロント**: Next.js（後続で追加）
  - S3 + CloudFrontで配信（独自ドメイン無しの間はCloudFrontドメイン）
- **API/Realtime**: Node.js（Fastify）+ Socket.IO
  - ルーム単位のリアルタイム同期（ダイス/トークン移動/通知/演出）
- **DB**: RDS PostgreSQL（Single-AZ）
- **オブジェクトストレージ**: S3（マップ画像・トークン画像）
- **Redis**: optional（水平スケールや厳格なレート制限をしたくなったら）

## 4. ルームと権限モデル（アカウントなし）
### 4.1 参加モデル
- 参加者は **`roomCode` + 表示名**で参加
- GM操作は **`gmSecret`** を持つクライアントのみ可能

### 4.2 セキュリティ上の方針（MVP）
- `gmSecret` は**URLに含めない**（共有は別経路）
- DB保存時は `gmSecret` を **ハッシュ化**して保持（pepper/argon2等は後続で実装）
- ルームコードは推測されにくい長さ（例: 8〜10桁英数字）
- 外部公開のため、最低限の **レート制限**（IP/ルーム単位）を入れる

## 5. API設計（HTTP）
### 5.1 ヘルスチェック（実装済み）
- `GET /healthz`
  - Response: `{ ok: true }`

### 5.2 ルーム系（予定）
- `POST /rooms`
  - ルーム作成、`roomCode` と `gmSecret` を返す
- `GET /rooms/:roomCode`
  - ルーム情報取得（公開情報のみ）

## 6. リアルタイム設計（Socket.IO）
### 6.1 接続・参加（実装済み）
- **Client → Server** `room:join`
  - Payload:
    - `roomCode: string`
    - `displayName: string`
    - `gmSecret?: string`
  - Ack:
    - OK: `{ ok: true, roomCode }`
    - NG: `{ ok: false, error, issues? }`
- **Server → Room** `room:memberJoined`
  - Payload: `{ displayName }`

### 6.2 ダイス（実装済み）
- **Client → Server** `dice:roll`
  - Payload:
    - `sides: number`（2〜1000）
    - `count: number`（1〜100）
    - `visibility: "public" | "gm_only"`
  - Ack: `{ ok: true, total } | { ok: false, error, issues? }`
- **Server → Room / Client** `dice:rolled`
  - Payload:
    - `displayName`
    - `sides`, `count`
    - `results: number[]`, `total`
    - `visibility`
    - `createdAt` (ISO)
  - 仕様:
    - `public` はルーム全員へ配信
    - `gm_only` はMVPでは送信者にのみ返す（後続で「GM端末のみへ」へ拡張）

### 6.3 演出（実装済み）
- **Client(GM) → Server** `effect:trigger`
  - Payload:
    - `kind: "flash" | "sound" | "vibrate"`
    - `target: "all" | "gm_only"`（MVPでは全員配信のみ運用）
    - `payload?: unknown`
    - `gmSecret?: string`
  - Ack: `{ ok: true } | { ok: false, error, issues? }`
- **Server → Room** `effect:triggered`
  - Payload:
    - `kind`
    - `payload`
    - `createdAt`

### 6.4 マップ/グリッド（拡張予定イベント）
- `map:set`（GMがマップ選択、グリッド設定）
- `token:spawn` / `token:move` / `token:remove`
  - `token:move` は**throttle**必須（10〜20Hz上限）

### 6.5 通知（拡張予定イベント）
- `gm:notify`（GM→PL、オンラインはWSで即時）
- オフラインは後続でWeb Push（PWA）を検討

## 7. データモデル（DB / 予定）
最初は「アカウントなし」で成立する最小テーブルから始め、後で `users` を追加可能な形にする。

- `rooms`
  - `id`, `room_code`, `created_at`, `updated_at`
- `room_secrets`
  - `room_id`, `gm_secret_hash`, `created_at`
- `room_members`
  - `room_id`, `member_id(ulid)`, `display_name`, `is_gm`, `joined_at`, `last_seen_at`
- `dice_logs`
  - `room_id`, `display_name`, `sides`, `count`, `results(jsonb)`, `total`, `visibility`, `created_at`
- `maps`（後続）
  - `room_id`, `image_key(s3)`, `grid_setting(jsonb)`
- `tokens`（後続）
  - `room_id`, `map_id`, `token_key(s3)`, `pos_x`, `pos_y`, `visibility`, `updated_at`
- `messages`（後続）
  - `room_id`, `to_member_id?`, `body`, `created_at`

## 8. AWS/Terraform（最小構成の方針）
### 8.1 リソース一覧（最小）
- VPC（public/private×2AZ）
- ALB（HTTPS終端、WebSocket）
- ECS(Fargate) service（`apps/api`）
- RDS Postgres（Single-AZ、暗号化ON、自動バックアップON）
- S3（assets/web）
- CloudFront（web配信、当面はデフォルトドメイン）

### 8.2 コスト優先の注意点
- NAT Gatewayはコスト増になりやすいので、必要性を精査
- 監視は最初はCloudWatch Logs + 最低限アラームでOK

## 9. リポジトリ構成（現状/予定）
- `apps/api/` : Fastify + Socket.IO（実装済みの土台）
- `apps/web/` : Next.js（後続）
- `packages/shared/` : 共有型（イベントpayloadのzod schema等、後続）
- `infra/terraform/` : Terraform（雛形あり）

## 10. 非機能要件（MVP）
- **HTTPS必須**
- **入力検証**: zodでpayload検証（実装済み）
- **ログ**: APIは構造化ログ（fastify logger）
- **レート制限**: 追加予定（外部公開前に必須）
- **脆弱性対策**: CORSのoriginは本番で絞る（`*`は開発向け）

