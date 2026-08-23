resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db-private-subnet-group"
  subnet_ids = var.subnet_ids

  tags = {
    Name    = "${var.project_name}-db-subnet-group"
    Project = "HelpMe"
  }
}

# Luật của nhóm này nằm ở các resource `aws_security_group_rule` riêng bên dưới, KHÔNG phải block
# `ingress`/`egress` inline. Không được trộn hai kiểu: block inline được coi là TOÀN BỘ tập luật, nên
# mỗi lần apply Terraform sẽ xoá bất kỳ luật nào không khai trong đó - kể cả
# `aws_security_group_rule.ai_tasks_to_rds` ở infra/main.tf, tức là chặn đứng đường vào CSDL của AI
# worker. Luật đó buộc phải đứng riêng vì `modules/rds` không thể phụ thuộc ngược vào `modules/ai_service`
# (ai_service đã phụ thuộc rds để lấy endpoint - trộn vào sẽ thành vòng lặp module).
resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds-sg"
  description = "Security group for PostgreSQL RDS"
  vpc_id      = var.vpc_id

  tags = {
    Name    = "${var.project_name}-rds-sg"
    Project = "HelpMe"
  }
}

resource "aws_security_group_rule" "app_tasks_to_rds" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.rds.id
  source_security_group_id = var.app_tasks_sg_id
  description              = "helpme ECS app tasks to RDS 5432"
}

resource "aws_security_group_rule" "bastion_to_rds" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.rds.id
  source_security_group_id = var.bastion_sg_id
  description              = "helpme bastion to RDS 5432"
}

resource "aws_security_group_rule" "rds_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.rds.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "outbound"
}

resource "aws_db_instance" "main" {
  identifier            = "${var.project_name}-db"
  engine                = "postgres"
  engine_version        = "16"
  instance_class        = "db.t4g.micro"
  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"

  db_name  = "helpme"
  username = "adminuser"
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  publicly_accessible = false
  apply_immediately   = true

  # Mã hoá at-rest bằng KMS, dùng khoá do AWS quản lý (`aws/rds`) - không khai `kms_key_id` nghĩa là
  # khoá đó. Không mất phí, không thể làm mất, và không đánh đổi gì so với CMK ngoài việc thiếu key
  # policy riêng cùng khả năng thu hồi.
  #
  # ⚠️ KHÔNG BẬT CỜ NÀY BẰNG `terraform apply` TRÊN MỘT INSTANCE ĐANG CHẠY.
  # `storage_encrypted` là thuộc tính ForceNew: Terraform sẽ HUỶ instance và tạo lại một cái RỖNG.
  # AWS không cho bật mã hoá tại chỗ - phải snapshot -> copy kèm mã hoá -> restore -> đổi tên, xem
  # [[Runbooks/Cloud_Deployment]] mục "Encrypting RDS at rest". Làm tay xong thì dòng này chỉ còn là
  # mô tả đúng hiện trạng, và `terraform plan` sạch.
  storage_encrypted = true

  # Chốt chặn cho chính cảnh báo trên: mọi kế hoạch đòi thay thế hoặc huỷ instance này sẽ lỗi thay
  # vì âm thầm chạy. `skip_final_snapshot = true` trước đây nghĩa là một lần huỷ nhầm là mất sạch dữ
  # liệu, không có gì để khôi phục.
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project_name}-db-final"

  lifecycle {
    prevent_destroy = true
  }

  # Multi-AZ with a single standby: RDS keeps a synchronous copy in a second availability zone and
  # fails over to it automatically. The standby is NOT readable - it serves no queries. That is the
  # difference from a read replica, and the reason both servers share one endpoint below.
  multi_az = true

  # Required for Multi-AZ, and the provider default here is 0 (disabled).
  backup_retention_period = 7

  tags = {
    Project = "HelpMe"
  }
}

variable "project_name" {}
variable "vpc_id" {}
variable "subnet_ids" {}
variable "db_password" {}
variable "app_tasks_sg_id" {}
variable "bastion_sg_id" {}

output "cluster_endpoint" {
  value = aws_db_instance.main.address
}

# Exposed so callers can attach further 5432 ingress without editing this module — see the
# ai_tasks_to_rds rule in infra/main.tf. Adding that ingress here instead would make rds depend on
# ai_service, which already depends on rds for the endpoint: a module cycle.
output "security_group_id" {
  value = aws_security_group.rds.id
}
