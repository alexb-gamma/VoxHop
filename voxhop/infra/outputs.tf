output "elastic_ip" {
  description = "VoxHop Elastic IP — register this as wsUrl in telco-ai-bridge customers.json"
  value       = aws_eip.voxhop.public_ip
}

output "instance_id" {
  description = "VoxHop EC2 instance ID"
  value       = aws_instance.voxhop.id
}

output "s3_bucket_name" {
  description = "VoxHop debug S3 bucket name"
  value       = aws_s3_bucket.debug.id
}

output "voxhop_ws_url" {
  description = "WebSocket URL for telco-ai-bridge customers.json wsUrl field"
  value       = "wss://${aws_eip.voxhop.public_ip}:3000/ws/calls"
}

# P1-01: Route 53 NS records for manual sub-delegation of voxhop.borshik.net (M-08)
output "ns_records" {
  description = "Route 53 NS records for voxhop.borshik.net — add these to borshik.net registrar to complete sub-delegation"
  value       = aws_route53_zone.voxhop.name_servers
}
