# Terraform（AWS / 東京 / 独自ドメインなし）

当面は身内運用・コスト優先の最小構成で、以下をTerraformで管理する想定。

- S3 + CloudFront（フロント配信用、デフォルトドメイン）
- ALB + ECS(Fargate)（API + WebSocket）
- RDS Postgres（Single-AZ、小さめから）

## まず決めている前提
- Region: `ap-northeast-1`
- 独自ドメイン: なし（後でRoute53/ACMを追加）

