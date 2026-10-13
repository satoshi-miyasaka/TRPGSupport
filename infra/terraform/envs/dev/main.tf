terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

locals {
  name_prefix = var.name_prefix
  tags = {
    Project = "TRPGSupport"
    Env     = var.env
  }
}

# TODO: 最小のVPC / ECS(Fargate)+ALB / RDS / S3+CloudFront を順に追加

